import { createHash } from 'node:crypto'

import { z } from 'zod'

import {
  OAuthConnectionResultSchema,
  TenantIdSchema,
  type OAuthConnectionResult,
} from './contracts.js'
import { ConnectorError } from './errors.js'
import type {
  ConnectorClockPort,
  ConnectorEntropyPort,
  CredentialVaultPort,
  OAuthStateStorePort,
  ProviderCredential,
  SecretString,
} from './ports.js'
import { secret } from './ports.js'
import { SmartThingsTokenResponseSchema } from './smartthings-schemas.js'

const SMARTTHINGS_API_ORIGIN = 'https://api.smartthings.com'
const SMARTTHINGS_AUTHORIZE_URL = `${SMARTTHINGS_API_ORIGIN}/v1/oauth/authorize`
const SMARTTHINGS_TOKEN_URL = `${SMARTTHINGS_API_ORIGIN}/v1/oauth/token`
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
const TOKEN_REFRESH_SKEW_MS = 60 * 1000

export const SMARTTHINGS_DEVICE_SCOPES = ['r:devices:$', 'x:devices:$'] as const

// SmartThings' documented confidential-client flow lists no PKCE parameters.
export const SMARTTHINGS_PKCE_SUPPORT = 'not_documented' as const

const OAuthConfigSchema = z
  .object({
    clientId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[a-zA-Z0-9._-]+$/),
    clientSecret: z.string().min(1).max(4096),
    redirectUri: z.url().refine((value) => {
      const url = new URL(value)
      return (
        url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''
      )
    }),
  })
  .strict()

const BeginAuthorizationInputSchema = z
  .object({
    tenantId: TenantIdSchema,
    sessionBinding: z.string().min(16).max(256),
  })
  .strict()

const CompleteAuthorizationInputSchema = z
  .object({
    tenantId: TenantIdSchema,
    sessionBinding: z.string().min(16).max(256),
    state: z.string().min(32).max(512),
    code: z.string().min(1).max(4096).optional(),
    error: z.literal('access_denied').optional(),
  })
  .strict()
  .refine((value) => (value.code === undefined) !== (value.error === undefined))

export interface SmartThingsOAuthConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
}

interface SmartThingsOAuthDependencies {
  readonly clock: ConnectorClockPort
  readonly entropy: ConnectorEntropyPort
  readonly fetch: typeof fetch
  readonly stateStore: OAuthStateStorePort
  readonly vault: CredentialVaultPort
}

interface SmartThingsTokenManagerDependencies {
  readonly clock: ConnectorClockPort
  readonly fetch: typeof fetch
  readonly vault: CredentialVaultPort
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseGrantedScopes(value: string): readonly string[] {
  const scopes = value
    .split(/\s+/u)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0)

  if (
    scopes.length === 0 ||
    scopes.some((scope) => !/^[rwx]:[a-z]+:[a-zA-Z0-9*$._-]+$/u.test(scope))
  ) {
    throw new ConnectorError({ code: 'invalid_provider_response' })
  }

  return [...new Set(scopes)].sort()
}

function hasDeviceScope(scopes: readonly string[], permission: 'r' | 'x'): boolean {
  return scopes.some((scope) => scope.startsWith(`${permission}:devices:`))
}

function assertRequiredScopes(scopes: readonly string[]): void {
  if (!hasDeviceScope(scopes, 'r') || !hasDeviceScope(scopes, 'x')) {
    throw new ConnectorError({ code: 'provider_access_denied' })
  }
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`
}

function rateLimitDelay(response: Response): number | undefined {
  const raw = response.headers.get('x-ratelimit-reset')
  if (raw === null || !/^\d+$/u.test(raw)) {
    return undefined
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) ? Math.min(value, 86_400_000) : undefined
}

async function parseTokenResponse(
  response: Response,
): Promise<z.infer<typeof SmartThingsTokenResponseSchema>> {
  if (response.status === 429) {
    const retryAfterMs = rateLimitDelay(response)
    throw new ConnectorError({
      code: 'provider_rate_limited',
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConnectorError({ code: 'authentication_required' })
  }
  if (response.status >= 500) {
    throw new ConnectorError({ code: 'provider_temporarily_unavailable', retryable: true })
  }
  if (!response.ok) {
    throw new ConnectorError({ code: 'invalid_oauth_callback' })
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ConnectorError({ code: 'invalid_provider_response' })
  }
  const parsed = SmartThingsTokenResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new ConnectorError({ code: 'invalid_provider_response' })
  }
  return parsed.data
}

function toCredential(input: {
  readonly tenantId: string
  readonly token: z.infer<typeof SmartThingsTokenResponseSchema>
  readonly now: Date
}): Omit<ProviderCredential, 'revision'> {
  const scopes = parseGrantedScopes(input.token.scope)
  assertRequiredScopes(scopes)
  return {
    tenantId: input.tenantId,
    provider: 'smartthings',
    accessToken: secret(input.token.access_token),
    refreshToken: secret(input.token.refresh_token),
    installedAppId: secret(input.token.installed_app_id),
    accessTokenExpiresAt: new Date(input.now.getTime() + input.token.expires_in * 1000),
    scopes,
  }
}

export class SmartThingsOAuthClient {
  readonly #config: z.infer<typeof OAuthConfigSchema>
  readonly #dependencies: SmartThingsOAuthDependencies

  constructor(config: SmartThingsOAuthConfig, dependencies: SmartThingsOAuthDependencies) {
    this.#config = OAuthConfigSchema.parse(config)
    this.#dependencies = dependencies
  }

  async beginAuthorization(input: {
    readonly tenantId: string
    readonly sessionBinding: string
  }): Promise<{ readonly authorizationUrl: string }> {
    const parsed = BeginAuthorizationInputSchema.parse(input)
    const state = this.#dependencies.entropy.randomToken(32)
    if (!/^[a-zA-Z0-9_-]{32,512}$/u.test(state)) {
      throw new ConnectorError({ code: 'invalid_oauth_callback' })
    }

    const now = this.#dependencies.clock.now()
    await this.#dependencies.stateStore.put({
      tenantId: parsed.tenantId,
      sessionBinding: parsed.sessionBinding,
      stateDigest: digest(state),
      redirectUri: this.#config.redirectUri,
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
    })

    const url = new URL(SMARTTHINGS_AUTHORIZE_URL)
    url.searchParams.set('client_id', this.#config.clientId)
    url.searchParams.set('scope', SMARTTHINGS_DEVICE_SCOPES.join(' '))
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', this.#config.redirectUri)
    url.searchParams.set('state', state)
    return { authorizationUrl: url.toString() }
  }

  async completeAuthorization(input: {
    readonly tenantId: string
    readonly sessionBinding: string
    readonly state: string
    readonly code?: string
    readonly error?: 'access_denied'
  }): Promise<OAuthConnectionResult> {
    const parsed = CompleteAuthorizationInputSchema.parse(input)
    const now = this.#dependencies.clock.now()
    const state = await this.#dependencies.stateStore.consume({
      tenantId: parsed.tenantId,
      sessionBinding: parsed.sessionBinding,
      stateDigest: digest(parsed.state),
      now,
    })
    if (state === null || state.expiresAt.getTime() < now.getTime()) {
      throw new ConnectorError({ code: 'state_mismatch' })
    }
    if (state.redirectUri !== this.#config.redirectUri) {
      throw new ConnectorError({ code: 'state_mismatch' })
    }
    if (parsed.error !== undefined) {
      throw new ConnectorError({ code: 'authorization_denied' })
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: parsed.code ?? '',
      client_id: this.#config.clientId,
      redirect_uri: this.#config.redirectUri,
    })
    let response: Response
    try {
      response = await this.#dependencies.fetch(SMARTTHINGS_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: basicAuthorization(this.#config.clientId, this.#config.clientSecret),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      })
    } catch {
      throw new ConnectorError({ code: 'provider_temporarily_unavailable', retryable: true })
    }

    const token = await parseTokenResponse(response)
    const credential = toCredential({ tenantId: parsed.tenantId, token, now })
    await this.#dependencies.vault.create(credential)

    return OAuthConnectionResultSchema.parse({
      provider: 'smartthings',
      status: 'connected',
      scopes: { deviceRead: true, deviceExecute: true },
      expiresAt: credential.accessTokenExpiresAt.toISOString(),
    })
  }
}

export class SmartThingsTokenManager {
  readonly #clientId: string
  readonly #clientSecret: string
  readonly #dependencies: SmartThingsTokenManagerDependencies

  constructor(config: SmartThingsOAuthConfig, dependencies: SmartThingsTokenManagerDependencies) {
    const parsed = OAuthConfigSchema.parse(config)
    this.#clientId = parsed.clientId
    this.#clientSecret = parsed.clientSecret
    this.#dependencies = dependencies
  }

  async accessToken(tenantId: string): Promise<SecretString> {
    TenantIdSchema.parse(tenantId)
    const credential = await this.#dependencies.vault.load(tenantId)
    if (credential === null) {
      throw new ConnectorError({ code: 'authentication_required' })
    }
    if (
      credential.accessTokenExpiresAt.getTime() - this.#dependencies.clock.now().getTime() >
      TOKEN_REFRESH_SKEW_MS
    ) {
      return credential.accessToken
    }
    return this.refresh(tenantId, false)
  }

  async refreshAfterUnauthorized(
    tenantId: string,
    rejectedAccessToken: SecretString,
  ): Promise<SecretString> {
    return this.refresh(TenantIdSchema.parse(tenantId), true, rejectedAccessToken)
  }

  private async refresh(
    tenantId: string,
    force: boolean,
    rejectedAccessToken?: SecretString,
  ): Promise<SecretString> {
    return this.#dependencies.vault.withRefreshLock(tenantId, async () => {
      const current = await this.#dependencies.vault.load(tenantId)
      if (current === null) {
        throw new ConnectorError({ code: 'authentication_required' })
      }
      if (
        force &&
        rejectedAccessToken !== undefined &&
        current.accessToken !== rejectedAccessToken
      ) {
        return current.accessToken
      }
      if (
        !force &&
        current.accessTokenExpiresAt.getTime() - this.#dependencies.clock.now().getTime() >
          TOKEN_REFRESH_SKEW_MS
      ) {
        return current.accessToken
      }

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: this.#clientId,
      })
      let response: Response
      try {
        response = await this.#dependencies.fetch(SMARTTHINGS_TOKEN_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: basicAuthorization(this.#clientId, this.#clientSecret),
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
        })
      } catch {
        throw new ConnectorError({ code: 'provider_temporarily_unavailable', retryable: true })
      }

      const token = await parseTokenResponse(response)
      const replacement = toCredential({
        tenantId,
        token,
        now: this.#dependencies.clock.now(),
      })
      if (replacement.installedAppId !== current.installedAppId) {
        throw new ConnectorError({ code: 'tenant_boundary_violation' })
      }
      const replaced = await this.#dependencies.vault.replace(current.revision, replacement)
      if (!replaced) {
        throw new ConnectorError({ code: 'credential_rotation_conflict', retryable: true })
      }
      return replacement.accessToken
    })
  }
}

import { describe, expect, it, vi } from 'vitest'

import { secret } from '../ports.js'
import {
  SMARTTHINGS_DEVICE_SCOPES,
  SMARTTHINGS_PKCE_SUPPORT,
  SmartThingsOAuthClient,
  SmartThingsTokenManager,
} from '../smartthings-oauth.js'
import { FixedClock, FixedEntropy, InMemoryOAuthStateStore, InMemoryVault } from './fakes.js'

const NOW = new Date('2026-07-15T12:00:00.000Z')
const SESSION = 'session-binding-0123456789'
const CONFIG = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://trash.example.test/integrations/smartthings/callback',
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      access_token: 'access-token-value',
      token_type: 'bearer',
      refresh_token: 'refresh-token-value',
      expires_in: 86_399,
      scope: 'r:devices:device-one x:devices:device-one',
      installed_app_id: 'installed-app-id',
      ...overrides,
    },
    { status: 200 },
  )
}

describe('SmartThingsOAuthClient', () => {
  it('requests only user-selected device scopes and binds a one-time CSRF state', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => tokenResponse())
    const stateStore = new InMemoryOAuthStateStore()
    const vault = new InMemoryVault()
    const entropy = new FixedEntropy()
    const client = new SmartThingsOAuthClient(CONFIG, {
      clock: new FixedClock(NOW),
      entropy,
      fetch: fetchMock,
      stateStore,
      vault,
    })

    const started = await client.beginAuthorization({
      tenantId: 'tenant-a',
      sessionBinding: SESSION,
    })
    const url = new URL(started.authorizationUrl)
    expect(url.origin + url.pathname).toBe('https://api.smartthings.com/v1/oauth/authorize')
    expect(url.searchParams.get('scope')).toBe(SMARTTHINGS_DEVICE_SCOPES.join(' '))
    expect(url.searchParams.get('state')).toBe(entropy.value)
    expect(url.searchParams.has('code_challenge')).toBe(false)
    expect(url.searchParams.has('code_challenge_method')).toBe(false)
    expect(SMARTTHINGS_PKCE_SUPPORT).toBe('not_documented')

    await expect(
      client.completeAuthorization({
        tenantId: 'tenant-b',
        sessionBinding: SESSION,
        state: entropy.value,
        code: 'authorization-code',
      }),
    ).rejects.toMatchObject({ code: 'state_mismatch' })

    const result = await client.completeAuthorization({
      tenantId: 'tenant-a',
      sessionBinding: SESSION,
      state: entropy.value,
      code: 'authorization-code',
    })
    expect(result).toEqual({
      provider: 'smartthings',
      status: 'connected',
      scopes: { deviceRead: true, deviceExecute: true },
      expiresAt: '2026-07-16T11:59:59.000Z',
    })
    expect(JSON.stringify(result)).not.toMatch(/access|refresh|installed-app-id/u)
    expect(vault.credentials.get('tenant-a')).toMatchObject({ revision: 1 })

    await expect(
      client.completeAuthorization({
        tenantId: 'tenant-a',
        sessionBinding: SESSION,
        state: entropy.value,
        code: 'authorization-code',
      }),
    ).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('validates denial state before returning a sanitized denial', async () => {
    const client = new SmartThingsOAuthClient(CONFIG, {
      clock: new FixedClock(NOW),
      entropy: new FixedEntropy(),
      fetch: vi.fn<typeof fetch>(),
      stateStore: new InMemoryOAuthStateStore(),
      vault: new InMemoryVault(),
    })
    const started = await client.beginAuthorization({
      tenantId: 'tenant-a',
      sessionBinding: SESSION,
    })
    const state = new URL(started.authorizationUrl).searchParams.get('state')!
    await expect(
      client.completeAuthorization({
        tenantId: 'tenant-a',
        sessionBinding: SESSION,
        state,
        error: 'access_denied',
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' })
  })

  it('rejects a token that lacks execute access', async () => {
    const client = new SmartThingsOAuthClient(CONFIG, {
      clock: new FixedClock(NOW),
      entropy: new FixedEntropy(),
      fetch: vi.fn<typeof fetch>(async () => tokenResponse({ scope: 'r:devices:device-one' })),
      stateStore: new InMemoryOAuthStateStore(),
      vault: new InMemoryVault(),
    })
    const started = await client.beginAuthorization({
      tenantId: 'tenant-a',
      sessionBinding: SESSION,
    })
    await expect(
      client.completeAuthorization({
        tenantId: 'tenant-a',
        sessionBinding: SESSION,
        state: new URL(started.authorizationUrl).searchParams.get('state')!,
        code: 'authorization-code',
      }),
    ).rejects.toMatchObject({ code: 'provider_access_denied' })
  })

  it('classifies provider throttling without exposing the provider body', async () => {
    const client = new SmartThingsOAuthClient(CONFIG, {
      clock: new FixedClock(NOW),
      entropy: new FixedEntropy(),
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json(
          { error: 'contains-private-provider-detail' },
          { status: 429, headers: { 'x-ratelimit-reset': '2500' } },
        ),
      ),
      stateStore: new InMemoryOAuthStateStore(),
      vault: new InMemoryVault(),
    })
    const started = await client.beginAuthorization({
      tenantId: 'tenant-a',
      sessionBinding: SESSION,
    })
    const promise = client.completeAuthorization({
      tenantId: 'tenant-a',
      sessionBinding: SESSION,
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: 'authorization-code',
    })
    await expect(promise).rejects.toMatchObject({
      code: 'provider_rate_limited',
      retryable: true,
      retryAfterMs: 2500,
      message: 'provider_rate_limited',
    })
  })
})

describe('SmartThingsTokenManager', () => {
  it('atomically rotates both single-use tokens before returning access', async () => {
    const vault = new InMemoryVault()
    await vault.create({
      tenantId: 'tenant-a',
      provider: 'smartthings',
      accessToken: secret('expired-access'),
      refreshToken: secret('single-use-refresh'),
      installedAppId: secret('installed-app-id'),
      accessTokenExpiresAt: new Date(NOW.getTime() - 1),
      scopes: ['r:devices:device-one', 'x:devices:device-one'],
    })
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (!(init?.body instanceof URLSearchParams)) {
        throw new Error('expected form-encoded token request')
      }
      expect(init.body.toString()).toContain('refresh_token=single-use-refresh')
      return tokenResponse({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
      })
    })
    const manager = new SmartThingsTokenManager(CONFIG, {
      clock: new FixedClock(NOW),
      fetch: fetchMock,
      vault,
    })

    expect(await manager.accessToken('tenant-a')).toBe('rotated-access')
    expect(vault.credentials.get('tenant-a')).toMatchObject({
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
      revision: 2,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not rotate again when another worker already replaced the rejected token', async () => {
    const vault = new InMemoryVault()
    await vault.create({
      tenantId: 'tenant-a',
      provider: 'smartthings',
      accessToken: secret('already-rotated-access'),
      refreshToken: secret('already-rotated-refresh'),
      installedAppId: secret('installed-app-id'),
      accessTokenExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      scopes: ['r:devices:device-one', 'x:devices:device-one'],
    })
    const fetchMock = vi.fn<typeof fetch>()
    const manager = new SmartThingsTokenManager(CONFIG, {
      clock: new FixedClock(NOW),
      fetch: fetchMock,
      vault,
    })

    expect(await manager.refreshAfterUnauthorized('tenant-a', secret('rejected-old-access'))).toBe(
      'already-rotated-access',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a refresh response that changes the tenant installation identity', async () => {
    const vault = new InMemoryVault()
    await vault.create({
      tenantId: 'tenant-a',
      provider: 'smartthings',
      accessToken: secret('expired-access'),
      refreshToken: secret('single-use-refresh'),
      installedAppId: secret('installed-app-id'),
      accessTokenExpiresAt: new Date(NOW.getTime() - 1),
      scopes: ['r:devices:device-one', 'x:devices:device-one'],
    })
    const manager = new SmartThingsTokenManager(CONFIG, {
      clock: new FixedClock(NOW),
      fetch: vi.fn<typeof fetch>(async () =>
        tokenResponse({ installed_app_id: 'different-installed-app' }),
      ),
      vault,
    })

    await expect(manager.accessToken('tenant-a')).rejects.toMatchObject({
      code: 'tenant_boundary_violation',
    })
    expect(vault.credentials.get('tenant-a')).toMatchObject({
      installedAppId: 'installed-app-id',
      revision: 1,
    })
  })
})

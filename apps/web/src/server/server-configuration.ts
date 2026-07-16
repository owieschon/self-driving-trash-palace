import { isAbsolute, normalize, resolve } from 'node:path'

import { z } from 'zod'

import {
  IdentityTelemetryKeyIdSchema,
  IdentityTelemetryPrincipalIdSchema,
  IsoDateTimeSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
} from '@trash-palace/core'

import { parseDevBootstrap, type DevSessionBootstrap } from './management-routes.js'
import { isLoopbackHostname, parseTrustedHttpOrigin } from './trusted-origin.js'

const SecretValueSchema = z
  .string()
  .min(32)
  .refine((value) => !value.startsWith('replace-with-'), {
    message: 'Example placeholder secrets are not valid runtime configuration',
  })

const EnvironmentSchema = z
  .looseObject({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    DATABASE_URL: z.string().min(1),
    SESSION_SIGNING_KEY: SecretValueSchema,
    TOOL_INVOCATION_SCOPE_KEY: SecretValueSchema,
    GATEWAY_CALLBACK_SIGNING_KEY: SecretValueSchema,
    GATEWAY_CALLBACK_SIGNING_KEY_ID: z.string().regex(/^gwk_[A-Za-z0-9_-]{8,64}$/),
    IDENTITY_TELEMETRY_SIGNING_KEY: SecretValueSchema,
    IDENTITY_TELEMETRY_SIGNING_KEY_ID: IdentityTelemetryKeyIdSchema,
    IDENTITY_TELEMETRY_PRINCIPAL_ID: IdentityTelemetryPrincipalIdSchema,
    TRASH_PALACE_LOCAL_ORGANIZATION_ID: OrganizationIdSchema,
    TRASH_PALACE_LOCAL_PALACE_ID: PalaceIdSchema,
    TRASH_PALACE_EVIDENCE_ALIAS_KEY: SecretValueSchema,
    TRASH_PALACE_EVIDENCE_SINK_PATH: z.string().min(1),
    TRASH_PALACE_APP_VERSION: z.string().default('0.0.0'),
    TRASH_PALACE_ENVIRONMENT: z.enum(['evaluation', 'hosted_demo', 'local']).default('local'),
    TRASH_PALACE_EVIDENCE_ORIGIN: z.enum(['evaluation', 'fixture', 'live']).optional(),
    TRASH_PALACE_CLOCK_MODE: z.enum(['fixture', 'system']).default('system'),
    TRASH_PALACE_FIXTURE_REAL_START_AT: IsoDateTimeSchema.optional(),
    TRASH_PALACE_ALLOWED_ORIGIN: z.string().min(1),
    TRASH_PALACE_DEV_SESSION_ENABLED: z.enum(['true', 'false']).default('false'),
    TRASH_PALACE_DEV_ORGANIZATION_ID: z.string().optional(),
    TRASH_PALACE_DEV_USER_ID: z.string().optional(),
    TRASH_PALACE_DEV_MEMBERSHIP_ID: z.string().optional(),
  })
  .superRefine((environment, context) => {
    const keys = [
      'SESSION_SIGNING_KEY',
      'TOOL_INVOCATION_SCOPE_KEY',
      'GATEWAY_CALLBACK_SIGNING_KEY',
      'IDENTITY_TELEMETRY_SIGNING_KEY',
      'TRASH_PALACE_EVIDENCE_ALIAS_KEY',
    ] as const
    if (new Set(keys.map((key) => environment[key])).size !== keys.length) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_SIGNING_KEY'],
        message: 'Every signing and scoping purpose requires an independent secret',
      })
    }
    const expectedOrigin = originFor(environment.TRASH_PALACE_ENVIRONMENT)
    if (
      environment.TRASH_PALACE_EVIDENCE_ORIGIN !== undefined &&
      environment.TRASH_PALACE_EVIDENCE_ORIGIN !== expectedOrigin
    ) {
      context.addIssue({
        code: 'custom',
        path: ['TRASH_PALACE_EVIDENCE_ORIGIN'],
        message: 'Evidence origin does not match the configured environment',
      })
    }
    if (
      environment.TRASH_PALACE_CLOCK_MODE === 'fixture' &&
      environment.TRASH_PALACE_FIXTURE_REAL_START_AT === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['TRASH_PALACE_FIXTURE_REAL_START_AT'],
        message: 'Fixture clock mode requires one shared real start instant',
      })
    }
    if (
      environment.TRASH_PALACE_CLOCK_MODE === 'system' &&
      environment.TRASH_PALACE_FIXTURE_REAL_START_AT !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['TRASH_PALACE_FIXTURE_REAL_START_AT'],
        message: 'System clock mode must not retain a fixture start instant',
      })
    }
  })

export type WebDomainClockConfiguration =
  Readonly<{ mode: 'fixture'; realStartAt: string }> | Readonly<{ mode: 'system' }>

export interface WebServerConfiguration {
  readonly databaseUrl: string
  readonly sessionSigningKey: string
  readonly toolInvocationScopeKey: string
  readonly gatewayCallbackSigningKey: string
  readonly gatewayCallbackSigningKeyId: string
  readonly identityTelemetrySigningKey: string
  readonly identityTelemetrySigningKeyId: ReturnType<typeof IdentityTelemetryKeyIdSchema.parse>
  readonly identityTelemetryPrincipalId: ReturnType<typeof IdentityTelemetryPrincipalIdSchema.parse>
  readonly localOrganizationId: ReturnType<typeof OrganizationIdSchema.parse>
  readonly localPalaceId: ReturnType<typeof PalaceIdSchema.parse>
  readonly evidenceAliasKey: string
  readonly evidenceSinkPath: string
  readonly applicationVersion: string
  readonly evidenceEnvironment: 'evaluation' | 'hosted_demo' | 'local'
  readonly evidenceOrigin: 'evaluation' | 'fixture' | 'live'
  readonly domainClock: WebDomainClockConfiguration
  readonly allowedOrigin: string
  readonly devBootstrap: DevSessionBootstrap
}

export function parseWebServerConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): WebServerConfiguration {
  const parsed = EnvironmentSchema.parse(environment)
  const databaseUrl = new URL(parsed.DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new TypeError('DATABASE_URL must use PostgreSQL')
  }
  const allowedOrigin = parseTrustedHttpOrigin(
    parsed.TRASH_PALACE_ALLOWED_ORIGIN,
    'TRASH_PALACE_ALLOWED_ORIGIN',
  )
  const devSessionRequested = parsed.TRASH_PALACE_DEV_SESSION_ENABLED === 'true'
  if (
    devSessionRequested &&
    (parsed.NODE_ENV !== 'development' || !isLoopbackOrigin(allowedOrigin))
  ) {
    throw new TypeError('Development session bootstrap requires development mode and loopback')
  }
  if (devSessionRequested) {
    if (
      parsed.TRASH_PALACE_DEV_ORGANIZATION_ID === undefined ||
      parsed.TRASH_PALACE_DEV_USER_ID === undefined ||
      parsed.TRASH_PALACE_DEV_MEMBERSHIP_ID === undefined
    ) {
      throw new TypeError('Development session bootstrap requires fixed seeded identity IDs')
    }
  }
  return {
    databaseUrl: databaseUrl.toString(),
    sessionSigningKey: parsed.SESSION_SIGNING_KEY,
    toolInvocationScopeKey: parsed.TOOL_INVOCATION_SCOPE_KEY,
    gatewayCallbackSigningKey: parsed.GATEWAY_CALLBACK_SIGNING_KEY,
    gatewayCallbackSigningKeyId: parsed.GATEWAY_CALLBACK_SIGNING_KEY_ID,
    identityTelemetrySigningKey: parsed.IDENTITY_TELEMETRY_SIGNING_KEY,
    identityTelemetrySigningKeyId: parsed.IDENTITY_TELEMETRY_SIGNING_KEY_ID,
    identityTelemetryPrincipalId: parsed.IDENTITY_TELEMETRY_PRINCIPAL_ID,
    localOrganizationId: parsed.TRASH_PALACE_LOCAL_ORGANIZATION_ID,
    localPalaceId: parsed.TRASH_PALACE_LOCAL_PALACE_ID,
    evidenceAliasKey: parsed.TRASH_PALACE_EVIDENCE_ALIAS_KEY,
    evidenceSinkPath: absoluteJsonlPath(parsed.TRASH_PALACE_EVIDENCE_SINK_PATH),
    applicationVersion: semver(parsed.TRASH_PALACE_APP_VERSION),
    evidenceEnvironment: parsed.TRASH_PALACE_ENVIRONMENT,
    evidenceOrigin:
      parsed.TRASH_PALACE_EVIDENCE_ORIGIN ?? originFor(parsed.TRASH_PALACE_ENVIRONMENT),
    domainClock: domainClockConfiguration(
      parsed.TRASH_PALACE_CLOCK_MODE,
      parsed.TRASH_PALACE_FIXTURE_REAL_START_AT,
    ),
    allowedOrigin,
    devBootstrap: parseDevBootstrap({
      enabled: devSessionRequested,
      organizationId: parsed.TRASH_PALACE_DEV_ORGANIZATION_ID ?? 'disabled',
      userId: parsed.TRASH_PALACE_DEV_USER_ID ?? 'disabled',
      membershipId: parsed.TRASH_PALACE_DEV_MEMBERSHIP_ID ?? 'disabled',
    }),
  }
}

function originFor(
  environment: 'evaluation' | 'hosted_demo' | 'local',
): 'evaluation' | 'fixture' | 'live' {
  if (environment === 'evaluation') return 'evaluation'
  if (environment === 'hosted_demo') return 'live'
  return 'fixture'
}

function absoluteJsonlPath(value: string): string {
  if (
    !isAbsolute(value) ||
    normalize(value) !== value ||
    resolve(value) !== value ||
    !value.endsWith('.jsonl')
  ) {
    throw new TypeError('TRASH_PALACE_EVIDENCE_SINK_PATH must be a normalized absolute JSONL path')
  }
  return value
}

function semver(value: string): string {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new TypeError('TRASH_PALACE_APP_VERSION must be semantic version text')
  }
  return value
}

function isLoopbackOrigin(origin: string): boolean {
  return isLoopbackHostname(new URL(origin).hostname)
}

function domainClockConfiguration(
  mode: 'fixture' | 'system',
  realStartAt: string | undefined,
): WebDomainClockConfiguration {
  if (mode === 'system') return { mode }
  if (realStartAt === undefined) {
    throw new TypeError('Fixture clock mode requires one shared real start instant')
  }
  return { mode, realStartAt }
}

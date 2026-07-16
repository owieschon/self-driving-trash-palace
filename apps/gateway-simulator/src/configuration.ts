import { z } from 'zod'

import { IdentityTelemetryKeyIdSchema, IsoDateTimeSchema } from '@trash-palace/core'

import { GATEWAY_FAULT_PROFILES, type GatewayFaultProfile } from './faults.js'

const IntegerEnvironmentValue = (minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^\d+$/, 'Expected an unsigned base-10 integer')
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum))

const GatewaySimulatorEnvironmentSchema = z
  .object({
    GATEWAY_SIMULATOR_HOST: z
      .string()
      .regex(/^(?:0\.0\.0\.0|127\.0\.0\.1|localhost|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/i)
      .default('0.0.0.0'),
    GATEWAY_SIMULATOR_PORT: IntegerEnvironmentValue(1, 65_535).default(4319),
    GATEWAY_SIMULATOR_LAB_MODE: z.enum(['true', 'false']).default('false'),
    GATEWAY_SIMULATOR_FAULT_PROFILE: z.enum(['none', 'lost_ack']).default('none'),
    GATEWAY_CALLBACK_SIGNING_KEY_ID: z
      .string()
      .regex(/^gwk_[A-Za-z0-9_-]{8,64}$/)
      .default('gwk_local_gateway_2026'),
    GATEWAY_CALLBACK_SIGNING_KEY: z
      .string()
      .min(32)
      .refine((value) => !value.startsWith('replace-with-'), {
        message: 'Gateway callback signing key must not use the example placeholder',
      }),
    GATEWAY_CALLBACK_MAX_ATTEMPTS: IntegerEnvironmentValue(1, 8).default(4),
    GATEWAY_CALLBACK_INITIAL_BACKOFF_MS: IntegerEnvironmentValue(1, 10_000).default(100),
    GATEWAY_CALLBACK_MAX_BACKOFF_MS: IntegerEnvironmentValue(1, 30_000).default(2_000),
    GATEWAY_CALLBACK_REQUEST_TIMEOUT_MS: IntegerEnvironmentValue(100, 30_000).default(2_000),
    GATEWAY_CALLBACK_READINESS_INTERVAL_MS: IntegerEnvironmentValue(100, 60_000).default(1_000),
    GATEWAY_CALLBACK_MAX_TRACKED: IntegerEnvironmentValue(16, 4_096).default(512),
    IDENTITY_TELEMETRY_SIGNING_KEY_ID: IdentityTelemetryKeyIdSchema,
    IDENTITY_TELEMETRY_SIGNING_KEY: z
      .string()
      .min(32)
      .refine((value) => !value.startsWith('replace-with-'), {
        message: 'Identity telemetry signing key must not use the example placeholder',
      }),
    IDENTITY_TELEMETRY_MAX_ATTEMPTS: IntegerEnvironmentValue(1, 8).default(4),
    IDENTITY_TELEMETRY_INITIAL_BACKOFF_MS: IntegerEnvironmentValue(1, 10_000).default(100),
    IDENTITY_TELEMETRY_MAX_BACKOFF_MS: IntegerEnvironmentValue(1, 30_000).default(2_000),
    IDENTITY_TELEMETRY_REQUEST_TIMEOUT_MS: IntegerEnvironmentValue(100, 30_000).default(2_000),
    IDENTITY_TELEMETRY_READINESS_INTERVAL_MS: IntegerEnvironmentValue(100, 60_000).default(1_000),
    IDENTITY_TELEMETRY_MAX_TRACKED: IntegerEnvironmentValue(2, 4_096).default(128),
    TRASH_PALACE_FIXTURE_REAL_START_AT: IsoDateTimeSchema.optional(),
    GATEWAY_SHUTDOWN_TIMEOUT_MS: IntegerEnvironmentValue(100, 60_000).default(10_000),
  })
  .strict()
  .superRefine((environment, context) => {
    if (
      environment.GATEWAY_SIMULATOR_FAULT_PROFILE !== 'none' &&
      environment.GATEWAY_SIMULATOR_LAB_MODE !== 'true'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['GATEWAY_SIMULATOR_FAULT_PROFILE'],
        message: 'Gateway fault injection requires explicit lab mode',
      })
    }
    if (
      environment.GATEWAY_CALLBACK_MAX_BACKOFF_MS < environment.GATEWAY_CALLBACK_INITIAL_BACKOFF_MS
    ) {
      context.addIssue({
        code: 'custom',
        path: ['GATEWAY_CALLBACK_MAX_BACKOFF_MS'],
        message: 'Maximum callback backoff cannot be shorter than initial callback backoff',
      })
    }
    if (
      environment.IDENTITY_TELEMETRY_MAX_BACKOFF_MS <
      environment.IDENTITY_TELEMETRY_INITIAL_BACKOFF_MS
    ) {
      context.addIssue({
        code: 'custom',
        path: ['IDENTITY_TELEMETRY_MAX_BACKOFF_MS'],
        message: 'Maximum identity telemetry backoff cannot be shorter than its initial backoff',
      })
    }
    if (environment.GATEWAY_CALLBACK_SIGNING_KEY === environment.IDENTITY_TELEMETRY_SIGNING_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['IDENTITY_TELEMETRY_SIGNING_KEY'],
        message: 'Identity telemetry and callback signing require independent keys',
      })
    }
    const callbackWorstCase = worstCaseDeliveryMilliseconds({
      attempts: environment.GATEWAY_CALLBACK_MAX_ATTEMPTS,
      requestTimeout: environment.GATEWAY_CALLBACK_REQUEST_TIMEOUT_MS,
      initialBackoff: environment.GATEWAY_CALLBACK_INITIAL_BACKOFF_MS,
      maximumBackoff: environment.GATEWAY_CALLBACK_MAX_BACKOFF_MS,
    })
    if (callbackWorstCase > environment.GATEWAY_SHUTDOWN_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['GATEWAY_SHUTDOWN_TIMEOUT_MS'],
        message: 'Shutdown timeout must cover the configured worst-case bounded callback delivery',
      })
    }
    const identityWorstCase = worstCaseDeliveryMilliseconds({
      attempts: environment.IDENTITY_TELEMETRY_MAX_ATTEMPTS,
      requestTimeout: environment.IDENTITY_TELEMETRY_REQUEST_TIMEOUT_MS,
      initialBackoff: environment.IDENTITY_TELEMETRY_INITIAL_BACKOFF_MS,
      maximumBackoff: environment.IDENTITY_TELEMETRY_MAX_BACKOFF_MS,
    })
    if (identityWorstCase > environment.GATEWAY_SHUTDOWN_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['GATEWAY_SHUTDOWN_TIMEOUT_MS'],
        message:
          'Shutdown timeout must cover the configured worst-case bounded identity telemetry delivery',
      })
    }
  })

export interface GatewaySimulatorConfiguration {
  readonly bindHost: string
  readonly port: number
  readonly faultProfile: GatewayFaultProfile
  readonly signingKeyId: string
  readonly signingKey: string
  readonly identitySigningKeyId: string
  readonly identitySigningKey: string
  readonly callbackDelivery: {
    readonly maximumAttempts: number
    readonly initialBackoffMilliseconds: number
    readonly maximumBackoffMilliseconds: number
    readonly requestTimeoutMilliseconds: number
    readonly readinessIntervalMilliseconds: number
    readonly maximumTrackedCallbacks: number
  }
  readonly identityDelivery: {
    readonly maximumAttempts: number
    readonly initialBackoffMilliseconds: number
    readonly maximumBackoffMilliseconds: number
    readonly requestTimeoutMilliseconds: number
    readonly readinessIntervalMilliseconds: number
    readonly maximumTrackedEvents: number
  }
  readonly clock:
    Readonly<{ mode: 'anchored'; realStartAt: string }> | Readonly<{ mode: 'immediate' }>
  readonly shutdownTimeoutMilliseconds: number
}

export interface ParseGatewaySimulatorConfigurationOptions {
  /** Production requires the same absolute fixture anchor supplied to the web process. */
  readonly requireSharedFixtureStart?: boolean
}

export function parseGatewaySimulatorConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  options: ParseGatewaySimulatorConfigurationOptions = {},
): GatewaySimulatorConfiguration {
  const parsed = GatewaySimulatorEnvironmentSchema.parse({
    GATEWAY_SIMULATOR_HOST: environment.GATEWAY_SIMULATOR_HOST,
    GATEWAY_SIMULATOR_PORT: environment.GATEWAY_SIMULATOR_PORT,
    GATEWAY_SIMULATOR_LAB_MODE: environment.GATEWAY_SIMULATOR_LAB_MODE,
    GATEWAY_SIMULATOR_FAULT_PROFILE: environment.GATEWAY_SIMULATOR_FAULT_PROFILE,
    GATEWAY_CALLBACK_SIGNING_KEY_ID: environment.GATEWAY_CALLBACK_SIGNING_KEY_ID,
    GATEWAY_CALLBACK_SIGNING_KEY: environment.GATEWAY_CALLBACK_SIGNING_KEY,
    GATEWAY_CALLBACK_MAX_ATTEMPTS: environment.GATEWAY_CALLBACK_MAX_ATTEMPTS,
    GATEWAY_CALLBACK_INITIAL_BACKOFF_MS: environment.GATEWAY_CALLBACK_INITIAL_BACKOFF_MS,
    GATEWAY_CALLBACK_MAX_BACKOFF_MS: environment.GATEWAY_CALLBACK_MAX_BACKOFF_MS,
    GATEWAY_CALLBACK_REQUEST_TIMEOUT_MS: environment.GATEWAY_CALLBACK_REQUEST_TIMEOUT_MS,
    GATEWAY_CALLBACK_READINESS_INTERVAL_MS: environment.GATEWAY_CALLBACK_READINESS_INTERVAL_MS,
    GATEWAY_CALLBACK_MAX_TRACKED: environment.GATEWAY_CALLBACK_MAX_TRACKED,
    IDENTITY_TELEMETRY_SIGNING_KEY_ID: environment.IDENTITY_TELEMETRY_SIGNING_KEY_ID,
    IDENTITY_TELEMETRY_SIGNING_KEY: environment.IDENTITY_TELEMETRY_SIGNING_KEY,
    IDENTITY_TELEMETRY_MAX_ATTEMPTS: environment.IDENTITY_TELEMETRY_MAX_ATTEMPTS,
    IDENTITY_TELEMETRY_INITIAL_BACKOFF_MS: environment.IDENTITY_TELEMETRY_INITIAL_BACKOFF_MS,
    IDENTITY_TELEMETRY_MAX_BACKOFF_MS: environment.IDENTITY_TELEMETRY_MAX_BACKOFF_MS,
    IDENTITY_TELEMETRY_REQUEST_TIMEOUT_MS: environment.IDENTITY_TELEMETRY_REQUEST_TIMEOUT_MS,
    IDENTITY_TELEMETRY_READINESS_INTERVAL_MS: environment.IDENTITY_TELEMETRY_READINESS_INTERVAL_MS,
    IDENTITY_TELEMETRY_MAX_TRACKED: environment.IDENTITY_TELEMETRY_MAX_TRACKED,
    TRASH_PALACE_FIXTURE_REAL_START_AT: environment.TRASH_PALACE_FIXTURE_REAL_START_AT,
    GATEWAY_SHUTDOWN_TIMEOUT_MS: environment.GATEWAY_SHUTDOWN_TIMEOUT_MS,
  })
  if (
    options.requireSharedFixtureStart === true &&
    parsed.TRASH_PALACE_FIXTURE_REAL_START_AT === undefined
  ) {
    throw new TypeError('TRASH_PALACE_FIXTURE_REAL_START_AT is required in production')
  }
  return Object.freeze({
    bindHost: parsed.GATEWAY_SIMULATOR_HOST,
    port: parsed.GATEWAY_SIMULATOR_PORT,
    faultProfile: GATEWAY_FAULT_PROFILES[parsed.GATEWAY_SIMULATOR_FAULT_PROFILE],
    signingKeyId: parsed.GATEWAY_CALLBACK_SIGNING_KEY_ID,
    signingKey: parsed.GATEWAY_CALLBACK_SIGNING_KEY,
    identitySigningKeyId: parsed.IDENTITY_TELEMETRY_SIGNING_KEY_ID,
    identitySigningKey: parsed.IDENTITY_TELEMETRY_SIGNING_KEY,
    callbackDelivery: Object.freeze({
      maximumAttempts: parsed.GATEWAY_CALLBACK_MAX_ATTEMPTS,
      initialBackoffMilliseconds: parsed.GATEWAY_CALLBACK_INITIAL_BACKOFF_MS,
      maximumBackoffMilliseconds: parsed.GATEWAY_CALLBACK_MAX_BACKOFF_MS,
      requestTimeoutMilliseconds: parsed.GATEWAY_CALLBACK_REQUEST_TIMEOUT_MS,
      readinessIntervalMilliseconds: parsed.GATEWAY_CALLBACK_READINESS_INTERVAL_MS,
      maximumTrackedCallbacks: parsed.GATEWAY_CALLBACK_MAX_TRACKED,
    }),
    identityDelivery: Object.freeze({
      maximumAttempts: parsed.IDENTITY_TELEMETRY_MAX_ATTEMPTS,
      initialBackoffMilliseconds: parsed.IDENTITY_TELEMETRY_INITIAL_BACKOFF_MS,
      maximumBackoffMilliseconds: parsed.IDENTITY_TELEMETRY_MAX_BACKOFF_MS,
      requestTimeoutMilliseconds: parsed.IDENTITY_TELEMETRY_REQUEST_TIMEOUT_MS,
      readinessIntervalMilliseconds: parsed.IDENTITY_TELEMETRY_READINESS_INTERVAL_MS,
      maximumTrackedEvents: parsed.IDENTITY_TELEMETRY_MAX_TRACKED,
    }),
    clock:
      parsed.TRASH_PALACE_FIXTURE_REAL_START_AT === undefined
        ? Object.freeze({ mode: 'immediate' as const })
        : Object.freeze({
            mode: 'anchored' as const,
            realStartAt: parsed.TRASH_PALACE_FIXTURE_REAL_START_AT,
          }),
    shutdownTimeoutMilliseconds: parsed.GATEWAY_SHUTDOWN_TIMEOUT_MS,
  })
}

function worstCaseDeliveryMilliseconds(input: {
  readonly attempts: number
  readonly initialBackoff: number
  readonly maximumBackoff: number
  readonly requestTimeout: number
}): number {
  const retryBackoffMilliseconds = Array.from({ length: input.attempts - 1 }, (_, index) =>
    Math.min(input.maximumBackoff, input.initialBackoff * 2 ** index),
  ).reduce((total, backoff) => total + backoff, 0)
  return input.attempts * input.requestTimeout + retryBackoffMilliseconds
}

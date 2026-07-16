import { isAbsolute, normalize, resolve } from 'node:path'

import type { FlagshipClockConfiguration } from '@trash-palace/application'
import {
  IsoDateTimeSchema,
  OrganizationIdSchema,
  UserIdSchema,
  type OrganizationId,
  type UserId,
} from '@trash-palace/core'

export type WorkerEvidenceEnvironment = 'evaluation' | 'hosted_demo' | 'local'
export type WorkerEvidenceOrigin = 'evaluation' | 'fixture' | 'live'
export type CaretakerDecisionProviderConfiguration =
  | Readonly<{ kind: 'deterministic' }>
  | Readonly<{
      kind: 'claude'
      apiKey: string
      authorization: Readonly<{
        authorizationId: string
        maximumCostUsdPerDecision: number
      }>
    }>
export type ApplicationTransportFaultConfiguration =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'application_commit_then_response_lost'
      organizationId: OrganizationId
    }>

export interface WorkerServerConfiguration {
  readonly databaseUrl: string
  readonly workerId: string
  readonly serviceActorId: UserId
  readonly toolInvocationScopeKey: string
  readonly evidenceAliasKey: string
  readonly evidenceSinkPath: string
  readonly repositoryRoot: string
  readonly applicationVersion: string
  readonly evidenceEnvironment: WorkerEvidenceEnvironment
  readonly evidenceOrigin: WorkerEvidenceOrigin
  readonly decisionProvider: CaretakerDecisionProviderConfiguration
  readonly domainClock: FlagshipClockConfiguration
  readonly applicationTransportFault: ApplicationTransportFaultConfiguration
  readonly gatewayTimeoutMilliseconds: number
  readonly leaseTtlMilliseconds: number
  readonly outboxPumpIntervalMilliseconds: number
  readonly healthHost: '0.0.0.0' | '127.0.0.1'
  readonly healthPort: number
}

export type WorkerBootstrapConfiguration = Readonly<
  Pick<WorkerServerConfiguration, 'databaseUrl' | 'repositoryRoot' | 'applicationVersion'> & {
    readonly profile: 'local-fixture'
  }
>

export class WorkerConfigurationError extends Error {
  public override readonly name = 'WorkerConfigurationError'
}

export function parseWorkerServerConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): WorkerServerConfiguration {
  const evidenceEnvironment = oneOf(
    environment.TRASH_PALACE_ENVIRONMENT ?? 'local',
    ['evaluation', 'hosted_demo', 'local'] as const,
    'TRASH_PALACE_ENVIRONMENT',
  )
  const evidenceOrigin = oneOf(
    environment.TRASH_PALACE_EVIDENCE_ORIGIN ?? originFor(evidenceEnvironment),
    ['evaluation', 'fixture', 'live'] as const,
    'TRASH_PALACE_EVIDENCE_ORIGIN',
  )
  assertCompatibleEvidenceOrigin(evidenceEnvironment, evidenceOrigin)
  const domainClock = flagshipClockConfiguration(environment)
  const applicationTransportFault = applicationTransportFaultConfiguration(environment, {
    evidenceEnvironment,
    evidenceOrigin,
    domainClock,
  })
  const decisionProvider = decisionProviderConfiguration(environment)
  const toolInvocationScopeKey = secretKey(
    required(environment, 'TOOL_INVOCATION_SCOPE_KEY'),
    'TOOL_INVOCATION_SCOPE_KEY',
  )
  const evidenceAliasKey = secretKey(
    required(environment, 'TRASH_PALACE_EVIDENCE_ALIAS_KEY'),
    'TRASH_PALACE_EVIDENCE_ALIAS_KEY',
  )
  if (toolInvocationScopeKey === evidenceAliasKey) {
    throw configuration('Tool scoping and evidence aliasing require independent secrets')
  }

  return Object.freeze({
    databaseUrl: postgresUrl(required(environment, 'DATABASE_URL')),
    workerId: workerId(required(environment, 'TRASH_PALACE_WORKER_ID')),
    serviceActorId: UserIdSchema.parse(
      required(environment, 'TRASH_PALACE_WORKER_SERVICE_ACTOR_ID'),
    ),
    toolInvocationScopeKey,
    evidenceAliasKey,
    evidenceSinkPath: absoluteFilePath(
      required(environment, 'TRASH_PALACE_EVIDENCE_SINK_PATH'),
      'TRASH_PALACE_EVIDENCE_SINK_PATH',
      '.jsonl',
    ),
    repositoryRoot: absoluteDirectoryPath(
      required(environment, 'TRASH_PALACE_REPOSITORY_ROOT'),
      'TRASH_PALACE_REPOSITORY_ROOT',
    ),
    applicationVersion: semver(
      environment.TRASH_PALACE_APP_VERSION ?? '0.0.0',
      'TRASH_PALACE_APP_VERSION',
    ),
    evidenceEnvironment,
    evidenceOrigin,
    decisionProvider,
    domainClock,
    applicationTransportFault,
    gatewayTimeoutMilliseconds: integerInRange(
      environment.TRASH_PALACE_GATEWAY_TIMEOUT_MS ?? '10000',
      'TRASH_PALACE_GATEWAY_TIMEOUT_MS',
      100,
      30_000,
    ),
    leaseTtlMilliseconds: integerInRange(
      environment.TRASH_PALACE_MISSION_LEASE_TTL_MS ?? '30000',
      'TRASH_PALACE_MISSION_LEASE_TTL_MS',
      1_000,
      5 * 60_000,
    ),
    outboxPumpIntervalMilliseconds: integerInRange(
      environment.TRASH_PALACE_OUTBOX_PUMP_INTERVAL_MS ??
        (domainClock.mode === 'fixture' ? '25' : '250'),
      'TRASH_PALACE_OUTBOX_PUMP_INTERVAL_MS',
      10,
      5_000,
    ),
    healthHost: oneOf(
      environment.TRASH_PALACE_WORKER_HEALTH_HOST ?? '0.0.0.0',
      ['0.0.0.0', '127.0.0.1'] as const,
      'TRASH_PALACE_WORKER_HEALTH_HOST',
    ),
    healthPort: integerInRange(
      environment.TRASH_PALACE_WORKER_HEALTH_PORT ?? '4320',
      'TRASH_PALACE_WORKER_HEALTH_PORT',
      1_024,
      65_535,
    ),
  })
}

function decisionProviderConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): CaretakerDecisionProviderConfiguration {
  const kind = oneOf(
    environment.TRASH_PALACE_CARETAKER_PROVIDER ?? 'deterministic',
    ['deterministic', 'claude'] as const,
    'TRASH_PALACE_CARETAKER_PROVIDER',
  )
  if (kind === 'deterministic') return Object.freeze({ kind })

  const maximumCostUsdPerDecision = positiveNumberInRange(
    required(environment, 'TRASH_PALACE_CLAUDE_MAX_COST_USD_PER_DECISION'),
    'TRASH_PALACE_CLAUDE_MAX_COST_USD_PER_DECISION',
    0.0001,
    10,
  )
  return Object.freeze({
    kind,
    apiKey: required(environment, 'ANTHROPIC_API_KEY'),
    authorization: Object.freeze({
      authorizationId: stableAuthorizationId(
        required(environment, 'TRASH_PALACE_LIVE_MODEL_AUTHORIZATION_ID'),
      ),
      maximumCostUsdPerDecision,
    }),
  })
}

function applicationTransportFaultConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  runtime: Readonly<{
    evidenceEnvironment: WorkerEvidenceEnvironment
    evidenceOrigin: WorkerEvidenceOrigin
    domainClock: FlagshipClockConfiguration
  }>,
): ApplicationTransportFaultConfiguration {
  const labMode = optionalBoolean(environment.TRASH_PALACE_LAB_MODE, 'TRASH_PALACE_LAB_MODE')
  const fault = environment.TRASH_PALACE_APPLICATION_TRANSPORT_FAULT
  const organizationId = environment.TRASH_PALACE_APPLICATION_TRANSPORT_FAULT_ORGANIZATION_ID
  if (fault === undefined) {
    if (organizationId !== undefined) {
      throw configuration(
        'TRASH_PALACE_APPLICATION_TRANSPORT_FAULT_ORGANIZATION_ID requires an application transport fault',
      )
    }
    return Object.freeze({ kind: 'none' })
  }
  if (fault !== 'application_commit_then_response_lost') {
    throw configuration('TRASH_PALACE_APPLICATION_TRANSPORT_FAULT is invalid')
  }
  if (!labMode) {
    throw configuration('Application transport faults require TRASH_PALACE_LAB_MODE=true')
  }
  if (
    runtime.evidenceEnvironment === 'hosted_demo' ||
    runtime.evidenceOrigin === 'live' ||
    runtime.domainClock.mode !== 'fixture'
  ) {
    throw configuration(
      'Application transport faults require a local or evaluation fixture-clock runtime',
    )
  }
  return Object.freeze({
    kind: fault,
    organizationId: OrganizationIdSchema.parse(
      required(environment, 'TRASH_PALACE_APPLICATION_TRANSPORT_FAULT_ORGANIZATION_ID'),
    ),
  })
}

function flagshipClockConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): FlagshipClockConfiguration {
  const mode = oneOf(
    environment.TRASH_PALACE_CLOCK_MODE ?? 'system',
    ['system', 'fixture'] as const,
    'TRASH_PALACE_CLOCK_MODE',
  )
  const realStartAt = environment.TRASH_PALACE_FIXTURE_REAL_START_AT
  if (mode === 'system') {
    if (realStartAt !== undefined) {
      throw configuration(
        'TRASH_PALACE_FIXTURE_REAL_START_AT is only valid when TRASH_PALACE_CLOCK_MODE=fixture',
      )
    }
    return Object.freeze({ mode })
  }
  return Object.freeze({
    mode,
    realStartAt: isoInstant(
      required(environment, 'TRASH_PALACE_FIXTURE_REAL_START_AT'),
      'TRASH_PALACE_FIXTURE_REAL_START_AT',
    ),
  })
}

/** Parses only the values consumed by the migration and canonical local-data bootstrap. */
export function parseWorkerBootstrapConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): WorkerBootstrapConfiguration {
  return Object.freeze({
    profile: oneOf(
      required(environment, 'TRASH_PALACE_BOOTSTRAP_PROFILE'),
      ['local-fixture'] as const,
      'TRASH_PALACE_BOOTSTRAP_PROFILE',
    ),
    databaseUrl: postgresUrl(required(environment, 'DATABASE_URL')),
    repositoryRoot: absoluteDirectoryPath(
      required(environment, 'TRASH_PALACE_REPOSITORY_ROOT'),
      'TRASH_PALACE_REPOSITORY_ROOT',
    ),
    applicationVersion: semver(
      environment.TRASH_PALACE_APP_VERSION ?? '0.0.0',
      'TRASH_PALACE_APP_VERSION',
    ),
  })
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]
  if (value === undefined || value.trim().length === 0) {
    throw configuration(`${name} is required`)
  }
  if (value !== value.trim() || value.includes('\u0000')) {
    throw configuration(`${name} is malformed`)
  }
  return value
}

function postgresUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw configuration('DATABASE_URL must be a PostgreSQL URL')
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname.length === 0 ||
    parsed.pathname.length < 2 ||
    parsed.hash.length > 0
  ) {
    throw configuration('DATABASE_URL must be a PostgreSQL URL')
  }
  return value
}

function workerId(value: string): string {
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(value)) {
    throw configuration('TRASH_PALACE_WORKER_ID is malformed')
  }
  return value
}

function secretKey(value: string, name: string): string {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes < 32 || bytes > 4_096) {
    throw configuration(`${name} must contain between 32 and 4096 bytes`)
  }
  return value
}

function absoluteFilePath(value: string, name: string, extension: string): string {
  const path = absolutePath(value, name)
  if (!path.endsWith(extension)) throw configuration(`${name} must end with ${extension}`)
  return path
}

function absoluteDirectoryPath(value: string, name: string): string {
  const path = absolutePath(value, name)
  if (path === '/') throw configuration(`${name} cannot be the filesystem root`)
  return path
}

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || resolve(value) !== value) {
    throw configuration(`${name} must be a normalized absolute path`)
  }
  return value
}

function semver(value: string, name: string): string {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw configuration(`${name} must be semantic version text`)
  }
  return value
}

function stableAuthorizationId(value: string): string {
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(value)) {
    throw configuration('TRASH_PALACE_LIVE_MODEL_AUTHORIZATION_ID is malformed')
  }
  return value
}

function positiveNumberInRange(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw configuration(`${name} must be between ${minimum} and ${maximum}`)
  }
  return parsed
}

function isoInstant(value: string, name: string): string {
  const parsed = IsoDateTimeSchema.safeParse(value)
  if (!parsed.success) {
    throw configuration(`${name} must be an ISO 8601 instant with a timezone`)
  }
  return parsed.data
}

function integerInRange(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw configuration(`${name} must be an integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw configuration(`${name} must be between ${minimum} and ${maximum}`)
  }
  return parsed
}

function optionalBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  throw configuration(`${name} must be true or false`)
}

function oneOf<const Values extends readonly string[]>(
  value: string,
  values: Values,
  name: string,
): Values[number] {
  if (!values.includes(value)) throw configuration(`${name} is invalid`)
  return value
}

function originFor(environment: WorkerEvidenceEnvironment): WorkerEvidenceOrigin {
  if (environment === 'evaluation') return 'evaluation'
  if (environment === 'hosted_demo') return 'live'
  return 'fixture'
}

function assertCompatibleEvidenceOrigin(
  environment: WorkerEvidenceEnvironment,
  origin: WorkerEvidenceOrigin,
): void {
  const expected = originFor(environment)
  if (origin !== expected) {
    throw configuration('TRASH_PALACE_EVIDENCE_ORIGIN does not match TRASH_PALACE_ENVIRONMENT')
  }
}

function configuration(message: string): WorkerConfigurationError {
  return new WorkerConfigurationError(message)
}

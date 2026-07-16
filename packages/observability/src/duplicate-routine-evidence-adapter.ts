import { createHash } from 'node:crypto'

import {
  AttemptIdSchema,
  EventIdSchema,
  MissionIdSchema,
  OperationIdSchema,
  OrganizationIdSchema,
  PlanActionIdSchema,
  PlanIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  RunIdSchema,
  VerificationIdSchema,
} from '@trash-palace/core'
import { z } from 'zod'

import { canonicalJson } from './canonical.js'
import { parseSafeEvidenceEvent, type SafeEvidenceEvent } from './contracts.js'
import {
  DuplicateRoutineMeasurementInputSchema,
  type DuplicateRoutineMeasurementInput,
} from './duplicate-routine-measurement.js'
import type { AnalyticsAliaser } from './identifiers.js'
import { assertPublicationSafe } from './redaction.js'

const IsoTimestampSchema = z.iso.datetime({ offset: true })
const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const PrivateLedgerIdentifierSchema = z.string().min(8).max(128)

const LedgerBindingFields = {
  organizationId: OrganizationIdSchema,
  missionId: MissionIdSchema,
  planId: PlanIdSchema,
  planActionId: PlanActionIdSchema,
} as const

const PostgresActivationIntentProjectionSchema = z
  .object({
    ...LedgerBindingFields,
    activationIntentId: PrivateLedgerIdentifierSchema,
    runId: RunIdSchema,
    actionKind: z.literal('replace_homecoming_routine'),
    requestedAt: IsoTimestampSchema,
  })
  .strict()

const PostgresOperationProjectionSchema = z
  .object({
    ...LedgerBindingFields,
    id: OperationIdSchema,
    status: z.enum(['pending', 'claimed', 'committed', 'failed', 'cancelled']),
    createdAt: IsoTimestampSchema,
    committedAt: IsoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((operation, context) => {
    if ((operation.status === 'committed') !== (operation.committedAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['committedAt'],
        message: 'Only a committed operation has a commit timestamp',
      })
    }
  })

const PostgresAttemptProjectionSchema = z
  .object({
    id: AttemptIdSchema,
    organizationId: OrganizationIdSchema,
    operationId: OperationIdSchema,
    sequence: z.number().int().positive(),
    transport: z.enum(['http', 'mcp', 'worker', 'gateway']),
    status: z.enum(['pending', 'succeeded', 'unknown', 'failed']),
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if ((attempt.status === 'pending') !== (attempt.completedAt === null)) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Only a pending attempt omits its completion timestamp',
      })
    }
  })

const PostgresActiveRoutineProjectionSchema = z
  .object({
    id: RoutineVersionIdSchema,
    routineId: RoutineIdSchema,
    organizationId: OrganizationIdSchema,
    sourcePlanId: PlanIdSchema,
    sourceOperationId: OperationIdSchema,
    status: z.enum(['active', 'inactive']),
    createdAt: IsoTimestampSchema,
  })
  .strict()

const PostgresVerificationProjectionSchema = z
  .object({
    id: VerificationIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    status: z.enum(['passed', 'failed']),
    assertionResults: z.array(z.boolean()).min(1),
    completedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((verification, context) => {
    const passed = verification.assertionResults.every(Boolean)
    if ((verification.status === 'passed') !== passed) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Verification status must agree with its assertion results',
      })
    }
  })

const PostgresReconciliationProjectionSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    operationId: OperationIdSchema,
    sequence: z.number().int().positive(),
    resolution: z.enum(['committed', 'definitely_absent', 'still_unknown', 'failed']),
    occurredAt: IsoTimestampSchema,
  })
  .strict()

/**
 * A bounded query projection over the authoritative PostgreSQL ledger. It intentionally excludes
 * payloads, error messages, objective text, credentials, and arbitrary JSON columns.
 */
export const PostgresDuplicateRoutineLedgerSchema = z
  .object({
    schemaVersion: z.literal('duplicate-routine-postgres-ledger@1'),
    source: z.literal('postgresql_projection'),
    control: z.enum(['broken', 'corrected']),
    fixtureCohortHash: ContentHashSchema,
    window: z
      .object({
        startedAt: IsoTimestampSchema,
        endedAt: IsoTimestampSchema,
      })
      .strict(),
    activationIntent: PostgresActivationIntentProjectionSchema,
    operations: z.array(PostgresOperationProjectionSchema).min(1),
    attempts: z.array(PostgresAttemptProjectionSchema).min(1),
    routineVersions: z.array(PostgresActiveRoutineProjectionSchema).min(1),
    verifications: z.array(PostgresVerificationProjectionSchema),
    reconciliationPolls: z.array(PostgresReconciliationProjectionSchema),
  })
  .strict()

export type PostgresDuplicateRoutineLedger = z.infer<typeof PostgresDuplicateRoutineLedgerSchema>

export type DuplicateRoutineEvidenceAdapterErrorCode =
  | 'cross_tenant_binding'
  | 'invalid_jsonl'
  | 'mismatched_plan_action'
  | 'missing_jsonl_generation'
  | 'missing_operation'

export class DuplicateRoutineEvidenceAdapterError extends Error {
  public constructor(
    public readonly code: DuplicateRoutineEvidenceAdapterErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DuplicateRoutineEvidenceAdapterError'
  }
}

export interface DuplicateRoutineEvidenceSources {
  readonly ledger: unknown
  readonly evidenceJsonl: string
  readonly aliaser: AnalyticsAliaser
}

type GenerationEvidenceEvent = Extract<
  SafeEvidenceEvent,
  { readonly kind: 'ai'; readonly event: '$ai_generation' }
>

function isGenerationEvidenceEvent(event: SafeEvidenceEvent): event is GenerationEvidenceEvent {
  return event.kind === 'ai' && event.event === '$ai_generation'
}

function measurementEventId(
  aliaser: AnalyticsAliaser,
  control: 'broken' | 'corrected',
  collection: string,
  privateIdentity: string,
) {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion: 'duplicate-routine-measurement-identity@1',
        control,
        collection,
        privateIdentity,
      }),
    )
    .digest('hex')
    .slice(0, 24)
  return aliaser.insertId('measurement record', EventIdSchema.parse(`evt_measure_${digest}`))
}

function parseJsonl(input: string): readonly SafeEvidenceEvent[] {
  if (input.trim().length === 0) return []

  return input
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return parseSafeEvidenceEvent(JSON.parse(line) as unknown)
      } catch {
        throw new DuplicateRoutineEvidenceAdapterError(
          'invalid_jsonl',
          `Local evidence line ${index + 1} is not a valid analytics-safe event`,
        )
      }
    })
}

function assertLedgerRelationships(ledger: PostgresDuplicateRoutineLedger): void {
  const binding = ledger.activationIntent
  const operations = new Map(ledger.operations.map((operation) => [operation.id, operation]))

  for (const operation of ledger.operations) {
    if (operation.organizationId !== binding.organizationId) {
      throw new DuplicateRoutineEvidenceAdapterError(
        'cross_tenant_binding',
        'An operation crosses the activation-intent tenant boundary',
      )
    }
    if (
      operation.missionId !== binding.missionId ||
      operation.planId !== binding.planId ||
      operation.planActionId !== binding.planActionId
    ) {
      throw new DuplicateRoutineEvidenceAdapterError(
        'mismatched_plan_action',
        'An operation is not bound to the measured mission and plan action',
      )
    }
  }

  for (const attempt of ledger.attempts) {
    const operation = operations.get(attempt.operationId)
    if (operation === undefined) {
      throw new DuplicateRoutineEvidenceAdapterError(
        'missing_operation',
        'An attempt references an operation outside the bounded ledger projection',
      )
    }
    if (attempt.organizationId !== operation.organizationId) {
      throw new DuplicateRoutineEvidenceAdapterError(
        'cross_tenant_binding',
        'An attempt crosses its operation tenant boundary',
      )
    }
  }

  for (const routine of ledger.routineVersions) {
    const operation = operations.get(routine.sourceOperationId)
    if (operation === undefined) {
      throw new DuplicateRoutineEvidenceAdapterError(
        'missing_operation',
        'A routine outcome references an operation outside the bounded ledger projection',
      )
    }
    if (routine.organizationId !== binding.organizationId) {
      throw new DuplicateRoutineEvidenceAdapterError(
        'cross_tenant_binding',
        'A routine outcome crosses the activation-intent tenant boundary',
      )
    }
    if (routine.sourcePlanId !== binding.planId) {
      throw new DuplicateRoutineEvidenceAdapterError(
        'mismatched_plan_action',
        'A routine outcome is not bound to the measured plan',
      )
    }
  }

  for (const verification of ledger.verifications) {
    if (verification.organizationId !== binding.organizationId) {
      throw new DuplicateRoutineEvidenceAdapterError(
        'cross_tenant_binding',
        'A verifier result crosses the activation-intent tenant boundary',
      )
    }
    if (verification.missionId !== binding.missionId) {
      throw new DuplicateRoutineEvidenceAdapterError(
        'mismatched_plan_action',
        'A verifier result is not bound to the measured mission',
      )
    }
  }

  for (const poll of ledger.reconciliationPolls) {
    const operation = operations.get(poll.operationId)
    if (operation === undefined) {
      throw new DuplicateRoutineEvidenceAdapterError(
        'missing_operation',
        'A reconciliation poll references an operation outside the bounded ledger projection',
      )
    }
    if (poll.organizationId !== operation.organizationId) {
      throw new DuplicateRoutineEvidenceAdapterError(
        'cross_tenant_binding',
        'A reconciliation poll crosses its operation tenant boundary',
      )
    }
  }
}

function measurementTransport(
  transport: 'http' | 'mcp' | 'worker' | 'gateway',
): 'http' | 'in_process' | 'gateway' {
  if (transport === 'gateway') return 'gateway'
  if (transport === 'worker') return 'in_process'
  return 'http'
}

function measurementOperationOutcome(
  operation: PostgresDuplicateRoutineLedger['operations'][number],
  attempts: readonly PostgresDuplicateRoutineLedger['attempts'][number][],
): 'pending' | 'committed' | 'failed' | 'unknown' {
  if (operation.status === 'committed') return 'committed'
  if (operation.status === 'failed' || operation.status === 'cancelled') return 'failed'
  if (attempts.some((attempt) => attempt.status === 'unknown')) return 'unknown'
  return 'pending'
}

function measurementAttemptOutcome(
  status: 'pending' | 'succeeded' | 'unknown' | 'failed',
): 'committed' | 'failed' | 'unknown' {
  if (status === 'succeeded') return 'committed'
  if (status === 'unknown') return 'unknown'
  return 'failed'
}

function reconciliationResolution(
  resolution: 'committed' | 'definitely_absent' | 'still_unknown' | 'failed',
): 'committed' | 'absent_retrying' | 'still_unknown' | 'failed' {
  return resolution === 'definitely_absent' ? 'absent_retrying' : resolution
}

function durationBetween(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
}

/**
 * Converts bounded authoritative ledger rows and a strict local JSONL trace into the public-safe
 * measurement normal form. Raw identifiers exist only at this adapter boundary.
 */
export function createDuplicateRoutineMeasurementInputFromEvidence(
  sources: DuplicateRoutineEvidenceSources,
): DuplicateRoutineMeasurementInput {
  const ledger = PostgresDuplicateRoutineLedgerSchema.parse(sources.ledger)
  assertLedgerRelationships(ledger)
  const events = parseJsonl(sources.evidenceJsonl)
  const binding = ledger.activationIntent
  const aliaser = sources.aliaser
  const reference = {
    organizationAlias: aliaser.alias('organization', binding.organizationId),
    missionAlias: aliaser.alias('mission', binding.missionId),
    activationIntentAlias: aliaser.alias('activation_intent', binding.activationIntentId),
    planAlias: aliaser.alias('plan', binding.planId),
    planActionAlias: aliaser.alias('plan_action', binding.planActionId),
  } as const
  const expectedRunAlias = aliaser.alias('run', binding.runId)
  const attemptsByOperation = new Map<string, typeof ledger.attempts>()
  for (const operation of ledger.operations) {
    attemptsByOperation.set(
      operation.id,
      ledger.attempts.filter((attempt) => attempt.operationId === operation.id),
    )
  }

  const generationEvents = events
    .filter(isGenerationEvidenceEvent)
    .filter(
      (event) =>
        event.properties.organization_alias === reference.organizationAlias &&
        event.properties.mission_alias === reference.missionAlias &&
        event.properties.run_alias === expectedRunAlias,
    )
  if (generationEvents.length === 0) {
    throw new DuplicateRoutineEvidenceAdapterError(
      'missing_jsonl_generation',
      'The bounded local JSONL trace has no generation for the measured mission run',
    )
  }
  const activeRoutines = ledger.routineVersions.filter((routine) => routine.status === 'active')
  const latestActivationAt = activeRoutines.reduce(
    (latest, routine) =>
      Date.parse(routine.createdAt) > Date.parse(latest) ? routine.createdAt : latest,
    binding.requestedAt,
  )

  const input = DuplicateRoutineMeasurementInputSchema.parse({
    schemaVersion: 'duplicate-routine-measurement-input@1',
    evidenceBasis: 'credential_free_deterministic_fixture',
    scenario: 'two_routines_one_timeout',
    fixtureCohortHash: ledger.fixtureCohortHash,
    control: ledger.control,
    window: ledger.window,
    activationIntents: [
      {
        evidenceId: measurementEventId(
          aliaser,
          ledger.control,
          'activation-intent',
          binding.activationIntentId,
        ),
        observedAt: binding.requestedAt,
        ...reference,
        intentKind: 'activate_homecoming_routine',
      },
    ],
    planActions: [
      {
        evidenceId: measurementEventId(
          aliaser,
          ledger.control,
          'plan-action',
          binding.planActionId,
        ),
        observedAt: binding.requestedAt,
        ...reference,
        actionKind: binding.actionKind,
      },
    ],
    operations: ledger.operations.map((operation) => {
      const attempts = attemptsByOperation.get(operation.id) ?? []
      return {
        evidenceId: measurementEventId(aliaser, ledger.control, 'operation', operation.id),
        observedAt: operation.committedAt ?? operation.createdAt,
        ...reference,
        operationAlias: aliaser.alias('operation', operation.id),
        outcome: measurementOperationOutcome(operation, attempts),
      }
    }),
    attempts: ledger.attempts.map((attempt) => {
      const operation = ledger.operations.find((candidate) => candidate.id === attempt.operationId)
      if (operation === undefined) {
        throw new DuplicateRoutineEvidenceAdapterError(
          'missing_operation',
          'An attempt references an operation outside the bounded ledger projection',
        )
      }
      return {
        evidenceId: measurementEventId(aliaser, ledger.control, 'attempt', attempt.id),
        observedAt: attempt.completedAt ?? attempt.startedAt,
        ...reference,
        operationAlias: aliaser.alias('operation', operation.id),
        attemptAlias: aliaser.alias('attempt', attempt.id),
        sequence: attempt.sequence,
        transport: measurementTransport(attempt.transport),
        outcome: measurementAttemptOutcome(attempt.status),
      }
    }),
    activeDurableRoutineOutcomes: activeRoutines.map((routine) => ({
      evidenceId: measurementEventId(aliaser, ledger.control, 'routine-version', routine.id),
      observedAt: ledger.window.endedAt,
      ...reference,
      operationAlias: aliaser.alias('operation', routine.sourceOperationId),
      resourceAlias: aliaser.alias('resource', routine.routineId),
      activatedAt: routine.createdAt,
      durability: 'database',
      stateAtWindowEnd: 'active',
    })),
    verifierResults: ledger.verifications.map((verification) => ({
      evidenceId: measurementEventId(aliaser, ledger.control, 'verification', verification.id),
      observedAt: verification.completedAt,
      ...reference,
      verificationAlias: aliaser.alias('verification', verification.id),
      passed: verification.status === 'passed',
      assertionCount: verification.assertionResults.length,
      failedAssertionCount: verification.assertionResults.filter((passed) => !passed).length,
    })),
    activationLatencies: [
      {
        evidenceId: measurementEventId(
          aliaser,
          ledger.control,
          'activation-latency',
          binding.planActionId,
        ),
        observedAt: latestActivationAt,
        ...reference,
        latencyAlias: aliaser.alias('latency', `${ledger.control}:${binding.planActionId}`),
        durationMs: durationBetween(binding.requestedAt, latestActivationAt),
      },
    ],
    reconciliations: ledger.reconciliationPolls.map((poll) => {
      const unknownAttempt = ledger.attempts
        .filter(
          (attempt) =>
            attempt.operationId === poll.operationId &&
            attempt.status === 'unknown' &&
            attempt.completedAt !== null &&
            Date.parse(attempt.completedAt) <= Date.parse(poll.occurredAt),
        )
        .sort(
          (left, right) => Date.parse(right.completedAt ?? '') - Date.parse(left.completedAt ?? ''),
        )[0]
      if (unknownAttempt?.completedAt === null || unknownAttempt === undefined) {
        throw new DuplicateRoutineEvidenceAdapterError(
          'mismatched_plan_action',
          'A reconciliation poll has no prior unknown attempt in the bounded ledger projection',
        )
      }
      return {
        evidenceId: measurementEventId(
          aliaser,
          ledger.control,
          'reconciliation',
          `${poll.operationId}:${poll.sequence}`,
        ),
        observedAt: poll.occurredAt,
        ...reference,
        operationAlias: aliaser.alias('operation', poll.operationId),
        reconciliationAlias: aliaser.alias(
          'reconciliation',
          `${poll.operationId}:${poll.sequence}`,
        ),
        resolution: reconciliationResolution(poll.resolution),
        durationMs: durationBetween(unknownAttempt.completedAt, poll.occurredAt),
      }
    }),
    cancellationSafetyChecks: [],
    userInterventions: [],
    modelCosts: generationEvents.map((event) => ({
      evidenceId: event.insertId,
      observedAt: event.occurredAt,
      ...reference,
      generationAlias: aliaser.alias('generation', event.insertId),
      inputTokens: event.properties.$ai_input_tokens,
      outputTokens: event.properties.$ai_output_tokens,
      totalCostUsd: event.properties.$ai_total_cost_usd ?? 0,
    })),
  })
  assertPublicationSafe(input)
  return input
}

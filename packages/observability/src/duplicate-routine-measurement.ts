import { createHash } from 'node:crypto'

import { z } from 'zod'

import { canonicalJson, type JsonValue } from './canonical.js'
import { AnalyticsAliasSchema, StableInsertIdSchema } from './identifiers.js'
import { assertPublicationSafe } from './redaction.js'

const IsoTimestampSchema = z.iso.datetime({ offset: true })
const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const CountSchema = z.number().int().nonnegative()
const DurationMillisecondsSchema = z.number().nonnegative()
const CostUsdSchema = z.number().nonnegative()

function aliasFor(namespace: string): typeof AnalyticsAliasSchema {
  return AnalyticsAliasSchema.refine((value) => value.startsWith(`tpa_${namespace}_v1_`), {
    message: `Expected an analytics-safe ${namespace} alias`,
  })
}

const OrganizationAliasSchema = aliasFor('organization')
const MissionAliasSchema = aliasFor('mission')
const ActivationIntentAliasSchema = aliasFor('activation_intent')
const PlanAliasSchema = aliasFor('plan')
const PlanActionAliasSchema = aliasFor('plan_action')
const OperationAliasSchema = aliasFor('operation')
const AttemptAliasSchema = aliasFor('attempt')
const ResourceAliasSchema = aliasFor('resource')
const VerificationAliasSchema = aliasFor('verification')
const LatencyAliasSchema = aliasFor('latency')
const ReconciliationAliasSchema = aliasFor('reconciliation')
const CancellationAliasSchema = aliasFor('cancellation')
const InterventionAliasSchema = aliasFor('intervention')
const GenerationAliasSchema = aliasFor('generation')

const EvidenceIdentityFields = {
  evidenceId: StableInsertIdSchema,
  observedAt: IsoTimestampSchema,
} as const

const PlanActionReferenceFields = {
  organizationAlias: OrganizationAliasSchema,
  missionAlias: MissionAliasSchema,
  activationIntentAlias: ActivationIntentAliasSchema,
  planAlias: PlanAliasSchema,
  planActionAlias: PlanActionAliasSchema,
} as const

export const MeasurementWindowSchema = z
  .object({
    startedAt: IsoTimestampSchema,
    endedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((window, context) => {
    if (Date.parse(window.endedAt) <= Date.parse(window.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'The measurement window must end after it starts',
      })
    }
  })

export const NormalizedActivationIntentSchema = z
  .object({
    ...EvidenceIdentityFields,
    ...PlanActionReferenceFields,
    intentKind: z.literal('activate_homecoming_routine'),
  })
  .strict()

export const PlanActionIdentitySchema = z
  .object({
    ...EvidenceIdentityFields,
    ...PlanActionReferenceFields,
    actionKind: z.literal('replace_homecoming_routine'),
  })
  .strict()

export const MeasurementOperationSchema = z
  .object({
    ...EvidenceIdentityFields,
    ...PlanActionReferenceFields,
    operationAlias: OperationAliasSchema,
    outcome: z.enum(['pending', 'committed', 'failed', 'unknown']),
  })
  .strict()

export const MeasurementAttemptSchema = z
  .object({
    ...EvidenceIdentityFields,
    ...PlanActionReferenceFields,
    operationAlias: OperationAliasSchema,
    attemptAlias: AttemptAliasSchema,
    sequence: CountSchema.min(1),
    transport: z.enum(['in_process', 'http', 'gateway']),
    outcome: z.enum(['committed', 'failed', 'unknown']),
  })
  .strict()

export const ActiveDurableRoutineOutcomeSchema = z
  .object({
    ...EvidenceIdentityFields,
    ...PlanActionReferenceFields,
    operationAlias: OperationAliasSchema,
    resourceAlias: ResourceAliasSchema,
    activatedAt: IsoTimestampSchema,
    durability: z.literal('database'),
    stateAtWindowEnd: z.literal('active'),
  })
  .strict()

export const VerifierResultEvidenceSchema = z
  .object({
    ...EvidenceIdentityFields,
    ...PlanActionReferenceFields,
    verificationAlias: VerificationAliasSchema,
    passed: z.boolean(),
    assertionCount: CountSchema.min(1),
    failedAssertionCount: CountSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.failedAssertionCount > result.assertionCount) {
      context.addIssue({
        code: 'custom',
        path: ['failedAssertionCount'],
        message: 'Failed assertions cannot exceed all assertions',
      })
    }
    if (result.passed !== (result.failedAssertionCount === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['passed'],
        message: 'Verifier pass state must agree with failed assertion count',
      })
    }
  })

export const ActivationLatencyEvidenceSchema = z
  .object({
    ...EvidenceIdentityFields,
    ...PlanActionReferenceFields,
    latencyAlias: LatencyAliasSchema,
    durationMs: DurationMillisecondsSchema,
  })
  .strict()

export const ReconciliationEvidenceSchema = z
  .object({
    ...EvidenceIdentityFields,
    ...PlanActionReferenceFields,
    operationAlias: OperationAliasSchema,
    reconciliationAlias: ReconciliationAliasSchema,
    resolution: z.enum(['committed', 'absent_retrying', 'still_unknown', 'failed']),
    durationMs: DurationMillisecondsSchema,
  })
  .strict()

export const CancellationSafetyEvidenceSchema = z
  .object({
    ...EvidenceIdentityFields,
    ...PlanActionReferenceFields,
    cancellationAlias: CancellationAliasSchema,
    checkpoint: z.enum([
      'before_dispatch',
      'after_dispatch_before_commit',
      'after_commit_before_callback',
      'after_callback',
    ]),
    passed: z.boolean(),
  })
  .strict()

export const UserInterventionEvidenceSchema = z
  .object({
    ...EvidenceIdentityFields,
    ...PlanActionReferenceFields,
    interventionAlias: InterventionAliasSchema,
    kind: z.enum(['manual_duplicate_cleanup', 'plan_edited', 'plan_rejected', 'manual_correction']),
  })
  .strict()

export const ModelCostEvidenceSchema = z
  .object({
    ...EvidenceIdentityFields,
    ...PlanActionReferenceFields,
    generationAlias: GenerationAliasSchema,
    inputTokens: CountSchema,
    outputTokens: CountSchema,
    totalCostUsd: CostUsdSchema,
  })
  .strict()

export const DuplicateRoutineMeasurementInputSchema = z
  .object({
    schemaVersion: z.literal('duplicate-routine-measurement-input@1'),
    evidenceBasis: z.literal('credential_free_deterministic_fixture'),
    scenario: z.literal('two_routines_one_timeout'),
    fixtureCohortHash: ContentHashSchema,
    control: z.enum(['broken', 'corrected']),
    window: MeasurementWindowSchema,
    activationIntents: z.array(NormalizedActivationIntentSchema),
    planActions: z.array(PlanActionIdentitySchema),
    operations: z.array(MeasurementOperationSchema),
    attempts: z.array(MeasurementAttemptSchema),
    activeDurableRoutineOutcomes: z.array(ActiveDurableRoutineOutcomeSchema),
    verifierResults: z.array(VerifierResultEvidenceSchema),
    activationLatencies: z.array(ActivationLatencyEvidenceSchema),
    reconciliations: z.array(ReconciliationEvidenceSchema),
    cancellationSafetyChecks: z.array(CancellationSafetyEvidenceSchema),
    userInterventions: z.array(UserInterventionEvidenceSchema),
    modelCosts: z.array(ModelCostEvidenceSchema),
  })
  .strict()

export type DuplicateRoutineMeasurementInput = z.infer<
  typeof DuplicateRoutineMeasurementInputSchema
>

type ActivationIntent = z.infer<typeof NormalizedActivationIntentSchema>
type PlanActionIdentity = z.infer<typeof PlanActionIdentitySchema>
type MeasurementOperation = z.infer<typeof MeasurementOperationSchema>
type MeasurementAttempt = z.infer<typeof MeasurementAttemptSchema>
type ActiveDurableRoutineOutcome = z.infer<typeof ActiveDurableRoutineOutcomeSchema>
type VerifierResultEvidence = z.infer<typeof VerifierResultEvidenceSchema>
type ActivationLatencyEvidence = z.infer<typeof ActivationLatencyEvidenceSchema>
type ReconciliationEvidence = z.infer<typeof ReconciliationEvidenceSchema>
type CancellationSafetyEvidence = z.infer<typeof CancellationSafetyEvidenceSchema>
type UserInterventionEvidence = z.infer<typeof UserInterventionEvidenceSchema>
type ModelCostEvidence = z.infer<typeof ModelCostEvidenceSchema>

type MeasurementCollectionName =
  | 'activationIntents'
  | 'planActions'
  | 'operations'
  | 'attempts'
  | 'activeDurableRoutineOutcomes'
  | 'verifierResults'
  | 'activationLatencies'
  | 'reconciliations'
  | 'cancellationSafetyChecks'
  | 'userInterventions'
  | 'modelCosts'

interface EvidenceRecord {
  readonly evidenceId: string
  readonly observedAt: string
}

interface PlanActionReference {
  readonly organizationAlias: string
  readonly missionAlias: string
  readonly activationIntentAlias: string
  readonly planAlias: string
  readonly planActionAlias: string
}

export type DuplicateRoutineMeasurementErrorCode =
  | 'comparison_mismatch'
  | 'conflicting_evidence_identity'
  | 'cross_tenant_binding'
  | 'mismatched_plan_action'
  | 'missing_reference'
  | 'out_of_window'

export class DuplicateRoutineMeasurementError extends Error {
  public constructor(
    public readonly code: DuplicateRoutineMeasurementErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DuplicateRoutineMeasurementError'
  }
}

function keysOf(schema: { readonly shape: Readonly<Record<string, unknown>> }): readonly string[] {
  return Object.freeze(Object.keys(schema.shape).sort())
}

/**
 * These are the only fields accepted by the credential-free measurement normal form. Raw IDs,
 * prompts, headers, credentials, and arbitrary analytics properties have no input slot.
 */
export const DUPLICATE_ROUTINE_MEASUREMENT_INPUT_ALLOWLISTS = Object.freeze({
  activationIntent: keysOf(NormalizedActivationIntentSchema),
  planAction: keysOf(PlanActionIdentitySchema),
  operation: keysOf(MeasurementOperationSchema),
  attempt: keysOf(MeasurementAttemptSchema),
  activeDurableRoutineOutcome: keysOf(ActiveDurableRoutineOutcomeSchema),
  verifierResult: keysOf(VerifierResultEvidenceSchema),
  activationLatency: keysOf(ActivationLatencyEvidenceSchema),
  reconciliation: keysOf(ReconciliationEvidenceSchema),
  cancellationSafety: keysOf(CancellationSafetyEvidenceSchema),
  userIntervention: keysOf(UserInterventionEvidenceSchema),
  modelCost: keysOf(ModelCostEvidenceSchema),
})

export const CREDENTIAL_FREE_MEASUREMENT_EVIDENCE = Object.freeze({
  basis: 'credential_free_deterministic_fixture',
  reportContract: 'Implemented',
  deterministicMeasurement: 'Deterministic-verified',
  posthogIngestion: 'Blocked',
  liveImprovementLoop: 'Blocked',
} as const)

interface DeduplicatedRecords<RecordType extends EvidenceRecord> {
  readonly records: readonly RecordType[]
  readonly replayedRecordCount: number
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue
}

function semanticCanonical(record: EvidenceRecord): string {
  const { evidenceId: _evidenceId, ...semanticRecord } = record
  return canonicalJson(asJsonValue(semanticRecord))
}

function deduplicateRecords<RecordType extends EvidenceRecord>(
  collection: MeasurementCollectionName,
  records: readonly RecordType[],
  semanticIdentity: (record: RecordType) => string,
): DeduplicatedRecords<RecordType> {
  const byEvidenceId = new Map<string, string>()
  const bySemanticIdentity = new Map<string, string>()
  const unique: RecordType[] = []
  let replayedRecordCount = 0

  for (const record of records) {
    const recordCanonical = canonicalJson(asJsonValue(record))
    const priorEvidence = byEvidenceId.get(record.evidenceId)
    if (priorEvidence !== undefined) {
      if (priorEvidence !== recordCanonical) {
        throw new DuplicateRoutineMeasurementError(
          'conflicting_evidence_identity',
          `${collection} reuses evidence identity ${record.evidenceId} with different data`,
        )
      }
      replayedRecordCount += 1
      continue
    }

    const identity = semanticIdentity(record)
    const semantic = semanticCanonical(record)
    const priorSemantic = bySemanticIdentity.get(identity)
    if (priorSemantic !== undefined) {
      if (priorSemantic !== semantic) {
        throw new DuplicateRoutineMeasurementError(
          'conflicting_evidence_identity',
          `${collection} reuses semantic identity ${identity} with different data`,
        )
      }
      byEvidenceId.set(record.evidenceId, recordCanonical)
      replayedRecordCount += 1
      continue
    }

    byEvidenceId.set(record.evidenceId, recordCanonical)
    bySemanticIdentity.set(identity, semantic)
    unique.push(record)
  }

  return { records: unique, replayedRecordCount }
}

function assertEvidenceIdentitiesDoNotCrossCollections(
  collections: readonly {
    readonly name: MeasurementCollectionName
    readonly records: readonly EvidenceRecord[]
  }[],
): void {
  const owners = new Map<string, MeasurementCollectionName>()
  for (const collection of collections) {
    for (const record of collection.records) {
      const owner = owners.get(record.evidenceId)
      if (owner !== undefined && owner !== collection.name) {
        throw new DuplicateRoutineMeasurementError(
          'conflicting_evidence_identity',
          `Evidence identity ${record.evidenceId} is reused by ${owner} and ${collection.name}`,
        )
      }
      owners.set(record.evidenceId, collection.name)
    }
  }
}

interface NormalizedMeasurementInput {
  readonly input: DuplicateRoutineMeasurementInput
  readonly activationIntents: readonly ActivationIntent[]
  readonly planActions: readonly PlanActionIdentity[]
  readonly operations: readonly MeasurementOperation[]
  readonly attempts: readonly MeasurementAttempt[]
  readonly activeDurableRoutineOutcomes: readonly ActiveDurableRoutineOutcome[]
  readonly verifierResults: readonly VerifierResultEvidence[]
  readonly activationLatencies: readonly ActivationLatencyEvidence[]
  readonly reconciliations: readonly ReconciliationEvidence[]
  readonly cancellationSafetyChecks: readonly CancellationSafetyEvidence[]
  readonly userInterventions: readonly UserInterventionEvidence[]
  readonly modelCosts: readonly ModelCostEvidence[]
  readonly inventory: EvidenceInventory
}

export interface EvidenceCollectionInventory {
  readonly received: number
  readonly unique: number
  readonly replayed: number
}

export interface EvidenceInventory {
  readonly receivedRecordCount: number
  readonly uniqueRecordCount: number
  readonly replayedRecordCount: number
  readonly collections: Readonly<Record<MeasurementCollectionName, EvidenceCollectionInventory>>
}

function normalizeMeasurementInput(input: unknown): NormalizedMeasurementInput {
  const parsed = DuplicateRoutineMeasurementInputSchema.parse(input)
  assertEvidenceIdentitiesDoNotCrossCollections([
    { name: 'activationIntents', records: parsed.activationIntents },
    { name: 'planActions', records: parsed.planActions },
    { name: 'operations', records: parsed.operations },
    { name: 'attempts', records: parsed.attempts },
    { name: 'activeDurableRoutineOutcomes', records: parsed.activeDurableRoutineOutcomes },
    { name: 'verifierResults', records: parsed.verifierResults },
    { name: 'activationLatencies', records: parsed.activationLatencies },
    { name: 'reconciliations', records: parsed.reconciliations },
    { name: 'cancellationSafetyChecks', records: parsed.cancellationSafetyChecks },
    { name: 'userInterventions', records: parsed.userInterventions },
    { name: 'modelCosts', records: parsed.modelCosts },
  ])

  const activationIntents = deduplicateRecords(
    'activationIntents',
    parsed.activationIntents,
    (record) => record.activationIntentAlias,
  )
  const planActions = deduplicateRecords(
    'planActions',
    parsed.planActions,
    (record) => record.planActionAlias,
  )
  const operations = deduplicateRecords(
    'operations',
    parsed.operations,
    (record) => record.operationAlias,
  )
  const attempts = deduplicateRecords('attempts', parsed.attempts, (record) => record.attemptAlias)
  const activeDurableRoutineOutcomes = deduplicateRecords(
    'activeDurableRoutineOutcomes',
    parsed.activeDurableRoutineOutcomes,
    (record) => record.resourceAlias,
  )
  const verifierResults = deduplicateRecords(
    'verifierResults',
    parsed.verifierResults,
    (record) => record.verificationAlias,
  )
  const activationLatencies = deduplicateRecords(
    'activationLatencies',
    parsed.activationLatencies,
    (record) => record.latencyAlias,
  )
  const reconciliations = deduplicateRecords(
    'reconciliations',
    parsed.reconciliations,
    (record) => record.reconciliationAlias,
  )
  const cancellationSafetyChecks = deduplicateRecords(
    'cancellationSafetyChecks',
    parsed.cancellationSafetyChecks,
    (record) => record.cancellationAlias,
  )
  const userInterventions = deduplicateRecords(
    'userInterventions',
    parsed.userInterventions,
    (record) => record.interventionAlias,
  )
  const modelCosts = deduplicateRecords(
    'modelCosts',
    parsed.modelCosts,
    (record) => record.generationAlias,
  )

  const results = {
    activationIntents,
    planActions,
    operations,
    attempts,
    activeDurableRoutineOutcomes,
    verifierResults,
    activationLatencies,
    reconciliations,
    cancellationSafetyChecks,
    userInterventions,
    modelCosts,
  }
  const collections = Object.fromEntries(
    (
      Object.entries(results) as [MeasurementCollectionName, DeduplicatedRecords<EvidenceRecord>][]
    ).map(([name, result]) => [
      name,
      {
        received: parsed[name].length,
        unique: result.records.length,
        replayed: result.replayedRecordCount,
      },
    ]),
  ) as Record<MeasurementCollectionName, EvidenceCollectionInventory>
  const inventory = Object.values(collections).reduce<EvidenceInventory>(
    (aggregate, collection) => ({
      receivedRecordCount: aggregate.receivedRecordCount + collection.received,
      uniqueRecordCount: aggregate.uniqueRecordCount + collection.unique,
      replayedRecordCount: aggregate.replayedRecordCount + collection.replayed,
      collections,
    }),
    {
      receivedRecordCount: 0,
      uniqueRecordCount: 0,
      replayedRecordCount: 0,
      collections,
    },
  )

  const normalized: NormalizedMeasurementInput = {
    input: parsed,
    activationIntents: activationIntents.records,
    planActions: planActions.records,
    operations: operations.records,
    attempts: attempts.records,
    activeDurableRoutineOutcomes: activeDurableRoutineOutcomes.records,
    verifierResults: verifierResults.records,
    activationLatencies: activationLatencies.records,
    reconciliations: reconciliations.records,
    cancellationSafetyChecks: cancellationSafetyChecks.records,
    userInterventions: userInterventions.records,
    modelCosts: modelCosts.records,
    inventory,
  }
  validateMeasurementRelationships(normalized)
  return normalized
}

function assertWithinWindow(
  timestamp: string,
  field: string,
  window: z.infer<typeof MeasurementWindowSchema>,
): void {
  const value = Date.parse(timestamp)
  if (value < Date.parse(window.startedAt) || value > Date.parse(window.endedAt)) {
    throw new DuplicateRoutineMeasurementError(
      'out_of_window',
      `${field} falls outside the declared measurement window`,
    )
  }
}

function assertSamePlanAction(
  record: PlanActionReference,
  binding: PlanActionReference,
  recordLabel: string,
): void {
  if (record.organizationAlias !== binding.organizationAlias) {
    throw new DuplicateRoutineMeasurementError(
      'cross_tenant_binding',
      `${recordLabel} crosses organization boundaries`,
    )
  }
  if (
    record.missionAlias !== binding.missionAlias ||
    record.activationIntentAlias !== binding.activationIntentAlias ||
    record.planAlias !== binding.planAlias ||
    record.planActionAlias !== binding.planActionAlias
  ) {
    throw new DuplicateRoutineMeasurementError(
      'mismatched_plan_action',
      `${recordLabel} is not bound to the referenced activation intent and plan action`,
    )
  }
}

function referencedPlanAction(
  record: PlanActionReference,
  planActions: ReadonlyMap<string, PlanActionIdentity>,
  recordLabel: string,
): PlanActionIdentity {
  const binding = planActions.get(record.planActionAlias)
  if (binding === undefined) {
    throw new DuplicateRoutineMeasurementError(
      'missing_reference',
      `${recordLabel} references an unknown plan action`,
    )
  }
  assertSamePlanAction(record, binding, recordLabel)
  return binding
}

function validateMeasurementRelationships(normalized: NormalizedMeasurementInput): void {
  const window = normalized.input.window
  const collectionRecords: readonly (readonly EvidenceRecord[])[] = [
    normalized.activationIntents,
    normalized.planActions,
    normalized.operations,
    normalized.attempts,
    normalized.activeDurableRoutineOutcomes,
    normalized.verifierResults,
    normalized.activationLatencies,
    normalized.reconciliations,
    normalized.cancellationSafetyChecks,
    normalized.userInterventions,
    normalized.modelCosts,
  ]
  for (const records of collectionRecords) {
    for (const record of records) {
      assertWithinWindow(record.observedAt, 'Evidence observedAt', window)
    }
  }
  for (const routine of normalized.activeDurableRoutineOutcomes) {
    assertWithinWindow(routine.activatedAt, 'Routine activatedAt', window)
  }

  const activationIntents = new Map(
    normalized.activationIntents.map((intent) => [intent.activationIntentAlias, intent]),
  )
  const planActions = new Map(
    normalized.planActions.map((action) => [action.planActionAlias, action]),
  )
  const planOwner = new Map<string, string>()
  const actionCountByIntent = new Map<string, number>()

  for (const action of normalized.planActions) {
    const intent = activationIntents.get(action.activationIntentAlias)
    if (intent === undefined) {
      throw new DuplicateRoutineMeasurementError(
        'missing_reference',
        'Plan action references an unknown activation intent',
      )
    }
    assertSamePlanAction(action, intent, 'Plan action')
    const owner = planOwner.get(action.planAlias)
    if (owner !== undefined && owner !== action.activationIntentAlias) {
      throw new DuplicateRoutineMeasurementError(
        'mismatched_plan_action',
        'One plan is bound to more than one activation intent',
      )
    }
    planOwner.set(action.planAlias, action.activationIntentAlias)
    actionCountByIntent.set(
      action.activationIntentAlias,
      (actionCountByIntent.get(action.activationIntentAlias) ?? 0) + 1,
    )
  }
  for (const intent of normalized.activationIntents) {
    if (actionCountByIntent.get(intent.activationIntentAlias) !== 1) {
      throw new DuplicateRoutineMeasurementError(
        'mismatched_plan_action',
        'Each normalized activation intent must bind exactly one plan action',
      )
    }
  }

  const operations = new Map(
    normalized.operations.map((operation) => [operation.operationAlias, operation]),
  )
  const attemptsByOperation = new Map<string, MeasurementAttempt[]>()

  for (const operation of normalized.operations) {
    referencedPlanAction(operation, planActions, 'Operation')
  }
  for (const attempt of normalized.attempts) {
    referencedPlanAction(attempt, planActions, 'Attempt')
    const operation = operations.get(attempt.operationAlias)
    if (operation === undefined) {
      throw new DuplicateRoutineMeasurementError(
        'missing_reference',
        'Attempt references an unknown operation',
      )
    }
    assertSamePlanAction(attempt, operation, 'Attempt')
    const siblings = attemptsByOperation.get(attempt.operationAlias) ?? []
    if (siblings.some((candidate) => candidate.sequence === attempt.sequence)) {
      throw new DuplicateRoutineMeasurementError(
        'conflicting_evidence_identity',
        'One operation has more than one attempt at the same sequence',
      )
    }
    siblings.push(attempt)
    attemptsByOperation.set(attempt.operationAlias, siblings)
  }
  for (const operation of normalized.operations) {
    if (!attemptsByOperation.has(operation.operationAlias)) {
      throw new DuplicateRoutineMeasurementError(
        'missing_reference',
        'Each operation must have at least one normalized attempt',
      )
    }
  }

  for (const routine of normalized.activeDurableRoutineOutcomes) {
    referencedPlanAction(routine, planActions, 'Durable routine outcome')
    const operation = operations.get(routine.operationAlias)
    if (operation === undefined) {
      throw new DuplicateRoutineMeasurementError(
        'missing_reference',
        'Durable routine outcome references an unknown operation',
      )
    }
    assertSamePlanAction(routine, operation, 'Durable routine outcome')
  }
  for (const result of normalized.verifierResults) {
    referencedPlanAction(result, planActions, 'Verifier result')
  }
  for (const latency of normalized.activationLatencies) {
    referencedPlanAction(latency, planActions, 'Activation latency')
  }
  for (const reconciliation of normalized.reconciliations) {
    referencedPlanAction(reconciliation, planActions, 'Reconciliation')
    const operation = operations.get(reconciliation.operationAlias)
    if (operation === undefined) {
      throw new DuplicateRoutineMeasurementError(
        'missing_reference',
        'Reconciliation references an unknown operation',
      )
    }
    assertSamePlanAction(reconciliation, operation, 'Reconciliation')
    if (
      !attemptsByOperation
        .get(reconciliation.operationAlias)
        ?.some((attempt) => attempt.outcome === 'unknown')
    ) {
      throw new DuplicateRoutineMeasurementError(
        'mismatched_plan_action',
        'Reconciliation requires an unknown operation attempt',
      )
    }
  }
  for (const cancellation of normalized.cancellationSafetyChecks) {
    referencedPlanAction(cancellation, planActions, 'Cancellation safety check')
  }
  for (const intervention of normalized.userInterventions) {
    referencedPlanAction(intervention, planActions, 'User intervention')
  }
  for (const cost of normalized.modelCosts) {
    referencedPlanAction(cost, planActions, 'Model cost')
  }
}

export interface MeasuredRate {
  readonly state: 'measured'
  readonly numerator: number
  readonly denominator: number
  readonly value: number
}

export interface ZeroDenominatorRate {
  readonly state: 'zero_denominator'
  readonly numerator: number
  readonly denominator: 0
  readonly value: null
}

export type RateMetric = MeasuredRate | ZeroDenominatorRate

export interface MeasuredLatencyDistribution {
  readonly state: 'measured'
  readonly count: number
  readonly medianMs: number
  readonly p95Ms: number
  readonly maximumMs: number
}

export interface EmptyLatencyDistribution {
  readonly state: 'no_evidence'
  readonly count: 0
  readonly medianMs: null
  readonly p95Ms: null
  readonly maximumMs: null
}

export type LatencyDistribution = MeasuredLatencyDistribution | EmptyLatencyDistribution

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round((value + Number.EPSILON) * scale) / scale
}

function rate(numerator: number, denominator: number, scale: number): RateMetric {
  if (denominator === 0) {
    return { state: 'zero_denominator', numerator, denominator: 0, value: null }
  }
  return {
    state: 'measured',
    numerator,
    denominator,
    value: round((numerator / denominator) * scale),
  }
}

function latencyDistribution(values: readonly number[]): LatencyDistribution {
  if (values.length === 0) {
    return {
      state: 'no_evidence',
      count: 0,
      medianMs: null,
      p95Ms: null,
      maximumMs: null,
    }
  }
  const ordered = [...values].sort((left, right) => left - right)
  const requiredValueAt = (index: number): number => {
    const value = ordered.at(index)
    if (value === undefined) {
      throw new Error('Latency distribution index is outside the measured sample')
    }
    return value
  }
  const middle = Math.floor(ordered.length / 2)
  const median =
    ordered.length % 2 === 0
      ? (requiredValueAt(middle - 1) + requiredValueAt(middle)) / 2
      : requiredValueAt(middle)
  const p95Index = Math.max(0, Math.ceil(ordered.length * 0.95) - 1)
  return {
    state: 'measured',
    count: ordered.length,
    medianMs: round(median),
    p95Ms: round(requiredValueAt(p95Index)),
    maximumMs: round(requiredValueAt(-1)),
  }
}

function hashCohort(normalized: NormalizedMeasurementInput): string {
  const identities = normalized.activationIntents
    .map((intent) => ({
      organizationAlias: intent.organizationAlias,
      missionAlias: intent.missionAlias,
      activationIntentAlias: intent.activationIntentAlias,
      planAlias: intent.planAlias,
      planActionAlias: intent.planActionAlias,
    }))
    .sort((left, right) => left.activationIntentAlias.localeCompare(right.activationIntentAlias))
  return createHash('sha256')
    .update(canonicalJson(asJsonValue(identities)))
    .digest('hex')
}

function groupRecords<RecordType>(
  records: readonly RecordType[],
  keyFor: (record: RecordType) => string,
): ReadonlyMap<string, readonly RecordType[]> {
  const groups = new Map<string, RecordType[]>()
  for (const record of records) {
    const key = keyFor(record)
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }
  return groups
}

export interface DuplicateRoutineCluster {
  readonly organizationAlias: string
  readonly missionAlias: string
  readonly activationIntentAlias: string
  readonly planAlias: string
  readonly planActionAlias: string
  readonly operationCount: number
  readonly unknownAttemptCount: number
  readonly activeDurableRoutineCount: number
  readonly manualDuplicateCleanupCount: number
}

export interface DuplicateRoutineMeasurementReport {
  readonly schemaVersion: 'duplicate-routine-measurement-report@1'
  readonly title: 'Ambiguous activation responses create duplicate routines'
  readonly control: 'broken' | 'corrected'
  readonly scenario: 'two_routines_one_timeout'
  readonly fixtureCohortHash: string
  readonly cohortIdentityHash: string
  readonly window: z.infer<typeof MeasurementWindowSchema>
  readonly evidenceClassification: typeof CREDENTIAL_FREE_MEASUREMENT_EVIDENCE
  readonly evidenceInventory: EvidenceInventory
  readonly primaryMetric: {
    readonly name: 'plans_with_duplicate_durable_routines_per_1000_activation_intents'
    readonly unit: 'plans_per_1000_activation_intents'
    readonly result: RateMetric
  }
  readonly signals: {
    readonly unknownOperationAttemptCount: number
    readonly planActionWithMultipleOperationsCount: number
    readonly planWithMultipleActiveRoutinesCount: number
    readonly manualDuplicateCleanupCount: number
  }
  readonly guardrails: {
    readonly verifierPassRatePercent: RateMetric
    readonly activationLatency: LatencyDistribution
    readonly reconciliationLatency: LatencyDistribution
    readonly cancellationSafetyPassRatePercent: RateMetric
    readonly userInterventionsPer1000ActivationIntents: RateMetric
    readonly modelCost: {
      readonly totalCostUsd: number
      readonly averageCostPerActivationIntentUsd: RateMetric
      readonly inputTokens: number
      readonly outputTokens: number
    }
  }
  readonly duplicateClusters: readonly DuplicateRoutineCluster[]
}

export function createDuplicateRoutineMeasurementReport(
  input: unknown,
): DuplicateRoutineMeasurementReport {
  const normalized = normalizeMeasurementInput(input)
  const activationIntentCount = normalized.activationIntents.length
  const operationsByAction = groupRecords(
    normalized.operations,
    (operation) => operation.planActionAlias,
  )
  const attemptsByPlan = groupRecords(normalized.attempts, (attempt) => attempt.planAlias)
  const routinesByPlan = groupRecords(
    normalized.activeDurableRoutineOutcomes,
    (routine) => routine.planAlias,
  )
  const interventionsByPlan = groupRecords(
    normalized.userInterventions,
    (intervention) => intervention.planAlias,
  )

  const duplicateClusters = normalized.planActions
    .filter((action) => (routinesByPlan.get(action.planAlias)?.length ?? 0) > 1)
    .map<DuplicateRoutineCluster>((action) => ({
      organizationAlias: action.organizationAlias,
      missionAlias: action.missionAlias,
      activationIntentAlias: action.activationIntentAlias,
      planAlias: action.planAlias,
      planActionAlias: action.planActionAlias,
      operationCount: operationsByAction.get(action.planActionAlias)?.length ?? 0,
      unknownAttemptCount:
        attemptsByPlan.get(action.planAlias)?.filter((attempt) => attempt.outcome === 'unknown')
          .length ?? 0,
      activeDurableRoutineCount: routinesByPlan.get(action.planAlias)?.length ?? 0,
      manualDuplicateCleanupCount:
        interventionsByPlan
          .get(action.planAlias)
          ?.filter((intervention) => intervention.kind === 'manual_duplicate_cleanup').length ?? 0,
    }))
    .sort((left, right) => left.planAlias.localeCompare(right.planAlias))

  const passedVerifications = normalized.verifierResults.filter((result) => result.passed).length
  const passedCancellations = normalized.cancellationSafetyChecks.filter(
    (result) => result.passed,
  ).length
  const totalCostUsd = round(
    normalized.modelCosts.reduce((total, cost) => total + cost.totalCostUsd, 0),
    8,
  )
  const totalInputTokens = normalized.modelCosts.reduce(
    (total, cost) => total + cost.inputTokens,
    0,
  )
  const totalOutputTokens = normalized.modelCosts.reduce(
    (total, cost) => total + cost.outputTokens,
    0,
  )

  const report: DuplicateRoutineMeasurementReport = {
    schemaVersion: 'duplicate-routine-measurement-report@1',
    title: 'Ambiguous activation responses create duplicate routines',
    control: normalized.input.control,
    scenario: normalized.input.scenario,
    fixtureCohortHash: normalized.input.fixtureCohortHash,
    cohortIdentityHash: hashCohort(normalized),
    window: normalized.input.window,
    evidenceClassification: CREDENTIAL_FREE_MEASUREMENT_EVIDENCE,
    evidenceInventory: normalized.inventory,
    primaryMetric: {
      name: 'plans_with_duplicate_durable_routines_per_1000_activation_intents',
      unit: 'plans_per_1000_activation_intents',
      result: rate(duplicateClusters.length, activationIntentCount, 1_000),
    },
    signals: {
      unknownOperationAttemptCount: normalized.attempts.filter(
        (attempt) => attempt.outcome === 'unknown',
      ).length,
      planActionWithMultipleOperationsCount: [...operationsByAction.values()].filter(
        (operations) => operations.length > 1,
      ).length,
      planWithMultipleActiveRoutinesCount: duplicateClusters.length,
      manualDuplicateCleanupCount: normalized.userInterventions.filter(
        (intervention) => intervention.kind === 'manual_duplicate_cleanup',
      ).length,
    },
    guardrails: {
      verifierPassRatePercent: rate(passedVerifications, normalized.verifierResults.length, 100),
      activationLatency: latencyDistribution(
        normalized.activationLatencies.map((latency) => latency.durationMs),
      ),
      reconciliationLatency: latencyDistribution(
        normalized.reconciliations.map((reconciliation) => reconciliation.durationMs),
      ),
      cancellationSafetyPassRatePercent: rate(
        passedCancellations,
        normalized.cancellationSafetyChecks.length,
        100,
      ),
      userInterventionsPer1000ActivationIntents: rate(
        normalized.userInterventions.length,
        activationIntentCount,
        1_000,
      ),
      modelCost: {
        totalCostUsd,
        averageCostPerActivationIntentUsd: rate(totalCostUsd, activationIntentCount, 1),
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
    },
    duplicateClusters,
  }
  assertPublicationSafe(report)
  return report
}

export interface DuplicateRoutineControlComparison {
  readonly schemaVersion: 'duplicate-routine-control-comparison@1'
  readonly title: 'Ambiguous activation responses create duplicate routines'
  readonly changeUnderTest: 'server_stable_operation_identity_and_reconciliation_before_retry'
  readonly evidenceClassification: typeof CREDENTIAL_FREE_MEASUREMENT_EVIDENCE
  readonly broken: DuplicateRoutineMeasurementReport
  readonly corrected: DuplicateRoutineMeasurementReport
  readonly primaryMetricDeltaPer1000: number | null
  readonly duplicatePlanDelta: number
  readonly controlGate: {
    readonly status: 'passed' | 'failed' | 'not_comparable'
    readonly sameFixtureCohort: boolean
    readonly nonzeroActivationIntentDenominator: boolean
    readonly brokenControlCreatedExactlyTwoActiveRoutines: boolean
    readonly brokenControlReportedDuplication: boolean
    readonly correctedControlReportedZeroDuplication: boolean
    readonly primaryMetricImproved: boolean
  }
}

export function compareDuplicateRoutineControls(input: {
  readonly broken: unknown
  readonly corrected: unknown
}): DuplicateRoutineControlComparison {
  const broken = createDuplicateRoutineMeasurementReport(input.broken)
  const corrected = createDuplicateRoutineMeasurementReport(input.corrected)
  if (broken.control !== 'broken' || corrected.control !== 'corrected') {
    throw new DuplicateRoutineMeasurementError(
      'comparison_mismatch',
      'Comparison inputs must identify the broken and corrected controls',
    )
  }

  const sameFixtureCohort =
    broken.fixtureCohortHash === corrected.fixtureCohortHash &&
    broken.cohortIdentityHash === corrected.cohortIdentityHash &&
    canonicalJson(asJsonValue(broken.window)) === canonicalJson(asJsonValue(corrected.window))
  if (!sameFixtureCohort) {
    throw new DuplicateRoutineMeasurementError(
      'comparison_mismatch',
      'Broken and corrected controls must use the same fixture cohort and measurement window',
    )
  }

  const brokenMetric = broken.primaryMetric.result
  const correctedMetric = corrected.primaryMetric.result
  const nonzeroActivationIntentDenominator =
    brokenMetric.state === 'measured' && correctedMetric.state === 'measured'
  const brokenControlCreatedExactlyTwoActiveRoutines =
    broken.duplicateClusters.length > 0 &&
    broken.duplicateClusters.every((cluster) => cluster.activeDurableRoutineCount === 2)
  const brokenControlReportedDuplication = brokenMetric.numerator > 0
  const correctedControlReportedZeroDuplication = correctedMetric.numerator === 0
  const primaryMetricImproved =
    nonzeroActivationIntentDenominator && correctedMetric.value < brokenMetric.value
  const passed =
    nonzeroActivationIntentDenominator &&
    brokenControlCreatedExactlyTwoActiveRoutines &&
    brokenControlReportedDuplication &&
    correctedControlReportedZeroDuplication &&
    primaryMetricImproved

  const comparison: DuplicateRoutineControlComparison = {
    schemaVersion: 'duplicate-routine-control-comparison@1',
    title: 'Ambiguous activation responses create duplicate routines',
    changeUnderTest: 'server_stable_operation_identity_and_reconciliation_before_retry',
    evidenceClassification: CREDENTIAL_FREE_MEASUREMENT_EVIDENCE,
    broken,
    corrected,
    primaryMetricDeltaPer1000: nonzeroActivationIntentDenominator
      ? round(correctedMetric.value - brokenMetric.value)
      : null,
    duplicatePlanDelta: correctedMetric.numerator - brokenMetric.numerator,
    controlGate: {
      status: nonzeroActivationIntentDenominator
        ? passed
          ? 'passed'
          : 'failed'
        : 'not_comparable',
      sameFixtureCohort,
      nonzeroActivationIntentDenominator,
      brokenControlCreatedExactlyTwoActiveRoutines,
      brokenControlReportedDuplication,
      correctedControlReportedZeroDuplication,
      primaryMetricImproved,
    },
  }
  assertPublicationSafe(comparison)
  return comparison
}

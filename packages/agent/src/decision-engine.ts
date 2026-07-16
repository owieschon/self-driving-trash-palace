import {
  CARETAKER_BUDGETS,
  ContextReceiptIdSchema,
  EvidenceIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  MissionConstraintSchema,
  MissionProgramKindSchema,
  MissionPhaseSchema,
  MissionStateSchema,
  OperationIdSchema,
  PalaceIdSchema,
  PlanActionIdSchema,
  PlanIdSchema,
  PlansProposeInputSchema,
  RunIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  ReceiptIdSchema,
  Sha256Schema,
  TaskLedgerItemSchema,
  TOOL_REGISTRY,
  ToolNameSchema,
  ToolCallIdSchema,
  ToolResultStatusSchema,
  hashToolValue,
  type ToolName,
} from '@trash-palace/core'
import { z } from 'zod'

import { ExactToolContractSectionSchema } from './context-contracts.js'
import { AuthoredContextSectionSchema } from './context.js'
import { HostPolicySectionSchema } from './host-policy.js'
import { StableIdSchema, canonicalJson, uniqueArray } from './primitives.js'

const DecisionReasonSchema = z.string().min(1).max(500)
const MaterialFieldSchema = z.string().regex(/^[a-z][a-zA-Z0-9_.-]{2,119}$/)

export const DecisionEvidenceReferenceSchema = z
  .object({
    id: EvidenceIdSchema,
    kind: z.enum(['runtime_state', 'tool_result', 'policy', 'verifier_receipt']),
    supports: uniqueArray(MaterialFieldSchema, 'Evidence-supported fields').min(1),
  })
  .strict()

const DecisionBaseShape = {
  schemaVersion: z.literal('caretaker-decision@1'),
  reason: DecisionReasonSchema,
  evidenceIds: uniqueArray(EvidenceIdSchema, 'Decision evidence IDs'),
} as const

function toolInvocationDecision<const Name extends ToolName>(name: Name) {
  return z
    .object({
      ...DecisionBaseShape,
      kind: z.literal('invoke_tool'),
      toolName: z.literal(name),
      input: TOOL_REGISTRY[name].inputSchema,
    })
    .strict()
}

export const ToolInvocationDecisionSchema = z.discriminatedUnion('toolName', [
  toolInvocationDecision('palaces.get'),
  toolInvocationDecision('crews.list'),
  toolInvocationDecision('capabilities.list'),
  toolInvocationDecision('routines.list'),
  toolInvocationDecision('routines.get'),
  toolInvocationDecision('executions.list'),
  toolInvocationDecision('knowledge.search'),
  toolInvocationDecision('plans.propose'),
  toolInvocationDecision('plans.validate'),
  toolInvocationDecision('plans.simulate'),
  toolInvocationDecision('plans.request_approval'),
  toolInvocationDecision('plans.activate'),
  toolInvocationDecision('operations.get'),
  toolInvocationDecision('verification.get_evidence'),
  toolInvocationDecision('missions.cancel'),
])

export const ClarificationDecisionSchema = z
  .object({
    ...DecisionBaseShape,
    evidenceIds: uniqueArray(EvidenceIdSchema, 'Clarification evidence IDs').min(1),
    kind: z.literal('request_clarification'),
    materialField: MaterialFieldSchema,
    question: z.string().min(1).max(320),
    choices: z
      .array(
        z
          .object({
            id: StableIdSchema,
            label: z.string().min(1).max(160),
          })
          .strict(),
      )
      .min(2)
      .max(3),
  })
  .strict()
  .superRefine((decision, context) => {
    if (new Set(decision.choices.map((choice) => choice.id)).size !== decision.choices.length) {
      context.addIssue({
        code: 'custom',
        message: 'Clarification choice IDs must be unique',
        path: ['choices'],
      })
    }
  })

export const PauseDecisionSchema = z
  .object({
    ...DecisionBaseShape,
    evidenceIds: uniqueArray(EvidenceIdSchema, 'Pause evidence IDs').min(1),
    kind: z.literal('pause'),
    pauseReason: z.enum([
      'awaiting_approval',
      'waiting_for_evidence',
      'waiting_for_reconciliation',
      'budget_exhausted',
      'human_action_required',
    ]),
    resumeWhen: z.string().min(1).max(320),
  })
  .strict()

export const EscalationDecisionSchema = z
  .object({
    ...DecisionBaseShape,
    evidenceIds: uniqueArray(EvidenceIdSchema, 'Escalation evidence IDs').min(1),
    kind: z.literal('escalate'),
    escalationReason: z.enum([
      'authorization_denied',
      'unsupported_capability',
      'untrusted_context',
      'stale_protected_state',
      'reconciliation_exhausted',
      'hard_invariant_risk',
      'host_inconsistency',
    ]),
    disposition: z.enum(['safe_refusal', 'human_review']),
    safestAction: z.string().min(1).max(320),
  })
  .strict()

export const GroundedClaimSchema = z
  .object({
    field: MaterialFieldSchema,
    value: z.json(),
    evidenceIds: uniqueArray(EvidenceIdSchema, 'Claim evidence IDs').min(1),
  })
  .strict()

export const GroundedSummaryDecisionSchema = z
  .object({
    ...DecisionBaseShape,
    evidenceIds: uniqueArray(EvidenceIdSchema, 'Summary evidence IDs').min(1),
    kind: z.literal('grounded_summary'),
    status: z.enum(['progress_update', 'verifier_receipt_available', 'safe_stop']),
    claims: z.array(GroundedClaimSchema).min(1).max(32),
  })
  .strict()
  .superRefine((decision, context) => {
    const fields = decision.claims.map((claim) => claim.field)
    if (new Set(fields).size !== fields.length) {
      context.addIssue({
        code: 'custom',
        message: 'Grounded summary claim fields must be unique',
        path: ['claims'],
      })
    }
  })

export const CaretakerDecisionSchema = z.union([
  ToolInvocationDecisionSchema,
  ClarificationDecisionSchema,
  PauseDecisionSchema,
  EscalationDecisionSchema,
  GroundedSummaryDecisionSchema,
])

export const DecisionBudgetSchema = z
  .object({
    toolCalls: z
      .object({
        used: z.number().int().nonnegative(),
        max: z.literal(CARETAKER_BUDGETS.maxToolCallsPerRun),
      })
      .strict(),
    planRevisions: z
      .object({
        used: z.number().int().nonnegative(),
        max: z.literal(CARETAKER_BUDGETS.maxPlanRevisions),
      })
      .strict(),
    clarifications: z
      .object({
        used: z.number().int().nonnegative(),
        max: z.literal(CARETAKER_BUDGETS.maxClarificationPauses),
      })
      .strict(),
    reconciliationPolls: z
      .object({
        used: z.number().int().nonnegative(),
        max: z.literal(CARETAKER_BUDGETS.maxReconciliationPolls),
      })
      .strict(),
    activeRuntimeMilliseconds: z
      .object({
        used: z.number().int().nonnegative(),
        max: z.literal(CARETAKER_BUDGETS.maxActiveRuntimeSeconds * 1_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((budget, context) => {
    for (const [field, value] of Object.entries(budget)) {
      if (value.used > value.max) {
        context.addIssue({
          code: 'custom',
          message: `${field} budget usage cannot exceed its ceiling`,
          path: [field, 'used'],
        })
      }
    }
  })

const MaterialIssueSchema = z
  .object({
    kind: z.enum(['missing_preference', 'constraint_conflict']),
    field: MaterialFieldSchema,
    question: z.string().min(1).max(320),
    choices: z
      .array(z.object({ id: StableIdSchema, label: z.string().min(1).max(160) }).strict())
      .min(2)
      .max(3),
    resolvedChoiceId: StableIdSchema.nullable(),
    evidenceIds: uniqueArray(EvidenceIdSchema, 'Material issue evidence IDs').min(1),
  })
  .strict()
  .superRefine((issue, context) => {
    const choiceIds = issue.choices.map((choice) => choice.id)
    if (new Set(choiceIds).size !== choiceIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Material issue choice IDs must be unique',
        path: ['choices'],
      })
    }
    if (issue.resolvedChoiceId !== null && !choiceIds.includes(issue.resolvedChoiceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Resolved material choice must identify one offered choice',
        path: ['resolvedChoiceId'],
      })
    }
  })

const PlanDecisionStateSchema = z
  .object({
    status: z.enum([
      'absent',
      'draft_ready',
      'candidate',
      'validated',
      'simulated',
      'awaiting_approval',
      'approved',
      'stale',
    ]),
    proposal: PlansProposeInputSchema.nullable(),
    planId: PlanIdSchema.nullable(),
    actionId: PlanActionIdSchema.nullable(),
    expectedVersion: z.number().int().positive().nullable(),
    protectedRoutineId: RoutineIdSchema.nullable(),
    protectedRoutineVersionId: RoutineVersionIdSchema.nullable(),
  })
  .strict()
  .superRefine((plan, context) => {
    if (
      plan.status === 'absent' &&
      [
        plan.proposal,
        plan.planId,
        plan.actionId,
        plan.expectedVersion,
        plan.protectedRoutineId,
        plan.protectedRoutineVersionId,
      ].some((value) => value !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Absent plan state cannot carry persisted or proposed plan data',
      })
    }
    if (plan.status === 'draft_ready' && plan.proposal === null) {
      context.addIssue({
        code: 'custom',
        message: 'A draft-ready plan requires an exact proposal',
        path: ['proposal'],
      })
    }
    if (
      plan.status === 'draft_ready' &&
      [
        plan.planId,
        plan.actionId,
        plan.expectedVersion,
        plan.protectedRoutineId,
        plan.protectedRoutineVersionId,
      ].some((value) => value !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An unpersisted draft cannot claim persisted plan identities',
      })
    }
    if (
      !['absent', 'draft_ready'].includes(plan.status) &&
      (plan.planId === null || plan.actionId === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Persisted plan state requires a plan and action ID',
      })
    }
    if (plan.status === 'approved' && plan.expectedVersion === null) {
      context.addIssue({
        code: 'custom',
        message: 'An approved plan requires its protected expected version',
        path: ['expectedVersion'],
      })
    }
    if (
      plan.status === 'stale' &&
      (plan.protectedRoutineId === null || plan.protectedRoutineVersionId === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A stale plan requires the protected routine identity',
      })
    }
  })

const OperationDecisionStateSchema = z
  .object({
    status: z.enum(['absent', 'pending', 'outcome_unknown', 'committed', 'failed']),
    operationId: OperationIdSchema.nullable(),
    reconciliationRequired: z.boolean(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (operation.status !== 'absent' && operation.operationId === null) {
      context.addIssue({
        code: 'custom',
        message: 'A durable operation state requires an operation ID',
        path: ['operationId'],
      })
    }
    if (
      operation.reconciliationRequired !== ['pending', 'outcome_unknown'].includes(operation.status)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only pending or unknown outcomes require reconciliation',
        path: ['reconciliationRequired'],
      })
    }
  })

const VerificationDecisionStateSchema = z
  .object({
    status: z.enum(['not_ready', 'evidence_needed', 'verifier_passed', 'verifier_failed']),
    claims: z.array(GroundedClaimSchema).max(32),
    failedCriteria: uniqueArray(StableIdSchema, 'Failed verification criteria'),
  })
  .strict()
  .superRefine((verification, context) => {
    if (verification.status === 'verifier_passed' && verification.claims.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A verifier pass requires grounded claim projections',
        path: ['claims'],
      })
    }
    if (verification.status === 'verifier_failed' && verification.failedCriteria.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A verifier failure requires failed criterion IDs',
        path: ['failedCriteria'],
      })
    }
  })

export const CaretakerLiveStateSchema = z
  .object({
    access: z.enum(['authorized', 'denied']),
    discovery: z
      .object({
        palace: z.enum(['needed', 'ready']),
        crew: z.enum(['needed', 'ready']),
        capabilities: z.enum(['needed', 'ready']),
        routines: z.enum(['needed', 'ready']),
        knowledge: z.enum(['needed', 'ready']),
      })
      .strict(),
    materialIssue: MaterialIssueSchema.nullable(),
    capabilityFit: z.enum(['supported', 'unsupported']),
    plan: PlanDecisionStateSchema,
    operation: OperationDecisionStateSchema,
    verification: VerificationDecisionStateSchema,
    integrityAlerts: uniqueArray(
      z.enum(['prompt_injection', 'cross_tenant_identifier', 'forged_approval']),
      'Integrity alerts',
    ),
  })
  .strict()

export const ModelSafeAuthoredContextSectionSchema = AuthoredContextSectionSchema.extend({
  authority: z.literal('authored_guidance'),
  sourceAuthority: z.enum(['skill', 'reference', 'evidence']),
  visibility: z.enum(['public', 'internal']),
  sensitivity: z.enum(['public', 'internal']),
  tenantScoped: z.literal(false),
}).strict()

const CaretakerFrozenContextPayloadSchema = z
  .object({
    schemaVersion: z.literal('caretaker-frozen-context@1'),
    receiptId: ContextReceiptIdSchema,
    receiptBindingHash: Sha256Schema,
    bundleId: z.string().min(1).max(200),
    bundleHash: Sha256Schema,
    frozenAt: IsoDateTimeSchema,
    hostPolicy: HostPolicySectionSchema,
    exactContracts: ExactToolContractSectionSchema,
    sections: z.array(ModelSafeAuthoredContextSectionSchema).max(32),
    filtering: z
      .object({
        confidentialSourcesExcluded: z.number().int().nonnegative(),
        tenantPrivateSourcesExcluded: z.number().int().nonnegative(),
        crossTenantSourcesExcluded: z.number().int().nonnegative(),
        runtimeSnapshotsExcluded: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()

export const CaretakerFrozenContextSchema = CaretakerFrozenContextPayloadSchema.extend({
  projectionHash: Sha256Schema,
})
  .strict()
  .superRefine((contextProjection, context) => {
    const { projectionHash, ...payload } = contextProjection
    if (hashToolValue(payload) !== projectionHash) {
      context.addIssue({
        code: 'custom',
        path: ['projectionHash'],
        message: 'Frozen model context projection hash does not match its payload',
      })
    }
  })

export const CaretakerRetrievedKnowledgeSchema = z
  .object({
    authority: z.literal('untrusted_evidence'),
    instructionRole: z.literal('untrusted_evidence'),
    sourceId: z.string().regex(/^[a-z][a-z0-9_.:/-]{2,199}$/),
    sourceVersion: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    excerpt: z.string().min(1).max(2_000),
    excerptHash: Sha256Schema,
    provenance: z
      .object({
        toolName: z.literal('knowledge.search'),
        callId: ToolCallIdSchema,
        receiptId: ReceiptIdSchema,
        resultHash: Sha256Schema,
        evidenceIds: uniqueArray(EvidenceIdSchema, 'Knowledge provenance evidence IDs').min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((knowledge, context) => {
    if (
      knowledge.excerptHash !==
      hashToolValue({
        sourceId: knowledge.sourceId,
        sourceVersion: knowledge.sourceVersion,
        title: knowledge.title,
        excerpt: knowledge.excerpt,
      })
    ) {
      context.addIssue({
        code: 'custom',
        path: ['excerptHash'],
        message: 'Retrieved knowledge hash does not match its bounded excerpt',
      })
    }
  })

export type CaretakerFrozenContext = z.output<typeof CaretakerFrozenContextSchema>
export type CaretakerRetrievedKnowledge = z.output<typeof CaretakerRetrievedKnowledgeSchema>

export function createCaretakerFrozenContext(
  input: z.input<typeof CaretakerFrozenContextPayloadSchema>,
): CaretakerFrozenContext {
  const payload = CaretakerFrozenContextPayloadSchema.parse(input)
  return CaretakerFrozenContextSchema.parse({ ...payload, projectionHash: hashToolValue(payload) })
}

export const CaretakerDecisionRequestSchema = z
  .object({
    schemaVersion: z.literal('caretaker-decision-request@1'),
    requestId: StableIdSchema,
    contextReceiptId: ContextReceiptIdSchema,
    contextBundleHash: Sha256Schema,
    frozenContext: CaretakerFrozenContextSchema,
    retrievedKnowledge: z.array(CaretakerRetrievedKnowledgeSchema).max(6),
    runId: RunIdSchema,
    mission: z
      .object({
        id: MissionIdSchema,
        palaceId: PalaceIdSchema,
        programKind: MissionProgramKindSchema,
        objective: z.string().min(1).max(2_000),
        constraints: MissionConstraintSchema,
        state: MissionStateSchema,
        version: z.number().int().nonnegative(),
        taskLedger: z.array(TaskLedgerItemSchema).max(32),
      })
      .strict(),
    turnIndex: z.number().int().nonnegative(),
    allowedTools: uniqueArray(ToolNameSchema, 'Allowed tools'),
    budget: DecisionBudgetSchema,
    evidence: z.array(DecisionEvidenceReferenceSchema).min(1).max(128),
    liveState: CaretakerLiveStateSchema,
    lastToolResult: z
      .object({
        toolName: ToolNameSchema,
        status: ToolResultStatusSchema,
        errorCode: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
          .nullable(),
        evidenceIds: uniqueArray(EvidenceIdSchema, 'Tool-result evidence IDs'),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((request, context) => {
    const evidenceIds = request.evidence.map((entry) => entry.id)
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Decision evidence IDs must be unique',
        path: ['evidence'],
      })
    }
    for (const [index, evidenceId] of (request.lastToolResult?.evidenceIds ?? []).entries()) {
      if (!evidenceIds.includes(evidenceId)) {
        context.addIssue({
          code: 'custom',
          message: 'Last tool result references evidence outside the request catalog',
          path: ['lastToolResult', 'evidenceIds', index],
        })
      }
    }
    if (
      request.frozenContext.receiptId !== request.contextReceiptId ||
      request.frozenContext.receiptBindingHash !== request.contextBundleHash
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Frozen model context must bind the request context receipt and bundle hash',
        path: ['frozenContext'],
      })
    }
    request.retrievedKnowledge.forEach((knowledge, knowledgeIndex) => {
      knowledge.provenance.evidenceIds.forEach((evidenceId, evidenceIndex) => {
        if (!evidenceIds.includes(evidenceId)) {
          context.addIssue({
            code: 'custom',
            message: 'Retrieved knowledge references evidence outside the request catalog',
            path: [
              'retrievedKnowledge',
              knowledgeIndex,
              'provenance',
              'evidenceIds',
              evidenceIndex,
            ],
          })
        }
      })
    })
    const knowledgeReady = request.liveState.discovery.knowledge === 'ready'
    if (knowledgeReady !== request.retrievedKnowledge.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Knowledge is ready only when bounded, provenance-preserving excerpts are present',
        path: ['liveState', 'discovery', 'knowledge'],
      })
    }
  })

export type CaretakerDecision = z.infer<typeof CaretakerDecisionSchema>
export type CaretakerDecisionRequest = z.infer<typeof CaretakerDecisionRequestSchema>
export type CaretakerLiveState = z.infer<typeof CaretakerLiveStateSchema>

export const DecisionAttemptIdSchema = StableIdSchema

const DecisionObservationRequestIdSchema = StableIdSchema.nullable()
const DecisionObservationEngineIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/+~-]*$/)
const DecisionObservationCodeSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_.-]*$/)
const DecisionObservationModelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+~-]*$/)
const DecisionObservationStopReasonSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+~-]*$/)

const DecisionObservationBaseShape = {
  schemaVersion: z.literal('caretaker-decision-observation@1'),
  requestId: DecisionObservationRequestIdSchema,
  attemptId: DecisionAttemptIdSchema,
  engineId: DecisionObservationEngineIdSchema,
} as const

export const DeterministicDecisionObservationSchema = z
  .object({
    ...DecisionObservationBaseShape,
    kind: z.literal('deterministic_decision'),
    status: z.enum(['succeeded', 'failed']),
    decisionKind: z
      .enum(['invoke_tool', 'request_clarification', 'pause', 'escalate', 'grounded_summary'])
      .nullable(),
    failureCode: DecisionObservationCodeSchema.nullable(),
  })
  .strict()
  .superRefine((observation, context) => {
    const failed = observation.status === 'failed'
    if (failed !== (observation.failureCode !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['failureCode'],
        message: 'A deterministic failure requires one safe failure code',
      })
    }
    if (failed === (observation.decisionKind !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['decisionKind'],
        message: 'Only a successful deterministic decision carries its decision kind',
      })
    }
  })

export const ModelGenerationDecisionObservationSchema = z
  .object({
    ...DecisionObservationBaseShape,
    kind: z.literal('model_generation'),
    provider: z.literal('anthropic'),
    model: DecisionObservationModelSchema,
    status: z.enum(['succeeded', 'failed']),
    resultSubtype: z.enum([
      'success',
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ]),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadInputTokens: z.number().int().nonnegative(),
    cacheCreationInputTokens: z.number().int().nonnegative(),
    cacheReportingExclusive: z.literal(true),
    durationMilliseconds: z.number().nonnegative(),
    apiDurationMilliseconds: z.number().nonnegative(),
    timeToFirstTokenMilliseconds: z.number().nonnegative().optional(),
    totalCostUsd: z.number().nonnegative(),
    stopReason: DecisionObservationStopReasonSchema.nullable(),
    streamed: z.literal(false),
    failureCode: DecisionObservationCodeSchema.nullable(),
  })
  .strict()
  .superRefine((observation, context) => {
    if ((observation.status === 'failed') !== (observation.failureCode !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['failureCode'],
        message: 'A failed model generation requires one safe failure code',
      })
    }
    if (observation.status === 'succeeded' && observation.resultSubtype !== 'success') {
      context.addIssue({
        code: 'custom',
        path: ['resultSubtype'],
        message: 'A successful generation requires the SDK success subtype',
      })
    }
  })

export const DecisionAdapterFailureObservationSchema = z
  .object({
    ...DecisionObservationBaseShape,
    kind: z.literal('adapter_failure'),
    provider: z.enum(['anthropic', 'deterministic']),
    model: DecisionObservationModelSchema.nullable(),
    failureCode: DecisionObservationCodeSchema,
    generationUsageAvailable: z.literal(false),
  })
  .strict()

export const CaretakerDecisionObservationSchema = z.discriminatedUnion('kind', [
  DeterministicDecisionObservationSchema,
  ModelGenerationDecisionObservationSchema,
  DecisionAdapterFailureObservationSchema,
])

export type CaretakerDecisionObservation = z.output<typeof CaretakerDecisionObservationSchema>
export type CaretakerDecisionObservationInput =
  CaretakerDecisionObservation extends infer Observation
    ? Observation extends CaretakerDecisionObservation
      ? Omit<Observation, 'attemptId'>
      : never
    : never
export type CaretakerDecisionObserver = (observation: CaretakerDecisionObservation) => Promise<void>

export type CaretakerDecisionActivation =
  | Readonly<{
      signal: AbortSignal
      attemptId: z.input<typeof DecisionAttemptIdSchema>
      observe: CaretakerDecisionObserver
    }>
  | Readonly<{
      signal: AbortSignal
      attemptId?: undefined
      observe?: undefined
    }>

export class CaretakerDecisionObservationDeliveryError extends Error {
  public constructor() {
    super('Caretaker decision observation delivery failed')
    this.name = 'CaretakerDecisionObservationDeliveryError'
  }
}

/** Validates the analytics-safe boundary before awaiting the host-owned observer. */
export async function emitCaretakerDecisionObservation(
  activation: CaretakerDecisionActivation | undefined,
  observation: CaretakerDecisionObservationInput,
): Promise<void> {
  if (activation?.observe === undefined) return
  const parsed = CaretakerDecisionObservationSchema.parse({
    ...observation,
    attemptId: DecisionAttemptIdSchema.parse(activation.attemptId),
  })
  try {
    await activation.observe(parsed)
  } catch {
    throw new CaretakerDecisionObservationDeliveryError()
  }
}

export interface CaretakerDecisionEngine {
  readonly id: string
  decide(
    request: CaretakerDecisionRequest,
    activation?: CaretakerDecisionActivation,
  ): Promise<CaretakerDecision>
}

function collectDecisionEvidenceIds(decision: CaretakerDecision): readonly string[] {
  if (decision.kind !== 'grounded_summary') return decision.evidenceIds
  return [...decision.evidenceIds, ...decision.claims.flatMap((claim) => claim.evidenceIds)]
}

export function parseDecisionForRequest(
  requestInput: unknown,
  decisionInput: unknown,
): CaretakerDecision {
  const request = CaretakerDecisionRequestSchema.parse(requestInput)
  const decision = CaretakerDecisionSchema.parse(decisionInput)
  const knownEvidence = new Set<string>(request.evidence.map((entry) => entry.id))

  if (
    request.budget.activeRuntimeMilliseconds.used >= request.budget.activeRuntimeMilliseconds.max &&
    !(decision.kind === 'pause' && decision.pauseReason === 'budget_exhausted')
  ) {
    throw new Error('The active-runtime budget is exhausted')
  }

  for (const evidenceId of collectDecisionEvidenceIds(decision)) {
    if (!knownEvidence.has(evidenceId)) {
      throw new Error(`Decision references unknown evidence ${evidenceId}`)
    }
  }

  if (decision.kind === 'invoke_tool') {
    if (!request.allowedTools.includes(decision.toolName)) {
      throw new Error(`Tool ${decision.toolName} is outside the host allowlist`)
    }
    if (request.budget.toolCalls.used >= request.budget.toolCalls.max) {
      throw new Error('Tool-call budget is exhausted')
    }
    if (
      decision.toolName === 'plans.propose' &&
      request.budget.planRevisions.used >= request.budget.planRevisions.max
    ) {
      throw new Error('The plan-revision budget is exhausted')
    }
    if (
      decision.toolName === 'operations.get' &&
      request.budget.reconciliationPolls.used >= request.budget.reconciliationPolls.max
    ) {
      throw new Error('The reconciliation-poll budget is exhausted')
    }
    const phase = MissionPhaseSchema.parse(request.mission.state.phase)
    if (!TOOL_REGISTRY[decision.toolName].allowedPhases.includes(phase)) {
      throw new Error(`Tool ${decision.toolName} is not allowed during ${phase}`)
    }
    if (
      (request.lastToolResult?.status === 'unknown' ||
        request.liveState.operation.reconciliationRequired) &&
      decision.toolName !== 'operations.get'
    ) {
      throw new Error('An unknown operation must reconcile before another tool can run')
    }
  }

  if (
    decision.kind === 'request_clarification' &&
    request.budget.clarifications.used >= request.budget.clarifications.max
  ) {
    throw new Error('The clarification-pause budget is exhausted')
  }

  if (decision.kind === 'request_clarification') {
    const issue = request.liveState.materialIssue
    if (
      issue === null ||
      issue.resolvedChoiceId !== null ||
      decision.materialField !== issue.field ||
      decision.question !== issue.question ||
      JSON.stringify(decision.choices) !== JSON.stringify(issue.choices)
    ) {
      throw new Error('Clarification must match the unresolved host-projected material issue')
    }
  }

  if (decision.kind === 'grounded_summary') {
    const evidenceById = new Map(request.evidence.map((entry) => [entry.id, entry]))
    for (const claim of decision.claims) {
      if (
        claim.evidenceIds.some(
          (evidenceId) => !evidenceById.get(evidenceId)?.supports.includes(claim.field),
        )
      ) {
        throw new Error(`Claim ${claim.field} lacks evidence that supports that field`)
      }
    }
    if (decision.status === 'verifier_receipt_available') {
      if (request.liveState.verification.status !== 'verifier_passed') {
        throw new Error('Only an application verifier pass can expose a verifier receipt summary')
      }
      const verifierClaims = new Map(
        request.liveState.verification.claims.map((claim) => [claim.field, claim]),
      )
      for (const claim of decision.claims) {
        const verifierClaim = verifierClaims.get(claim.field)
        if (
          verifierClaim === undefined ||
          canonicalJson(verifierClaim.value) !== canonicalJson(claim.value) ||
          claim.evidenceIds.some((evidenceId) => !verifierClaim.evidenceIds.includes(evidenceId))
        ) {
          throw new Error(`Claim ${claim.field} is not projected from the current verifier receipt`)
        }
      }
      const referencedEvidenceIds = new Set([
        ...decision.evidenceIds,
        ...decision.claims.flatMap((claim) => claim.evidenceIds),
      ])
      if (
        request.evidence.every(
          (evidence) =>
            evidence.kind !== 'verifier_receipt' || !referencedEvidenceIds.has(evidence.id),
        )
      ) {
        throw new Error('A completion summary requires a durable verifier receipt')
      }
    }
  }

  if (decision.kind === 'pause') {
    if (
      decision.pauseReason === 'awaiting_approval' &&
      (request.liveState.plan.status !== 'awaiting_approval' ||
        request.mission.state.status !== 'waiting_for_user' ||
        request.mission.state.phase !== 'approve')
    ) {
      throw new Error('Approval pause requires waiting_for_user/approve on an exact plan')
    }
    if (
      decision.pauseReason === 'waiting_for_evidence' &&
      (request.mission.state.status !== 'waiting_for_system' ||
        request.mission.state.phase !== 'observe')
    ) {
      throw new Error('Evidence pause requires waiting_for_system/observe')
    }
    if (
      decision.pauseReason === 'waiting_for_reconciliation' &&
      (request.mission.state.status !== 'running' ||
        request.mission.state.phase !== 'reconcile' ||
        !request.liveState.operation.reconciliationRequired)
    ) {
      throw new Error('Reconciliation pause requires running/reconcile with an unknown operation')
    }
    if (
      decision.pauseReason === 'budget_exhausted' &&
      !Object.values(request.budget).some((budget) => budget.used >= budget.max)
    ) {
      throw new Error('Budget pause requires an exhausted host-derived budget')
    }
  }

  return decision
}

import type {
  Attempt,
  EvidenceId,
  Execution,
  ExecutionMilestoneName,
  GatewayCallback,
  GatewayCommand,
  GatewayCommandInstruction,
  GatewayCommandLogicalKey,
  GatewayDispatchState,
  GatewayEffectState,
  IdentityTelemetryEvent,
  IdentityTelemetryPrincipal,
  Mission,
  MissionId,
  OperationId,
  OrganizationId,
  PersistedEvidenceRecord,
  PlanActionId,
  PlanId,
  Principal,
  Sha256,
  Verification,
} from '@trash-palace/core'
import {
  AttemptIdSchema,
  EvidenceIdSchema,
  GatewayCallbackSchema,
  GatewayCommandLogicalKeySchema,
  GatewayCommandInstructionSchema,
  GatewayCommandSchema,
  GatewayDispatchStateSchema,
  GatewayEffectStateSchema,
  GatewayCommandIdSchema,
  GatewaySignatureMetadataSchema,
  IdentityTagIdSchema,
  IdentityTelemetryKeyIdSchema,
  IdentityTelemetryNonceSchema,
  IdentityTelemetryPrincipalIdSchema,
  IdentityTelemetryProviderEventIdSchema,
  ExecutionIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  MissionPhaseSchema,
  OperationIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  ReceiptIdSchema,
  RunIdSchema,
  Sha256Schema,
  TaskLedgerItemSchema,
  TOOL_REGISTRY,
  ToolCallIdSchema,
  hashToolValue,
  type ToolName,
} from '@trash-palace/core'
import {
  CaretakerEvidenceProfileSchema,
  CaretakerTerminalEvidenceEnvelopeSchema,
  type CaretakerEvidenceProfile,
  type CaretakerTerminalEvidenceEnvelope,
} from '@trash-palace/observability'
import { z } from 'zod'

export type {
  GatewayCallback,
  GatewayCommand,
  GatewayCommandInstruction,
  GatewayDispatchResult,
} from '@trash-palace/core'

export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

export const CaretakerRunStatusSchema = z.enum([
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'abandoned',
])

export const CaretakerRunCheckpointKindSchema = z.enum([
  'activated',
  'state_persisted',
  'decision_attempt',
  'tool_call',
  'tool_wait',
  'plan_revision',
  'clarification_pause',
  'approval_pause',
  'human_review_pause',
  'reconciliation_poll',
  'external_wait',
  'budget_exhausted',
  'completed',
  'failed',
  'safe_refusal',
  'host_failed',
  'cancelled',
  'lease_replaced',
])

export const CaretakerRunMutationCheckpointKindSchema = CaretakerRunCheckpointKindSchema.exclude([
  'activated',
  'lease_replaced',
])

export const CaretakerRunCountersSchema = z
  .object({
    toolCallCount: z.number().int().min(0).max(24),
    planRevisionCount: z.number().int().min(0).max(3),
    clarificationPauseCount: z.number().int().min(0).max(2),
    reconciliationPollCount: z.number().int().min(0).max(3),
    activeRuntimeMilliseconds: z.number().int().min(0).max(300_000),
  })
  .strict()

function pendingToolCallSchema<const Name extends ToolName>(name: Name) {
  return z
    .object({
      callId: ToolCallIdSchema,
      toolName: z.literal(name),
      input: TOOL_REGISTRY[name].inputSchema,
      inputHash: Sha256Schema,
    })
    .strict()
}

const CREDENTIAL_KEY =
  /^(?:api[_-]?key|authorization|cookie|credential|headers?|password|secret|token)$/i
const CREDENTIAL_VALUE =
  /(?:\bbearer\s+[a-z0-9._~+/-]{8,}|\b(?:phc|phx|sk)_[a-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|password|secret|token)=\S+)/i
const HOME_PATH = /(?:^|[\s"'(])\/(?:Users|home)\/[^/\s]+/
const PRIVATE_URL =
  /https?:\/\/(?:localhost|0\.0\.0\.0|127\.0\.0\.1|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?(?:\/|\b)/i

function findUnsafePendingToolInput(
  value: unknown,
  path: readonly (number | string)[] = [],
): Readonly<{ path: readonly (number | string)[]; message: string }> | null {
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE.test(value)) {
      return { path, message: 'Pending tool input cannot retain credential-shaped values' }
    }
    if (HOME_PATH.test(value)) {
      return { path, message: 'Pending tool input cannot retain absolute home paths' }
    }
    if (PRIVATE_URL.test(value)) {
      return { path, message: 'Pending tool input cannot retain private network URLs' }
    }
    return null
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const finding = findUnsafePendingToolInput(item, [...path, index])
      if (finding !== null) return finding
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(key)) {
        return {
          path: [...path, key],
          message: 'Pending tool input cannot retain credential-bearing fields',
        }
      }
      const finding = findUnsafePendingToolInput(item, [...path, key])
      if (finding !== null) return finding
    }
  }
  return null
}

export const CaretakerPendingToolCallSchema = z
  .discriminatedUnion('toolName', [
    pendingToolCallSchema('palaces.get'),
    pendingToolCallSchema('crews.list'),
    pendingToolCallSchema('capabilities.list'),
    pendingToolCallSchema('routines.list'),
    pendingToolCallSchema('routines.get'),
    pendingToolCallSchema('executions.list'),
    pendingToolCallSchema('knowledge.search'),
    pendingToolCallSchema('plans.propose'),
    pendingToolCallSchema('plans.validate'),
    pendingToolCallSchema('plans.simulate'),
    pendingToolCallSchema('plans.request_approval'),
    pendingToolCallSchema('plans.activate'),
    pendingToolCallSchema('operations.get'),
    pendingToolCallSchema('verification.get_evidence'),
    pendingToolCallSchema('missions.cancel'),
  ])
  .superRefine((pending, context) => {
    if (hashToolValue(pending.input) !== pending.inputHash) {
      context.addIssue({
        code: 'custom',
        path: ['inputHash'],
        message: 'Pending tool input hash must bind its canonical typed input',
      })
    }
    const unsafe = findUnsafePendingToolInput(pending.input)
    if (unsafe !== null) {
      context.addIssue({ code: 'custom', path: ['input', ...unsafe.path], message: unsafe.message })
    }
  })

export const CaretakerTaskLedgerSchema = z
  .array(TaskLedgerItemSchema)
  .max(32)
  .superRefine((items, context) => {
    const ids = new Set<string>()
    for (const [index, item] of items.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Caretaker task IDs must be unique',
        })
      }
      ids.add(item.id)
      if (new Set(item.evidenceRefs).size !== item.evidenceRefs.length) {
        context.addIssue({
          code: 'custom',
          path: [index, 'evidenceRefs'],
          message: 'Caretaker task evidence references must be unique',
        })
      }
    }
  })

export const CaretakerRunRecordSchema = z
  .object({
    id: RunIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    leaseEpoch: z.number().int().positive(),
    status: CaretakerRunStatusSchema,
    phase: MissionPhaseSchema,
    version: z.number().int().nonnegative(),
    taskLedgerVersion: z.number().int().nonnegative(),
    counters: CaretakerRunCountersSchema,
    pendingToolCall: CaretakerPendingToolCallSchema.nullable(),
    evidenceProfile: CaretakerEvidenceProfileSchema,
    startedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    if ((run.status === 'active') !== (run.endedAt === null)) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'Only an active Caretaker run may omit its end time',
      })
    }
  })

export const CaretakerRunCheckpointSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    runId: RunIdSchema,
    sequence: z.number().int().nonnegative(),
    mutationKey: Sha256Schema,
    mutationHash: Sha256Schema,
    kind: CaretakerRunCheckpointKindSchema,
    runStatus: CaretakerRunStatusSchema,
    phase: MissionPhaseSchema,
    runVersion: z.number().int().nonnegative(),
    taskLedgerVersion: z.number().int().nonnegative(),
    taskLedgerHash: Sha256Schema,
    taskLedger: CaretakerTaskLedgerSchema,
    counters: CaretakerRunCountersSchema,
    pendingToolCall: CaretakerPendingToolCallSchema.nullable(),
    evidenceRefs: z.array(EvidenceIdSchema).max(32),
    occurredAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (checkpoint.sequence !== checkpoint.runVersion) {
      context.addIssue({
        code: 'custom',
        path: ['sequence'],
        message: 'Caretaker checkpoint sequence must equal the run version',
      })
    }
    if (new Set(checkpoint.evidenceRefs).size !== checkpoint.evidenceRefs.length) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceRefs'],
        message: 'Caretaker checkpoint evidence references must be unique',
      })
    }
  })

export type CaretakerRunStatus = z.infer<typeof CaretakerRunStatusSchema>
export type CaretakerRunCheckpointKind = z.infer<typeof CaretakerRunCheckpointKindSchema>
export type CaretakerRunMutationCheckpointKind = z.infer<
  typeof CaretakerRunMutationCheckpointKindSchema
>
export type CaretakerRunCounters = z.infer<typeof CaretakerRunCountersSchema>
export type CaretakerPendingToolCall = z.infer<typeof CaretakerPendingToolCallSchema>
export type CaretakerTaskLedger = z.infer<typeof CaretakerTaskLedgerSchema>
export type CaretakerRunRecord = z.infer<typeof CaretakerRunRecordSchema>
export type CaretakerRunCheckpoint = z.infer<typeof CaretakerRunCheckpointSchema>

export interface CaretakerRunSnapshot {
  readonly run: CaretakerRunRecord
  readonly checkpoint: CaretakerRunCheckpoint
  readonly taskLedger: CaretakerTaskLedger
}

export const CaretakerTerminalEvidenceDeliveryStatusSchema = z.enum(['pending', 'delivered'])

export const CaretakerTerminalEvidenceDeliverySchema = z
  .object({
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    runId: RunIdSchema,
    envelope: CaretakerTerminalEvidenceEnvelopeSchema,
    status: CaretakerTerminalEvidenceDeliveryStatusSchema,
    createdAt: IsoDateTimeSchema,
    deliveredAt: IsoDateTimeSchema.nullable(),
    captureStatus: z.enum(['stored', 'duplicate']).nullable(),
  })
  .strict()
  .superRefine((delivery, context) => {
    const delivered = delivery.status === 'delivered'
    if (delivered !== (delivery.deliveredAt !== null && delivery.captureStatus !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['deliveredAt'],
        message: 'Delivered Caretaker evidence requires its sink acknowledgement and timestamp',
      })
    }
  })

export type CaretakerTerminalEvidenceDeliveryStatus = z.infer<
  typeof CaretakerTerminalEvidenceDeliveryStatusSchema
>
export type CaretakerTerminalEvidenceDelivery = z.infer<
  typeof CaretakerTerminalEvidenceDeliverySchema
>

export type { CaretakerEvidenceProfile, CaretakerTerminalEvidenceEnvelope }
export { CaretakerEvidenceProfileSchema, CaretakerTerminalEvidenceEnvelopeSchema }

export interface AuthContext {
  readonly sessionId: string
  readonly principal: Principal
  readonly csrfToken: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly authenticatedAt: string
}

export interface DelegatedAuthContext {
  readonly tokenId: string
  readonly principal: Principal
  readonly expiresAt: string
}

export type ServiceContext = Readonly<{
  principal: Principal
  source: 'worker' | 'verifier' | 'system'
}>

export type ActorContext = AuthContext | ServiceContext

export type OutboxTopic =
  | 'gateway.dispatch'
  | 'gateway.effect.reconcile'
  | 'execution.deadline'
  | 'execution.identity-arrival'
  | 'mission.resume'
  | 'mission.verify'
  | 'operation.reconcile'

export const IDENTITY_ARRIVAL_EXECUTION_TOPIC = 'execution.identity-arrival' as const

export const IdentityArrivalExecutionReferenceSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    operationId: OperationIdSchema,
    executionId: ExecutionIdSchema,
    evidenceId: EvidenceIdSchema,
  })
  .strict()

export type IdentityArrivalExecutionReference = z.infer<
  typeof IdentityArrivalExecutionReferenceSchema
>

export function identityArrivalExecutionOutboxIdentity(
  input: IdentityArrivalExecutionReference,
): Readonly<{ outboxId: string; deduplicationKey: string }> {
  const reference = IdentityArrivalExecutionReferenceSchema.parse(input)
  const digest = hashToolValue({ topic: IDENTITY_ARRIVAL_EXECUTION_TOPIC, reference })
  return {
    outboxId: `out_identity_${digest.slice(0, 32)}`,
    deduplicationKey: `${IDENTITY_ARRIVAL_EXECUTION_TOPIC}:${digest}`,
  }
}

export const IdentityArrivalExecutionEnqueueResultSchema = z
  .object({
    topic: z.literal(IDENTITY_ARRIVAL_EXECUTION_TOPIC),
    outboxId: z.string().regex(/^out_identity_[a-f0-9]{32}$/),
    deduplicationKey: z.string().regex(/^execution\.identity-arrival:[a-f0-9]{64}$/),
    reference: IdentityArrivalExecutionReferenceSchema,
    status: z.enum(['duplicate', 'stored']),
  })
  .strict()
  .superRefine((result, context) => {
    const identity = identityArrivalExecutionOutboxIdentity(result.reference)
    if (
      result.outboxId !== identity.outboxId ||
      result.deduplicationKey !== identity.deduplicationKey
    ) {
      context.addIssue({
        code: 'custom',
        path: ['outboxId'],
        message: 'Identity-arrival execution job identity does not match its exact reference',
      })
    }
  })

export type IdentityArrivalExecutionEnqueueResult = z.infer<
  typeof IdentityArrivalExecutionEnqueueResultSchema
>

export interface OutboxMessage {
  readonly id: string
  readonly organizationId: OrganizationId
  readonly topic: OutboxTopic
  readonly deduplicationKey: string
  readonly payload: Readonly<Record<string, JsonValue>>
  readonly status: 'pending' | 'claimed' | 'dispatched' | 'cancelled'
  readonly availableAt: string
  readonly createdAt: string
  readonly claimedBy: string | null
  readonly claimExpiresAt: string | null
  readonly dispatchedAt: string | null
  readonly deliveryAttempts: number
  readonly lastErrorCode: string | null
}

export const GatewayDispatchReferenceSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    operationId: OperationIdSchema,
    commandId: GatewayCommandIdSchema,
    generation: z.number().int().positive(),
  })
  .strict()

export type GatewayDispatchReference = z.infer<typeof GatewayDispatchReferenceSchema>

export const GatewayEffectReconciliationReferenceSchema = GatewayDispatchReferenceSchema

export type GatewayEffectReconciliationReference = GatewayDispatchReference

export const ExecutionDeadlineReferenceSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    operationId: OperationIdSchema,
    executionId: ExecutionIdSchema,
  })
  .strict()

export type ExecutionDeadlineReference = z.infer<typeof ExecutionDeadlineReferenceSchema>

export const MissionReferenceSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
  })
  .strict()

export type MissionReference = z.infer<typeof MissionReferenceSchema>

export const OperationReferenceSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    operationId: OperationIdSchema,
  })
  .strict()

export type OperationReference = z.infer<typeof OperationReferenceSchema>

export const OperationReconciliationReferenceSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    operationId: OperationIdSchema,
    attemptId: AttemptIdSchema,
  })
  .strict()

export type OperationReconciliationReference = z.infer<
  typeof OperationReconciliationReferenceSchema
>

export const DeviceExecutionMilestoneNameSchema = z.enum([
  'preheat',
  'pathway_lighting',
  'unlock',
  'relock',
])

export type DeviceExecutionMilestoneName = Exclude<ExecutionMilestoneName, 'verified_arrival'>

export const GatewayEffectCancellationPolicySchema = z.enum([
  'cancel_if_pending',
  'mandatory_relock',
])

export type GatewayEffectCancellationPolicy = z.infer<typeof GatewayEffectCancellationPolicySchema>

export const GatewayEffectAuthorizationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }).strict(),
  z.object({ kind: z.literal('mission_lease'), epoch: z.number().int().positive() }).strict(),
])

export type GatewayEffectAuthorization = z.infer<typeof GatewayEffectAuthorizationSchema>

export type PlannedGatewayEffect = GatewayCommandInstruction &
  Readonly<{
    logicalKey: GatewayCommandLogicalKey
    dispatchAt: string
    milestone: DeviceExecutionMilestoneName
    cancellationPolicy: GatewayEffectCancellationPolicy
  }>

export const PlannedGatewayEffectSchema: z.ZodType<PlannedGatewayEffect> = z
  .unknown()
  .transform((value, context): PlannedGatewayEffect => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Expected a canonical gateway instruction with an ISO dispatch time',
      })
      return z.NEVER
    }
    const { cancellationPolicy, dispatchAt, logicalKey, milestone, ...instructionInput } =
      value as Record<string, unknown>
    const parsedDispatchAt = IsoDateTimeSchema.safeParse(dispatchAt)
    const parsedInstruction = GatewayCommandInstructionSchema.safeParse(instructionInput)
    const parsedLogicalKey = GatewayCommandLogicalKeySchema.safeParse(logicalKey)
    const parsedMilestone = DeviceExecutionMilestoneNameSchema.safeParse(milestone)
    const parsedCancellationPolicy =
      GatewayEffectCancellationPolicySchema.safeParse(cancellationPolicy)
    if (
      !parsedDispatchAt.success ||
      !parsedInstruction.success ||
      !parsedLogicalKey.success ||
      !parsedMilestone.success ||
      !parsedCancellationPolicy.success
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expected a canonical gateway instruction with an ISO dispatch time',
      })
      return z.NEVER
    }
    return {
      ...parsedInstruction.data,
      logicalKey: parsedLogicalKey.data,
      dispatchAt: parsedDispatchAt.data,
      milestone: parsedMilestone.data,
      cancellationPolicy: parsedCancellationPolicy.data,
    }
  })

export interface GatewayEffectRecord {
  readonly command: GatewayCommand
  readonly dispatchAt: string
  readonly milestone: DeviceExecutionMilestoneName
  readonly cancellationPolicy: GatewayEffectCancellationPolicy
  readonly authorization: GatewayEffectAuthorization
  readonly dispatchState: GatewayDispatchState
  readonly effectState: GatewayEffectState
  readonly reconciliationAttempts: number
  readonly lastReconciledAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export const GatewayEffectRecordSchema: z.ZodType<GatewayEffectRecord> = z
  .object({
    command: GatewayCommandSchema,
    dispatchAt: IsoDateTimeSchema,
    milestone: DeviceExecutionMilestoneNameSchema,
    cancellationPolicy: GatewayEffectCancellationPolicySchema,
    authorization: GatewayEffectAuthorizationSchema,
    dispatchState: GatewayDispatchStateSchema,
    effectState: GatewayEffectStateSchema,
    reconciliationAttempts: z.number().int().nonnegative(),
    lastReconciledAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.command.id !== record.dispatchState.commandId ||
      record.command.id !== record.effectState.commandId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['command', 'id'],
        message: 'Gateway effect state must bind the materialized command',
      })
    }
    const isRelock = record.milestone === 'relock' && record.command.kind === 'locked_desired_state'
    if ((record.cancellationPolicy === 'mandatory_relock') !== isRelock) {
      context.addIssue({
        code: 'custom',
        path: ['cancellationPolicy'],
        message: 'Only the relock desired-state effect may survive cancellation',
      })
    }
  })

export interface GatewayEffectIntent {
  readonly command: GatewayCommand
  readonly dispatchAt: string
  readonly milestone: DeviceExecutionMilestoneName
  readonly cancellationPolicy: GatewayEffectCancellationPolicy
  readonly authorization: GatewayEffectAuthorization
  readonly createdAt: string
}

export interface GatewayEffectMaterialization {
  readonly intent: GatewayEffectIntent
  readonly dispatchOutboxId: string
}

export type GatewayEffectMaterializationResult =
  | Readonly<{ status: 'created'; effect: GatewayEffectRecord }>
  | Readonly<{ status: 'existing'; effect: GatewayEffectRecord }>

export type GatewayDispatchClaimResult =
  | Readonly<{
      status: 'claimed'
      effect: GatewayEffectRecord
      attempt: Attempt
    }>
  | Readonly<{
      status: 'not_claimed'
      reason:
        | 'cancelled'
        | 'not_due'
        | 'already_dispatching'
        | 'authorization_invalid'
        | 'capability_unavailable'
        | 'dispatch_terminal'
        | 'effect_terminal'
      effect: GatewayEffectRecord
    }>

export type GatewayDispatchFinalizationResult = Readonly<{
  status: 'applied' | 'already_finalized' | 'stale_generation'
  effect: GatewayEffectRecord
  attempt: Attempt
}>

export type GatewayCallbackApplicationResult = Readonly<{
  status: 'advanced' | 'duplicate' | 'replayed'
  effect: GatewayEffectRecord
  callback: StoredGatewayCallback
}>

export interface GatewayPendingCancellationResult {
  readonly cancelledCommandIds: readonly GatewayCommand['id'][]
  readonly preservedCommandIds: readonly GatewayCommand['id'][]
  readonly reconciliationCommandIds: readonly GatewayCommand['id'][]
}

export type GatewayEffectReconciliationResult =
  | Readonly<{ status: 'cancelled' | 'resolved'; effect: GatewayEffectRecord }>
  | Readonly<{ status: 'retry_authorized'; effect: GatewayEffectRecord }>
  | Readonly<{
      status: 'waiting_for_callback'
      effect: GatewayEffectRecord
      nextPollAt: string
    }>
  | Readonly<{ status: 'intervention_required'; effect: GatewayEffectRecord }>

export interface ExecutionMilestoneUpdateResult {
  readonly status: 'advanced' | 'replayed'
  readonly execution: Execution
}

export type ExecutionReadinessResult =
  | Readonly<{ status: 'not_ready'; execution: Execution }>
  | Readonly<{
      status: 'finalized' | 'replayed'
      reason: 'all_completed' | 'known_failure' | 'deadline_elapsed'
      execution: Execution
    }>

export interface PersistedEvidenceApplication {
  readonly record: PersistedEvidenceRecord
  readonly execution: Execution
}

export const AuthenticatedGatewayPrincipalSchema = z
  .object({
    id: z.string().regex(/^gwp_[A-Za-z0-9_-]{8,64}$/),
    organizationId: OrganizationIdSchema,
  })
  .strict()

export const VerifiedGatewayCallbackSchema = z
  .object({
    callback: GatewayCallbackSchema,
    authenticatedPrincipal: AuthenticatedGatewayPrincipalSchema,
    verifierKeyId: GatewaySignatureMetadataSchema.shape.keyId,
    verifierKeyVersion: z.number().int().positive(),
    verifierVersion: z.literal(1),
    signatureTimestamp: IsoDateTimeSchema,
    verifiedPayloadDigest: Sha256Schema,
  })
  .strict()
  .superRefine((verified, context) => {
    if (verified.callback.organizationId !== verified.authenticatedPrincipal.organizationId) {
      context.addIssue({
        code: 'custom',
        path: ['callback', 'organizationId'],
        message: 'Gateway callback organization must match its authenticated principal',
      })
    }
  })

export type VerifiedGatewayCallback = z.output<typeof VerifiedGatewayCallbackSchema>

export interface StoredGatewayCallback extends GatewayCallback {
  readonly verifierKeyId: VerifiedGatewayCallback['verifierKeyId']
  readonly verifierVersion: VerifiedGatewayCallback['verifierVersion']
  readonly verifiedPayloadDigest: Sha256
  readonly receivedAt: string
}

export const IdentityTelemetryIngressProvenanceSchema = z
  .object({
    schemaVersion: z.literal('identity-telemetry-ingress@1'),
    providerEventId: IdentityTelemetryProviderEventIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    palaceId: PalaceIdSchema,
    identityTagId: IdentityTagIdSchema,
    nonce: IdentityTelemetryNonceSchema,
    principalId: IdentityTelemetryPrincipalIdSchema,
    keyId: IdentityTelemetryKeyIdSchema,
    keyVersion: z.number().int().positive(),
    verifiedPayloadHash: Sha256Schema,
    signatureTimestamp: IsoDateTimeSchema,
    verifiedAt: IsoDateTimeSchema,
    evidenceId: EvidenceIdSchema,
    authorityReceiptId: ReceiptIdSchema,
    identityVerified: z.boolean(),
  })
  .strict()

export type IdentityTelemetryIngressProvenance = z.output<
  typeof IdentityTelemetryIngressProvenanceSchema
>

export interface IdentityTelemetryVerificationKey {
  readonly principal: Omit<IdentityTelemetryPrincipal, 'purpose'> & {
    readonly purpose: string
  }
  readonly key: string | Uint8Array
}

export interface IdentityTelemetryEvidenceAppendResult {
  readonly status: 'duplicate' | 'stored'
  readonly record: PersistedEvidenceRecord
  readonly provenance: IdentityTelemetryIngressProvenance
}

export interface IdentityTelemetryIngestionResult extends IdentityTelemetryEvidenceAppendResult {
  readonly event: IdentityTelemetryEvent
  readonly executionJobs: readonly IdentityArrivalExecutionEnqueueResult[]
}

export interface StoredExecution {
  readonly operationId: OperationId
  readonly execution: Execution
  readonly authorization: GatewayEffectAuthorization
}

export interface CancellationRecord {
  readonly id: string
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly requestedBy: string
  readonly reason: string
  readonly checkpoint:
    | 'before_operation'
    | 'unclaimed_operation'
    | 'claimed_or_committed'
    | 'gateway_dispatched'
    | 'durable_effect'
  readonly outcome:
    | 'cancelled_without_mutation'
    | 'cancelled_unclaimed_operations'
    | 'stopped_remaining_actions'
    | 'reconcile_dispatched_effect'
    | 'compensating_plan_required'
  readonly compensatingPlanRequired: boolean
  readonly requestedAt: string
}

export interface CancellationResult {
  readonly cancellation: CancellationRecord
  readonly mission: Mission
}

export interface CompensatingPlanLink {
  readonly organizationId: OrganizationId
  readonly planId: PlanId
  readonly actionId: PlanActionId
  readonly compensatesOperationId: OperationId
  readonly createdAt: string
}

export interface PlanValidationRecord {
  readonly planId: PlanId
  readonly valid: boolean
  readonly checks: readonly PlanValidationCheck[]
  readonly createdAt: string
}

export interface PlanValidationCheck {
  readonly type: 'capability' | 'conflict' | 'hard_invariant' | 'schema'
  readonly passed: boolean
  readonly message: string
}

export type SimulationScenario = 'access' | 'energy' | 'timing' | 'transport_failure'

export interface PlanSimulationRecord {
  readonly planId: PlanId
  readonly feasible: boolean
  readonly projectedBatteryUsePercentagePoints: number
  readonly results: readonly {
    readonly scenario: SimulationScenario
    readonly passed: boolean
    readonly evidence: string
  }[]
  readonly createdAt: string
}

export interface ReconciliationPoll {
  readonly organizationId: OrganizationId
  readonly operationId: OperationId
  readonly sequence: number
  readonly resolution: 'committed' | 'definitely_absent' | 'still_unknown' | 'failed'
  readonly occurredAt: string
}

export interface VerificationInput {
  readonly missionId: MissionId
  readonly evidenceIds: readonly EvidenceId[]
}

export interface StoredVerification {
  readonly verification: Verification
}

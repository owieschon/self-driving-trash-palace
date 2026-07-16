import {
  ApprovalIdSchema,
  ContextReceiptSchema,
  ContextReceiptIdSchema,
  EvidenceIdSchema,
  MissionIdSchema,
  MissionSchema,
  OperationIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PlanActionIdSchema,
  PlanIdSchema,
  PlansProposeInputSchema,
  PrincipalSchema,
  ReceiptIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  RunIdSchema,
  Sha256Schema,
  TOOL_REGISTRY_HASH,
  ToolCallIdSchema,
  ToolCallReceiptSchema,
  UserIdSchema,
  hashToolValue,
  parseToolResult,
  projectToolSchema,
  type Mission,
  type MissionState,
  type EvidenceId,
  type RunId,
  type Sha256,
  type ToolName,
} from '@trash-palace/core'
import {
  MissionLeaseService,
  MissionLifecycleService,
  NOOP_OBSERVABILITY,
  type CaretakerTerminalEvidenceDelivery,
  type CaretakerRunSnapshot,
  type MissionExecutionContext,
  type MissionExecutionUnitOfWorkPort,
  type MissionFence,
  type SystemCaretakerEvidenceDeliveryPort,
  type TenantRepositories,
} from '@trash-palace/application'
import {
  FixedEntropy,
  InMemoryApplicationStore,
  SequentialIdGenerator,
} from '@trash-palace/application/testing'
import {
  AnalyticsAliaser,
  InMemoryEvidenceSink,
  type EvidenceCaptureResult,
  type EvidenceSink,
  type SafeEvidenceEvent,
} from '@trash-palace/observability'
import { describe, expect, it } from 'vitest'

import { contextBundleHashForReceipt } from './caretaker-context.js'
import { CaretakerEvidenceRecorder } from './caretaker-evidence.js'
import {
  CaretakerLifecycleHost,
  type CaretakerHostClock,
  type CaretakerHostProjection,
  type CaretakerHostProjectionPort,
  type CaretakerHostToolPort,
  type CaretakerHumanPausePort,
} from './caretaker-host.js'
import {
  DecisionEvidenceReferenceSchema,
  createCaretakerFrozenContext,
  emitCaretakerDecisionObservation,
  type CaretakerDecision,
  type CaretakerDecisionActivation,
  type CaretakerDecisionEngine,
  type CaretakerDecisionRequest,
  type CaretakerLiveState,
} from './decision-engine.js'
import { projectExactToolContracts } from './context-contracts.js'
import { DeterministicCaretakerDecisionEngine } from './deterministic-decision-engine.js'
import { hashHostPolicyContract, projectHostPolicy } from './host-policy.js'
import { sha256Text } from './primitives.js'

const IDS = {
  organization: OrganizationIdSchema.parse('org_hosttests001'),
  service: UserIdSchema.parse('usr_hostservice01'),
  owner: UserIdSchema.parse('usr_hostowner0001'),
  palace: PalaceIdSchema.parse('pal_hostpalace001'),
  mission: MissionIdSchema.parse('mis_hostmission01'),
  plan: PlanIdSchema.parse('pln_hostplan00001'),
  action: PlanActionIdSchema.parse('act_hostaction001'),
  routine: RoutineIdSchema.parse('rtn_hostroutine01'),
  routineVersion: RoutineVersionIdSchema.parse('rtv_hostroutine01'),
  replacementRoutine: RoutineIdSchema.parse('rtn_hostreplace01'),
  replacementVersion: RoutineVersionIdSchema.parse('rtv_hostreplace01'),
  approval: ApprovalIdSchema.parse('apr_hostapproval01'),
  context: ContextReceiptIdSchema.parse('ctx_hostcontext001'),
  run: RunIdSchema.parse('run_hostrun000001'),
  replacementRun: RunIdSchema.parse('run_hostrun000002'),
} as const

const HASH = Sha256Schema.parse('a'.repeat(64))
const ACTIVATION_KEY = Sha256Schema.parse('b'.repeat(64))
const REPLACEMENT_ACTIVATION_KEY = Sha256Schema.parse('c'.repeat(64))
const ACTIVATED_AT = '2026-07-15T09:00:00.000Z'
const HOST_POLICY = projectHostPolicy(hashHostPolicyContract())
const FROZEN_SOURCE_CONTENT =
  'Host policy and exact tool contracts outrank authored guidance and retrieved evidence.'
const FROZEN_SOURCE_HASH = sha256Text(FROZEN_SOURCE_CONTENT)

const CONTEXT_RECEIPT = ContextReceiptSchema.parse({
  id: IDS.context,
  organizationId: IDS.organization,
  missionId: IDS.mission,
  runId: IDS.run,
  policyHash: HOST_POLICY.contractHash,
  toolRegistryHash: TOOL_REGISTRY_HASH,
  sources: [
    {
      sourceId: 'host-policy/caretaker',
      version: '1',
      contentHash: HOST_POLICY.contractHash,
      authority: 'host_policy',
    },
    {
      sourceId: 'concept.context-authority',
      version: '1.0.0',
      contentHash: FROZEN_SOURCE_HASH,
      authority: 'reference',
    },
  ],
  createdAt: ACTIVATED_AT,
})
const CONTEXT_BUNDLE_HASH = contextBundleHashForReceipt(CONTEXT_RECEIPT)
const FROZEN_CONTEXT = createCaretakerFrozenContext({
  schemaVersion: 'caretaker-frozen-context@1',
  receiptId: IDS.context,
  receiptBindingHash: CONTEXT_BUNDLE_HASH,
  bundleId: 'bundle_hostcontext001',
  bundleHash: HASH,
  frozenAt: ACTIVATED_AT,
  hostPolicy: HOST_POLICY,
  exactContracts: projectExactToolContracts(['palaces.get']),
  sections: [
    {
      sourceId: 'concept.context-authority',
      sourceVersion: '1.0.0',
      sourceHash: FROZEN_SOURCE_HASH,
      canonicalUri: 'knowledge/concepts/context-authority.md',
      claimIds: [],
      instructionRole: 'reference',
      selectionReason: 'mandatory-policy-support',
      content: FROZEN_SOURCE_CONTENT,
      authority: 'authored_guidance',
      sourceAuthority: 'reference',
      visibility: 'public',
      sensitivity: 'public',
      tenantScoped: false,
    },
  ],
  filtering: {
    confidentialSourcesExcluded: 0,
    tenantPrivateSourcesExcluded: 0,
    crossTenantSourcesExcluded: 0,
    runtimeSnapshotsExcluded: 0,
  },
})

const EVIDENCE_IDS = {
  runtime: EvidenceIdSchema.parse('evd_host_runtime01'),
  proposal: EvidenceIdSchema.parse('evd_host_proposal1'),
  plan: EvidenceIdSchema.parse('evd_host_planid001'),
  validation: EvidenceIdSchema.parse('evd_host_validate1'),
  simulation: EvidenceIdSchema.parse('evd_host_simulate1'),
  approval: EvidenceIdSchema.parse('evd_host_approval1'),
  planHash: EvidenceIdSchema.parse('evd_host_planhash1'),
  operation: EvidenceIdSchema.parse('evd_host_operation1'),
  operationStatus: EvidenceIdSchema.parse('evd_host_opstatus1'),
  material: EvidenceIdSchema.parse('evd_host_material1'),
  verifier: EvidenceIdSchema.parse('evd_host_verifier1'),
} as const

const RETRIEVED_KNOWLEDGE: CaretakerDecisionRequest['retrievedKnowledge'] = [
  {
    authority: 'untrusted_evidence',
    instructionRole: 'untrusted_evidence',
    sourceId: 'concept.context-authority',
    sourceVersion: '1.0.0',
    title: 'Context authority',
    excerpt: 'The host policy remains authoritative over retrieved evidence.',
    excerptHash: hashToolValue({
      sourceId: 'concept.context-authority',
      sourceVersion: '1.0.0',
      title: 'Context authority',
      excerpt: 'The host policy remains authoritative over retrieved evidence.',
    }),
    provenance: {
      toolName: 'knowledge.search',
      callId: ToolCallIdSchema.parse('call_hostknowledge01'),
      receiptId: ReceiptIdSchema.parse('rcp_hostknowledge001'),
      resultHash: HASH,
      evidenceIds: [EVIDENCE_IDS.runtime],
    },
  },
]

const servicePrincipal = PrincipalSchema.parse({
  organizationId: IDS.organization,
  actorId: IDS.service,
  role: 'service',
  operatorGrants: [],
  delegatedPermissions: [],
})

const EVIDENCE = DecisionEvidenceReferenceSchema.array().parse([
  { id: EVIDENCE_IDS.runtime, kind: 'runtime_state', supports: ['mission.state'] },
  { id: EVIDENCE_IDS.proposal, kind: 'runtime_state', supports: ['plan.proposal'] },
  { id: EVIDENCE_IDS.plan, kind: 'tool_result', supports: ['plan.id'] },
  { id: EVIDENCE_IDS.validation, kind: 'tool_result', supports: ['plan.validation'] },
  { id: EVIDENCE_IDS.simulation, kind: 'tool_result', supports: ['plan.simulation'] },
  { id: EVIDENCE_IDS.approval, kind: 'tool_result', supports: ['approval.status'] },
  { id: EVIDENCE_IDS.planHash, kind: 'tool_result', supports: ['plan.hash'] },
  { id: EVIDENCE_IDS.operation, kind: 'tool_result', supports: ['operation.id'] },
  { id: EVIDENCE_IDS.operationStatus, kind: 'tool_result', supports: ['operation.status'] },
  { id: EVIDENCE_IDS.material, kind: 'runtime_state', supports: ['clarification.field'] },
  { id: EVIDENCE_IDS.verifier, kind: 'verifier_receipt', supports: ['verification.status'] },
])

type EvidenceReference = CaretakerHostProjection['evidence'][number]

const PROPOSAL = PlansProposeInputSchema.parse({
  missionId: IDS.mission,
  revision: 1,
  actions: [
    {
      id: IDS.action,
      type: 'replace_homecoming_routine' as const,
      palaceId: IDS.palace,
      protectedRoutineId: IDS.routine,
      protectedRoutineVersionId: IDS.routineVersion,
      expectedProtectedVersion: 1,
      replacementRoutineId: IDS.replacementRoutine,
      replacementRoutineVersionId: IDS.replacementVersion,
      replacement: {
        name: 'Night Shift Homecoming',
        trigger: {
          type: 'verified_arrival' as const,
          windowStart: '00:00',
          windowEnd: '03:00',
          timezone: 'America/New_York',
        },
        actions: [
          { type: 'preheat' as const, targetCelsius: 20, completeBy: '02:00' },
          {
            type: 'pathway_lighting' as const,
            intensityPercent: 40,
            durationSeconds: 900,
            beginsAfter: 'verified_arrival' as const,
          },
          {
            type: 'unlock' as const,
            durationSeconds: 90,
            requireVerifiedIdentity: true as const,
          },
          { type: 'lock_desired_state' as const, afterUnlockSeconds: 90 },
        ],
        constraints: {
          projectedBatteryUseMaxPercentagePoints: 15,
          hardInvariantIds: [
            'tenant_context_host_derived',
            'verified_identity_required_for_unlock',
            'routine_activation_validated',
            'exact_plan_approval_required',
            'retry_preserves_logical_operation',
            'verifier_owns_mission_success',
            'secrets_excluded_from_model_context',
          ],
        },
        projectedBatteryUsePercentagePoints: 13,
      },
    },
  ],
  successCriteriaIds: ['verified_arrival_required'],
})

function planState(status: CaretakerLiveState['plan']['status']): CaretakerLiveState['plan'] {
  if (status === 'draft_ready') {
    return {
      status,
      proposal: PROPOSAL,
      planId: null,
      actionId: null,
      expectedVersion: null,
      protectedRoutineId: null,
      protectedRoutineVersionId: null,
    }
  }
  if (status === 'absent') {
    return {
      status,
      proposal: null,
      planId: null,
      actionId: null,
      expectedVersion: null,
      protectedRoutineId: null,
      protectedRoutineVersionId: null,
    }
  }
  return {
    status,
    proposal: null,
    planId: IDS.plan,
    actionId: IDS.action,
    expectedVersion: status === 'approved' ? 1 : null,
    protectedRoutineId: status === 'stale' ? IDS.routine : null,
    protectedRoutineVersionId: status === 'stale' ? IDS.routineVersion : null,
  }
}

function liveState(
  planStatus: CaretakerLiveState['plan']['status'] = 'draft_ready',
): CaretakerLiveState {
  return {
    access: 'authorized',
    discovery: {
      palace: 'ready',
      crew: 'ready',
      capabilities: 'ready',
      routines: 'ready',
      knowledge: 'ready',
    },
    materialIssue: null,
    capabilityFit: 'supported',
    plan: planState(planStatus),
    operation: { status: 'absent', operationId: null, reconciliationRequired: false },
    verification: { status: 'not_ready', claims: [], failedCriteria: [] },
    integrityAlerts: [],
  }
}

function reconciledLiveState(state: CaretakerLiveState): CaretakerLiveState {
  return {
    ...state,
    operation: {
      status: 'committed',
      operationId: OperationIdSchema.parse('op_hostoperation1'),
      reconciliationRequired: false,
    },
    verification: { status: 'evidence_needed', claims: [], failedCriteria: [] },
  }
}

function makeMission(state: MissionState, taskLedger: Mission['taskLedger'] = []): Mission {
  return MissionSchema.parse({
    id: IDS.mission,
    organizationId: IDS.organization,
    palaceId: IDS.palace,
    initiatedBy: IDS.owner,
    objective: 'Create one safe homecoming routine',
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    successCriteriaIds: ['verified_arrival_required'],
    state,
    version: 1,
    runId: null,
    contextReceiptId: IDS.context,
    taskLedger,
    createdAt: ACTIVATED_AT,
    updatedAt: ACTIVATED_AT,
  })
}

class TestClock implements CaretakerHostClock {
  #current = new Date(ACTIVATED_AT)
  #monotonic = 0

  now(): Date {
    return new Date(this.#current)
  }

  monotonicMilliseconds(): number {
    return this.#monotonic
  }

  advance(milliseconds: number): void {
    this.#current = new Date(this.#current.getTime() + milliseconds)
    this.#monotonic += milliseconds
  }
}

class FailOnceToolEvidenceSink implements EvidenceSink {
  readonly #inner = new InMemoryEvidenceSink()
  #failed = false

  public capture(event: SafeEvidenceEvent): Promise<EvidenceCaptureResult> {
    if (!this.#failed && event.event === '$ai_span' && event.properties.span_kind === 'tool') {
      this.#failed = true
      throw new Error('Injected tool evidence outage')
    }
    return this.#inner.capture(event)
  }

  public all(): Promise<readonly SafeEvidenceEvent[]> {
    return this.#inner.all()
  }
}

class ToggleTerminalEvidenceSink implements EvidenceSink {
  readonly #inner = new InMemoryEvidenceSink()
  failTerminal = true

  public capture(event: SafeEvidenceEvent): Promise<EvidenceCaptureResult> {
    if (this.failTerminal && event.event === '$ai_trace') {
      throw new Error('Injected terminal evidence outage')
    }
    return this.#inner.capture(event)
  }

  public all(): Promise<readonly SafeEvidenceEvent[]> {
    return this.#inner.all()
  }
}

class FailOnceAcknowledgementDeliveryPort implements SystemCaretakerEvidenceDeliveryPort {
  #failed = false

  public constructor(private readonly inner: SystemCaretakerEvidenceDeliveryPort) {}

  public get(runId: RunId): Promise<CaretakerTerminalEvidenceDelivery | null> {
    return this.inner.get(runId)
  }

  public listPending(limit: number): Promise<readonly CaretakerTerminalEvidenceDelivery[]> {
    return this.inner.listPending(limit)
  }

  public acknowledge(input: {
    readonly runId: RunId
    readonly eventHash: Sha256
    readonly captureStatus: 'stored' | 'duplicate'
    readonly deliveredAt: string
  }): Promise<'acknowledged' | 'already_acknowledged'> {
    if (!this.#failed) {
      this.#failed = true
      throw new Error('Injected crash after terminal evidence capture')
    }
    return this.inner.acknowledge(input)
  }
}

class TestWorld implements CaretakerHostProjectionPort, CaretakerHumanPausePort {
  lastToolResult: CaretakerDecisionRequest['lastToolResult'] = null

  public constructor(
    readonly store: InMemoryApplicationStore,
    public state: CaretakerLiveState,
    private readonly context: MissionExecutionContext,
    public evidence: readonly EvidenceReference[] = EVIDENCE,
  ) {}

  async load(): Promise<CaretakerHostProjection> {
    const mission = await this.store.run(IDS.organization, async (repositories) => {
      const value = await repositories.missions.get(IDS.mission)
      if (value === null) throw new Error('Test mission is absent')
      return value
    })
    return {
      contextReceiptId: IDS.context,
      contextBundleHash: CONTEXT_BUNDLE_HASH,
      frozenContext: FROZEN_CONTEXT,
      retrievedKnowledge: RETRIEVED_KNOWLEDGE,
      mission,
      evidence: this.evidence,
      liveState: this.state,
      lastToolResult: this.lastToolResult,
    }
  }

  async requestClarification(): Promise<void> {
    await this.setMissionState({ status: 'waiting_for_user', phase: 'plan' })
  }

  async setMissionState(state: MissionState): Promise<void> {
    await this.store.runFenced(this.context.fence, async (repositories) => {
      const mission = await repositories.missions.get(IDS.mission)
      if (mission === null) throw new Error('Test mission is absent')
      const saved = await repositories.missions.save(
        {
          ...mission,
          state,
          version: mission.version + 1,
          updatedAt: new Date(Date.parse(mission.updatedAt) + 1).toISOString(),
        },
        mission.version,
      )
      if (!saved) throw new Error('Test mission update conflicted')
    })
  }
}

type ToolBehavior =
  | 'call_in_progress'
  | 'failed'
  | 'never'
  | 'pending'
  | 'pending_approval'
  | 'reconciliation_pending'
  | 'reject'
  | 'succeeded_approval'
  | 'unknown_activation'

class RecordingToolPort implements CaretakerHostToolPort {
  readonly attempts: string[] = []
  readonly executions: string[] = []
  readonly #durable = new Map<string, Awaited<ReturnType<CaretakerHostToolPort['invoke']>>>()
  crashAfterDurableResult = false

  public constructor(
    private readonly world: TestWorld,
    private readonly clock: TestClock,
    private readonly behavior: (toolName: ToolName) => ToolBehavior = () => 'call_in_progress',
    private readonly durationMilliseconds = 0,
    private readonly receiptTimeOffsetMilliseconds = 0,
  ) {}

  async invoke(input: Parameters<CaretakerHostToolPort['invoke']>[0]) {
    input.signal.throwIfAborted()
    this.attempts.push(input.pendingToolCall.callId)
    const startedAt = this.#receiptTime().toISOString()
    this.clock.advance(this.durationMilliseconds)
    const existing = this.#durable.get(input.pendingToolCall.callId)
    if (existing !== undefined) {
      this.world.lastToolResult = lastToolResult(existing.result, existing.evidenceIds)
      return existing
    }

    this.executions.push(input.pendingToolCall.callId)
    const raw = await this.#execute(input)
    if (isTransientToolResult(raw.result)) {
      throw new Error('Transient dispatcher state has no durable tool receipt')
    }
    const observed = withToolReceipt(
      input.pendingToolCall,
      raw,
      startedAt,
      this.#receiptTime().toISOString(),
    )
    this.#durable.set(input.pendingToolCall.callId, observed)
    this.world.lastToolResult = lastToolResult(observed.result, observed.evidenceIds)
    if (this.crashAfterDurableResult) {
      this.crashAfterDurableResult = false
      throw new Error('Injected crash after durable tool result')
    }
    return observed
  }

  #receiptTime(): Date {
    return new Date(this.clock.now().valueOf() + this.receiptTimeOffsetMilliseconds)
  }

  async #execute(input: Parameters<CaretakerHostToolPort['invoke']>[0]) {
    const { callId, toolName } = input.pendingToolCall
    const behavior = this.behavior(toolName)
    if (behavior === 'never') return new Promise<never>(() => undefined)
    if (behavior === 'reject') throw new Error('Injected tool adapter rejection')
    if (behavior === 'succeeded_approval') {
      this.world.state = { ...this.world.state, plan: planState('awaiting_approval') }
      await this.world.setMissionState({ status: 'waiting_for_user', phase: 'approve' })
      return {
        result: {
          schemaVersion: 'tool-result@1',
          toolName,
          callId,
          status: 'succeeded',
          retryable: false,
          receiptId: receiptIdFor(callId),
          resourceVersion: null,
          data: { approvalRequestId: IDS.approval, paused: true },
          error: null,
        },
        evidenceIds: [EVIDENCE_IDS.approval],
      }
    }
    if (behavior === 'pending_approval') {
      this.world.state = { ...this.world.state, plan: planState('awaiting_approval') }
      await this.world.setMissionState({ status: 'waiting_for_user', phase: 'approve' })
      return {
        result: {
          schemaVersion: 'tool-result@1',
          toolName,
          callId,
          status: 'pending',
          retryable: false,
          receiptId: receiptIdFor(callId),
          resourceVersion: null,
          data: { approvalRequestId: IDS.approval, paused: true },
          error: null,
        },
        evidenceIds: [EVIDENCE_IDS.approval],
      }
    }
    if (behavior === 'unknown_activation') {
      this.world.state = {
        ...this.world.state,
        operation: {
          status: 'outcome_unknown',
          operationId: OperationIdSchema.parse('op_hostoperation1'),
          reconciliationRequired: true,
        },
      }
      await this.world.setMissionState({ status: 'running', phase: 'reconcile' })
      return {
        result: resultEnvelope(toolName, callId, 'unknown'),
        evidenceIds: [EVIDENCE_IDS.operationStatus],
      }
    }
    if (behavior === 'call_in_progress' || behavior === 'reconciliation_pending') {
      return {
        result: resultEnvelope(
          toolName,
          callId,
          'pending',
          behavior === 'call_in_progress' ? 'CALL_IN_PROGRESS' : 'RECONCILIATION_PENDING',
        ),
        evidenceIds: [],
      }
    }
    if (behavior === 'pending') {
      this.world.state = {
        ...this.world.state,
        operation: {
          status: 'pending',
          operationId: OperationIdSchema.parse('op_hostoperation1'),
          reconciliationRequired: true,
        },
      }
      await this.world.setMissionState({ status: 'running', phase: 'reconcile' })
      return {
        result: resultEnvelope(toolName, callId, 'pending'),
        evidenceIds: [EVIDENCE_IDS.operationStatus],
      }
    }
    return {
      result: resultEnvelope(toolName, callId, behavior),
      evidenceIds: [],
    }
  }
}

function isTransientToolResult(result: unknown): boolean {
  const errorCode = (result as { readonly error?: { readonly code?: unknown } | null }).error?.code
  return errorCode === 'CALL_IN_PROGRESS' || errorCode === 'RECONCILIATION_PENDING'
}

function resultEnvelope(
  toolName: ToolName,
  callId: string,
  status: 'failed' | 'pending' | 'unknown',
  errorCode?: string,
) {
  return {
    schemaVersion: 'tool-result@1',
    toolName,
    callId,
    status,
    retryable: status === 'pending',
    receiptId: receiptIdFor(callId),
    resourceVersion: null,
    data: null,
    error: {
      code:
        errorCode ??
        (status === 'pending'
          ? 'ACCEPTED_PENDING'
          : status === 'unknown'
            ? 'OUTCOME_UNKNOWN'
            : 'SAFE_FAILURE'),
      message: 'Safe test result',
      details: {},
    },
  }
}

function receiptIdFor(callId: string) {
  return ReceiptIdSchema.parse(`rcp_${hashToolValue(callId).slice(0, 32)}`)
}

function withToolReceipt(
  pending: Parameters<CaretakerHostToolPort['invoke']>[0]['pendingToolCall'],
  observed: Readonly<{ result: unknown; evidenceIds: readonly EvidenceId[] }>,
  startedAt: string,
  completedAt: string,
): Awaited<ReturnType<CaretakerHostToolPort['invoke']>> {
  const result = parseToolResult(pending.toolName, observed.result)
  return {
    ...observed,
    receipt: ToolCallReceiptSchema.parse({
      schemaVersion: 'tool-call-receipt@1',
      id: result.receiptId,
      callId: pending.callId,
      toolName: pending.toolName,
      status: result.status,
      channel: 'in_process',
      tenantScopeHash: HASH,
      inputHash: pending.inputHash,
      resultHash: hashToolValue(result),
      toolContractHash: projectToolSchema(pending.toolName).contractHash,
      toolRegistryHash: TOOL_REGISTRY_HASH,
      attemptId: null,
      evidenceIds: observed.evidenceIds,
      startedAt,
      completedAt,
    }),
  }
}

function lastToolResult(
  result: unknown,
  evidenceIds: readonly EvidenceId[],
): NonNullable<CaretakerDecisionRequest['lastToolResult']> {
  const envelope = result as Readonly<{
    toolName: ToolName
    status: 'conflict' | 'denied' | 'failed' | 'pending' | 'succeeded' | 'unknown'
    error: Readonly<{ code: string }> | null
  }>
  return {
    toolName: envelope.toolName,
    status: envelope.status,
    errorCode: envelope.error?.code ?? null,
    evidenceIds: [...evidenceIds],
  }
}

async function observedTestDecision(
  engineId: string,
  request: CaretakerDecisionRequest,
  activation: CaretakerDecisionActivation | undefined,
  decision: CaretakerDecision,
): Promise<CaretakerDecision> {
  await emitCaretakerDecisionObservation(activation, {
    schemaVersion: 'caretaker-decision-observation@1',
    kind: 'deterministic_decision',
    requestId: request.requestId,
    engineId,
    status: 'succeeded',
    decisionKind: decision.kind,
    failureCode: null,
  })
  return decision
}

class FaultingUnitOfWork implements MissionExecutionUnitOfWorkPort {
  faultCheckpointKind: string | null = null
  reportFirstCheckpointAsConflict = false

  public constructor(private readonly inner: MissionExecutionUnitOfWorkPort) {}

  async runFenced<Result>(
    fence: MissionFence,
    work: (repositories: TenantRepositories) => Promise<Result>,
  ): Promise<Result> {
    const result = await this.inner.runFenced(fence, work)
    const snapshot = snapshotFromUnknown(result)
    if (snapshot !== null && this.faultCheckpointKind === snapshot.checkpoint.kind) {
      this.faultCheckpointKind = null
      throw new Error(`Injected crash after ${snapshot.checkpoint.kind}`)
    }
    if (snapshot !== null && this.reportFirstCheckpointAsConflict) {
      this.reportFirstCheckpointAsConflict = false
      return { kind: 'version_conflict', snapshot } as Result
    }
    return result
  }
}

function snapshotFromUnknown(value: unknown): CaretakerRunSnapshot | null {
  if (value === null || typeof value !== 'object' || !('kind' in value) || !('snapshot' in value)) {
    return null
  }
  const snapshot = (value as { readonly snapshot?: unknown }).snapshot
  if (snapshot === null || typeof snapshot !== 'object' || !('checkpoint' in snapshot)) return null
  return snapshot as CaretakerRunSnapshot
}

async function fixture(input: {
  state?: MissionState
  live?: CaretakerLiveState
  taskLedger?: Mission['taskLedger']
  toolBehavior?: (toolName: ToolName) => ToolBehavior
  toolDurationMilliseconds?: number
  toolReceiptTimeOffsetMilliseconds?: number
  engine?: CaretakerDecisionEngine
  evidenceSink?: EvidenceSink
  evidenceDeliveries?: (store: InMemoryApplicationStore) => SystemCaretakerEvidenceDeliveryPort
  projection?: (world: TestWorld, clock: TestClock) => CaretakerHostProjectionPort
}) {
  const clock = new TestClock()
  const mission = makeMission(input.state ?? { status: 'running', phase: 'plan' }, input.taskLedger)
  const store = new InMemoryApplicationStore(
    { missions: [mission], contextReceipts: [CONTEXT_RECEIPT] },
    clock,
  )
  const lease = await new MissionLeaseService(
    store,
    clock,
    new SequentialIdGenerator(),
    new FixedEntropy('host_test_entropy_1234567890'),
  ).acquire({
    organizationId: IDS.organization,
    missionId: IDS.mission,
    ownerId: 'worker-one',
    ttlMilliseconds: 1_000,
  })
  const context: MissionExecutionContext = {
    fence: lease.fence,
    signal: new AbortController().signal,
    principal: servicePrincipal,
  }
  const world = new TestWorld(store, input.live ?? liveState(), context)
  const tools = new RecordingToolPort(
    world,
    clock,
    input.toolBehavior,
    input.toolDurationMilliseconds,
    input.toolReceiptTimeOffsetMilliseconds,
  )
  const unitOfWork = new FaultingUnitOfWork(store)
  const evidenceSink = input.evidenceSink ?? new InMemoryEvidenceSink()
  const evidenceDeliveries = input.evidenceDeliveries?.(store) ?? store
  const evidenceRecorder = new CaretakerEvidenceRecorder({
    sink: evidenceSink,
    deliveries: evidenceDeliveries,
    aliaser: new AnalyticsAliaser('test-only-host-alias-key-with-at-least-32-bytes'),
    environment: 'test',
    dataOrigin: 'fixture',
    appVersion: '0.0.0-test',
    harnessVersion: 'caretaker-host@1',
    modelConfigVersion: input.engine?.id ?? 'deterministic-caretaker@1',
  })
  const host = new CaretakerLifecycleHost({
    unitOfWork,
    projections: input.projection?.(world, clock) ?? world,
    tools,
    humanPauses: world,
    missionTransitions: new MissionLifecycleService(
      store,
      clock,
      new SequentialIdGenerator(),
      NOOP_OBSERVABILITY,
      unitOfWork,
    ),
    decisionEngine: input.engine ?? new DeterministicCaretakerDecisionEngine(),
    evidence: evidenceRecorder,
    clock,
  })
  return {
    clock,
    context,
    evidenceRecorder,
    evidenceDeliveries,
    evidenceSink,
    host,
    leaseService: new MissionLeaseService(store, clock),
    store,
    tools,
    unitOfWork,
    world,
  }
}

function activation(
  context: MissionExecutionContext,
  requestedRunId = IDS.run,
  activationKey = ACTIVATION_KEY,
  activatedAt = ACTIVATED_AT,
) {
  return {
    context,
    requestedRunId,
    missionId: IDS.mission,
    activationKey,
    activatedAt,
  }
}

describe('Caretaker lifecycle host', () => {
  it('chooses different valid tools when current protected state changes', async () => {
    const baseline = await fixture({})
    const changed = await fixture({ live: liveState('stale') })

    await expect(baseline.host.resume(activation(baseline.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })
    await expect(changed.host.resume(activation(changed.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })

    expect(await pendingToolNames(baseline.store)).toEqual(['plans.propose'])
    expect(await pendingToolNames(changed.store)).toEqual(['routines.get'])
  })

  it('persists an external clarification pause without invoking a tool', async () => {
    const current = liveState('absent')
    current.materialIssue = {
      kind: 'missing_preference',
      field: 'preference.temperature_celsius',
      question: 'Which safe temperature should the palace reach?',
      choices: [
        { id: 'energy_first', label: '20°C' },
        { id: 'comfort_first', label: '22°C' },
      ],
      resolvedChoiceId: null,
      evidenceIds: [EVIDENCE_IDS.material],
    }
    const test = await fixture({ live: current })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'clarification',
    })
    expect(test.tools.executions).toEqual([])
    const [run] = (await test.store.snapshot()).caretakerRuns
    expect(run?.counters.clarificationPauseCount).toBe(1)
  })

  it('stops at the authenticated approval boundary after the request tool succeeds', async () => {
    const test = await fixture({
      state: { status: 'running', phase: 'validate' },
      live: liveState('simulated'),
      toolBehavior: (toolName) =>
        toolName === 'plans.request_approval' ? 'succeeded_approval' : 'pending',
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'approval',
    })
    expect(test.tools.executions).toHaveLength(1)
    expect((await test.store.snapshot()).caretakerRuns[0]).toMatchObject({
      status: 'paused',
      pendingToolCall: null,
    })
    expect(
      (await test.store.snapshot()).caretakerRunCheckpoints.map((checkpoint) => checkpoint.kind),
    ).toEqual(['activated', 'decision_attempt', 'tool_call', 'state_persisted', 'approval_pause'])
  })

  it('treats an accepted approval request as a human pause, not operation uncertainty', async () => {
    const test = await fixture({
      state: { status: 'running', phase: 'validate' },
      live: liveState('simulated'),
      toolBehavior: (toolName) =>
        toolName === 'plans.request_approval' ? 'pending_approval' : 'pending',
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'approval',
    })
    expect(await pendingToolNames(test.store)).toEqual(['plans.request_approval'])
    expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe(
      'approval_pause',
    )
  })

  it('records one replay-safe context, decision, tool, and terminal trace hierarchy', async () => {
    const test = await fixture({
      state: { status: 'running', phase: 'validate' },
      live: liveState('simulated'),
      toolBehavior: () => 'succeeded_approval',
      toolDurationMilliseconds: 17,
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'approval',
    })
    const first = await test.evidenceSink.all()
    expect(first).toHaveLength(4)
    expect(
      first.filter(
        (event) => event.event === '$ai_span' && event.properties.span_kind === 'context',
      ),
    ).toHaveLength(1)
    expect(
      first.filter(
        (event) =>
          event.event === '$ai_span' && event.properties.$ai_span_name === 'caretaker.decision',
      ),
    ).toHaveLength(1)
    expect(
      first.find(
        (event) =>
          event.event === '$ai_span' && event.properties.tool_name === 'plans.request_approval',
      )?.properties,
    ).toMatchObject({ status: 'succeeded', $ai_latency: 0.017, span_kind: 'tool' })
    expect(first.find((event) => event.event === '$ai_trace')?.properties).toMatchObject({
      outcome: 'waiting_for_user',
      pause_reason: 'approval',
      tool_call_count: 1,
      generation_count: 0,
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'approval',
    })
    await expect(test.evidenceSink.all()).resolves.toEqual(first)
    expect(test.tools.executions).toHaveLength(1)
  })

  it('replays a pending terminal envelope without a mission lease after the host crashes', async () => {
    const test = await fixture({
      state: { status: 'running', phase: 'validate' },
      live: liveState('simulated'),
      toolBehavior: () => 'succeeded_approval',
    })
    test.unitOfWork.faultCheckpointKind = 'approval_pause'

    await expect(test.host.resume(activation(test.context))).rejects.toThrow(
      /Injected crash after approval_pause/,
    )
    const afterCrash = await test.store.snapshot()
    expect(afterCrash.caretakerRuns[0]).toMatchObject({ status: 'paused' })
    expect(afterCrash.caretakerTerminalEvidenceDeliveries[0]).toMatchObject({
      runId: IDS.run,
      status: 'pending',
      deliveredAt: null,
      captureStatus: null,
    })
    expect((await test.evidenceSink.all()).some((event) => event.event === '$ai_trace')).toBe(false)

    await expect(test.leaseService.release(test.context.fence)).resolves.toBe(true)
    await expect(test.evidenceRecorder.deliverTerminal(IDS.run)).resolves.toBe('delivered')
    expect((await test.store.snapshot()).caretakerTerminalEvidenceDeliveries[0]).toMatchObject({
      status: 'delivered',
      captureStatus: 'stored',
    })
    expect(
      (await test.evidenceSink.all()).filter((event) => event.event === '$ai_trace'),
    ).toHaveLength(1)
  })

  it('retains a terminal envelope through a sink outage and acknowledges only after storage', async () => {
    const evidenceSink = new ToggleTerminalEvidenceSink()
    const test = await fixture({
      state: { status: 'running', phase: 'validate' },
      live: liveState('simulated'),
      toolBehavior: () => 'succeeded_approval',
      evidenceSink,
    })

    await expect(test.host.resume(activation(test.context))).rejects.toThrow(
      /Injected terminal evidence outage/,
    )
    expect((await test.store.snapshot()).caretakerTerminalEvidenceDeliveries[0]).toMatchObject({
      status: 'pending',
      captureStatus: null,
    })
    expect((await evidenceSink.all()).some((event) => event.event === '$ai_trace')).toBe(false)

    evidenceSink.failTerminal = false
    await expect(test.evidenceRecorder.deliverTerminal(IDS.run)).resolves.toBe('delivered')
    expect((await test.store.snapshot()).caretakerTerminalEvidenceDeliveries[0]).toMatchObject({
      status: 'delivered',
      captureStatus: 'stored',
    })
  })

  it('replays an exact terminal event after capture succeeds but acknowledgement crashes', async () => {
    const evidenceSink = new InMemoryEvidenceSink()
    const test = await fixture({
      state: { status: 'running', phase: 'validate' },
      live: liveState('simulated'),
      toolBehavior: () => 'succeeded_approval',
      evidenceSink,
      evidenceDeliveries: (store) => new FailOnceAcknowledgementDeliveryPort(store),
    })

    await expect(test.host.resume(activation(test.context))).rejects.toThrow(
      /Injected crash after terminal evidence capture/,
    )
    const beforeReplay = await test.store.snapshot()
    expect(beforeReplay.caretakerTerminalEvidenceDeliveries[0]).toMatchObject({
      status: 'pending',
      captureStatus: null,
    })
    expect((await evidenceSink.all()).filter((event) => event.event === '$ai_trace')).toHaveLength(
      1,
    )

    await expect(test.evidenceRecorder.deliverTerminal(IDS.run)).resolves.toBe('delivered')
    expect((await test.store.snapshot()).caretakerTerminalEvidenceDeliveries[0]).toMatchObject({
      status: 'delivered',
      captureStatus: 'duplicate',
    })
    expect((await evidenceSink.all()).filter((event) => event.event === '$ai_trace')).toHaveLength(
      1,
    )
  })

  it('keeps the frozen initiator aliases when a replacement worker principal resumes the run', async () => {
    const test = await fixture({
      state: { status: 'running', phase: 'validate' },
      live: liveState('simulated'),
      toolBehavior: () => 'succeeded_approval',
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'approval',
    })
    const beforeReplay = await test.store.snapshot()
    const events = await test.evidenceSink.all()
    const replacementContext: MissionExecutionContext = {
      ...test.context,
      principal: PrincipalSchema.parse({
        ...servicePrincipal,
        actorId: UserIdSchema.parse('usr_hostservice02'),
      }),
    }

    await expect(test.host.resume(activation(replacementContext))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'approval',
    })
    const afterReplay = await test.store.snapshot()
    expect(afterReplay.caretakerRuns[0]?.evidenceProfile).toEqual(
      beforeReplay.caretakerRuns[0]?.evidenceProfile,
    )
    expect(await test.evidenceSink.all()).toEqual(events)
  })

  it('keeps the durable tool reservation when evidence storage fails, then replays safely', async () => {
    const evidenceSink = new FailOnceToolEvidenceSink()
    const test = await fixture({
      state: { status: 'running', phase: 'validate' },
      live: liveState('simulated'),
      toolBehavior: () => 'succeeded_approval',
      evidenceSink,
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })
    expect((await test.store.snapshot()).caretakerRuns[0]).toMatchObject({
      status: 'active',
      pendingToolCall: { toolName: 'plans.request_approval' },
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'approval',
    })
    expect(test.tools.executions).toHaveLength(1)
    expect(test.tools.attempts).toHaveLength(2)
    expect(
      (await evidenceSink.all()).filter(
        (event) =>
          event.event === '$ai_span' && event.properties.tool_name === 'plans.request_approval',
      ),
    ).toHaveLength(1)
  })

  it('yields an unknown activation to the durable reconciler', async () => {
    const current = liveState('approved')
    const test = await fixture({
      state: { status: 'running', phase: 'execute' },
      live: current,
      toolBehavior: (toolName) =>
        toolName === 'plans.activate' ? 'unknown_activation' : 'call_in_progress',
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'system',
    })
    expect(await pendingToolNames(test.store)).toEqual(['plans.activate'])
    expect(test.tools.executions).toHaveLength(1)
    expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe('external_wait')
  })

  it('allows activation after an accepted-pending approval request', async () => {
    const test = await fixture({
      state: { status: 'running', phase: 'execute' },
      live: liveState('approved'),
      toolBehavior: () => 'call_in_progress',
    })
    test.world.lastToolResult = {
      toolName: 'plans.request_approval',
      status: 'pending',
      errorCode: null,
      evidenceIds: [EVIDENCE_IDS.approval],
    }

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })
    expect(await pendingToolNames(test.store)).toEqual(['plans.activate'])
  })

  it('accepts an unknown activation that durably reconciles before the next projection', async () => {
    let reconciled = false
    const test = await fixture({
      state: { status: 'running', phase: 'execute' },
      live: liveState('approved'),
      toolBehavior: (toolName) =>
        toolName === 'plans.activate' ? 'unknown_activation' : 'call_in_progress',
      projection: (world) => ({
        load: async () => {
          const projected = await world.load()
          if (!reconciled && projected.lastToolResult?.status === 'unknown') {
            reconciled = true
            world.state = reconciledLiveState(world.state)
            world.lastToolResult = null
            await world.setMissionState({ status: 'waiting_for_system', phase: 'observe' })
            return world.load()
          }
          return projected
        },
      }),
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'system',
    })
    expect(test.tools.executions).toHaveLength(1)
    expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe('external_wait')
  })

  it('rejects an unknown activation whose operation changes without the durable reconcile state', async () => {
    let operationChanged = false
    const test = await fixture({
      state: { status: 'running', phase: 'execute' },
      live: liveState('approved'),
      toolBehavior: (toolName) =>
        toolName === 'plans.activate' ? 'unknown_activation' : 'call_in_progress',
      projection: (world) => ({
        load: async () => {
          const projected = await world.load()
          if (!operationChanged && projected.lastToolResult?.status === 'unknown') {
            operationChanged = true
            world.state = reconciledLiveState(world.state)
            world.lastToolResult = null
            return world.load()
          }
          return projected
        },
      }),
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'failed',
      reason: 'host_rejected_decision',
    })
    expect(test.tools.executions).toHaveLength(1)
    expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe('host_failed')
  })

  it('turns a durable accepted-pending result into a system reconciliation wait', async () => {
    const test = await fixture({
      state: { status: 'running', phase: 'execute' },
      live: liveState('approved'),
      toolBehavior: (toolName) => (toolName === 'plans.activate' ? 'pending' : 'call_in_progress'),
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'system',
    })

    expect(await pendingToolNames(test.store)).toEqual(['plans.activate'])
    expect((await test.store.snapshot()).caretakerRuns[0]).toMatchObject({
      pendingToolCall: null,
      counters: { toolCallCount: 1, reconciliationPollCount: 0 },
    })
  })

  it('resumes the same plan call after a crash between semantic and tool reservations', async () => {
    const test = await fixture({
      taskLedger: [
        {
          id: 'inspect_state',
          label: 'Inspect current state',
          status: 'in_progress',
          evidenceRefs: [EVIDENCE_IDS.runtime],
        },
      ],
    })
    test.unitOfWork.faultCheckpointKind = 'plan_revision'

    await expect(test.host.resume(activation(test.context))).rejects.toThrow(
      /Injected crash after plan_revision/,
    )
    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })

    const snapshot = await test.store.snapshot()
    expect(test.tools.executions).toHaveLength(1)
    expect(snapshot.missions[0]?.taskLedger).toHaveLength(1)
    expect(snapshot.caretakerRuns[0]?.counters).toMatchObject({
      planRevisionCount: 1,
      toolCallCount: 1,
    })
  })

  it('uses the reserved call after a crash immediately before tool invocation', async () => {
    const test = await fixture({ live: liveState('stale') })
    test.unitOfWork.faultCheckpointKind = 'tool_call'

    await expect(test.host.resume(activation(test.context))).rejects.toThrow(
      /Injected crash after tool_call/,
    )
    const [reservation] = (await test.store.snapshot()).caretakerRuns
    const reservedCallId = reservation?.pendingToolCall?.callId
    expect(reservedCallId).toBeDefined()

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })
    expect(test.tools.executions).toEqual([reservedCallId])
  })

  it('replays one durable call after a post-tool crash without repeating its effect', async () => {
    const test = await fixture({
      state: { status: 'running', phase: 'validate' },
      live: liveState('simulated'),
      toolBehavior: () => 'succeeded_approval',
    })
    test.tools.crashAfterDurableResult = true

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })
    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'approval',
    })
    expect(test.tools.attempts).toHaveLength(2)
    expect(new Set(test.tools.attempts).size).toBe(1)
    expect(test.tools.executions).toHaveLength(1)
  })

  it('clears a completed pending call when its security receipt predates fixture domain time', async () => {
    const test = await fixture({
      state: { status: 'running', phase: 'validate' },
      live: liveState('simulated'),
      toolBehavior: () => 'succeeded_approval',
      toolReceiptTimeOffsetMilliseconds: -30 * 24 * 60 * 60 * 1_000,
    })
    test.tools.crashAfterDurableResult = true

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })
    expect((await test.store.snapshot()).caretakerRuns[0]?.pendingToolCall).not.toBeNull()

    test.clock.advance(100)
    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'approval',
    })

    const snapshot = await test.store.snapshot()
    expect(snapshot.caretakerRuns[0]?.pendingToolCall).toBeNull()
    expect(test.tools.attempts).toHaveLength(2)
    expect(new Set(test.tools.attempts).size).toBe(1)
    expect(test.tools.executions).toHaveLength(1)
    expect(
      (await test.evidenceSink.all()).find(
        (event) => event.event === '$ai_span' && event.properties.span_kind === 'tool',
      )?.occurredAt,
    ).toBe(ACTIVATED_AT)
  })

  it('persists context sufficiency before asking the planner for consequential work', async () => {
    const test = await fixture({
      state: { status: 'running', phase: 'understand' },
      live: liveState('draft_ready'),
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })

    const snapshot = await test.store.snapshot()
    expect(snapshot.missions[0]).toMatchObject({
      state: { status: 'running', phase: 'plan' },
      version: 2,
    })
    expect(snapshot.missionEvents.at(-1)?.event).toBe('context_sufficient')
    expect(snapshot.caretakerRuns[0]).toMatchObject({
      phase: 'plan',
      pendingToolCall: { toolName: 'plans.propose' },
    })
  })

  it('preserves the pending call and counters across lease takeover', async () => {
    const test = await fixture({})
    test.unitOfWork.faultCheckpointKind = 'plan_revision'
    await expect(test.host.resume(activation(test.context))).rejects.toThrow()

    test.clock.advance(1_000)
    const nextLease = await test.leaseService.acquire({
      organizationId: IDS.organization,
      missionId: IDS.mission,
      ownerId: 'worker-two',
      ttlMilliseconds: 1_000,
    })
    const nextContext: MissionExecutionContext = {
      fence: nextLease.fence,
      signal: new AbortController().signal,
      principal: servicePrincipal,
    }

    await expect(
      test.host.resume(
        activation(
          nextContext,
          IDS.replacementRun,
          REPLACEMENT_ACTIVATION_KEY,
          test.clock.now().toISOString(),
        ),
      ),
    ).resolves.toMatchObject({ kind: 'retry', reason: 'tool_pending', runId: IDS.run })
    const snapshot = await test.store.snapshot()
    expect(snapshot.caretakerRuns).toHaveLength(1)
    expect(snapshot.caretakerRuns[0]).toMatchObject({
      id: IDS.run,
      leaseEpoch: 2,
      counters: { planRevisionCount: 1, toolCallCount: 1 },
    })
  })

  it('reloads a reported version conflict instead of allocating another call identity', async () => {
    const test = await fixture({})
    test.unitOfWork.reportFirstCheckpointAsConflict = true

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })
    expect(test.tools.executions).toHaveLength(1)
    expect(new Set(test.tools.attempts).size).toBe(1)
  })

  it.each(['call_in_progress', 'reconciliation_pending'] as const)(
    'retains one durable reservation while the dispatcher reports %s',
    async (toolBehavior) => {
      const test = await fixture({ toolBehavior: () => toolBehavior })

      await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
        kind: 'retry',
        reason: 'tool_pending',
      })
      const afterFirstPoll = (await test.store.snapshot()).caretakerRuns[0]
      const callId = afterFirstPoll?.pendingToolCall?.callId

      await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
        kind: 'retry',
        reason: 'tool_pending',
      })
      const afterSecondPoll = (await test.store.snapshot()).caretakerRuns[0]

      expect(test.tools.attempts).toEqual([callId, callId])
      expect(afterSecondPoll).toMatchObject({
        pendingToolCall: { callId },
        counters: { toolCallCount: 1, activeRuntimeMilliseconds: 2 },
      })
      expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe('tool_wait')
    },
  )

  it('accounts for model and tool time before pausing at the active-runtime ceiling', async () => {
    const clockedEngine: CaretakerDecisionEngine = {
      id: 'clocked-engine@1',
      async decide(request, activation) {
        budgetClock.advance(100)
        return new DeterministicCaretakerDecisionEngine().decide(request, activation)
      },
    }
    const test = await fixture({
      engine: clockedEngine,
      toolBehavior: () => 'failed',
      toolDurationMilliseconds: 100,
    })
    const budgetClock = test.clock
    await seedRuntime(test.store, test.context, test.evidenceRecorder, 299_800)

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'budget',
    })
    expect(test.tools.executions).toHaveLength(1)
    expect((await test.store.snapshot()).caretakerRuns[0]?.counters).toMatchObject({
      activeRuntimeMilliseconds: 300_000,
      planRevisionCount: 1,
      toolCallCount: 1,
    })
  })

  it('never invokes a tool when the model call exhausts the active-runtime budget', async () => {
    let modelCalls = 0
    const test = await fixture({
      engine: {
        id: 'slow-engine@1',
        async decide(request, activation) {
          modelCalls += 1
          slowClock.advance(100)
          return new DeterministicCaretakerDecisionEngine().decide(request, activation)
        },
      },
    })
    const slowClock = test.clock
    await seedRuntime(test.store, test.context, test.evidenceRecorder, 299_900)

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'budget',
    })
    expect(modelCalls).toBe(1)
    expect(test.tools.attempts).toEqual([])
  })

  it.each(['projection', 'model'] as const)(
    'enforces the remaining wall-clock budget when %s ignores AbortSignal',
    async (dependency) => {
      const test = await fixture(
        dependency === 'model'
          ? { engine: { id: 'hung-engine@1', decide: () => new Promise<never>(() => undefined) } }
          : { projection: () => ({ load: () => new Promise<never>(() => undefined) }) },
      )
      await seedRuntime(test.store, test.context, test.evidenceRecorder, 299_999)

      await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
        kind: 'paused',
        reason: 'budget',
      })
      expect((await test.store.snapshot()).caretakerRuns[0]).toMatchObject({
        status: 'paused',
        counters: { activeRuntimeMilliseconds: 300_000 },
      })
      expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe(
        'budget_exhausted',
      )
    },
  )

  it.each(['projection', 'model'] as const)(
    'durably fails and retains measured runtime when %s rejects',
    async (dependency) => {
      let calls = 0
      const test = await fixture(
        dependency === 'model'
          ? {
              engine: {
                id: 'rejecting-engine@1',
                decide: async () => {
                  calls += 1
                  rejectingClock.advance(7)
                  throw new Error('model unavailable')
                },
              },
            }
          : {
              projection: () => ({
                load: async () => {
                  calls += 1
                  rejectingClock.advance(7)
                  throw new Error('projection unavailable')
                },
              }),
            },
      )
      const rejectingClock = test.clock

      await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
        kind: 'failed',
        reason: 'host_rejected_decision',
      })
      await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
        kind: 'failed',
        reason: 'host_rejected_decision',
      })
      expect(calls).toBe(1)
      expect((await test.store.snapshot()).caretakerRuns[0]).toMatchObject({
        status: 'failed',
        counters: { activeRuntimeMilliseconds: 7 },
      })
      expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe('host_failed')
    },
  )

  it.each(['projection', 'model'] as const)(
    'retains measured runtime when the activation aborts during %s',
    async (dependency) => {
      let enteredDependency: (() => void) | undefined
      const entered = new Promise<void>((resolve) => {
        enteredDependency = resolve
      })
      const test = await fixture(
        dependency === 'model'
          ? {
              engine: {
                id: 'abortable-model@1',
                decide: () => {
                  abortClock.advance(5)
                  enteredDependency?.()
                  return new Promise<never>(() => undefined)
                },
              },
            }
          : {
              projection: () => ({
                load: () => {
                  abortClock.advance(5)
                  enteredDependency?.()
                  return new Promise<never>(() => undefined)
                },
              }),
            },
      )
      const abortClock = test.clock
      const controller = new AbortController()
      const running = test.host.resume(activation({ ...test.context, signal: controller.signal }))
      await entered
      controller.abort(new Error('activation cancelled'))

      await expect(running).rejects.toThrow(/activation cancelled/)
      expect((await test.store.snapshot()).caretakerRuns[0]).toMatchObject({
        status: 'active',
        counters: { activeRuntimeMilliseconds: 5 },
      })
      expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe(
        'state_persisted',
      )
    },
  )

  it('retains a rejected tool call and its runtime for exact replay', async () => {
    const test = await fixture({ toolBehavior: () => 'reject', toolDurationMilliseconds: 7 })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })

    expect((await test.store.snapshot()).caretakerRuns[0]).toMatchObject({
      status: 'active',
      pendingToolCall: { toolName: 'plans.propose' },
      counters: { activeRuntimeMilliseconds: 7, toolCallCount: 1 },
    })
    expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe('tool_wait')
  })

  it('retains the exact call and runtime when activation aborts during a tool', async () => {
    let enteredTool: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      enteredTool = resolve
    })
    const test = await fixture({
      toolBehavior: () => {
        enteredTool?.()
        return 'never'
      },
      toolDurationMilliseconds: 5,
    })
    const controller = new AbortController()
    const running = test.host.resume(activation({ ...test.context, signal: controller.signal }))
    await entered
    controller.abort(new Error('activation cancelled'))

    await expect(running).rejects.toThrow(/activation cancelled/)
    expect((await test.store.snapshot()).caretakerRuns[0]).toMatchObject({
      status: 'active',
      pendingToolCall: { toolName: 'plans.propose' },
      counters: { activeRuntimeMilliseconds: 5, toolCallCount: 1 },
    })
    expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe('tool_wait')
  })

  it('keeps one timed-out call at the runtime ceiling without allocating new work', async () => {
    const test = await fixture({ toolBehavior: () => 'never' })
    await seedRuntime(test.store, test.context, test.evidenceRecorder, 299_999)

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })
    const afterFirstWait = (await test.store.snapshot()).caretakerRuns[0]
    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })
    const afterSecondWait = (await test.store.snapshot()).caretakerRuns[0]

    expect(test.tools.attempts).toEqual([
      afterFirstWait?.pendingToolCall?.callId,
      afterFirstWait?.pendingToolCall?.callId,
    ])
    expect(afterSecondWait).toMatchObject({
      version: afterFirstWait?.version,
      pendingToolCall: { callId: afterFirstWait?.pendingToolCall?.callId },
      counters: { activeRuntimeMilliseconds: 300_000, toolCallCount: 1 },
    })
  })

  it('settles the same timed-out call before pausing without new agent work', async () => {
    let attempts = 0
    const test = await fixture({
      toolBehavior: () => {
        attempts += 1
        return attempts === 1 ? 'never' : 'failed'
      },
    })
    await seedRuntime(test.store, test.context, test.evidenceRecorder, 299_999)

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'retry',
      reason: 'tool_pending',
    })
    const callId = (await test.store.snapshot()).caretakerRuns[0]?.pendingToolCall?.callId
    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'budget',
    })

    expect(test.tools.attempts).toEqual([callId, callId])
    expect((await test.store.snapshot()).caretakerRuns[0]).toMatchObject({
      status: 'paused',
      pendingToolCall: null,
      counters: { activeRuntimeMilliseconds: 300_000, toolCallCount: 1 },
    })
  })

  it('accepts completion only from a succeeded mission with retained verifier evidence', async () => {
    const current = liveState('approved')
    current.verification = {
      status: 'verifier_passed',
      claims: [
        {
          field: 'verification.status',
          value: 'passed',
          evidenceIds: [EVIDENCE_IDS.verifier],
        },
      ],
      failedCriteria: [],
    }
    const test = await fixture({ state: { status: 'running', phase: 'verify' }, live: current })
    await startRun(test.store, test.context, test.evidenceRecorder)
    await test.world.setMissionState({ status: 'succeeded', phase: 'verify' })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'completed',
      verifierEvidenceIds: [EVIDENCE_IDS.verifier],
    })
  })

  it('durably rejects a verifier summary before the mission itself succeeds', async () => {
    const current = liveState('approved')
    current.verification = {
      status: 'verifier_passed',
      claims: [
        {
          field: 'verification.status',
          value: 'passed',
          evidenceIds: [EVIDENCE_IDS.verifier],
        },
      ],
      failedCriteria: [],
    }
    const test = await fixture({ state: { status: 'running', phase: 'verify' }, live: current })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'failed',
      reason: 'host_rejected_decision',
    })
    expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe('host_failed')
  })

  it('fails closed on forged success or unsupported claim evidence', async () => {
    const forged: CaretakerDecisionEngine = {
      id: 'forged-success@1',
      decide: async (request, activation): Promise<CaretakerDecision> =>
        observedTestDecision('forged-success@1', request, activation, {
          schemaVersion: 'caretaker-decision@1',
          kind: 'grounded_summary',
          reason: 'Pretend the mission passed.',
          evidenceIds: [EVIDENCE_IDS.runtime],
          status: 'verifier_receipt_available',
          claims: [
            {
              field: 'verification.status',
              value: 'passed',
              evidenceIds: [EVIDENCE_IDS.runtime],
            },
          ],
        }),
    }
    const test = await fixture({
      state: { status: 'running', phase: 'verify' },
      live: liveState('approved'),
      engine: forged,
    })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'failed',
      reason: 'host_rejected_decision',
    })
    expect((await test.store.snapshot()).missions[0]?.state.status).toBe('running')
  })

  it('rejects a model-selected tool outside service permissions before dispatch', async () => {
    const unauthorized: CaretakerDecisionEngine = {
      id: 'unauthorized-tool@1',
      decide: async (request, activation): Promise<CaretakerDecision> =>
        observedTestDecision('unauthorized-tool@1', request, activation, {
          schemaVersion: 'caretaker-decision@1',
          kind: 'invoke_tool',
          toolName: 'missions.cancel',
          input: { missionId: IDS.mission, reason: 'The model cannot grant itself control.' },
          reason: 'Attempt a host-owned control action.',
          evidenceIds: [EVIDENCE_IDS.runtime],
        }),
    }
    const test = await fixture({ engine: unauthorized })

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'failed',
      reason: 'host_rejected_decision',
    })
    expect(test.tools.attempts).toEqual([])
  })

  it.each(['denied', 'cross_tenant_identifier', 'forged_approval'] as const)(
    'projects zero tools and rejects a malicious invocation for %s state',
    async (unsafeState) => {
      let observedAllowedTools: readonly ToolName[] | undefined
      const malicious: CaretakerDecisionEngine = {
        id: 'unsafe-state-bypass@1',
        decide: async (request, activation): Promise<CaretakerDecision> => {
          observedAllowedTools = request.allowedTools
          return observedTestDecision('unsafe-state-bypass@1', request, activation, {
            schemaVersion: 'caretaker-decision@1',
            kind: 'invoke_tool',
            toolName: 'palaces.get',
            input: { palaceId: IDS.palace },
            reason: 'Attempt to bypass the empty host allowlist.',
            evidenceIds: [EVIDENCE_IDS.runtime],
          })
        },
      }
      const current = liveState()
      if (unsafeState === 'denied') current.access = 'denied'
      else current.integrityAlerts = [unsafeState]
      const test = await fixture({ live: current, engine: malicious })

      await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
        kind: 'failed',
        reason: 'host_rejected_decision',
      })
      expect(observedAllowedTools).toEqual([])
      expect(test.tools.attempts).toEqual([])
    },
  )

  it.each([
    ['safe_refusal', 'failed', 'safe_refusal'],
    ['human_review', 'paused', 'human_review'],
  ] as const)(
    'durably replays the exact %s disposition without rerunning the engine',
    async (disposition, resultKind, resultReason) => {
      let modelCalls = 0
      const test = await fixture({
        engine: {
          id: `disposition-${disposition}@1`,
          decide: async (request, activation): Promise<CaretakerDecision> => {
            modelCalls += 1
            return observedTestDecision(`disposition-${disposition}@1`, request, activation, {
              schemaVersion: 'caretaker-decision@1',
              kind: 'escalate',
              reason: 'The host must retain this disposition exactly.',
              evidenceIds: [EVIDENCE_IDS.runtime],
              escalationReason: 'hard_invariant_risk',
              disposition,
              safestAction: 'Keep protected state unchanged.',
            })
          },
        },
      })

      await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
        kind: resultKind,
        reason: resultReason,
      })
      await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
        kind: resultKind,
        reason: resultReason,
      })
      expect(modelCalls).toBe(1)
      expect((await test.store.snapshot()).missions[0]?.state.status).toBe('running')
      expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe(
        disposition === 'safe_refusal' ? 'safe_refusal' : 'human_review_pause',
      )
    },
  )

  it('replays the original terminal disposition unchanged under a newer lease', async () => {
    let modelCalls = 0
    const test = await fixture({
      engine: {
        id: 'cross-lease-safe-refusal@1',
        decide: async (request, activation): Promise<CaretakerDecision> => {
          modelCalls += 1
          return observedTestDecision('cross-lease-safe-refusal@1', request, activation, {
            schemaVersion: 'caretaker-decision@1',
            kind: 'escalate',
            reason: 'Protected state must remain unchanged.',
            evidenceIds: [EVIDENCE_IDS.runtime],
            escalationReason: 'hard_invariant_risk',
            disposition: 'safe_refusal',
            safestAction: 'Retain the current routine.',
          })
        },
      },
    })
    const first = await test.host.resume(activation(test.context))
    expect(first).toMatchObject({ kind: 'failed', reason: 'safe_refusal', runId: IDS.run })
    const terminal = (await test.store.snapshot()).caretakerRuns[0]

    test.clock.advance(1_000)
    const nextLease = await test.leaseService.acquire({
      organizationId: IDS.organization,
      missionId: IDS.mission,
      ownerId: 'worker-two',
      ttlMilliseconds: 1_000,
    })
    const nextContext: MissionExecutionContext = {
      fence: nextLease.fence,
      signal: new AbortController().signal,
      principal: servicePrincipal,
    }

    await expect(
      test.host.resume(
        activation(
          nextContext,
          IDS.replacementRun,
          REPLACEMENT_ACTIVATION_KEY,
          test.clock.now().toISOString(),
        ),
      ),
    ).resolves.toMatchObject({ kind: 'failed', reason: 'safe_refusal', runId: IDS.run })
    const replayed = await test.store.snapshot()
    expect(modelCalls).toBe(1)
    expect(replayed.caretakerRuns).toHaveLength(1)
    expect(replayed.caretakerRuns[0]).toEqual(terminal)
  })

  it('returns the terminal winner when an external-pause checkpoint reports a conflict', async () => {
    const test = await fixture({
      live: liveState('absent'),
    })
    await startRun(test.store, test.context, test.evidenceRecorder)
    await test.world.setMissionState({ status: 'waiting_for_user', phase: 'plan' })
    test.unitOfWork.reportFirstCheckpointAsConflict = true

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'paused',
      reason: 'clarification',
    })
    expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe(
      'clarification_pause',
    )
  })

  it('returns the mission terminal winner when its checkpoint reports a conflict', async () => {
    const test = await fixture({})
    await startRun(test.store, test.context, test.evidenceRecorder)
    await test.world.setMissionState({ status: 'failed', phase: 'verify' })
    test.unitOfWork.reportFirstCheckpointAsConflict = true

    await expect(test.host.resume(activation(test.context))).resolves.toMatchObject({
      kind: 'failed',
      reason: 'mission_failed',
    })
    expect((await test.store.snapshot()).caretakerRunCheckpoints.at(-1)?.kind).toBe('failed')
  })

  it('honors an already-aborted activation before any durable work or tool call', async () => {
    const test = await fixture({})
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))

    await expect(
      test.host.resume(activation({ ...test.context, signal: controller.signal })),
    ).rejects.toThrow(/cancelled/)
    expect((await test.store.snapshot()).caretakerRuns).toEqual([])
    expect(test.tools.attempts).toEqual([])
  })
})

async function pendingToolNames(store: InMemoryApplicationStore): Promise<ToolName[]> {
  return (await store.snapshot()).caretakerRunCheckpoints.flatMap((checkpoint) =>
    checkpoint.kind === 'tool_call' && checkpoint.pendingToolCall !== null
      ? [checkpoint.pendingToolCall.toolName]
      : [],
  )
}

async function startRun(
  store: InMemoryApplicationStore,
  context: MissionExecutionContext,
  evidenceRecorder: CaretakerEvidenceRecorder,
): Promise<CaretakerRunSnapshot> {
  return store.runFenced(
    context.fence,
    async (repositories) =>
      (
        await repositories.caretakerRuns.start({
          runId: IDS.run,
          missionId: IDS.mission,
          mutationKey: ACTIVATION_KEY,
          evidenceProfile: evidenceRecorder.profile({
            runId: IDS.run,
            activatedAt: ACTIVATED_AT,
            organizationId: IDS.organization,
            actorId: IDS.owner,
            palaceId: IDS.palace,
            missionId: IDS.mission,
            contextManifestHash: contextBundleHashForReceipt(CONTEXT_RECEIPT),
          }),
          occurredAt: ACTIVATED_AT,
        })
      ).snapshot,
  )
}

async function seedRuntime(
  store: InMemoryApplicationStore,
  context: MissionExecutionContext,
  evidenceRecorder: CaretakerEvidenceRecorder,
  activeRuntimeMilliseconds: number,
): Promise<void> {
  const started = await startRun(store, context, evidenceRecorder)
  await store.runFenced(context.fence, async (repositories) => {
    await repositories.caretakerRuns.checkpoint({
      runId: started.run.id,
      expectedVersion: started.run.version,
      expectedTaskLedgerVersion: started.run.taskLedgerVersion,
      mutationKey: Sha256Schema.parse('d'.repeat(64)),
      kind: 'state_persisted',
      counters: { ...started.run.counters, activeRuntimeMilliseconds },
      pendingToolCall: null,
      taskLedger: started.taskLedger,
      evidenceRefs: [],
      occurredAt: ACTIVATED_AT,
    })
  })
}

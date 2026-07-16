import {
  EvidenceIdSchema,
  KnowledgeSearchOutputSchema,
  PlansProposeInputSchema,
  Sha256Schema,
  TOOL_REGISTRY_HASH,
  ToolCallReceiptSchema,
  hashToolValue,
  isRoutineReplacementAction,
  missionProgramKindOf,
  parseToolResult,
  projectToolSchema,
  type Capability,
  type ClarificationAnswer,
  type ClarificationRequest,
  type ContextReceipt,
  type CrewPreference,
  type CrewSchedule,
  type Device,
  type EvidenceId,
  type Mission,
  type Palace,
  type PersistedEvidenceRecord,
  type Plan,
  type Routine,
  type RoutineVersion,
  type ToolCallReceipt,
  type ToolName,
  type Verification,
} from '@trash-palace/core'
import {
  CaretakerPendingToolCallSchema,
  assertMissionExecutionContext,
  type AuthenticatedToolDispatcher,
  type CaretakerPendingToolCall,
  type CaretakerRunCheckpoint,
  type MissionExecutionContext,
  type MissionExecutionUnitOfWorkPort,
  type PlanSimulationRecord,
  type PlanValidationRecord,
  type ReconciliationPoll,
  type ToolCallReceiptRepositoryResolverPort,
  type ToolInvocationScopeHasherPort,
} from '@trash-palace/application'
import { z } from 'zod'

import {
  CaretakerRetrievedKnowledgeSchema,
  CaretakerLiveStateSchema,
  DecisionEvidenceReferenceSchema,
  createCaretakerFrozenContext,
  type CaretakerDecisionRequest,
  type CaretakerFrozenContext,
  type CaretakerLiveState,
  type CaretakerRetrievedKnowledge,
} from './decision-engine.js'
import { contextBundleHashForReceipt } from './caretaker-context.js'
import { ContextBundleSchema, type ContextBundle } from './context.js'
import { containsContextPoison } from './context-compiler.js'
import {
  type CaretakerHostProjection,
  type CaretakerHostProjectionPort,
  type CaretakerHostToolPort,
} from './caretaker-host.js'
import { hashHostPolicyContract } from './host-policy.js'

const DISCOVERY_TOOLS = {
  palace: 'palaces.get',
  crew: 'crews.list',
  capabilities: 'capabilities.list',
  routines: 'routines.list',
  knowledge: 'knowledge.search',
} as const satisfies Record<keyof CaretakerLiveState['discovery'], ToolName>

const EVIDENCE_KIND_PRIORITY = {
  policy: 0,
  runtime_state: 1,
  tool_result: 2,
  verifier_receipt: 3,
} as const

type MaterialIssue = NonNullable<CaretakerLiveState['materialIssue']>
type PlanProposal = NonNullable<CaretakerLiveState['plan']['proposal']>
type EvidenceKind = (typeof DecisionEvidenceReferenceSchema)['_output']['kind']

export class CaretakerRuntimeAdapterIntegrityError extends Error {
  public override readonly name = 'CaretakerRuntimeAdapterIntegrityError'
}

export interface CaretakerRuntimeReceiptDependencies {
  readonly receipts: ToolCallReceiptRepositoryResolverPort
  readonly scopes: Pick<ToolInvocationScopeHasherPort, 'tenant'>
}

export interface DispatcherCaretakerToolPortDependencies extends CaretakerRuntimeReceiptDependencies {
  readonly dispatcher: Pick<AuthenticatedToolDispatcher, 'invoke'>
}

/**
 * Keeps dispatcher authorization, idempotency, and result validation in the application layer.
 * The adapter accepts a result only when the tenant-scoped receipt independently binds it to the
 * durable host reservation.
 */
export class DispatcherCaretakerToolPort implements CaretakerHostToolPort {
  public constructor(private readonly dependencies: DispatcherCaretakerToolPortDependencies) {}

  public async invoke(input: {
    readonly context: MissionExecutionContext
    readonly pendingToolCall: CaretakerPendingToolCall
    readonly signal: AbortSignal
  }): Promise<{
    readonly result: unknown
    readonly evidenceIds: readonly EvidenceId[]
    readonly receipt: ToolCallReceipt
  }> {
    input.signal.throwIfAborted()
    const pending = CaretakerPendingToolCallSchema.parse(input.pendingToolCall)
    const organizationId = input.context.principal.organizationId
    const missionId = input.context.fence.missionId
    assertMissionExecutionContext(input.context, { organizationId, missionId })

    const untrustedResult = await this.dependencies.dispatcher.invoke(
      {
        callId: pending.callId,
        toolName: pending.toolName,
        input: pending.input,
      },
      {
        authentication: input.context,
        missionId,
        channel: 'in_process',
        signal: input.signal,
      },
    )
    input.signal.throwIfAborted()

    const result = parseToolResult(pending.toolName, untrustedResult)
    const tenantScopeHash = this.dependencies.scopes.tenant(organizationId)
    const repository = this.dependencies.receipts.forTenant({ organizationId, tenantScopeHash })
    const receipt = await repository.findByCallId(pending.callId)
    input.signal.throwIfAborted()

    if (receipt === null) {
      throw new CaretakerRuntimeAdapterIntegrityError(
        'The completed dispatcher result lacks a tenant-scoped durable receipt',
      )
    }
    assertReceiptBinding({ receipt, pending, result, tenantScopeHash })
    return { result, evidenceIds: [...receipt.evidenceIds], receipt }
  }
}

export interface CaretakerSynthesisSnapshot {
  readonly mission: Readonly<
    Pick<
      Mission,
      | 'id'
      | 'palaceId'
      | 'programKind'
      | 'objective'
      | 'constraints'
      | 'successCriteriaIds'
      | 'state'
      | 'version'
    >
  >
  readonly context: Readonly<{
    receiptId: ContextReceipt['id']
    bundleHash: ReturnType<typeof hashToolValue>
    policyHash: ContextReceipt['policyHash']
    toolRegistryHash: ContextReceipt['toolRegistryHash']
    sources: ContextReceipt['sources']
  }>
  readonly palace: Readonly<Pick<Palace, 'id' | 'timezone' | 'batteryAvailablePercentage'>>
  readonly crew: Readonly<{
    schedules: readonly Readonly<
      Pick<
        CrewSchedule,
        'id' | 'crewMemberId' | 'active' | 'version' | 'timezone' | 'windowStart' | 'windowEnd'
      >
    >[]
    preferences: readonly Readonly<
      Pick<
        CrewPreference,
        | 'id'
        | 'crewMemberId'
        | 'active'
        | 'version'
        | 'targetCelsius'
        | 'pathwayLightingIntensityPercent'
        | 'pathwayLightingDurationSeconds'
      >
    >[]
  }>
  readonly capabilities: Readonly<{
    devices: readonly Readonly<Pick<Device, 'id' | 'kind' | 'health' | 'version'>>[]
    capabilities: readonly Readonly<
      Pick<Capability, 'id' | 'deviceId' | 'kind' | 'enabled' | 'constraints'>
    >[]
  }>
  readonly routines: Readonly<{
    routines: readonly Readonly<Pick<Routine, 'id' | 'palaceId' | 'activeVersionId'>>[]
    versions: readonly Readonly<
      Pick<RoutineVersion, 'id' | 'routineId' | 'version' | 'status' | 'definition'>
    >[]
  }>
  readonly discovery: CaretakerLiveState['discovery']
  readonly capabilityFit: CaretakerLiveState['capabilityFit']
  readonly evidenceIds: readonly EvidenceId[]
  readonly persistedEvidence: readonly PersistedEvidenceRecord[]
  readonly clarification: Readonly<{
    request: ClarificationRequest
    answer: ClarificationAnswer | null
  }> | null
}

export interface CaretakerHomecomingDraftPort {
  synthesize(input: CaretakerSynthesisSnapshot): Promise<PlanProposal | null>
}

export interface CaretakerMaterialIssuePort {
  synthesize(input: CaretakerSynthesisSnapshot): Promise<MaterialIssue | null>
}

const FrozenContextSourcePolicySchema = z
  .object({
    sourceId: z.string().regex(/^[a-z][a-z0-9_.:/-]{2,199}$/),
    version: z.string().min(1).max(120),
    contentHash: Sha256Schema,
    visibility: z.enum(['public', 'internal', 'tenant']),
    sensitivity: z.enum(['public', 'internal', 'confidential']),
    tenantScoped: z.boolean(),
    tenantScopeHash: Sha256Schema.nullable(),
  })
  .strict()
  .superRefine((source, context) => {
    if (
      source.tenantScoped !== (source.tenantScopeHash !== null) ||
      source.tenantScoped !== (source.visibility === 'tenant')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Frozen source scope metadata is internally inconsistent',
      })
    }
  })

export interface CaretakerFrozenContextPort {
  load(input: {
    readonly context: MissionExecutionContext
    readonly missionId: Mission['id']
    readonly runId: NonNullable<Mission['runId']>
    readonly receiptId: ContextReceipt['id']
    readonly signal: AbortSignal
  }): Promise<{
    readonly bundle: unknown
    readonly sourcePolicies: readonly unknown[]
  }>
}

export interface RepositoryCaretakerProjectionPortDependencies extends CaretakerRuntimeReceiptDependencies {
  readonly unitOfWork: MissionExecutionUnitOfWorkPort
  readonly dispatcher: Pick<AuthenticatedToolDispatcher, 'invoke'>
  readonly frozenContexts: CaretakerFrozenContextPort
  readonly drafts?: CaretakerHomecomingDraftPort
  readonly materialIssues?: CaretakerMaterialIssuePort
}

type ToolReservation = Readonly<{
  sequence: number
  pending: CaretakerPendingToolCall
}>

type DurableProjection = Awaited<ReturnType<typeof loadDurableProjection>>

/** Reconstructs the decision surface from append-only receipts and tenant repository state. */
export class RepositoryCaretakerProjectionPort implements CaretakerHostProjectionPort {
  public constructor(
    private readonly dependencies: RepositoryCaretakerProjectionPortDependencies,
  ) {}

  public async load(input: {
    readonly context: MissionExecutionContext
    readonly runId: Parameters<CaretakerHostProjectionPort['load']>[0]['runId']
    readonly signal: AbortSignal
  }): Promise<CaretakerHostProjection> {
    input.signal.throwIfAborted()
    const durable = await this.dependencies.unitOfWork.runFenced(
      input.context.fence,
      async (repositories) =>
        loadDurableProjection({
          repositories,
          context: input.context,
          runId: input.runId,
          receipts: this.dependencies.receipts,
          scopes: this.dependencies.scopes,
          signal: input.signal,
        }),
    )
    input.signal.throwIfAborted()

    const frozenContext = await projectFrozenContext({
      port: this.dependencies.frozenContexts,
      scopes: this.dependencies.scopes,
      durable,
      context: input.context,
      signal: input.signal,
    })
    input.signal.throwIfAborted()
    const retrievedKnowledge = await replayRetrievedKnowledge({
      dispatcher: this.dependencies.dispatcher,
      durable,
      context: input.context,
      frozenContext,
      signal: input.signal,
    })
    input.signal.throwIfAborted()
    const evidence = buildEvidenceCatalog(durable)
    const discovery = projectDiscovery(durable.receipts, retrievedKnowledge)
    const capabilityFit = projectCapabilityFit(durable.capabilities, durable.mission)
    const synthesis = createSynthesisSnapshot({
      durable,
      evidenceIds: evidence.map((entry) => entry.id),
      discovery,
      capabilityFit,
    })

    const materialIssue =
      this.dependencies.materialIssues === undefined
        ? null
        : await this.dependencies.materialIssues.synthesize(synthesis)
    input.signal.throwIfAborted()
    const proposal =
      durable.plan !== null || this.dependencies.drafts === undefined
        ? null
        : await this.dependencies.drafts.synthesize(synthesis)
    input.signal.throwIfAborted()

    const parsedMaterialIssue = parseMaterialIssue(
      materialIssue,
      new Set(evidence.map((x) => x.id)),
    )
    const parsedProposal = parseProposal(proposal, durable.mission)
    const plan = projectPlan({
      plan: durable.plan,
      validation: durable.validation,
      simulations: durable.simulations,
      approval: durable.approval,
      currentProtectedVersion: durable.currentProtectedVersion,
      proposal: parsedProposal,
    })
    const integrityAlerts: ('forged_approval' | 'prompt_injection')[] = []
    if (approvalIsForged(durable.plan, durable.approval)) integrityAlerts.push('forged_approval')
    if (retrievedKnowledge.some((entry) => containsContextPoison(entry.excerpt))) {
      integrityAlerts.push('prompt_injection')
    }
    const operation = projectOperation(
      durable.mission,
      durable.plan,
      durable.approval,
      durable.operations,
      durable.attemptsByOperation,
      durable.reconciliationsByOperation,
    )
    const verification = projectVerification(durable.verification, operation)
    const liveState = CaretakerLiveStateSchema.parse({
      access: 'authorized',
      discovery,
      materialIssue: parsedMaterialIssue,
      capabilityFit,
      plan,
      operation,
      verification,
      integrityAlerts,
    })
    const lastToolResult = projectLastToolResult(durable, operation)

    return {
      contextReceiptId: durable.contextReceipt.id,
      contextBundleHash: contextBundleHashForReceipt(durable.contextReceipt),
      frozenContext,
      retrievedKnowledge,
      mission: {
        id: durable.mission.id,
        palaceId: durable.mission.palaceId,
        programKind: missionProgramKindOf(durable.mission),
        objective: durable.mission.objective,
        constraints: durable.mission.constraints,
        state: durable.mission.state,
        version: durable.mission.version,
        taskLedger: durable.snapshot.taskLedger,
      },
      evidence,
      liveState,
      lastToolResult,
    }
  }
}

async function loadDurableProjection(input: {
  readonly repositories: Parameters<MissionExecutionUnitOfWorkPort['runFenced']>[1] extends (
    repositories: infer Repositories,
  ) => Promise<unknown>
    ? Repositories
    : never
  readonly context: MissionExecutionContext
  readonly runId: Parameters<CaretakerHostProjectionPort['load']>[0]['runId']
  readonly receipts: ToolCallReceiptRepositoryResolverPort
  readonly scopes: Pick<ToolInvocationScopeHasherPort, 'tenant'>
  readonly signal: AbortSignal
}) {
  const { repositories, context, runId, signal } = input
  signal.throwIfAborted()
  const snapshot = await repositories.caretakerRuns.get(runId)
  if (snapshot === null) throw integrity('Caretaker run is absent from the fenced tenant')
  const mission = await repositories.missions.get(snapshot.run.missionId)
  if (mission === null) throw integrity('Caretaker mission is absent from the fenced tenant')
  assertRunBinding(snapshot, mission, context)
  if (mission.contextReceiptId === null) {
    throw integrity('Caretaker mission lacks a durable context receipt')
  }
  const contextReceipt = await repositories.contextReceipts.get(mission.contextReceiptId)
  if (contextReceipt === null) throw integrity('Caretaker context receipt is absent')
  assertContextReceiptBinding(contextReceipt, mission, snapshot.run.id)

  const checkpoints = await repositories.caretakerRuns.listCheckpoints(snapshot.run.id)
  assertCheckpointHistory(checkpoints, snapshot)
  const reservations = toolReservations(checkpoints)
  const tenantScopeHash = input.scopes.tenant(context.principal.organizationId)
  const receiptRepository = input.receipts.forTenant({
    organizationId: context.principal.organizationId,
    tenantScopeHash,
  })
  const receipts: ToolCallReceipt[] = []
  for (const reservation of reservations) {
    signal.throwIfAborted()
    const receipt = await receiptRepository.findByCallId(reservation.pending.callId)
    if (receipt === null) {
      throw integrity('A durable Caretaker tool reservation lacks its completed receipt')
    }
    assertProjectedReceiptBinding(receipt, reservation.pending, tenantScopeHash)
    receipts.push(receipt)
  }

  // A fenced PostgreSQL unit of work owns one client; pg 9 rejects overlapping client queries.
  const palace = await repositories.palaces.get(mission.palaceId)
  const crew = await repositories.crews.list(mission.palaceId, true)
  const capabilities = await repositories.capabilities.list(mission.palaceId)
  const routines = await repositories.routines.list(mission.palaceId)
  const plan = await repositories.plans.getLatestForMission(mission.id)
  const operations = await repositories.operations.listForMission(mission.id)
  const evidence = await repositories.evidence.listForMission(mission.id)
  const verification = await repositories.verifications.findForMission(mission.id)
  if (palace === null) throw integrity('Caretaker palace is absent from the fenced tenant')
  assertOwnedRecords(context.principal.organizationId, mission, {
    palace,
    crew,
    capabilities,
    routines,
    plan,
    operations,
    evidence,
    verification,
  })

  const validation =
    plan === null ? null : await repositories.planAssessments.getValidation(plan.id)
  const simulations =
    plan === null ? [] : await repositories.planAssessments.listSimulations(plan.id)
  const approval = plan === null ? null : await repositories.approvals.findForPlan(plan.id)
  const attemptsByOperation = new Map<
    (typeof operations)[number]['id'],
    Awaited<ReturnType<typeof repositories.attempts.listForOperation>>
  >()
  const reconciliationsByOperation = new Map<
    (typeof operations)[number]['id'],
    readonly ReconciliationPoll[]
  >()
  for (const operation of operations) {
    const attempts = await repositories.attempts.listForOperation(operation.id)
    const reconciliations = await repositories.reconciliations.listForOperation(operation.id)
    if (
      attempts.some(
        (attempt) =>
          attempt.organizationId !== context.principal.organizationId ||
          attempt.operationId !== operation.id,
      ) ||
      reconciliations.some(
        (poll) =>
          poll.organizationId !== context.principal.organizationId ||
          poll.operationId !== operation.id,
      )
    ) {
      throw integrity('Operation attempts or reconciliation polls escaped the fenced tenant')
    }
    attemptsByOperation.set(operation.id, attempts)
    reconciliationsByOperation.set(operation.id, reconciliations)
  }
  const clarificationRequest = await repositories.clarifications.findLatestForMission(mission.id)
  const clarificationAnswer =
    clarificationRequest === null
      ? null
      : await repositories.clarifications.getAnswerForRequest(clarificationRequest.id)
  assertClarificationProjectionBinding({
    mission,
    request: clarificationRequest,
    answer: clarificationAnswer,
    evidence,
  })
  const currentProtectedVersion =
    plan === null ? null : await currentVersionForPlan(repositories, plan)

  assertRelatedRecordBindings({
    mission,
    plan,
    approval,
    validation,
    simulations,
    verification,
  })
  assertProjectionEvidenceBindings({ evidence, receipts, verification, checkpoints })
  signal.throwIfAborted()
  return {
    snapshot,
    mission,
    contextReceipt,
    checkpoints,
    reservations,
    receipts,
    palace,
    crew,
    capabilities,
    routines,
    plan,
    validation,
    simulations,
    approval,
    operations,
    attemptsByOperation,
    reconciliationsByOperation,
    evidence,
    clarification:
      clarificationRequest === null
        ? null
        : { request: clarificationRequest, answer: clarificationAnswer },
    verification,
    currentProtectedVersion,
  }
}

function assertReceiptBinding(input: {
  readonly receipt: ToolCallReceipt
  readonly pending: CaretakerPendingToolCall
  readonly result: ReturnType<typeof parseToolResult>
  readonly tenantScopeHash: ReturnType<ToolInvocationScopeHasherPort['tenant']>
}): void {
  const receipt = ToolCallReceiptSchema.parse(input.receipt)
  const expectedContract = projectToolSchema(input.pending.toolName).contractHash
  if (
    input.result.callId !== input.pending.callId ||
    input.result.toolName !== input.pending.toolName ||
    receipt.callId !== input.pending.callId ||
    receipt.id !== input.result.receiptId ||
    receipt.toolName !== input.pending.toolName ||
    receipt.status !== input.result.status ||
    receipt.channel !== 'in_process' ||
    receipt.tenantScopeHash !== input.tenantScopeHash ||
    receipt.inputHash !== input.pending.inputHash ||
    receipt.resultHash !== hashToolValue(input.result) ||
    receipt.toolContractHash !== expectedContract ||
    receipt.toolRegistryHash !== TOOL_REGISTRY_HASH ||
    (receipt.status === 'unknown' && receipt.evidenceIds.length === 0)
  ) {
    throw integrity('Tool receipt does not bind the fenced dispatcher result')
  }
}

function assertProjectedReceiptBinding(
  receiptInput: ToolCallReceipt,
  pending: CaretakerPendingToolCall,
  tenantScopeHash: ReturnType<ToolInvocationScopeHasherPort['tenant']>,
): void {
  const receipt = ToolCallReceiptSchema.parse(receiptInput)
  if (
    receipt.callId !== pending.callId ||
    receipt.toolName !== pending.toolName ||
    receipt.channel !== 'in_process' ||
    receipt.tenantScopeHash !== tenantScopeHash ||
    receipt.inputHash !== pending.inputHash ||
    receipt.toolContractHash !== projectToolSchema(pending.toolName).contractHash ||
    receipt.toolRegistryHash !== TOOL_REGISTRY_HASH ||
    (receipt.status === 'unknown' && receipt.evidenceIds.length === 0)
  ) {
    throw integrity('Projected tool receipt does not match its durable reservation')
  }
}

function assertRunBinding(
  snapshot: DurableProjection['snapshot'],
  mission: Mission,
  context: MissionExecutionContext,
): void {
  assertMissionExecutionContext(context, {
    organizationId: context.principal.organizationId,
    missionId: mission.id,
  })
  if (
    snapshot.run.organizationId !== context.principal.organizationId ||
    snapshot.run.missionId !== mission.id ||
    snapshot.run.leaseEpoch !== context.fence.epoch ||
    snapshot.run.phase !== mission.state.phase ||
    mission.organizationId !== context.principal.organizationId ||
    mission.runId !== snapshot.run.id ||
    snapshot.checkpoint.runId !== snapshot.run.id ||
    snapshot.checkpoint.organizationId !== context.principal.organizationId ||
    snapshot.checkpoint.missionId !== mission.id ||
    snapshot.checkpoint.phase !== mission.state.phase
  ) {
    throw integrity('Caretaker run, mission, and active lease bindings disagree')
  }
  if (hashToolValue(snapshot.taskLedger) !== hashToolValue(mission.taskLedger)) {
    throw integrity('Caretaker run task ledger is stale')
  }
}

function assertContextReceiptBinding(
  receipt: ContextReceipt,
  mission: Mission,
  runId: Mission['runId'],
): void {
  if (
    receipt.id !== mission.contextReceiptId ||
    receipt.organizationId !== mission.organizationId ||
    receipt.missionId !== mission.id ||
    receipt.runId !== runId ||
    receipt.policyHash !== hashHostPolicyContract() ||
    receipt.toolRegistryHash !== TOOL_REGISTRY_HASH
  ) {
    throw integrity('Context receipt does not bind the current mission, run, policy, and tools')
  }
}

function assertCheckpointHistory(
  checkpoints: readonly CaretakerRunCheckpoint[],
  snapshot: DurableProjection['snapshot'],
): void {
  if (checkpoints.length === 0 || checkpoints.at(-1)?.sequence !== snapshot.run.version) {
    throw integrity('Caretaker checkpoint history is incomplete')
  }
  for (const [index, checkpoint] of checkpoints.entries()) {
    if (
      checkpoint.sequence !== index ||
      checkpoint.runId !== snapshot.run.id ||
      checkpoint.organizationId !== snapshot.run.organizationId ||
      checkpoint.missionId !== snapshot.run.missionId
    ) {
      throw integrity('Caretaker checkpoint history has an identity or sequence gap')
    }
  }
}

function toolReservations(checkpoints: readonly CaretakerRunCheckpoint[]): ToolReservation[] {
  const byCall = new Map<string, ToolReservation>()
  for (const checkpoint of checkpoints) {
    if (checkpoint.pendingToolCall === null) continue
    const pending = CaretakerPendingToolCallSchema.parse(checkpoint.pendingToolCall)
    const existing = byCall.get(pending.callId)
    if (
      existing !== undefined &&
      (existing.pending.toolName !== pending.toolName ||
        existing.pending.inputHash !== pending.inputHash)
    ) {
      throw integrity('Caretaker call identity was rebound in checkpoint history')
    }
    byCall.set(pending.callId, { sequence: checkpoint.sequence, pending })
  }
  return [...byCall.values()].sort((left, right) => left.sequence - right.sequence)
}

async function projectFrozenContext(input: {
  readonly port: CaretakerFrozenContextPort
  readonly scopes: Pick<ToolInvocationScopeHasherPort, 'tenant'>
  readonly durable: DurableProjection
  readonly context: MissionExecutionContext
  readonly signal: AbortSignal
}): Promise<CaretakerFrozenContext> {
  const loaded = await input.port.load({
    context: input.context,
    missionId: input.durable.mission.id,
    runId: input.durable.snapshot.run.id,
    receiptId: input.durable.contextReceipt.id,
    signal: input.signal,
  })
  input.signal.throwIfAborted()
  const bundle = ContextBundleSchema.parse(loaded.bundle)
  const sourcePolicies = z.array(FrozenContextSourcePolicySchema).parse(loaded.sourcePolicies)
  if (
    bundle.hostPolicy.contractHash !== input.durable.contextReceipt.policyHash ||
    bundle.exactContracts.toolRegistryHash !== input.durable.contextReceipt.toolRegistryHash
  ) {
    throw integrity('Frozen context artifact does not bind the durable policy and tool registry')
  }
  assertFrozenBundleReceiptBinding(bundle, input.durable.contextReceipt)

  const policyBySource = new Map<string, z.output<typeof FrozenContextSourcePolicySchema>>()
  for (const policy of sourcePolicies) {
    const key = `${policy.sourceId}\u0000${policy.version}`
    if (policyBySource.has(key)) throw integrity('Frozen context source policy is duplicated')
    policyBySource.set(key, policy)
  }
  if (policyBySource.size !== bundle.sections.length) {
    throw integrity('Frozen context source policy set does not match the retained bundle')
  }

  const currentTenantScopeHash = input.scopes.tenant(input.context.principal.organizationId)
  const filtering = {
    confidentialSourcesExcluded: 0,
    tenantPrivateSourcesExcluded: 0,
    crossTenantSourcesExcluded: 0,
    runtimeSnapshotsExcluded: bundle.runtimeSnapshots.length,
  }
  const sections: CaretakerFrozenContext['sections'][number][] = []
  for (const section of bundle.sections) {
    const key = `${section.sourceId}\u0000${section.sourceVersion}`
    const policy = policyBySource.get(key)
    const sourceReceipt = input.durable.contextReceipt.sources.find(
      (source) => source.sourceId === section.sourceId && source.version === section.sourceVersion,
    )
    if (
      policy === undefined ||
      sourceReceipt === undefined ||
      policy.contentHash !== section.sourceHash ||
      sourceReceipt.contentHash !== section.sourceHash ||
      !['skill', 'reference', 'evidence'].includes(sourceReceipt.authority)
    ) {
      throw integrity('Frozen authored context is not pinned by its durable source receipt')
    }

    if (policy.tenantScoped && policy.tenantScopeHash !== currentTenantScopeHash) {
      filtering.crossTenantSourcesExcluded += 1
      continue
    }
    if (policy.sensitivity === 'confidential') {
      filtering.confidentialSourcesExcluded += 1
      continue
    }
    if (policy.tenantScoped || policy.visibility === 'tenant') {
      filtering.tenantPrivateSourcesExcluded += 1
      continue
    }
    sections.push({
      ...section,
      authority: 'authored_guidance',
      sourceAuthority: sourceReceipt.authority as 'skill' | 'reference' | 'evidence',
      visibility: policy.visibility,
      sensitivity: policy.sensitivity,
      tenantScoped: false,
    })
  }

  return createCaretakerFrozenContext({
    schemaVersion: 'caretaker-frozen-context@1',
    receiptId: input.durable.contextReceipt.id,
    receiptBindingHash: contextBundleHashForReceipt(input.durable.contextReceipt),
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    frozenAt: bundle.frozenAt,
    hostPolicy: bundle.hostPolicy,
    exactContracts: bundle.exactContracts,
    sections,
    filtering,
  })
}

function assertFrozenBundleReceiptBinding(bundle: ContextBundle, receipt: ContextReceipt): void {
  const unmatched = new Set(receipt.sources.map((_, index) => index))
  const consume = (predicate: (source: ContextReceipt['sources'][number]) => boolean): void => {
    const index = [...unmatched].find((candidate) => {
      const source = receipt.sources[candidate]
      return source !== undefined && predicate(source)
    })
    if (index === undefined) {
      throw integrity('Frozen context component is absent from the durable source receipt')
    }
    unmatched.delete(index)
  }

  consume(
    (source) =>
      source.authority === 'host_policy' && source.contentHash === bundle.hostPolicy.contractHash,
  )
  for (const tool of bundle.exactContracts.tools) {
    consume(
      (source) => source.authority === 'tool_contract' && source.contentHash === tool.contractHash,
    )
  }
  for (const section of bundle.sections) {
    consume(
      (source) =>
        ['skill', 'reference', 'evidence'].includes(source.authority) &&
        source.sourceId === section.sourceId &&
        source.version === section.sourceVersion &&
        source.contentHash === section.sourceHash,
    )
  }
  for (const snapshot of bundle.runtimeSnapshots) {
    consume(
      (source) => source.authority === 'evidence' && source.contentHash === snapshot.snapshotHash,
    )
  }
  if (unmatched.size > 0) {
    throw integrity('Durable source receipt contains components outside the frozen context bundle')
  }
}

async function replayRetrievedKnowledge(input: {
  readonly dispatcher: Pick<AuthenticatedToolDispatcher, 'invoke'>
  readonly durable: DurableProjection
  readonly context: MissionExecutionContext
  readonly frozenContext: CaretakerFrozenContext
  readonly signal: AbortSignal
}): Promise<CaretakerRetrievedKnowledge[]> {
  const latest = [...input.durable.reservations]
    .reverse()
    .find((reservation) => reservation.pending.toolName === 'knowledge.search')
  if (latest === undefined) return []
  const receipt = input.durable.receipts.find(
    (candidate) => candidate.callId === latest.pending.callId,
  )
  if (receipt === undefined || receipt.status !== 'succeeded') return []

  const untrustedResult = await input.dispatcher.invoke(
    {
      callId: latest.pending.callId,
      toolName: 'knowledge.search',
      input: latest.pending.input,
    },
    {
      authentication: input.context,
      missionId: input.durable.mission.id,
      channel: 'in_process',
      signal: input.signal,
    },
  )
  input.signal.throwIfAborted()
  const result = parseToolResult('knowledge.search', untrustedResult)
  assertReceiptBinding({
    receipt,
    pending: latest.pending,
    result,
    tenantScopeHash: receipt.tenantScopeHash,
  })
  if (result.status !== 'succeeded') {
    throw integrity('Successful knowledge receipt replay did not return successful knowledge data')
  }
  const output = KnowledgeSearchOutputSchema.parse(result.data)
  const allowedSources = new Set(
    input.frozenContext.sections.map(
      (section) => `${section.sourceId}\u0000${section.sourceVersion}`,
    ),
  )
  const seen = new Set<string>()
  const projected: CaretakerRetrievedKnowledge[] = []
  for (const item of output.results) {
    const key = `${item.sourceId}\u0000${item.version}`
    if (!allowedSources.has(key) || seen.has(key)) continue
    seen.add(key)
    projected.push({
      authority: 'untrusted_evidence',
      instructionRole: 'untrusted_evidence',
      sourceId: item.sourceId,
      sourceVersion: item.version,
      title: item.title,
      excerpt: item.excerpt,
      excerptHash: hashToolValue({
        sourceId: item.sourceId,
        sourceVersion: item.version,
        title: item.title,
        excerpt: item.excerpt,
      }),
      provenance: {
        toolName: 'knowledge.search',
        callId: receipt.callId,
        receiptId: receipt.id,
        resultHash: receipt.resultHash,
        evidenceIds: [receiptEvidenceId(receipt), ...receipt.evidenceIds],
      },
    })
    if (projected.length === 6) break
  }
  return z.array(CaretakerRetrievedKnowledgeSchema).max(6).parse(projected)
}

function projectDiscovery(
  receipts: readonly ToolCallReceipt[],
  retrievedKnowledge: readonly CaretakerRetrievedKnowledge[],
): CaretakerLiveState['discovery'] {
  const succeeded = new Set(
    receipts.filter((receipt) => receipt.status === 'succeeded').map((receipt) => receipt.toolName),
  )
  return Object.fromEntries(
    Object.entries(DISCOVERY_TOOLS).map(([field, tool]) => [
      field,
      field === 'knowledge'
        ? retrievedKnowledge.length > 0
          ? 'ready'
          : 'needed'
        : succeeded.has(tool)
          ? 'ready'
          : 'needed',
    ]),
  ) as CaretakerLiveState['discovery']
}

function projectCapabilityFit(
  projection: DurableProjection['capabilities'],
  mission: Mission,
): CaretakerLiveState['capabilityFit'] {
  const devices = new Map(projection.devices.map((device) => [device.id, device]))
  const required =
    missionProgramKindOf(mission) === 'scheduled_hauler_access'
      ? ([
          ['service_hatch_access', 'service_hatch_lock'],
          ['residential_hatch_lock_state', 'residential_hatch_lock'],
        ] as const)
      : ([
          ['temperature_target', 'thermostat'],
          ['pathway_lighting', 'pathway_light'],
          ['lock_desired_state', 'lock'],
        ] as const)
  const supported = required.every(
    ([capabilityKind, deviceKind]) =>
      projection.capabilities.filter((capability) => {
        const device = devices.get(capability.deviceId)
        return (
          capability.enabled &&
          capability.kind === capabilityKind &&
          device?.kind === deviceKind &&
          device.health === 'online'
        )
      }).length === 1,
  )
  return supported ? 'supported' : 'unsupported'
}

function projectPlan(input: {
  readonly plan: Plan | null
  readonly validation: PlanValidationRecord | null
  readonly simulations: readonly PlanSimulationRecord[]
  readonly approval: DurableProjection['approval']
  readonly currentProtectedVersion: DurableProjection['currentProtectedVersion']
  readonly proposal: PlanProposal | null
}): CaretakerLiveState['plan'] {
  if (input.plan === null) {
    return input.proposal === null
      ? {
          status: 'absent',
          proposal: null,
          planId: null,
          actionId: null,
          expectedVersion: null,
          protectedRoutineId: null,
          protectedRoutineVersionId: null,
        }
      : {
          status: 'draft_ready',
          proposal: input.proposal,
          planId: null,
          actionId: null,
          expectedVersion: null,
          protectedRoutineId: null,
          protectedRoutineVersionId: null,
        }
  }
  if (input.plan.actions.length !== 1) {
    throw integrity('Caretaker projection requires one consequential plan action')
  }
  const action = input.plan.actions[0]
  if (action === undefined) throw integrity('Caretaker plan action is absent')
  const protectedRoutineId = isRoutineReplacementAction(action)
    ? action.protectedRoutineId
    : action.routineId
  const protectedRoutineVersionId = isRoutineReplacementAction(action)
    ? action.protectedRoutineVersionId
    : action.restoreVersionId
  const expectedVersion = isRoutineReplacementAction(action)
    ? action.expectedProtectedVersion
    : action.expectedCurrentVersion
  const stale =
    input.currentProtectedVersion === null ||
    input.currentProtectedVersion.version !== expectedVersion ||
    (isRoutineReplacementAction(action) &&
      input.currentProtectedVersion.routineVersionId !== action.protectedRoutineVersionId)

  let status: CaretakerLiveState['plan']['status']
  if (stale || ['superseded', 'rejected'].includes(input.plan.status)) status = 'stale'
  else if (input.plan.status === 'approved') status = 'approved'
  else if (input.plan.status === 'awaiting_approval') status = 'awaiting_approval'
  else if (input.simulations.some((simulation) => simulation.feasible)) status = 'simulated'
  else if (input.plan.status === 'validated' || input.validation?.valid === true)
    status = 'validated'
  else status = 'candidate'

  return {
    status,
    proposal: null,
    planId: input.plan.id,
    actionId: action.id,
    expectedVersion,
    protectedRoutineId,
    protectedRoutineVersionId,
  }
}

function projectOperation(
  mission: Mission,
  plan: Plan | null,
  approval: DurableProjection['approval'],
  operations: DurableProjection['operations'],
  attemptsByOperation: DurableProjection['attemptsByOperation'],
  reconciliationsByOperation: DurableProjection['reconciliationsByOperation'],
): CaretakerLiveState['operation'] {
  if (plan === null) return { status: 'absent', operationId: null, reconciliationRequired: false }
  if (plan.actions.length !== 1) {
    throw integrity('Caretaker operation projection requires one plan action')
  }
  const action = plan.actions[0]
  if (action === undefined) throw integrity('Caretaker operation plan action is absent')
  const relevant = operations.filter((operation) => operation.planId === plan.id)
  if (
    relevant.some(
      (operation) =>
        operation.planActionId !== action.id ||
        approval === null ||
        operation.approvalId !== approval.id,
    )
  ) {
    throw integrity('Durable operation does not bind the current plan action and approval')
  }
  relevant.sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt),
  )
  if (relevant.length === 0) {
    return { status: 'absent', operationId: null, reconciliationRequired: false }
  }
  if (relevant.length > 1) {
    throw integrity('One plan action has multiple durable logical operations')
  }
  const operation = relevant[0]
  if (operation === undefined) throw integrity('Durable operation projection is absent')
  const attempts = [...(attemptsByOperation.get(operation.id) ?? [])].sort(
    (left, right) => left.sequence - right.sequence,
  )
  if (attempts.some((attempt, index) => attempt.sequence !== index + 1)) {
    throw integrity('Operation attempt history has a sequence gap')
  }
  const reconciliations = [...(reconciliationsByOperation.get(operation.id) ?? [])].sort(
    (left, right) => left.sequence - right.sequence,
  )
  if (reconciliations.some((poll, index) => poll.sequence !== index + 1)) {
    throw integrity('Operation reconciliation history has a sequence gap')
  }
  const applicationUnknownAttempts = attempts.filter(
    (attempt) => attempt.transport !== 'gateway' && attempt.status === 'unknown',
  )
  if (attempts.length === 0 && reconciliations.length === 0 && operation.status === 'pending') {
    return { status: 'absent', operationId: null, reconciliationRequired: false }
  }
  if (applicationUnknownAttempts.length > 1) {
    throw integrity('Multiple application-unknown attempts cannot bind one reconciliation poll')
  }
  const applicationUnknownAttempt = applicationUnknownAttempts[0]
  const latestReconciliation = reconciliations.at(-1)
  if (latestReconciliation?.resolution === 'committed') {
    if (operation.status !== 'committed') {
      throw integrity('A committed reconciliation lacks the committed operation state')
    }
    if (applicationUnknownAttempt === undefined) {
      throw integrity('A committed operation reconciliation lacks an application-unknown attempt')
    }
    const unknownObservedAt =
      applicationUnknownAttempt.completedAt ?? applicationUnknownAttempt.startedAt
    if (Date.parse(latestReconciliation.occurredAt) < Date.parse(unknownObservedAt)) {
      throw integrity('A committed reconciliation predates its application-unknown attempt')
    }
    return { status: 'committed', operationId: operation.id, reconciliationRequired: false }
  }
  if (operation.status === 'committed') {
    return applicationUnknownAttempt !== undefined
      ? { status: 'outcome_unknown', operationId: operation.id, reconciliationRequired: true }
      : { status: 'committed', operationId: operation.id, reconciliationRequired: false }
  }
  if (operation.status === 'failed' || operation.status === 'cancelled') {
    return { status: 'failed', operationId: operation.id, reconciliationRequired: false }
  }
  if (latestReconciliation?.resolution === 'failed') {
    return { status: 'failed', operationId: operation.id, reconciliationRequired: false }
  }
  if (latestReconciliation?.resolution === 'definitely_absent') {
    if (mission.state.status !== 'running' || mission.state.phase !== 'execute') {
      throw integrity('A definitely absent operation is not at its authorized retry checkpoint')
    }
    return { status: 'absent', operationId: null, reconciliationRequired: false }
  }
  const outcomeUnknown =
    latestReconciliation?.resolution === 'still_unknown' || attempts.at(-1)?.status === 'unknown'
  return {
    status: outcomeUnknown ? 'outcome_unknown' : 'pending',
    operationId: operation.id,
    reconciliationRequired: true,
  }
}

function projectVerification(
  verification: Verification | null,
  operation: CaretakerLiveState['operation'],
): CaretakerLiveState['verification'] {
  if (verification === null) {
    return {
      status: operation.status === 'committed' ? 'evidence_needed' : 'not_ready',
      claims: [],
      failedCriteria: [],
    }
  }
  const claims = verification.assertions.map((assertion) => ({
    field: verificationField(assertion.predicate.id),
    value: { passed: assertion.passed, predicate: assertion.predicate.type },
    evidenceIds: assertion.evidenceIds,
  }))
  return verification.status === 'passed'
    ? { status: 'verifier_passed', claims, failedCriteria: [] }
    : {
        status: 'verifier_failed',
        claims,
        failedCriteria: verification.assertions
          .filter((assertion) => !assertion.passed)
          .map((assertion) => assertion.predicate.id),
      }
}

function projectLastToolResult(
  durable: DurableProjection,
  operation: CaretakerLiveState['operation'],
): CaretakerDecisionRequest['lastToolResult'] {
  const receipt = durable.receipts.at(-1) ?? null
  if (receipt === null) return null
  const unresolved = receipt.status === 'pending' || receipt.status === 'unknown'
  const operationExists = durable.operations.some(
    (candidate) => candidate.planId === durable.plan?.id,
  )
  if (unresolved && operationExists && !operation.reconciliationRequired) return null
  return {
    toolName: receipt.toolName,
    status: receipt.status,
    errorCode: null,
    evidenceIds: [receiptEvidenceId(receipt), ...receipt.evidenceIds],
  }
}

function approvalIsForged(plan: Plan | null, approval: DurableProjection['approval']): boolean {
  if (plan === null) return approval !== null
  if (approval?.status === 'approved' && plan.status !== 'approved') return true
  if (plan.status !== 'approved') return false
  if (approval === null || approval.status !== 'approved') return true
  if (
    approval.organizationId !== plan.organizationId ||
    approval.missionId !== plan.missionId ||
    approval.planId !== plan.id ||
    approval.planHash !== plan.hash
  ) {
    return true
  }
  const approvedActions = [...approval.actionIds].sort()
  const planActions = plan.actions.map((action) => action.id).sort()
  if (hashToolValue(approvedActions) !== hashToolValue(planActions)) return true
  if (approval.protectedResources.length !== plan.actions.length) return true
  return plan.actions.some((action) => {
    const protectedResource = approval.protectedResources.find((resource) =>
      isRoutineReplacementAction(action)
        ? resource.routineId === action.protectedRoutineId
        : resource.routineId === action.routineId,
    )
    if (protectedResource === undefined) return true
    return isRoutineReplacementAction(action)
      ? protectedResource.routineVersionId !== action.protectedRoutineVersionId ||
          protectedResource.version !== action.expectedProtectedVersion
      : protectedResource.version !== action.expectedCurrentVersion
  })
}

function buildEvidenceCatalog(durable: DurableProjection): CaretakerHostProjection['evidence'] {
  const entries = new Map<EvidenceId, { kind: EvidenceKind; supports: Set<string> }>()
  addEvidence(entries, contextEvidenceId(durable.contextReceipt), 'policy', [
    'tenant.access',
    'context.bundle_hash',
  ])
  addEvidence(entries, stateEvidenceId('capability', durable.capabilities), 'runtime_state', [
    'capability.fit',
  ])
  if (durable.plan !== null) {
    addEvidence(entries, entityStateEvidenceId('plan', durable.plan.id), 'runtime_state', [
      'plan.id',
      'plan.hash',
      'plan.protected_version',
    ])
  }
  if (durable.validation !== null) {
    addEvidence(entries, stateEvidenceId('validation', durable.validation), 'runtime_state', [
      'plan.validation',
    ])
  }
  for (const simulation of durable.simulations) {
    addEvidence(entries, stateEvidenceId('simulation', simulation), 'runtime_state', [
      'plan.simulation',
    ])
  }
  if (durable.approval !== null) {
    addEvidence(entries, entityStateEvidenceId('approval', durable.approval.id), 'runtime_state', [
      'approval.status',
      'approval.authority',
    ])
  }
  for (const operation of durable.operations) {
    addEvidence(entries, entityStateEvidenceId('operation', operation.id), 'runtime_state', [
      'operation.id',
      'operation.status',
    ])
    for (const reconciliation of durable.reconciliationsByOperation.get(operation.id) ?? []) {
      addEvidence(entries, stateEvidenceId('reconciliation', reconciliation), 'runtime_state', [
        'operation.id',
        'operation.status',
      ])
    }
  }
  for (const record of durable.evidence) {
    addEvidence(entries, record.evidence.id, 'runtime_state', ['evidence.runtime_state'])
  }
  for (const receipt of durable.receipts) {
    const field = `tool.${receipt.toolName}.status`
    addEvidence(
      entries,
      receiptEvidenceId(receipt),
      'tool_result',
      receipt.toolName === 'knowledge.search' ? [field, 'knowledge.retrieval'] : [field],
    )
    for (const evidenceId of receipt.evidenceIds) {
      addEvidence(
        entries,
        evidenceId,
        'tool_result',
        receipt.toolName === 'knowledge.search'
          ? [field, 'knowledge.retrieval']
          : [field, 'operation.status'],
      )
    }
  }
  if (durable.verification !== null) {
    for (const assertion of durable.verification.assertions) {
      for (const evidenceId of assertion.evidenceIds) {
        addEvidence(entries, evidenceId, 'verifier_receipt', [
          'verification.status',
          verificationField(assertion.predicate.id),
        ])
      }
    }
  }
  const known = new Set(entries.keys())
  for (const checkpoint of durable.checkpoints) {
    for (const evidenceId of checkpoint.evidenceRefs) {
      if (!known.has(evidenceId)) {
        throw integrity('Caretaker checkpoint references evidence outside durable projection state')
      }
    }
  }
  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) =>
      DecisionEvidenceReferenceSchema.parse({
        id,
        kind: value.kind,
        supports: [...value.supports].sort(),
      }),
    )
}

function addEvidence(
  entries: Map<EvidenceId, { kind: EvidenceKind; supports: Set<string> }>,
  id: EvidenceId,
  kind: EvidenceKind,
  supports: readonly string[],
): void {
  const existing = entries.get(id)
  if (existing === undefined) {
    entries.set(id, { kind, supports: new Set(supports) })
    return
  }
  if (EVIDENCE_KIND_PRIORITY[kind] > EVIDENCE_KIND_PRIORITY[existing.kind]) {
    existing.kind = kind
  }
  for (const field of supports) existing.supports.add(field)
}

function contextEvidenceId(receipt: ContextReceipt): EvidenceId {
  return derivedEvidenceId('context', {
    receiptId: receipt.id,
    bundleHash: contextBundleHashForReceipt(receipt),
  })
}

function receiptEvidenceId(receipt: ToolCallReceipt): EvidenceId {
  return derivedEvidenceId('tool_receipt', {
    receiptId: receipt.id,
    callId: receipt.callId,
    resultHash: receipt.resultHash,
  })
}

function stateEvidenceId(kind: string, value: unknown): EvidenceId {
  return derivedEvidenceId(kind, value)
}

function entityStateEvidenceId(kind: string, id: string): EvidenceId {
  return derivedEvidenceId(kind, { id })
}

function derivedEvidenceId(kind: string, value: unknown): EvidenceId {
  const digest = hashToolValue({ schemaVersion: 'caretaker-derived-evidence@1', kind, value })
  return EvidenceIdSchema.parse(`evd_${digest.slice(0, 32)}`)
}

function verificationField(predicateId: string): string {
  const candidate = `verification.${predicateId}`
  if (candidate.length <= 120) return candidate
  return `verification.${predicateId.slice(0, 86)}_${hashToolValue(predicateId).slice(0, 20)}`
}

function parseMaterialIssue(
  issue: MaterialIssue | null,
  evidenceIds: ReadonlySet<EvidenceId>,
): MaterialIssue | null {
  if (issue === null) return null
  const parsed = CaretakerLiveStateSchema.shape.materialIssue.unwrap().parse(issue)
  if (parsed.evidenceIds.some((id) => !evidenceIds.has(id))) {
    throw integrity('Material-issue synthesis referenced evidence outside durable state')
  }
  return parsed
}

function parseProposal(proposal: PlanProposal | null, mission: Mission): PlanProposal | null {
  if (proposal === null) return null
  const parsed = PlansProposeInputSchema.parse(proposal)
  if (
    parsed.missionId !== mission.id ||
    parsed.revision !== 1 ||
    hashToolValue([...parsed.successCriteriaIds].sort()) !==
      hashToolValue([...mission.successCriteriaIds].sort())
  ) {
    throw integrity('Homecoming draft synthesis escaped the current mission contract')
  }
  return parsed
}

function createSynthesisSnapshot(input: {
  readonly durable: DurableProjection
  readonly evidenceIds: readonly EvidenceId[]
  readonly discovery: CaretakerLiveState['discovery']
  readonly capabilityFit: CaretakerLiveState['capabilityFit']
}): CaretakerSynthesisSnapshot {
  const { durable } = input
  const snapshot: CaretakerSynthesisSnapshot = {
    mission: {
      id: durable.mission.id,
      palaceId: durable.mission.palaceId,
      programKind: missionProgramKindOf(durable.mission),
      objective: durable.mission.objective,
      constraints: durable.mission.constraints,
      successCriteriaIds: durable.mission.successCriteriaIds,
      state: durable.mission.state,
      version: durable.mission.version,
    },
    context: {
      receiptId: durable.contextReceipt.id,
      bundleHash: contextBundleHashForReceipt(durable.contextReceipt),
      policyHash: durable.contextReceipt.policyHash,
      toolRegistryHash: durable.contextReceipt.toolRegistryHash,
      sources: durable.contextReceipt.sources,
    },
    palace: {
      id: durable.palace.id,
      timezone: durable.palace.timezone,
      batteryAvailablePercentage: durable.palace.batteryAvailablePercentage,
    },
    crew: {
      schedules: durable.crew.schedules.map((schedule) => ({
        id: schedule.id,
        crewMemberId: schedule.crewMemberId,
        active: schedule.active,
        version: schedule.version,
        timezone: schedule.timezone,
        windowStart: schedule.windowStart,
        windowEnd: schedule.windowEnd,
      })),
      preferences: durable.crew.preferences.map((preference) => ({
        id: preference.id,
        crewMemberId: preference.crewMemberId,
        active: preference.active,
        version: preference.version,
        targetCelsius: preference.targetCelsius,
        pathwayLightingIntensityPercent: preference.pathwayLightingIntensityPercent,
        pathwayLightingDurationSeconds: preference.pathwayLightingDurationSeconds,
      })),
    },
    capabilities: {
      devices: durable.capabilities.devices.map((device) => ({
        id: device.id,
        kind: device.kind,
        health: device.health,
        version: device.version,
      })),
      capabilities: durable.capabilities.capabilities.map((capability) => ({
        id: capability.id,
        deviceId: capability.deviceId,
        kind: capability.kind,
        enabled: capability.enabled,
        constraints: capability.constraints,
      })),
    },
    routines: {
      routines: durable.routines.routines.map((routine) => ({
        id: routine.id,
        palaceId: routine.palaceId,
        activeVersionId: routine.activeVersionId,
      })),
      versions: durable.routines.versions.map((version) => ({
        id: version.id,
        routineId: version.routineId,
        version: version.version,
        status: version.status,
        definition: version.definition,
      })),
    },
    discovery: input.discovery,
    capabilityFit: input.capabilityFit,
    evidenceIds: input.evidenceIds,
    persistedEvidence: durable.evidence,
    clarification: durable.clarification,
  }
  const detached = structuredClone(snapshot)
  freezeRecursively(detached)
  return detached
}

function freezeRecursively(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
  for (const nested of Object.values(value)) freezeRecursively(nested)
  Object.freeze(value)
}

async function currentVersionForPlan(
  repositories: Parameters<typeof loadDurableProjection>[0]['repositories'],
  plan: Plan,
) {
  if (plan.actions.length !== 1) return null
  const action = plan.actions[0]
  if (action === undefined) return null
  const routineId = isRoutineReplacementAction(action)
    ? action.protectedRoutineId
    : action.routineId
  const current = await repositories.routines.getCurrentVersion(routineId)
  if (current !== null && current.routineId !== routineId) {
    throw integrity('Current protected routine version escaped its requested routine')
  }
  return current
}

function assertRelatedRecordBindings(input: {
  readonly mission: Mission
  readonly plan: Plan | null
  readonly approval: DurableProjection['approval']
  readonly validation: PlanValidationRecord | null
  readonly simulations: readonly PlanSimulationRecord[]
  readonly verification: Verification | null
}): void {
  if (input.plan === null) {
    if (
      input.approval !== null ||
      input.validation !== null ||
      input.simulations.length > 0 ||
      input.verification !== null
    ) {
      throw integrity('Plan-dependent projection state lacks its durable plan')
    }
    return
  }
  if (
    input.plan.organizationId !== input.mission.organizationId ||
    input.plan.missionId !== input.mission.id ||
    input.plan.palaceId !== input.mission.palaceId ||
    (input.validation?.planId !== undefined && input.validation.planId !== input.plan.id) ||
    input.simulations.some((simulation) => simulation.planId !== input.plan?.id) ||
    (input.approval !== null &&
      (input.approval.organizationId !== input.mission.organizationId ||
        input.approval.missionId !== input.mission.id ||
        input.approval.planId !== input.plan.id)) ||
    (input.verification !== null && input.verification.planHash !== input.plan.hash)
  ) {
    throw integrity('Plan-dependent projection records disagree with the current mission and plan')
  }
}

function assertOwnedRecords(
  organizationId: Mission['organizationId'],
  mission: Mission,
  records: Readonly<{
    palace: DurableProjection['palace']
    crew: DurableProjection['crew']
    capabilities: DurableProjection['capabilities']
    routines: DurableProjection['routines']
    plan: DurableProjection['plan']
    operations: DurableProjection['operations']
    evidence: DurableProjection['evidence']
    verification: DurableProjection['verification']
  }>,
): void {
  const owned = [
    records.palace,
    ...records.crew.crew,
    ...records.crew.identityTags,
    ...records.crew.schedules,
    ...records.crew.preferences,
    ...records.capabilities.devices,
    ...records.capabilities.capabilities,
    ...records.routines.routines,
    ...records.routines.versions,
    ...(records.plan === null ? [] : [records.plan]),
    ...records.operations,
    ...records.evidence.map((record) => record.evidence),
    ...(records.verification === null ? [] : [records.verification]),
  ]
  if (
    records.palace.id !== mission.palaceId ||
    owned.some((record) => record.organizationId !== organizationId) ||
    records.crew.crew.some((member) => member.palaceId !== mission.palaceId) ||
    records.crew.schedules.some((schedule) => schedule.palaceId !== mission.palaceId) ||
    records.crew.preferences.some((preference) => preference.palaceId !== mission.palaceId) ||
    records.capabilities.devices.some((device) => device.palaceId !== mission.palaceId) ||
    records.routines.routines.some((routine) => routine.palaceId !== mission.palaceId) ||
    (records.plan !== null && records.plan.missionId !== mission.id) ||
    records.operations.some((operation) => operation.missionId !== mission.id) ||
    records.evidence.some(
      (record) =>
        record.evidence.missionId !== mission.id || record.evidence.palaceId !== mission.palaceId,
    ) ||
    (records.verification !== null && records.verification.missionId !== mission.id)
  ) {
    throw integrity('A projected record escaped the fenced mission tenant')
  }

  const crewIds = new Set(records.crew.crew.map((member) => member.id))
  const deviceIds = new Set(records.capabilities.devices.map((device) => device.id))
  const routineIds = new Set(records.routines.routines.map((routine) => routine.id))
  if (
    records.crew.schedules.some((schedule) => !crewIds.has(schedule.crewMemberId)) ||
    records.crew.preferences.some((preference) => !crewIds.has(preference.crewMemberId)) ||
    records.crew.identityTags.some(
      (tag) => tag.crewMemberId !== null && !crewIds.has(tag.crewMemberId),
    ) ||
    records.capabilities.capabilities.some((capability) => !deviceIds.has(capability.deviceId)) ||
    records.routines.versions.some((version) => !routineIds.has(version.routineId))
  ) {
    throw integrity('A projected child record escaped its fenced palace aggregate')
  }
}

function assertProjectionEvidenceBindings(input: {
  readonly evidence: readonly PersistedEvidenceRecord[]
  readonly receipts: readonly ToolCallReceipt[]
  readonly verification: Verification | null
  readonly checkpoints: readonly CaretakerRunCheckpoint[]
}): void {
  const persisted = new Set(input.evidence.map((record) => record.evidence.id))
  for (const receipt of input.receipts) {
    if (receipt.evidenceIds.some((id) => !persisted.has(id))) {
      throw integrity('Tool receipt references evidence outside the fenced mission')
    }
  }
  if (
    input.verification?.assertions.some((assertion) =>
      assertion.evidenceIds.some((id) => !persisted.has(id)),
    ) === true
  ) {
    throw integrity('Verifier receipt references evidence outside the fenced mission')
  }
  const reservedCalls = new Set(
    toolReservations(input.checkpoints).map((entry) => entry.pending.callId),
  )
  if (input.receipts.some((receipt) => !reservedCalls.has(receipt.callId))) {
    throw integrity('Projected tool receipt lacks a durable Caretaker reservation')
  }
}

function assertClarificationProjectionBinding(input: {
  readonly mission: Mission
  readonly request: ClarificationRequest | null
  readonly answer: ClarificationAnswer | null
  readonly evidence: readonly PersistedEvidenceRecord[]
}): void {
  if (input.request === null) {
    if (input.answer !== null) {
      throw integrity('Clarification answer lacks its durable request')
    }
    return
  }

  const persistedEvidence = new Set(input.evidence.map((record) => record.evidence.id))
  const requestIsBound =
    input.request.organizationId === input.mission.organizationId &&
    input.request.missionId === input.mission.id &&
    input.request.evidenceRefs.every((id) => persistedEvidence.has(id))
  const answerIsRequired = input.request.status === 'answered'
  const answerIsBound =
    input.answer !== null &&
    input.answer.organizationId === input.mission.organizationId &&
    input.answer.missionId === input.mission.id &&
    input.answer.requestId === input.request.id &&
    input.request.choices.some((choice) => choice.id === input.answer?.choiceId) &&
    input.answer.evidenceRefs.every((id) => persistedEvidence.has(id))
  if (
    !requestIsBound ||
    answerIsRequired !== (input.answer !== null) ||
    (input.answer !== null && !answerIsBound) ||
    (input.request.status === 'pending' &&
      (input.mission.state.status !== 'waiting_for_user' || input.mission.state.phase !== 'plan'))
  ) {
    throw integrity('Clarification history escaped its fenced mission or durable pause')
  }
}

function integrity(message: string): CaretakerRuntimeAdapterIntegrityError {
  return new CaretakerRuntimeAdapterIntegrityError(message)
}

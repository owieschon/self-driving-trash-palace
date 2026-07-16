import {
  CARETAKER_BUDGETS,
  ContextReceiptSchema,
  ContextReceiptIdSchema,
  EvidenceIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  RunIdSchema,
  Sha256Schema,
  TOOL_REGISTRY,
  TOOL_REGISTRY_HASH,
  ToolCallIdSchema,
  ToolCallReceiptSchema,
  ToolNameSchema,
  hashToolValue,
  parseToolResult,
  principalHasPermission,
  type EvidenceId,
  type Mission,
  type Sha256,
  type ToolCallReceipt,
  type ToolName,
} from '@trash-palace/core'
import {
  CaretakerPendingToolCallSchema,
  CaretakerRunCountersSchema,
  ConflictError,
  LeaseLostError,
  caretakerRunStatusForCheckpoint,
  type CaretakerPendingToolCall,
  type CaretakerRunCheckpoint,
  type CaretakerRunCounters,
  type CaretakerRunMutationCheckpointKind,
  type CaretakerRunSnapshot,
  type MissionExecutionContext,
  type MissionExecutionUnitOfWorkPort,
} from '@trash-palace/application'
import { z } from 'zod'

import {
  CaretakerDecisionRequestSchema,
  parseDecisionForRequest,
  type CaretakerDecision,
  type CaretakerDecisionEngine,
  type CaretakerDecisionObservation,
  type CaretakerDecisionRequest,
  type CaretakerLiveState,
  type DecisionEvidenceReferenceSchema,
} from './decision-engine.js'
import { contextBundleHashForReceipt } from './caretaker-context.js'
import type {
  CaretakerEvidenceRecorder,
  CaretakerRunEvidence,
  CaretakerTraceEvidenceInput,
} from './caretaker-evidence.js'

const MAX_HOST_STEPS_PER_ACTIVATION = CARETAKER_BUDGETS.maxToolCallsPerRun * 3 + 16
const MAX_CHECKPOINT_EVIDENCE_REFS = 32
const MAX_ACTIVE_RUNTIME_MILLISECONDS = CARETAKER_BUDGETS.maxActiveRuntimeSeconds * 1_000

type DecisionEvidenceReference = z.infer<typeof DecisionEvidenceReferenceSchema>

export interface CaretakerHostClock {
  now(): Date
  monotonicMilliseconds(): number
}

const SYSTEM_HOST_CLOCK: CaretakerHostClock = {
  now: () => new Date(),
  monotonicMilliseconds: () => performance.now(),
}

export interface CaretakerHostProjection {
  readonly contextReceiptId: ReturnType<typeof ContextReceiptIdSchema.parse>
  readonly contextBundleHash: Sha256
  readonly frozenContext: CaretakerDecisionRequest['frozenContext']
  readonly retrievedKnowledge: CaretakerDecisionRequest['retrievedKnowledge']
  readonly mission: Readonly<
    Pick<
      Mission,
      | 'id'
      | 'palaceId'
      | 'programKind'
      | 'objective'
      | 'constraints'
      | 'state'
      | 'version'
      | 'taskLedger'
    >
  >
  readonly evidence: readonly DecisionEvidenceReference[]
  readonly liveState: CaretakerLiveState
  readonly lastToolResult: CaretakerDecisionRequest['lastToolResult']
}

export interface CaretakerHostProjectionPort {
  load(input: {
    readonly context: MissionExecutionContext
    readonly runId: ReturnType<typeof RunIdSchema.parse>
    readonly signal: AbortSignal
  }): Promise<CaretakerHostProjection>
}

export interface CaretakerHostToolPort {
  invoke(input: {
    readonly context: MissionExecutionContext
    readonly pendingToolCall: CaretakerPendingToolCall
    readonly signal: AbortSignal
  }): Promise<{
    readonly result: unknown
    readonly evidenceIds: readonly EvidenceId[]
    readonly receipt: ToolCallReceipt
  }>
}

export interface CaretakerHumanPausePort {
  requestClarification(input: {
    readonly context: MissionExecutionContext
    readonly missionId: ReturnType<typeof MissionIdSchema.parse>
    readonly runId: ReturnType<typeof RunIdSchema.parse>
    readonly materialField: string
    readonly question: string
    readonly choices: readonly Readonly<{ id: string; label: string }>[]
    readonly evidenceIds: readonly EvidenceId[]
    readonly signal: AbortSignal
  }): Promise<void>
}

export interface CaretakerMissionTransitionPort {
  transition(input: {
    readonly context: MissionExecutionContext
    readonly missionId: ReturnType<typeof MissionIdSchema.parse>
    readonly expectedVersion: number
    readonly event: 'context_sufficient'
  }): Promise<unknown>
}

export type CaretakerHostResult =
  | Readonly<{
      kind: 'completed'
      runId: ReturnType<typeof RunIdSchema.parse>
      runVersion: number
      verifierEvidenceIds: readonly EvidenceId[]
    }>
  | Readonly<{
      kind: 'paused'
      runId: ReturnType<typeof RunIdSchema.parse>
      runVersion: number
      reason: 'approval' | 'budget' | 'clarification' | 'human_review' | 'system'
    }>
  | Readonly<{
      kind: 'retry'
      runId: ReturnType<typeof RunIdSchema.parse>
      runVersion: number
      reason: 'checkpoint_contention' | 'tool_pending'
    }>
  | Readonly<{
      kind: 'failed'
      runId: ReturnType<typeof RunIdSchema.parse>
      runVersion: number
      reason: 'host_rejected_decision' | 'mission_failed' | 'safe_refusal'
    }>
  | Readonly<{
      kind: 'cancelled'
      runId: ReturnType<typeof RunIdSchema.parse>
      runVersion: number
    }>

export interface CaretakerLifecycleHostDependencies {
  readonly unitOfWork: MissionExecutionUnitOfWorkPort
  readonly projections: CaretakerHostProjectionPort
  readonly tools: CaretakerHostToolPort
  readonly humanPauses: CaretakerHumanPausePort
  readonly missionTransitions: CaretakerMissionTransitionPort
  readonly decisionEngine: CaretakerDecisionEngine
  readonly evidence: CaretakerEvidenceRecorder
  readonly clock?: CaretakerHostClock
}

export interface ResumeCaretakerInput {
  readonly context: MissionExecutionContext
  readonly requestedRunId: string
  readonly missionId: string
  readonly activationKey: string
  readonly activatedAt: string
}

type CheckpointResult = Readonly<
  | { kind: 'saved'; snapshot: CaretakerRunSnapshot }
  | { kind: 'conflict'; snapshot: CaretakerRunSnapshot }
>

type PendingExecutionResult = Readonly<
  | { kind: 'advanced'; snapshot: CaretakerRunSnapshot; reconciliationRequired: boolean }
  | { kind: 'conflict'; snapshot: CaretakerRunSnapshot }
  | { kind: 'wait'; snapshot: CaretakerRunSnapshot }
>

type ProjectedCheckpointResult = Readonly<
  | { kind: 'not_applicable' }
  | { kind: 'conflict'; snapshot: CaretakerRunSnapshot }
  | { kind: 'result'; result: CaretakerHostResult }
>

const TRANSIENT_TOOL_RESULT_CODES = new Set(['CALL_IN_PROGRESS', 'RECONCILIATION_PENDING'])

class CaretakerDependencyDeadlineError extends Error {
  override readonly name = 'CaretakerDependencyDeadlineError'
}

class CaretakerDecisionObservationContractError extends Error {
  override readonly name = 'CaretakerDecisionObservationContractError'
}

/**
 * Owns the bounded Caretaker activation. The engine may choose only among the exact tools and
 * evidence the host projects; durable application services retain mutation and verification
 * authority.
 */
export class CaretakerLifecycleHost {
  readonly #clock: CaretakerHostClock

  public constructor(private readonly dependencies: CaretakerLifecycleHostDependencies) {
    this.#clock = dependencies.clock ?? SYSTEM_HOST_CLOCK
  }

  public async resume(input: ResumeCaretakerInput): Promise<CaretakerHostResult> {
    const context = input.context
    context.signal.throwIfAborted()
    const requestedRunId = RunIdSchema.parse(input.requestedRunId)
    const missionId = MissionIdSchema.parse(input.missionId)
    const activationKey = Sha256Schema.parse(input.activationKey)
    const activatedAt = IsoDateTimeSchema.parse(input.activatedAt)
    this.#assertContext(context, missionId)

    const initialized = await this.dependencies.unitOfWork.runFenced(
      context.fence,
      async (repositories) => {
        const current = await repositories.caretakerRuns.getLatestForMission(missionId)
        const missionBeforeStart = await repositories.missions.get(missionId)
        if (missionBeforeStart === null || missionBeforeStart.contextReceiptId === null) {
          throw new Error('Caretaker run requires a mission with frozen context')
        }
        const terminalFinalization = ['succeeded', 'failed', 'cancelled'].includes(
          missionBeforeStart.state.status,
        )
        const profileRunId =
          current !== null && (current.run.status !== 'paused' || terminalFinalization)
            ? current.run.id
            : requestedRunId
        const contextReceipt = await repositories.contextReceipts.get(
          missionBeforeStart.contextReceiptId,
        )
        if (contextReceipt === null) throw new Error('Caretaker run context receipt is absent')
        const parsedContextReceipt = ContextReceiptSchema.parse(contextReceipt)
        const contextManifestHash = contextBundleHashForReceipt(parsedContextReceipt)
        const evidenceProfile = this.dependencies.evidence.profile({
          runId: profileRunId,
          activatedAt,
          organizationId: context.principal.organizationId,
          actorId: missionBeforeStart.initiatedBy,
          palaceId: missionBeforeStart.palaceId,
          missionId,
          contextManifestHash,
        })
        const snapshot = (
          await repositories.caretakerRuns.start({
            runId: profileRunId,
            missionId,
            mutationKey: activationKey,
            evidenceProfile,
            occurredAt: activatedAt,
          })
        ).snapshot
        const mission = await repositories.missions.get(missionId)
        if (
          mission === null ||
          mission.contextReceiptId !== parsedContextReceipt.id ||
          snapshot.run.id !== profileRunId ||
          snapshot.run.evidenceProfile.profileHash !== evidenceProfile.profileHash
        ) {
          throw new Error('Caretaker run changed while its evidence profile was frozen')
        }
        return {
          snapshot,
          mission,
          contextReceipt: parsedContextReceipt,
          contextManifestHash,
        }
      },
    )
    let snapshot = initialized.snapshot
    this.#assertSnapshot(snapshot, context, missionId)

    const contextReceipt = initialized.contextReceipt
    if (
      initialized.mission.organizationId !== context.principal.organizationId ||
      initialized.mission.id !== missionId ||
      initialized.mission.runId !== snapshot.run.id ||
      initialized.mission.contextReceiptId !== contextReceipt.id ||
      contextReceipt.organizationId !== context.principal.organizationId ||
      contextReceipt.missionId !== missionId ||
      contextReceipt.runId !== snapshot.run.id ||
      contextReceipt.toolRegistryHash !== TOOL_REGISTRY_HASH
    ) {
      throw new Error('Caretaker run, mission, and frozen context bindings disagree')
    }
    const contextManifestHash = initialized.contextManifestHash
    const evidence = this.dependencies.evidence.begin({
      runId: snapshot.run.id,
      profile: snapshot.run.evidenceProfile,
      activatedAt: snapshot.run.startedAt,
    })

    const result = await (async (): Promise<CaretakerHostResult> => {
      const terminal = await this.#terminalResult(context, snapshot)
      if (terminal !== null) return terminal

      let reconciliationRequiredAfterResult = false

      for (let step = 0; step < MAX_HOST_STEPS_PER_ACTIVATION; step += 1) {
        context.signal.throwIfAborted()

        const terminalSnapshot = await this.#terminalResult(context, snapshot)
        if (terminalSnapshot !== null) return terminalSnapshot

        if (snapshot.run.pendingToolCall !== null) {
          const recovered = await this.#executePendingTool(
            context,
            snapshot,
            evidence,
            contextManifestHash,
          )
          snapshot = recovered.snapshot
          if (recovered.kind === 'conflict') continue
          if (recovered.kind === 'wait') {
            return {
              kind: 'retry',
              runId: snapshot.run.id,
              runVersion: snapshot.run.version,
              reason: 'tool_pending',
            }
          }
          reconciliationRequiredAfterResult = recovered.reconciliationRequired
          continue
        }

        if (snapshot.run.counters.activeRuntimeMilliseconds >= MAX_ACTIVE_RUNTIME_MILLISECONDS) {
          const paused = await this.#saveCheckpoint(context, snapshot, {
            kind: 'budget_exhausted',
            counters: snapshot.run.counters,
            pendingToolCall: null,
            evidenceRefs: snapshot.checkpoint.evidenceRefs,
          })
          if (paused.kind === 'conflict') {
            snapshot = paused.snapshot
            continue
          }
          return {
            kind: 'paused',
            runId: paused.snapshot.run.id,
            runVersion: paused.snapshot.run.version,
            reason: 'budget',
          }
        }

        const projectedAt = this.#monotonicNow()
        const projectionIdentity = `projection_${snapshot.run.id}_${snapshot.run.version}`
        const projectionOccurredAt = snapshot.checkpoint.occurredAt
        let projection: CaretakerHostProjection
        try {
          projection = await this.#withinBudget(
            context.signal,
            snapshot.run.counters,
            async (signal) =>
              this.dependencies.projections.load({ context, runId: snapshot.run.id, signal }),
          )
          this.#assertProjection(projection, snapshot)
          if (projection.contextBundleHash !== contextManifestHash) {
            throw new Error('Projected context differs from the frozen run context')
          }
          const projectedResultRequiresReconciliation =
            projection.lastToolResult !== null &&
            requiresOperationReconciliation(
              projection.lastToolResult.toolName,
              projection.lastToolResult.status,
            )
          const fastReconciliationCompleted =
            reconciliationRequiredAfterResult &&
            projection.mission.state.status === 'waiting_for_system' &&
            projection.mission.state.phase === 'observe' &&
            projection.liveState.operation.status === 'committed' &&
            !projection.liveState.operation.reconciliationRequired &&
            projection.lastToolResult === null
          if (
            (reconciliationRequiredAfterResult || projectedResultRequiresReconciliation) &&
            !projection.liveState.operation.reconciliationRequired &&
            !fastReconciliationCompleted
          ) {
            throw new Error('A pending or unknown tool result lacks a reconciliation checkpoint')
          }
        } catch (error) {
          await evidence.recordContext({
            identity: projectionIdentity,
            contextManifestHash,
            occurredAt: projectionOccurredAt,
            latencyMilliseconds: this.#elapsed(projectedAt),
            status: 'failed',
            errorCode:
              error instanceof CaretakerDependencyDeadlineError
                ? 'projection_deadline_exceeded'
                : 'projection_failed',
          })
          if (['succeeded', 'failed', 'cancelled'].includes(initialized.mission.state.status)) {
            throw error
          }
          const failed = await this.#checkpointDependencyFailure(
            context,
            snapshot,
            projectedAt,
            error,
            snapshot.checkpoint.evidenceRefs,
          )
          if ('snapshot' in failed) {
            snapshot = failed.snapshot
            continue
          }
          return failed.result
        }
        const projectionRuntime = this.#elapsed(projectedAt)
        reconciliationRequiredAfterResult = false
        const projectedRuntime = this.#addRuntime(
          snapshot.run.counters.activeRuntimeMilliseconds,
          projectionRuntime,
        )

        const terminalState = await this.#checkpointTerminalMission(
          context,
          snapshot,
          projection,
          projectedRuntime,
        )
        if (terminalState.kind === 'conflict') {
          snapshot = terminalState.snapshot
          continue
        }
        if (terminalState.kind === 'result') return terminalState.result

        const externalPause = await this.#checkpointExternalPause(
          context,
          snapshot,
          projection,
          projectedRuntime,
        )
        if (externalPause.kind === 'conflict') {
          snapshot = externalPause.snapshot
          continue
        }
        if (externalPause.kind === 'result') return externalPause.result

        if (projectedRuntime >= MAX_ACTIVE_RUNTIME_MILLISECONDS) {
          const paused = await this.#saveCheckpoint(context, snapshot, {
            kind: 'budget_exhausted',
            counters: this.#withRuntime(snapshot.run.counters, projectedRuntime),
            pendingToolCall: null,
            evidenceRefs: this.#evidenceRefs(projection.evidence.map((entry) => entry.id)),
          })
          if (paused.kind === 'conflict') {
            snapshot = paused.snapshot
            continue
          }
          return {
            kind: 'paused',
            runId: paused.snapshot.run.id,
            runVersion: paused.snapshot.run.version,
            reason: 'budget',
          }
        }

        if (
          projection.mission.state.status === 'running' &&
          projection.mission.state.phase === 'understand' &&
          Object.values(projection.liveState.discovery).every((status) => status === 'ready')
        ) {
          await this.dependencies.missionTransitions.transition({
            context,
            missionId: projection.mission.id,
            expectedVersion: projection.mission.version,
            event: 'context_sufficient',
          })
          const advanced = await this.#saveCheckpoint(context, snapshot, {
            kind: 'state_persisted',
            counters: this.#withRuntime(snapshot.run.counters, projectedRuntime),
            pendingToolCall: null,
            evidenceRefs: this.#evidenceRefs(projection.evidence.map((entry) => entry.id)),
          })
          snapshot = advanced.snapshot
          if (advanced.kind === 'conflict') continue
          continue
        }

        const attempted = await this.#saveCheckpoint(context, snapshot, {
          kind: 'decision_attempt',
          counters: this.#withRuntime(snapshot.run.counters, projectedRuntime),
          pendingToolCall: null,
          evidenceRefs: this.#evidenceRefs(projection.evidence.map((entry) => entry.id)),
        })
        snapshot = attempted.snapshot
        if (attempted.kind === 'conflict') continue
        const attemptIdentity = `attempt_${snapshot.run.id}_${snapshot.checkpoint.sequence}`
        const attemptOccurredAt = snapshot.checkpoint.occurredAt
        await evidence.recordContext({
          identity: attemptIdentity,
          contextManifestHash,
          occurredAt: attemptOccurredAt,
          latencyMilliseconds: projectionRuntime,
          status: 'succeeded',
        })

        const request = this.#decisionRequest(context, snapshot, projection, projectedRuntime)
        const decisionStartedAt = this.#monotonicNow()
        let observationCount = 0
        let untrustedDecision: CaretakerDecision
        try {
          untrustedDecision = await this.#withinBudget(
            context.signal,
            this.#withRuntime(snapshot.run.counters, projectedRuntime),
            async (signal) =>
              this.dependencies.decisionEngine.decide(request, {
                signal,
                attemptId: attemptIdentity,
                observe: async (observation: CaretakerDecisionObservation) => {
                  observationCount += 1
                  if (observationCount !== 1) {
                    throw new CaretakerDecisionObservationContractError(
                      'A decision attempt emitted more than one terminal observation',
                    )
                  }
                  await evidence.recordDecisionObservation({
                    observation,
                    contextManifestHash,
                    occurredAt: attemptOccurredAt,
                    measuredLatencyMilliseconds: this.#elapsed(decisionStartedAt),
                  })
                },
              }),
          )
          if (observationCount !== 1) {
            throw new CaretakerDecisionObservationContractError(
              'A decision attempt omitted its terminal observation',
            )
          }
        } catch (error) {
          if (observationCount === 0) {
            await evidence.recordDecision({
              identity: attemptIdentity,
              contextManifestHash,
              occurredAt: attemptOccurredAt,
              latencyMilliseconds: this.#elapsed(decisionStartedAt),
              status: 'failed',
              errorCode:
                error instanceof CaretakerDependencyDeadlineError
                  ? 'decision_deadline_exceeded'
                  : error instanceof CaretakerDecisionObservationContractError
                    ? 'decision_observation_missing'
                    : 'decision_failed',
            })
          }
          const failed = await this.#checkpointDependencyFailure(
            context,
            snapshot,
            decisionStartedAt,
            error,
            this.#evidenceRefs(projection.evidence.map((entry) => entry.id)),
            projectedRuntime,
          )
          if ('snapshot' in failed) {
            snapshot = failed.snapshot
            continue
          }
          return failed.result
        }
        const decisionRuntime = this.#elapsed(decisionStartedAt)
        const activeRuntime = this.#addRuntime(projectedRuntime, decisionRuntime)

        if (activeRuntime >= MAX_ACTIVE_RUNTIME_MILLISECONDS) {
          const paused = await this.#saveCheckpoint(context, snapshot, {
            kind: 'budget_exhausted',
            counters: this.#withRuntime(snapshot.run.counters, activeRuntime),
            pendingToolCall: null,
            evidenceRefs: this.#evidenceRefs(projection.evidence.map((entry) => entry.id)),
          })
          if (paused.kind === 'conflict') {
            snapshot = paused.snapshot
            continue
          }
          return {
            kind: 'paused',
            runId: paused.snapshot.run.id,
            runVersion: paused.snapshot.run.version,
            reason: 'budget',
          }
        }

        let decision: CaretakerDecision
        try {
          decision = parseDecisionForRequest(request, untrustedDecision)
        } catch {
          const retained = await this.#saveCheckpoint(context, snapshot, {
            kind: 'host_failed',
            counters: this.#withRuntime(snapshot.run.counters, activeRuntime),
            pendingToolCall: null,
            evidenceRefs: this.#evidenceRefs(projection.evidence.map((entry) => entry.id)),
          })
          if (retained.kind === 'conflict') {
            snapshot = retained.snapshot
            continue
          }
          return {
            kind: 'failed',
            runId: retained.snapshot.run.id,
            runVersion: retained.snapshot.run.version,
            reason: 'host_rejected_decision',
          }
        }

        const handled = await this.#applyDecision(
          context,
          snapshot,
          projection,
          decision,
          activeRuntime,
        )
        if ('result' in handled) return handled.result
        snapshot = handled.snapshot
      }

      return {
        kind: 'retry',
        runId: snapshot.run.id,
        runVersion: snapshot.run.version,
        reason: 'checkpoint_contention',
      }
    })()

    if (result.kind !== 'retry' && !(result.kind === 'paused' && result.reason === 'system')) {
      await this.dependencies.evidence.deliverTerminal(result.runId)
    }
    return result
  }

  async #applyDecision(
    context: MissionExecutionContext,
    snapshot: CaretakerRunSnapshot,
    projection: CaretakerHostProjection,
    decision: CaretakerDecision,
    activeRuntime: number,
  ): Promise<
    Readonly<{ snapshot: CaretakerRunSnapshot }> | Readonly<{ result: CaretakerHostResult }>
  > {
    if (decision.kind === 'invoke_tool') {
      return { snapshot: await this.#reserveTool(context, snapshot, decision, activeRuntime) }
    }

    if (decision.kind === 'request_clarification') {
      await this.dependencies.humanPauses.requestClarification({
        context,
        missionId: projection.mission.id,
        runId: snapshot.run.id,
        materialField: decision.materialField,
        question: decision.question,
        choices: decision.choices,
        evidenceIds: decision.evidenceIds,
        signal: this.#budgetSignal(
          context.signal,
          this.#withRuntime(snapshot.run.counters, activeRuntime),
        ),
      })
      const updated = await this.dependencies.projections.load({
        context,
        runId: snapshot.run.id,
        signal: context.signal,
      })
      if (
        updated.mission.state.status !== 'waiting_for_user' ||
        updated.mission.state.phase !== 'plan'
      ) {
        throw new Error('Clarification pause did not reach waiting_for_user/plan')
      }
      const paused = await this.#saveCheckpoint(context, snapshot, {
        kind: 'clarification_pause',
        counters: CaretakerRunCountersSchema.parse({
          ...snapshot.run.counters,
          clarificationPauseCount: snapshot.run.counters.clarificationPauseCount + 1,
          activeRuntimeMilliseconds: activeRuntime,
        }),
        pendingToolCall: null,
        evidenceRefs: this.#evidenceRefs(decision.evidenceIds),
      })
      if (paused.kind === 'conflict') return { snapshot: paused.snapshot }
      return {
        result: {
          kind: 'paused',
          runId: paused.snapshot.run.id,
          runVersion: paused.snapshot.run.version,
          reason: 'clarification',
        },
      }
    }

    if (decision.kind === 'pause') {
      const kind =
        decision.pauseReason === 'awaiting_approval'
          ? 'approval_pause'
          : decision.pauseReason === 'budget_exhausted'
            ? 'budget_exhausted'
            : decision.pauseReason === 'waiting_for_evidence'
              ? 'external_wait'
              : decision.pauseReason === 'waiting_for_reconciliation'
                ? 'external_wait'
                : 'human_review_pause'
      const paused = await this.#saveCheckpoint(context, snapshot, {
        kind,
        counters: this.#withRuntime(snapshot.run.counters, activeRuntime),
        pendingToolCall: null,
        evidenceRefs: this.#evidenceRefs(decision.evidenceIds),
      })
      if (paused.kind === 'conflict') return { snapshot: paused.snapshot }
      return {
        result: {
          kind: 'paused',
          runId: paused.snapshot.run.id,
          runVersion: paused.snapshot.run.version,
          reason:
            decision.pauseReason === 'awaiting_approval'
              ? 'approval'
              : decision.pauseReason === 'budget_exhausted'
                ? 'budget'
                : decision.pauseReason === 'waiting_for_evidence'
                  ? 'system'
                  : decision.pauseReason === 'waiting_for_reconciliation'
                    ? 'system'
                    : 'human_review',
        },
      }
    }

    if (decision.kind === 'escalate') {
      const retained = await this.#saveCheckpoint(context, snapshot, {
        kind: decision.disposition === 'safe_refusal' ? 'safe_refusal' : 'human_review_pause',
        counters: this.#withRuntime(snapshot.run.counters, activeRuntime),
        pendingToolCall: null,
        evidenceRefs: this.#evidenceRefs(decision.evidenceIds),
      })
      if (retained.kind === 'conflict') return { snapshot: retained.snapshot }
      return {
        result:
          decision.disposition === 'safe_refusal'
            ? {
                kind: 'failed',
                runId: retained.snapshot.run.id,
                runVersion: retained.snapshot.run.version,
                reason: 'safe_refusal',
              }
            : {
                kind: 'paused',
                runId: retained.snapshot.run.id,
                runVersion: retained.snapshot.run.version,
                reason: 'human_review',
              },
      }
    }

    if (decision.status === 'verifier_receipt_available') {
      if (
        projection.mission.state.status !== 'succeeded' ||
        projection.mission.state.phase !== 'verify'
      ) {
        const rejected = await this.#saveCheckpoint(context, snapshot, {
          kind: 'host_failed',
          counters: this.#withRuntime(snapshot.run.counters, activeRuntime),
          pendingToolCall: null,
          evidenceRefs: this.#evidenceRefs([
            ...decision.evidenceIds,
            ...decision.claims.flatMap((claim) => claim.evidenceIds),
          ]),
        })
        if (rejected.kind === 'conflict') return { snapshot: rejected.snapshot }
        return {
          result: {
            kind: 'failed',
            runId: rejected.snapshot.run.id,
            runVersion: rejected.snapshot.run.version,
            reason: 'host_rejected_decision',
          },
        }
      }
      const evidenceById = new Map(projection.evidence.map((entry) => [entry.id, entry]))
      const verifierEvidenceIds = this.#evidenceRefs(
        [...decision.evidenceIds, ...decision.claims.flatMap((claim) => claim.evidenceIds)].filter(
          (evidenceId) => evidenceById.get(evidenceId)?.kind === 'verifier_receipt',
        ),
      )
      if (verifierEvidenceIds.length === 0) {
        throw new Error('Mission completion requires a durable verifier receipt')
      }
      const completed = await this.#saveCheckpoint(context, snapshot, {
        kind: 'completed',
        counters: this.#withRuntime(snapshot.run.counters, activeRuntime),
        pendingToolCall: null,
        evidenceRefs: this.#evidenceRefs([
          ...decision.evidenceIds,
          ...decision.claims.flatMap((claim) => claim.evidenceIds),
        ]),
      })
      if (completed.kind === 'conflict') return { snapshot: completed.snapshot }
      return {
        result: {
          kind: 'completed',
          runId: completed.snapshot.run.id,
          runVersion: completed.snapshot.run.version,
          verifierEvidenceIds,
        },
      }
    }

    const retained = await this.#saveCheckpoint(context, snapshot, {
      kind: decision.status === 'safe_stop' ? 'safe_refusal' : 'state_persisted',
      counters: this.#withRuntime(snapshot.run.counters, activeRuntime),
      pendingToolCall: null,
      evidenceRefs: this.#evidenceRefs([
        ...decision.evidenceIds,
        ...decision.claims.flatMap((claim) => claim.evidenceIds),
      ]),
    })
    if (retained.kind === 'conflict') return { snapshot: retained.snapshot }
    if (decision.status === 'safe_stop') {
      return {
        result: {
          kind: 'failed',
          runId: retained.snapshot.run.id,
          runVersion: retained.snapshot.run.version,
          reason: 'safe_refusal',
        },
      }
    }
    return {
      result: {
        kind: 'retry',
        runId: retained.snapshot.run.id,
        runVersion: retained.snapshot.run.version,
        reason: 'checkpoint_contention',
      },
    }
  }

  async #reserveTool(
    context: MissionExecutionContext,
    snapshot: CaretakerRunSnapshot,
    decision: Extract<CaretakerDecision, { kind: 'invoke_tool' }>,
    activeRuntime: number,
  ): Promise<CaretakerRunSnapshot> {
    const inputHash = hashToolValue(decision.input)
    const callId = this.#toolCallId(snapshot, decision.toolName, inputHash)
    const pendingToolCall = CaretakerPendingToolCallSchema.parse({
      callId,
      toolName: decision.toolName,
      input: decision.input,
      inputHash,
    })
    const evidenceRefs = this.#evidenceRefs(decision.evidenceIds)

    if (decision.toolName === 'plans.propose') {
      const semantic = await this.#saveCheckpoint(context, snapshot, {
        kind: 'plan_revision',
        counters: CaretakerRunCountersSchema.parse({
          ...snapshot.run.counters,
          planRevisionCount: snapshot.run.counters.planRevisionCount + 1,
          activeRuntimeMilliseconds: activeRuntime,
        }),
        pendingToolCall,
        evidenceRefs,
      })
      return semantic.snapshot
    }

    if (decision.toolName === 'operations.get') {
      const semantic = await this.#saveCheckpoint(context, snapshot, {
        kind: 'reconciliation_poll',
        counters: CaretakerRunCountersSchema.parse({
          ...snapshot.run.counters,
          reconciliationPollCount: snapshot.run.counters.reconciliationPollCount + 1,
          activeRuntimeMilliseconds: activeRuntime,
        }),
        pendingToolCall,
        evidenceRefs,
      })
      return semantic.snapshot
    }

    const reserved = await this.#saveCheckpoint(context, snapshot, {
      kind: 'tool_call',
      counters: CaretakerRunCountersSchema.parse({
        ...snapshot.run.counters,
        toolCallCount: snapshot.run.counters.toolCallCount + 1,
        activeRuntimeMilliseconds: activeRuntime,
      }),
      pendingToolCall,
      evidenceRefs,
    })
    return reserved.snapshot
  }

  async #executePendingTool(
    context: MissionExecutionContext,
    inputSnapshot: CaretakerRunSnapshot,
    evidence: CaretakerRunEvidence,
    contextManifestHash: Sha256,
  ): Promise<PendingExecutionResult> {
    let snapshot = inputSnapshot
    const pending = CaretakerPendingToolCallSchema.parse(snapshot.run.pendingToolCall)
    const reservationKind = await this.#pendingReservationKind(context, snapshot, pending.callId)

    if (reservationKind === 'plan_revision' || reservationKind === 'reconciliation_poll') {
      const callReserved = await this.#saveCheckpoint(context, snapshot, {
        kind: 'tool_call',
        counters: CaretakerRunCountersSchema.parse({
          ...snapshot.run.counters,
          toolCallCount: snapshot.run.counters.toolCallCount + 1,
        }),
        pendingToolCall: pending,
        evidenceRefs: snapshot.checkpoint.evidenceRefs,
      })
      snapshot = callReserved.snapshot
      if (callReserved.kind === 'conflict') return { kind: 'conflict', snapshot }
    }

    const toolCallCheckpoint = await this.#pendingToolCallCheckpoint(
      context,
      snapshot,
      pending.callId,
    )

    const invocationStartedAt = this.#monotonicNow()
    let observed: Awaited<ReturnType<CaretakerHostToolPort['invoke']>>
    try {
      observed = await this.#withinBudget(context.signal, snapshot.run.counters, async (signal) =>
        this.dependencies.tools.invoke({ context, pendingToolCall: pending, signal }),
      )
    } catch (error) {
      const activationAborted = context.signal.aborted
      const activeRuntime =
        error instanceof CaretakerDependencyDeadlineError
          ? MAX_ACTIVE_RUNTIME_MILLISECONDS
          : this.#addRuntimeForWait(
              snapshot.run.counters.activeRuntimeMilliseconds,
              this.#elapsed(invocationStartedAt),
            )
      const waited = await this.#checkpointToolWait(
        activationAborted ? this.#cleanupContext(context) : context,
        snapshot,
        pending,
        activeRuntime,
      )
      if (activationAborted) context.signal.throwIfAborted()
      return waited
    }
    const toolRuntime = this.#elapsed(invocationStartedAt)
    const activeRuntime = this.#addRuntime(
      snapshot.run.counters.activeRuntimeMilliseconds,
      toolRuntime,
    )
    let result: ReturnType<typeof parseToolResult>
    try {
      result = parseToolResult(pending.toolName, observed.result)
      if (result.callId !== pending.callId) {
        throw new Error('Tool result call identity does not match the durable reservation')
      }
    } catch {
      return this.#checkpointToolWait(
        context,
        snapshot,
        pending,
        this.#addRuntimeForWait(snapshot.run.counters.activeRuntimeMilliseconds, toolRuntime),
      )
    }
    if (
      result.status === 'pending' &&
      result.error !== null &&
      TRANSIENT_TOOL_RESULT_CODES.has(result.error.code)
    ) {
      return this.#checkpointToolWait(
        context,
        snapshot,
        pending,
        this.#addRuntimeForWait(snapshot.run.counters.activeRuntimeMilliseconds, toolRuntime),
      )
    }
    let evidenceIds: EvidenceId[]
    let receipt: ToolCallReceipt
    try {
      evidenceIds = this.#evidenceRefs(observed.evidenceIds)
      if (result.status === 'unknown' && evidenceIds.length === 0) {
        throw new Error('An unknown tool outcome requires durable reconciliation evidence')
      }
      receipt = ToolCallReceiptSchema.parse(observed.receipt)
      if (
        receipt.callId !== pending.callId ||
        receipt.id !== result.receiptId ||
        receipt.toolName !== pending.toolName ||
        receipt.status !== result.status ||
        receipt.inputHash !== pending.inputHash ||
        receipt.resultHash !== hashToolValue(result) ||
        receipt.toolRegistryHash !== TOOL_REGISTRY_HASH ||
        hashToolValue(receipt.evidenceIds) !== hashToolValue(evidenceIds)
      ) {
        throw new Error('Tool receipt does not bind the durable host observation')
      }
    } catch {
      return this.#checkpointToolWait(
        context,
        snapshot,
        pending,
        this.#addRuntimeForWait(snapshot.run.counters.activeRuntimeMilliseconds, toolRuntime),
      )
    }

    try {
      const coded = new Set(['denied', 'conflict', 'unknown', 'failed']).has(result.status)
      const errorCode = coded
        ? (result.error?.code.toLowerCase() ?? 'tool_result_failed')
        : undefined
      await evidence.recordTool({
        identity: receipt.id,
        contextManifestHash,
        // Claim leases and receipts use wall time. The immutable tool-call checkpoint is the
        // replay-stable domain-time anchor for evidence emitted by an accelerated fixture run.
        occurredAt: toolCallCheckpoint.occurredAt,
        latencyMilliseconds: Date.parse(receipt.completedAt) - Date.parse(receipt.startedAt),
        status: result.status,
        ...(errorCode === undefined ? {} : { errorCode }),
        toolName: pending.toolName,
      })
    } catch {
      return this.#checkpointToolWait(
        context,
        snapshot,
        pending,
        this.#addRuntimeForWait(snapshot.run.counters.activeRuntimeMilliseconds, toolRuntime),
      )
    }

    const retained = await this.#saveCheckpoint(context, snapshot, {
      kind: 'state_persisted',
      counters: this.#withRuntime(snapshot.run.counters, activeRuntime),
      pendingToolCall: null,
      evidenceRefs: evidenceIds,
    })
    if (retained.kind === 'conflict') return { kind: 'conflict', snapshot: retained.snapshot }
    return {
      kind: 'advanced',
      snapshot: retained.snapshot,
      reconciliationRequired: requiresOperationReconciliation(pending.toolName, result.status),
    }
  }

  async #checkpointToolWait(
    context: MissionExecutionContext,
    snapshot: CaretakerRunSnapshot,
    pendingToolCall: CaretakerPendingToolCall,
    activeRuntimeMilliseconds: number,
  ): Promise<PendingExecutionResult> {
    if (activeRuntimeMilliseconds <= snapshot.run.counters.activeRuntimeMilliseconds) {
      return { kind: 'wait', snapshot }
    }
    let waited: CheckpointResult
    try {
      waited = await this.#saveCheckpoint(context, snapshot, {
        kind: 'tool_wait',
        counters: this.#withRuntime(snapshot.run.counters, activeRuntimeMilliseconds),
        pendingToolCall,
        evidenceRefs: [],
      })
    } catch (error) {
      if (error instanceof LeaseLostError || !(error instanceof ConflictError)) throw error
      if (!/active Caretaker checkpoint|tool wait cannot change/i.test(error.message)) throw error
      return { kind: 'wait', snapshot }
    }
    return waited.kind === 'conflict'
      ? { kind: 'conflict', snapshot: waited.snapshot }
      : { kind: 'wait', snapshot: waited.snapshot }
  }

  async #pendingReservationKind(
    context: MissionExecutionContext,
    snapshot: CaretakerRunSnapshot,
    callId: ReturnType<typeof ToolCallIdSchema.parse>,
  ): Promise<CaretakerRunCheckpoint['kind']> {
    if (snapshot.checkpoint.kind !== 'lease_replaced') return snapshot.checkpoint.kind
    const checkpoints = await this.dependencies.unitOfWork.runFenced(
      context.fence,
      async (repositories) => repositories.caretakerRuns.listCheckpoints(snapshot.run.id),
    )
    const reservation = [...checkpoints]
      .reverse()
      .find(
        (checkpoint) =>
          checkpoint.kind !== 'lease_replaced' && checkpoint.pendingToolCall?.callId === callId,
      )
    if (reservation === undefined) {
      throw new Error('Pending tool reservation is absent from durable checkpoint history')
    }
    return reservation.kind
  }

  async #pendingToolCallCheckpoint(
    context: MissionExecutionContext,
    snapshot: CaretakerRunSnapshot,
    callId: ReturnType<typeof ToolCallIdSchema.parse>,
  ): Promise<CaretakerRunCheckpoint> {
    if (
      snapshot.checkpoint.kind === 'tool_call' &&
      snapshot.checkpoint.pendingToolCall?.callId === callId
    ) {
      return snapshot.checkpoint
    }
    const checkpoints = await this.dependencies.unitOfWork.runFenced(
      context.fence,
      async (repositories) => repositories.caretakerRuns.listCheckpoints(snapshot.run.id),
    )
    const toolCall = [...checkpoints]
      .reverse()
      .find(
        (checkpoint) =>
          checkpoint.kind === 'tool_call' && checkpoint.pendingToolCall?.callId === callId,
      )
    if (toolCall === undefined) {
      throw new Error('Pending tool call lacks its durable tool-call checkpoint')
    }
    return toolCall
  }

  #decisionRequest(
    context: MissionExecutionContext,
    snapshot: CaretakerRunSnapshot,
    projection: CaretakerHostProjection,
    activeRuntimeMilliseconds: number,
  ): CaretakerDecisionRequest {
    const allowedTools = this.#allowedTools(context, projection, snapshot.run.counters)
    return CaretakerDecisionRequestSchema.parse({
      schemaVersion: 'caretaker-decision-request@1',
      requestId: `request_${snapshot.run.id}_${snapshot.run.version}`,
      contextReceiptId: projection.contextReceiptId,
      contextBundleHash: projection.contextBundleHash,
      frozenContext: projection.frozenContext,
      retrievedKnowledge: projection.retrievedKnowledge,
      runId: snapshot.run.id,
      mission: {
        id: projection.mission.id,
        palaceId: projection.mission.palaceId,
        programKind: projection.mission.programKind ?? 'night_shift_homecoming',
        objective: projection.mission.objective,
        constraints: projection.mission.constraints,
        state: projection.mission.state,
        version: projection.mission.version,
        taskLedger: snapshot.taskLedger,
      },
      turnIndex: snapshot.run.version,
      allowedTools,
      budget: {
        toolCalls: {
          used: snapshot.run.counters.toolCallCount,
          max: CARETAKER_BUDGETS.maxToolCallsPerRun,
        },
        planRevisions: {
          used: snapshot.run.counters.planRevisionCount,
          max: CARETAKER_BUDGETS.maxPlanRevisions,
        },
        clarifications: {
          used: snapshot.run.counters.clarificationPauseCount,
          max: CARETAKER_BUDGETS.maxClarificationPauses,
        },
        reconciliationPolls: {
          used: snapshot.run.counters.reconciliationPollCount,
          max: CARETAKER_BUDGETS.maxReconciliationPolls,
        },
        activeRuntimeMilliseconds: {
          used: activeRuntimeMilliseconds,
          max: MAX_ACTIVE_RUNTIME_MILLISECONDS,
        },
      },
      evidence: projection.evidence,
      liveState: projection.liveState,
      lastToolResult: projection.lastToolResult,
    })
  }

  #allowedTools(
    context: MissionExecutionContext,
    projection: CaretakerHostProjection,
    counters: CaretakerRunCounters,
  ): ToolName[] {
    if (
      projection.liveState.access === 'denied' ||
      projection.liveState.integrityAlerts.includes('cross_tenant_identifier') ||
      projection.liveState.integrityAlerts.includes('forged_approval')
    ) {
      return []
    }
    const phase = projection.mission.state.phase
    const reconcileOnly =
      (projection.lastToolResult !== null &&
        requiresOperationReconciliation(
          projection.lastToolResult.toolName,
          projection.lastToolResult.status,
        )) ||
      projection.lastToolResult?.status === 'unknown' ||
      projection.liveState.operation.reconciliationRequired
    return ToolNameSchema.options.filter((toolName) => {
      const contract = TOOL_REGISTRY[toolName]
      if (!contract.allowedPhases.includes(phase)) return false
      if (!principalHasPermission(context.principal, contract.permission)) {
        return false
      }
      if (reconcileOnly && toolName !== 'operations.get') return false
      if (
        toolName === 'plans.propose' &&
        counters.planRevisionCount >= CARETAKER_BUDGETS.maxPlanRevisions
      ) {
        return false
      }
      if (
        toolName === 'operations.get' &&
        counters.reconciliationPollCount >= CARETAKER_BUDGETS.maxReconciliationPolls
      ) {
        return false
      }
      return counters.toolCallCount < CARETAKER_BUDGETS.maxToolCallsPerRun
    })
  }

  async #checkpointTerminalMission(
    context: MissionExecutionContext,
    snapshot: CaretakerRunSnapshot,
    projection: CaretakerHostProjection,
    activeRuntime: number,
  ): Promise<ProjectedCheckpointResult> {
    if (projection.mission.state.status === 'succeeded') {
      const verifierEvidenceIds = projection.evidence
        .filter((evidence) => evidence.kind === 'verifier_receipt')
        .map((evidence) => evidence.id)
      if (
        projection.mission.state.phase !== 'verify' ||
        projection.liveState.verification.status !== 'verifier_passed' ||
        verifierEvidenceIds.length === 0
      ) {
        throw new Error('Succeeded mission lacks a durable verifier receipt')
      }
      const saved = await this.#saveCheckpoint(context, snapshot, {
        kind: 'completed',
        counters: this.#withRuntime(snapshot.run.counters, activeRuntime),
        pendingToolCall: null,
        evidenceRefs: this.#evidenceRefs(projection.evidence.map((entry) => entry.id)),
      })
      if (saved.kind === 'conflict') return { kind: 'conflict', snapshot: saved.snapshot }
      return {
        kind: 'result',
        result: {
          kind: 'completed',
          runId: saved.snapshot.run.id,
          runVersion: saved.snapshot.run.version,
          verifierEvidenceIds,
        },
      }
    }
    if (projection.mission.state.status === 'cancelled') {
      const saved = await this.#saveCheckpoint(context, snapshot, {
        kind: 'cancelled',
        counters: this.#withRuntime(snapshot.run.counters, activeRuntime),
        pendingToolCall: null,
        evidenceRefs: this.#evidenceRefs(projection.evidence.map((entry) => entry.id)),
      })
      if (saved.kind === 'conflict') return { kind: 'conflict', snapshot: saved.snapshot }
      return {
        kind: 'result',
        result: {
          kind: 'cancelled',
          runId: saved.snapshot.run.id,
          runVersion: saved.snapshot.run.version,
        },
      }
    }
    if (projection.mission.state.status === 'failed') {
      const saved = await this.#saveCheckpoint(context, snapshot, {
        kind: 'failed',
        counters: this.#withRuntime(snapshot.run.counters, activeRuntime),
        pendingToolCall: null,
        evidenceRefs: this.#evidenceRefs(projection.evidence.map((entry) => entry.id)),
      })
      if (saved.kind === 'conflict') return { kind: 'conflict', snapshot: saved.snapshot }
      return {
        kind: 'result',
        result: {
          kind: 'failed',
          runId: saved.snapshot.run.id,
          runVersion: saved.snapshot.run.version,
          reason: 'mission_failed',
        },
      }
    }
    return { kind: 'not_applicable' }
  }

  async #checkpointExternalPause(
    context: MissionExecutionContext,
    snapshot: CaretakerRunSnapshot,
    projection: CaretakerHostProjection,
    activeRuntime: number,
  ): Promise<ProjectedCheckpointResult> {
    const { state } = projection.mission
    const kind =
      state.status === 'waiting_for_user' && state.phase === 'plan'
        ? 'clarification_pause'
        : state.status === 'waiting_for_user' && state.phase === 'approve'
          ? 'approval_pause'
          : state.status === 'waiting_for_system' && state.phase === 'observe'
            ? 'external_wait'
            : null
    if (kind === null) return { kind: 'not_applicable' }
    const counters =
      kind === 'clarification_pause'
        ? CaretakerRunCountersSchema.parse({
            ...snapshot.run.counters,
            clarificationPauseCount: snapshot.run.counters.clarificationPauseCount + 1,
            activeRuntimeMilliseconds: activeRuntime,
          })
        : this.#withRuntime(snapshot.run.counters, activeRuntime)
    const saved = await this.#saveCheckpoint(context, snapshot, {
      kind,
      counters,
      pendingToolCall: null,
      evidenceRefs: this.#evidenceRefs(projection.evidence.map((entry) => entry.id)),
    })
    if (saved.kind === 'conflict') return { kind: 'conflict', snapshot: saved.snapshot }
    return {
      kind: 'result',
      result: {
        kind: 'paused',
        runId: saved.snapshot.run.id,
        runVersion: saved.snapshot.run.version,
        reason:
          kind === 'clarification_pause'
            ? 'clarification'
            : kind === 'approval_pause'
              ? 'approval'
              : 'system',
      },
    }
  }

  async #saveCheckpoint(
    context: MissionExecutionContext,
    snapshot: CaretakerRunSnapshot,
    input: Readonly<{
      kind: CaretakerRunMutationCheckpointKind
      counters: CaretakerRunCounters
      pendingToolCall: CaretakerPendingToolCall | null
      evidenceRefs: readonly EvidenceId[]
    }>,
  ): Promise<CheckpointResult> {
    context.signal.throwIfAborted()
    const occurredAt = this.#clock.now().toISOString()
    const terminalEvidence =
      caretakerRunStatusForCheckpoint(input.kind) === 'active'
        ? null
        : await this.dependencies.evidence.terminalEnvelope({
            runId: snapshot.run.id,
            profile: snapshot.run.evidenceProfile,
            activatedAt: snapshot.run.startedAt,
            ...this.#terminalTrace(
              input.kind,
              input.counters,
              occurredAt,
              snapshot.run.evidenceProfile.contextManifestHash,
            ),
          })
    const mutationKey = Sha256Schema.parse(
      hashToolValue({
        schemaVersion: 'caretaker-host-checkpoint-key@1',
        runId: snapshot.run.id,
        expectedVersion: snapshot.run.version,
        expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
        kind: input.kind,
        counters: input.counters,
        pendingToolCall: input.pendingToolCall,
        evidenceRefs: input.evidenceRefs,
        terminalEvidenceHash: terminalEvidence?.eventHash ?? null,
      }),
    )
    const saved = await this.dependencies.unitOfWork.runFenced(
      context.fence,
      async (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId: snapshot.run.id,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey,
          kind: input.kind,
          counters: input.counters,
          pendingToolCall: input.pendingToolCall,
          taskLedger: snapshot.taskLedger,
          evidenceRefs: input.evidenceRefs,
          terminalEvidence,
          occurredAt,
        }),
    )
    this.#assertSnapshot(saved.snapshot, context, snapshot.run.missionId)
    return saved.kind === 'version_conflict'
      ? { kind: 'conflict', snapshot: saved.snapshot }
      : { kind: 'saved', snapshot: saved.snapshot }
  }

  #terminalTrace(
    kind: CaretakerRunMutationCheckpointKind,
    counters: CaretakerRunCounters,
    completedAt: string,
    contextManifestHash: Sha256,
  ): CaretakerTraceEvidenceInput {
    const common = {
      contextManifestHash,
      completedAt,
      counters,
      budgetExhausted: kind === 'budget_exhausted',
    }
    switch (kind) {
      case 'completed':
        return { ...common, outcome: 'verified' }
      case 'cancelled':
        return { ...common, outcome: 'cancelled' }
      case 'safe_refusal':
        return { ...common, outcome: 'safe_refusal' }
      case 'failed':
        return { ...common, outcome: 'failed', errorCode: 'terminal_failure' }
      case 'host_failed':
        return { ...common, outcome: 'failed', errorCode: 'host_rejected_decision' }
      case 'clarification_pause':
        return { ...common, outcome: 'waiting_for_user', pauseReason: 'clarification' }
      case 'approval_pause':
        return { ...common, outcome: 'waiting_for_user', pauseReason: 'approval' }
      case 'human_review_pause':
        return { ...common, outcome: 'waiting_for_user', pauseReason: 'human_review' }
      case 'budget_exhausted':
        return { ...common, outcome: 'waiting_for_user', pauseReason: 'budget' }
      case 'external_wait':
        return { ...common, outcome: 'waiting_for_system', pauseReason: 'system' }
      default:
        throw new Error(`Active Caretaker checkpoint ${kind} cannot carry terminal evidence`)
    }
  }

  async #terminalResult(
    context: MissionExecutionContext,
    snapshot: CaretakerRunSnapshot,
  ): Promise<CaretakerHostResult | null> {
    switch (snapshot.run.status) {
      case 'completed': {
        const projection = await this.#withinBudget(
          context.signal,
          snapshot.run.counters,
          async (signal) =>
            this.dependencies.projections.load({ context, runId: snapshot.run.id, signal }),
        )
        this.#assertProjection(projection, snapshot)
        const checkpointEvidence = new Set(snapshot.checkpoint.evidenceRefs)
        const verifierEvidenceIds = projection.evidence
          .filter(
            (evidence) =>
              evidence.kind === 'verifier_receipt' && checkpointEvidence.has(evidence.id),
          )
          .map((evidence) => evidence.id)
        if (
          projection.mission.state.status !== 'succeeded' ||
          projection.liveState.verification.status !== 'verifier_passed' ||
          verifierEvidenceIds.length === 0
        ) {
          throw new Error('Completed Caretaker run lacks a durable verifier receipt')
        }
        return {
          kind: 'completed',
          runId: snapshot.run.id,
          runVersion: snapshot.run.version,
          verifierEvidenceIds,
        }
      }
      case 'paused':
        return {
          kind: 'paused',
          runId: snapshot.run.id,
          runVersion: snapshot.run.version,
          reason:
            snapshot.checkpoint.kind === 'approval_pause'
              ? 'approval'
              : snapshot.checkpoint.kind === 'clarification_pause'
                ? 'clarification'
                : snapshot.checkpoint.kind === 'human_review_pause'
                  ? 'human_review'
                  : snapshot.checkpoint.kind === 'budget_exhausted'
                    ? 'budget'
                    : 'system',
        }
      case 'failed':
        if (snapshot.checkpoint.kind === 'safe_refusal') {
          return {
            kind: 'failed',
            runId: snapshot.run.id,
            runVersion: snapshot.run.version,
            reason: 'safe_refusal',
          }
        }
        if (snapshot.checkpoint.kind === 'host_failed') {
          return {
            kind: 'failed',
            runId: snapshot.run.id,
            runVersion: snapshot.run.version,
            reason: 'host_rejected_decision',
          }
        }
        return {
          kind: 'failed',
          runId: snapshot.run.id,
          runVersion: snapshot.run.version,
          reason: 'mission_failed',
        }
      case 'abandoned':
        return {
          kind: 'failed',
          runId: snapshot.run.id,
          runVersion: snapshot.run.version,
          reason: 'mission_failed',
        }
      case 'cancelled':
        return { kind: 'cancelled', runId: snapshot.run.id, runVersion: snapshot.run.version }
      default:
        return null
    }
  }

  #toolCallId(snapshot: CaretakerRunSnapshot, toolName: ToolName, inputHash: Sha256) {
    const digest = hashToolValue({
      schemaVersion: 'caretaker-tool-call-identity@1',
      missionId: snapshot.run.missionId,
      runId: snapshot.run.id,
      runVersion: snapshot.run.version,
      toolName,
      inputHash,
    })
    return ToolCallIdSchema.parse(`call_${digest.slice(0, 32)}`)
  }

  async #withinBudget<Result>(
    parent: AbortSignal,
    counters: CaretakerRunCounters,
    work: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    parent.throwIfAborted()
    const remaining = Math.max(
      1,
      MAX_ACTIVE_RUNTIME_MILLISECONDS - counters.activeRuntimeMilliseconds,
    )
    const deadline = new AbortController()
    const deadlineError = new CaretakerDependencyDeadlineError(
      'Caretaker dependency exceeded the remaining active-runtime budget',
    )
    const timer = setTimeout(() => deadline.abort(deadlineError), remaining)
    const signal = AbortSignal.any([parent, deadline.signal])
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        if (!parent.aborted) {
          reject(deadlineError)
          return
        }
        reject(
          parent.reason instanceof Error
            ? parent.reason
            : new Error('Caretaker activation was aborted by its host'),
        )
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const operation = Promise.resolve()
      .then(() => work(signal))
      .catch((error: unknown) => {
        if (deadline.signal.aborted && !parent.aborted) throw deadlineError
        throw error
      })
    try {
      return await Promise.race([operation, aborted])
    } finally {
      clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  async #checkpointDependencyFailure(
    context: MissionExecutionContext,
    snapshot: CaretakerRunSnapshot,
    startedAt: number,
    error: unknown,
    evidenceRefs: readonly EvidenceId[],
    baseActiveRuntimeMilliseconds = snapshot.run.counters.activeRuntimeMilliseconds,
  ): Promise<
    Readonly<{ snapshot: CaretakerRunSnapshot }> | Readonly<{ result: CaretakerHostResult }>
  > {
    const activationAborted = context.signal.aborted
    const measuredRuntime = this.#addRuntimeForWait(
      baseActiveRuntimeMilliseconds,
      this.#elapsed(startedAt),
    )
    const deadlineExceeded =
      error instanceof CaretakerDependencyDeadlineError ||
      measuredRuntime >= MAX_ACTIVE_RUNTIME_MILLISECONDS
    const activeRuntimeMilliseconds = deadlineExceeded
      ? MAX_ACTIVE_RUNTIME_MILLISECONDS
      : measuredRuntime
    let retained: CheckpointResult
    try {
      retained = await this.#saveCheckpoint(
        activationAborted ? this.#cleanupContext(context) : context,
        snapshot,
        {
          kind: deadlineExceeded
            ? 'budget_exhausted'
            : activationAborted
              ? 'state_persisted'
              : 'host_failed',
          counters: this.#withRuntime(snapshot.run.counters, activeRuntimeMilliseconds),
          pendingToolCall: null,
          evidenceRefs: this.#evidenceRefs(evidenceRefs),
        },
      )
    } catch (checkpointError) {
      if (activationAborted) context.signal.throwIfAborted()
      throw checkpointError
    }
    if (activationAborted) context.signal.throwIfAborted()
    if (retained.kind === 'conflict') return { snapshot: retained.snapshot }
    return {
      result: deadlineExceeded
        ? {
            kind: 'paused',
            runId: retained.snapshot.run.id,
            runVersion: retained.snapshot.run.version,
            reason: 'budget',
          }
        : {
            kind: 'failed',
            runId: retained.snapshot.run.id,
            runVersion: retained.snapshot.run.version,
            reason: 'host_rejected_decision',
          },
    }
  }

  #budgetSignal(parent: AbortSignal, counters: CaretakerRunCounters): AbortSignal {
    parent.throwIfAborted()
    const remaining = Math.max(
      1,
      MAX_ACTIVE_RUNTIME_MILLISECONDS - counters.activeRuntimeMilliseconds,
    )
    return AbortSignal.any([parent, AbortSignal.timeout(remaining)])
  }

  #cleanupContext(context: MissionExecutionContext): MissionExecutionContext {
    return { ...context, signal: new AbortController().signal }
  }

  #addRuntime(current: number, elapsed: number): number {
    return Math.min(MAX_ACTIVE_RUNTIME_MILLISECONDS, current + elapsed)
  }

  #addRuntimeForWait(current: number, elapsed: number): number {
    if (current >= MAX_ACTIVE_RUNTIME_MILLISECONDS) return current
    return this.#addRuntime(current, Math.max(1, elapsed))
  }

  #withRuntime(counters: CaretakerRunCounters, activeRuntimeMilliseconds: number) {
    return CaretakerRunCountersSchema.parse({ ...counters, activeRuntimeMilliseconds })
  }

  #monotonicNow(): number {
    const value = this.#clock.monotonicMilliseconds()
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('Caretaker host clock returned an invalid monotonic time')
    }
    return value
  }

  #elapsed(startedAt: number): number {
    const endedAt = this.#monotonicNow()
    if (endedAt < startedAt) throw new Error('Caretaker host clock moved backwards')
    return Math.ceil(endedAt - startedAt)
  }

  #evidenceRefs(values: readonly (EvidenceId | string)[]): EvidenceId[] {
    const parsed = z.array(EvidenceIdSchema).parse([...new Set(values)])
    if (parsed.length > MAX_CHECKPOINT_EVIDENCE_REFS) {
      throw new Error('Caretaker checkpoint evidence exceeds the retained reference ceiling')
    }
    return parsed
  }

  #assertContext(
    context: MissionExecutionContext,
    missionId: ReturnType<typeof MissionIdSchema.parse>,
  ): void {
    if (
      context.fence.missionId !== missionId ||
      context.principal.organizationId !== context.fence.organizationId ||
      context.principal.role !== 'service'
    ) {
      throw new Error('Caretaker activation requires a fenced same-tenant service principal')
    }
  }

  #assertSnapshot(
    snapshot: CaretakerRunSnapshot,
    context: MissionExecutionContext,
    missionId: ReturnType<typeof MissionIdSchema.parse>,
  ): void {
    if (
      snapshot.run.organizationId !== context.principal.organizationId ||
      snapshot.run.missionId !== missionId ||
      snapshot.checkpoint.runId !== snapshot.run.id ||
      snapshot.checkpoint.pendingToolCall?.callId !== snapshot.run.pendingToolCall?.callId
    ) {
      throw new Error('Caretaker run snapshot is inconsistent with the fenced activation')
    }
  }

  #assertProjection(projection: CaretakerHostProjection, snapshot: CaretakerRunSnapshot): void {
    ContextReceiptIdSchema.parse(projection.contextReceiptId)
    Sha256Schema.parse(projection.contextBundleHash)
    CaretakerDecisionRequestSchema.shape.frozenContext.parse(projection.frozenContext)
    CaretakerDecisionRequestSchema.shape.retrievedKnowledge.parse(projection.retrievedKnowledge)
    if (projection.mission.id !== snapshot.run.missionId) {
      throw new Error('Caretaker projection does not belong to the active mission')
    }
    if (projection.mission.taskLedger.length !== snapshot.taskLedger.length) {
      throw new Error('Caretaker projection task ledger is stale')
    }
    if (hashToolValue(projection.mission.taskLedger) !== hashToolValue(snapshot.taskLedger)) {
      throw new Error('Caretaker projection task ledger does not match the durable ledger')
    }
  }
}

function requiresOperationReconciliation(toolName: ToolName, status: string): boolean {
  return (
    TOOL_REGISTRY[toolName].risk === 'consequential' &&
    (status === 'pending' || status === 'unknown')
  )
}

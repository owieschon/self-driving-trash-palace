import {
  MissionStateSchema,
  type EvidenceId,
  type MissionPhase,
  type MissionState,
  type Sha256,
} from '@trash-palace/core'

import { ConflictError } from './errors.js'
import {
  CaretakerRunCheckpointSchema,
  CaretakerRunCheckpointKindSchema,
  CaretakerRunCountersSchema,
  CaretakerRunMutationCheckpointKindSchema,
  CaretakerPendingToolCallSchema,
  CaretakerTaskLedgerSchema,
  type CaretakerRunCheckpoint,
  type CaretakerRunCheckpointKind,
  type CaretakerRunCounters,
  type CaretakerRunMutationCheckpointKind,
  type CaretakerPendingToolCall,
  type CaretakerRunStatus,
  type CaretakerTaskLedger,
  type CaretakerTerminalEvidenceEnvelope,
} from './models.js'
import { hashCanonical } from './primitives.js'

export const EMPTY_CARETAKER_RUN_COUNTERS: CaretakerRunCounters = Object.freeze({
  toolCallCount: 0,
  planRevisionCount: 0,
  clarificationPauseCount: 0,
  reconciliationPollCount: 0,
  activeRuntimeMilliseconds: 0,
})

const TERMINAL_STATUS_BY_KIND: Readonly<
  Partial<Record<CaretakerRunCheckpointKind, CaretakerRunStatus>>
> = {
  clarification_pause: 'paused',
  approval_pause: 'paused',
  human_review_pause: 'paused',
  budget_exhausted: 'paused',
  completed: 'completed',
  failed: 'failed',
  safe_refusal: 'failed',
  host_failed: 'failed',
  cancelled: 'cancelled',
}

export function caretakerRunStatusForCheckpoint(
  inputKind: CaretakerRunCheckpointKind,
): CaretakerRunStatus {
  const kind = CaretakerRunCheckpointKindSchema.parse(inputKind)
  return TERMINAL_STATUS_BY_KIND[kind] ?? 'active'
}

export function parseCaretakerTaskLedger(input: unknown): CaretakerTaskLedger {
  return CaretakerTaskLedgerSchema.parse(input)
}

export function assertCaretakerMissionStateForCheckpoint(input: {
  readonly state: MissionState
  readonly kind: CaretakerRunMutationCheckpointKind
  readonly clearsPendingToolCall: boolean
}): void {
  const state = MissionStateSchema.parse(input.state)
  const kind = CaretakerRunMutationCheckpointKindSchema.parse(input.kind)
  if (kind === 'completed') {
    if (state.status !== 'succeeded' || state.phase !== 'verify') {
      throw new ConflictError('Completed run checkpoint requires a succeeded mission')
    }
    return
  }
  if (kind === 'failed') {
    if (state.status !== 'failed') {
      throw new ConflictError('Failed run checkpoint requires a failed mission')
    }
    return
  }
  if (kind === 'cancelled') {
    if (state.status !== 'cancelled') {
      throw new ConflictError('Cancelled run checkpoint requires a cancelled mission')
    }
    return
  }
  if (kind === 'clarification_pause') {
    if (state.status !== 'waiting_for_user' || state.phase !== 'plan') {
      throw new ConflictError('Clarification pause requires waiting_for_user/plan')
    }
    return
  }
  if (kind === 'approval_pause') {
    if (state.status !== 'waiting_for_user' || state.phase !== 'approve') {
      throw new ConflictError('Approval pause requires waiting_for_user/approve')
    }
    return
  }
  if (kind === 'external_wait') {
    const observing = state.status === 'waiting_for_system' && state.phase === 'observe'
    const reconciling = state.status === 'running' && state.phase === 'reconcile'
    if (!observing && !reconciling) {
      throw new ConflictError(
        'External wait requires waiting_for_system/observe or running/reconcile',
      )
    }
    return
  }
  const terminalMission = ['succeeded', 'failed', 'cancelled'].includes(state.status)
  if (kind === 'decision_attempt') {
    if (terminalMission) {
      throw new ConflictError('Decision attempt requires a nonterminal mission')
    }
    return
  }
  if (kind === 'state_persisted' && input.clearsPendingToolCall && !terminalMission) {
    return
  }
  if (['human_review_pause', 'safe_refusal', 'host_failed'].includes(kind)) {
    if (terminalMission) {
      throw new ConflictError(`${kind} requires a nonterminal mission`)
    }
    return
  }
  if (kind === 'budget_exhausted') {
    if (terminalMission) {
      throw new ConflictError('A terminal mission cannot pause for a Caretaker budget')
    }
    return
  }
  if (state.status !== 'running') {
    throw new ConflictError('Active Caretaker checkpoint requires a running mission')
  }
}

export function hashCaretakerTaskLedger(inputLedger: CaretakerTaskLedger): Sha256 {
  return hashCanonical(CaretakerTaskLedgerSchema.parse(inputLedger))
}

export function assertCaretakerTaskLedgerTransition(
  inputCurrent: CaretakerTaskLedger,
  inputNext: CaretakerTaskLedger,
): void {
  const current = CaretakerTaskLedgerSchema.parse(inputCurrent)
  const next = CaretakerTaskLedgerSchema.parse(inputNext)
  if (next.length < current.length) {
    throw new ConflictError('Caretaker tasks cannot be removed from the durable ledger')
  }
  for (const [index, existing] of current.entries()) {
    const candidate = next[index]
    if (candidate === undefined || candidate.id !== existing.id) {
      throw new ConflictError('Caretaker tasks are append-only and retain their order')
    }
    if (candidate.label !== existing.label) {
      throw new ConflictError('Caretaker task labels are immutable')
    }
    const candidateEvidence = new Set(candidate.evidenceRefs)
    if (existing.evidenceRefs.some((evidenceId) => !candidateEvidence.has(evidenceId))) {
      throw new ConflictError('Caretaker task evidence references are append-only')
    }
    if (existing.status === 'completed' && candidate.status !== 'completed') {
      throw new ConflictError('Completed Caretaker tasks are terminal')
    }
    if (existing.status === 'in_progress' && candidate.status === 'pending') {
      throw new ConflictError('In-progress Caretaker tasks cannot return to pending')
    }
  }
}

export function assertCaretakerCounterTransition(input: {
  readonly previous: CaretakerRunCounters
  readonly next: CaretakerRunCounters
  readonly kind: CaretakerRunMutationCheckpointKind
}): void {
  const previous = CaretakerRunCountersSchema.parse(input.previous)
  const next = CaretakerRunCountersSchema.parse(input.next)
  const kind = CaretakerRunMutationCheckpointKindSchema.parse(input.kind)
  const expectedIncrements = {
    toolCallCount: kind === 'tool_call' ? 1 : 0,
    planRevisionCount: kind === 'plan_revision' ? 1 : 0,
    clarificationPauseCount: kind === 'clarification_pause' ? 1 : 0,
    reconciliationPollCount: kind === 'reconciliation_poll' ? 1 : 0,
  } as const
  for (const [field, increment] of Object.entries(expectedIncrements) as readonly [
    keyof typeof expectedIncrements,
    number,
  ][]) {
    if (next[field] !== previous[field] + increment) {
      throw new ConflictError(`${field} must match its append-only Caretaker checkpoint`)
    }
  }
  if (next.activeRuntimeMilliseconds < previous.activeRuntimeMilliseconds) {
    throw new ConflictError('Caretaker active runtime cannot decrease')
  }
  if (
    kind === 'tool_wait' &&
    next.activeRuntimeMilliseconds === previous.activeRuntimeMilliseconds
  ) {
    throw new ConflictError('A tool-wait checkpoint must advance Caretaker active runtime')
  }
}

export function assertCaretakerPendingToolCallTransition(input: {
  readonly previous: CaretakerPendingToolCall | null
  readonly next: CaretakerPendingToolCall | null
  readonly previousCheckpointKind: CaretakerRunCheckpointKind | null
  readonly kind: CaretakerRunCheckpointKind
}): void {
  const previous =
    input.previous === null ? null : CaretakerPendingToolCallSchema.parse(input.previous)
  const next = input.next === null ? null : CaretakerPendingToolCallSchema.parse(input.next)
  const previousCheckpointKind =
    input.previousCheckpointKind === null
      ? null
      : CaretakerRunCheckpointKindSchema.parse(input.previousCheckpointKind)
  const status = caretakerRunStatusForCheckpoint(input.kind)
  if (previous === null && next !== null) {
    const validReservation =
      input.kind === 'tool_call' ||
      (input.kind === 'plan_revision' && next.toolName === 'plans.propose') ||
      (input.kind === 'reconciliation_poll' && next.toolName === 'operations.get')
    if (!validReservation) {
      throw new ConflictError('This checkpoint cannot reserve the pending tool call')
    }
  } else if (previous === null) {
    if (['tool_call', 'plan_revision', 'reconciliation_poll'].includes(input.kind)) {
      throw new ConflictError('This checkpoint must reserve its durable tool-call identity')
    }
  } else if (input.kind === 'lease_replaced') {
    if (next === null || hashCanonical(previous) !== hashCanonical(next)) {
      throw new ConflictError('Lease takeover must preserve the pending tool call')
    }
  } else if (['plan_revision', 'reconciliation_poll'].includes(previousCheckpointKind ?? '')) {
    if (
      input.kind !== 'tool_call' ||
      next === null ||
      hashCanonical(previous) !== hashCanonical(next)
    ) {
      throw new ConflictError('A semantic reservation must be followed by its tool call')
    }
  } else if (['tool_call', 'tool_wait'].includes(previousCheckpointKind ?? '')) {
    if (input.kind === 'tool_wait') {
      if (next === null || hashCanonical(previous) !== hashCanonical(next)) {
        throw new ConflictError('Tool wait must preserve the dispatched tool-call identity')
      }
    } else if (input.kind !== 'state_persisted' || next !== null) {
      throw new ConflictError(
        'A dispatched tool call may only wait or be cleared by its result checkpoint',
      )
    }
  } else {
    throw new ConflictError('Pending tool call lacks its durable reservation checkpoint')
  }
  if (status !== 'active' && next !== null) {
    throw new ConflictError('A paused or terminal Caretaker run cannot retain a pending tool call')
  }
}

export function assertCaretakerToolWaitPayloadTransition(input: {
  readonly previousCheckpointKind: CaretakerRunCheckpointKind | null
  readonly previousPhase: MissionPhase
  readonly nextPhase: MissionPhase
  readonly previousTaskLedger: CaretakerTaskLedger
  readonly nextTaskLedger: CaretakerTaskLedger
  readonly evidenceRefs: readonly EvidenceId[]
}): void {
  const previousCheckpointKind =
    input.previousCheckpointKind === null
      ? null
      : CaretakerRunCheckpointKindSchema.parse(input.previousCheckpointKind)
  if (!['tool_call', 'tool_wait'].includes(previousCheckpointKind ?? '')) {
    throw new ConflictError('Tool wait requires an existing dispatched tool call')
  }
  if (input.previousPhase !== input.nextPhase) {
    throw new ConflictError('Tool wait cannot change the Caretaker mission phase')
  }
  if (
    hashCaretakerTaskLedger(input.previousTaskLedger) !==
    hashCaretakerTaskLedger(input.nextTaskLedger)
  ) {
    throw new ConflictError('Tool wait cannot change the Caretaker task ledger')
  }
  if (input.evidenceRefs.length !== 0) {
    throw new ConflictError('Tool wait cannot append evidence')
  }
}

export function hashCaretakerCheckpointMutation(input: {
  readonly organizationId: string
  readonly missionId: string
  readonly runId: string
  readonly mutationKey: Sha256
  readonly kind: CaretakerRunMutationCheckpointKind
  readonly counters: CaretakerRunCounters
  readonly pendingToolCall: CaretakerPendingToolCall | null
  readonly taskLedger: CaretakerTaskLedger
  readonly evidenceRefs: readonly EvidenceId[]
  readonly terminalEvidence: CaretakerTerminalEvidenceEnvelope | null
  readonly occurredAt: string
}): Sha256 {
  return hashCanonical({
    schemaVersion: 'caretaker-checkpoint-mutation@2',
    ...input,
    taskLedger: CaretakerTaskLedgerSchema.parse(input.taskLedger),
    counters: CaretakerRunCountersSchema.parse(input.counters),
    pendingToolCall:
      input.pendingToolCall === null
        ? null
        : CaretakerPendingToolCallSchema.parse(input.pendingToolCall),
    kind: CaretakerRunMutationCheckpointKindSchema.parse(input.kind),
  })
}

export function parseCaretakerRunCheckpoint(input: unknown): CaretakerRunCheckpoint {
  return CaretakerRunCheckpointSchema.parse(input)
}

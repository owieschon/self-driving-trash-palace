import { EvidenceIdSchema, ToolCallIdSchema, hashToolValue } from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import {
  CaretakerRunCheckpointSchema,
  CaretakerRunCountersSchema,
  CaretakerPendingToolCallSchema,
  CaretakerTaskLedgerSchema,
} from '../models.js'
import {
  EMPTY_CARETAKER_RUN_COUNTERS,
  assertCaretakerCounterTransition,
  assertCaretakerMissionStateForCheckpoint,
  assertCaretakerPendingToolCallTransition,
  assertCaretakerTaskLedgerTransition,
  assertCaretakerToolWaitPayloadTransition,
  caretakerRunStatusForCheckpoint,
  hashCaretakerTaskLedger,
} from '../caretaker-run-ledger.js'

const task = {
  id: 'inspect_state',
  label: 'Inspect the current palace state',
  status: 'pending' as const,
  evidenceRefs: [],
}

describe('Caretaker durable run contracts', () => {
  it('pins the host-owned budgets to 24/3/2/3/300000', () => {
    expect(
      CaretakerRunCountersSchema.parse({
        toolCallCount: 24,
        planRevisionCount: 3,
        clarificationPauseCount: 2,
        reconciliationPollCount: 3,
        activeRuntimeMilliseconds: 300_000,
      }),
    ).toEqual({
      toolCallCount: 24,
      planRevisionCount: 3,
      clarificationPauseCount: 2,
      reconciliationPollCount: 3,
      activeRuntimeMilliseconds: 300_000,
    })
    expect(() =>
      CaretakerRunCountersSchema.parse({
        toolCallCount: 25,
        planRevisionCount: 3,
        clarificationPauseCount: 2,
        reconciliationPollCount: 3,
        activeRuntimeMilliseconds: 300_000,
      }),
    ).toThrow()
  })

  it('requires each counter increment to carry its matching append-only checkpoint', () => {
    expect(() =>
      assertCaretakerCounterTransition({
        previous: EMPTY_CARETAKER_RUN_COUNTERS,
        next: { ...EMPTY_CARETAKER_RUN_COUNTERS, toolCallCount: 1 },
        kind: 'tool_call',
      }),
    ).not.toThrow()
    expect(() =>
      assertCaretakerCounterTransition({
        previous: EMPTY_CARETAKER_RUN_COUNTERS,
        next: { ...EMPTY_CARETAKER_RUN_COUNTERS, toolCallCount: 1 },
        kind: 'state_persisted',
      }),
    ).toThrow(/toolCallCount/)
    for (const kind of ['human_review_pause', 'safe_refusal', 'host_failed'] as const) {
      expect(() =>
        assertCaretakerCounterTransition({
          previous: EMPTY_CARETAKER_RUN_COUNTERS,
          next: { ...EMPTY_CARETAKER_RUN_COUNTERS, reconciliationPollCount: 1 },
          kind,
        }),
      ).toThrow(/reconciliationPollCount/)
    }
  })

  it('keeps tasks ordered, evidence append-only, and completed work terminal', () => {
    const pending = CaretakerTaskLedgerSchema.parse([task])
    const completed = CaretakerTaskLedgerSchema.parse([
      { ...task, status: 'completed', evidenceRefs: ['evd_caretakerevidence'] },
    ])
    expect(() => assertCaretakerTaskLedgerTransition(pending, completed)).not.toThrow()
    expect(() => assertCaretakerTaskLedgerTransition(completed, pending)).toThrow(/evidence/)
    expect(() => assertCaretakerTaskLedgerTransition(completed, [])).toThrow(/cannot be removed/)
    expect(() => CaretakerTaskLedgerSchema.parse([task, task])).toThrow(/unique/)
    expect(() =>
      CaretakerTaskLedgerSchema.parse(
        Array.from({ length: 33 }, (_, index) => ({
          ...task,
          id: `task_${String(index).padStart(3, '0')}`,
        })),
      ),
    ).toThrow()
  })

  it('retains only the typed checkpoint surface and rejects raw prompt or model output fields', () => {
    const ledger = CaretakerTaskLedgerSchema.parse([task])
    const checkpoint = {
      organizationId: 'org_caretakerruns',
      missionId: 'mis_caretakerrestart',
      runId: 'run_caretakerrestart1',
      sequence: 0,
      mutationKey: '1'.repeat(64),
      mutationHash: '2'.repeat(64),
      kind: 'activated',
      runStatus: 'active',
      phase: 'understand',
      runVersion: 0,
      taskLedgerVersion: 0,
      taskLedgerHash: hashCaretakerTaskLedger(ledger),
      taskLedger: ledger,
      counters: EMPTY_CARETAKER_RUN_COUNTERS,
      pendingToolCall: null,
      evidenceRefs: [],
      occurredAt: '2026-07-15T00:00:00.000Z',
    }
    expect(CaretakerRunCheckpointSchema.parse(checkpoint)).toEqual(checkpoint)
    expect(() =>
      CaretakerRunCheckpointSchema.parse({
        ...checkpoint,
        rawPrompt: 'unretained prompt',
      }),
    ).toThrow()
    expect(() =>
      CaretakerRunCheckpointSchema.parse({
        ...checkpoint,
        modelOutput: 'unretained response',
      }),
    ).toThrow()
  })

  it('derives terminal run status from the checkpoint kind', () => {
    expect(caretakerRunStatusForCheckpoint('state_persisted')).toBe('active')
    expect(caretakerRunStatusForCheckpoint('decision_attempt')).toBe('active')
    expect(caretakerRunStatusForCheckpoint('clarification_pause')).toBe('paused')
    expect(caretakerRunStatusForCheckpoint('human_review_pause')).toBe('paused')
    expect(caretakerRunStatusForCheckpoint('completed')).toBe('completed')
    expect(caretakerRunStatusForCheckpoint('failed')).toBe('failed')
    expect(caretakerRunStatusForCheckpoint('safe_refusal')).toBe('failed')
    expect(caretakerRunStatusForCheckpoint('host_failed')).toBe('failed')
    expect(caretakerRunStatusForCheckpoint('cancelled')).toBe('cancelled')
  })

  it('reserves a decision attempt without counters or a pending tool call', () => {
    const counters = {
      toolCallCount: 2,
      planRevisionCount: 1,
      clarificationPauseCount: 0,
      reconciliationPollCount: 1,
      activeRuntimeMilliseconds: 500,
    }
    expect(() =>
      assertCaretakerCounterTransition({
        previous: counters,
        next: counters,
        kind: 'decision_attempt',
      }),
    ).not.toThrow()
    expect(() =>
      assertCaretakerMissionStateForCheckpoint({
        state: { status: 'waiting_for_system', phase: 'observe' },
        kind: 'decision_attempt',
        clearsPendingToolCall: false,
      }),
    ).not.toThrow()
    expect(() =>
      assertCaretakerMissionStateForCheckpoint({
        state: { status: 'failed', phase: 'verify' },
        kind: 'decision_attempt',
        clearsPendingToolCall: false,
      }),
    ).toThrow(/nonterminal/)
    expect(() =>
      assertCaretakerPendingToolCallTransition({
        previous: null,
        next: null,
        previousCheckpointKind: 'state_persisted',
        kind: 'decision_attempt',
      }),
    ).not.toThrow()
    expect(() =>
      assertCaretakerPendingToolCallTransition({
        previous: null,
        next: CaretakerPendingToolCallSchema.parse({
          callId: 'call_decisionattempt',
          toolName: 'palaces.get',
          input: { palaceId: 'pal_caretakerhome' },
          inputHash: hashToolValue({ palaceId: 'pal_caretakerhome' }),
        }),
        previousCheckpointKind: 'state_persisted',
        kind: 'decision_attempt',
      }),
    ).toThrow(/cannot reserve/)
  })

  it('allows an external wait while the durable operation reconciler owns resolution', () => {
    expect(() =>
      assertCaretakerMissionStateForCheckpoint({
        state: { status: 'running', phase: 'reconcile' },
        kind: 'external_wait',
        clearsPendingToolCall: false,
      }),
    ).not.toThrow()
    expect(() =>
      assertCaretakerMissionStateForCheckpoint({
        state: { status: 'running', phase: 'execute' },
        kind: 'external_wait',
        clearsPendingToolCall: false,
      }),
    ).toThrow(/running\/reconcile/)
  })

  it('binds a pending call to typed replay input and rejects sensitive persistence', () => {
    const input = { palaceId: 'pal_caretakerhome' }
    const pending = CaretakerPendingToolCallSchema.parse({
      callId: 'call_caretakerpending',
      toolName: 'palaces.get',
      input,
      inputHash: hashToolValue(input),
    })
    expect(() =>
      assertCaretakerPendingToolCallTransition({
        previous: null,
        next: pending,
        previousCheckpointKind: 'activated',
        kind: 'tool_call',
      }),
    ).not.toThrow()
    expect(() =>
      assertCaretakerPendingToolCallTransition({
        previous: pending,
        next: pending,
        previousCheckpointKind: 'tool_call',
        kind: 'state_persisted',
      }),
    ).toThrow(/cleared/)
    for (const kind of ['human_review_pause', 'safe_refusal', 'host_failed'] as const) {
      expect(() =>
        assertCaretakerPendingToolCallTransition({
          previous: pending,
          next: pending,
          previousCheckpointKind: 'tool_call',
          kind,
        }),
      ).toThrow(/may only wait or be cleared/)
    }
    expect(() =>
      CaretakerPendingToolCallSchema.parse({
        callId: 'call_caretakersecret',
        toolName: 'knowledge.search',
        input: {
          query: 'inspect Bearer secret-value-123456',
          phase: 'understand',
          limit: 6,
        },
        inputHash: hashToolValue({
          query: 'inspect Bearer secret-value-123456',
          phase: 'understand',
          limit: 6,
        }),
      }),
    ).toThrow(/credential-shaped/)
    expect(() =>
      CaretakerPendingToolCallSchema.parse({ ...pending, inputHash: 'f'.repeat(64) }),
    ).toThrow(/bind/)
  })

  it('lets tool_wait advance runtime without changing dispatched call semantics or payload', () => {
    const input = { palaceId: 'pal_caretakerhome' }
    const pending = CaretakerPendingToolCallSchema.parse({
      callId: 'call_caretakerpending',
      toolName: 'palaces.get',
      input,
      inputHash: hashToolValue(input),
    })
    const dispatchedCounters = {
      ...EMPTY_CARETAKER_RUN_COUNTERS,
      toolCallCount: 1,
      activeRuntimeMilliseconds: 100,
    }
    const waitingCounters = { ...dispatchedCounters, activeRuntimeMilliseconds: 250 }
    const ledger = CaretakerTaskLedgerSchema.parse([{ ...task, status: 'in_progress' }])

    expect(() =>
      assertCaretakerCounterTransition({
        previous: dispatchedCounters,
        next: waitingCounters,
        kind: 'tool_wait',
      }),
    ).not.toThrow()
    expect(() =>
      assertCaretakerPendingToolCallTransition({
        previous: pending,
        next: pending,
        previousCheckpointKind: 'tool_call',
        kind: 'tool_wait',
      }),
    ).not.toThrow()
    expect(() =>
      assertCaretakerPendingToolCallTransition({
        previous: pending,
        next: pending,
        previousCheckpointKind: 'tool_wait',
        kind: 'tool_wait',
      }),
    ).not.toThrow()
    expect(() =>
      assertCaretakerToolWaitPayloadTransition({
        previousCheckpointKind: 'tool_call',
        previousPhase: 'understand',
        nextPhase: 'understand',
        previousTaskLedger: ledger,
        nextTaskLedger: ledger,
        evidenceRefs: [],
      }),
    ).not.toThrow()

    for (const next of [
      { ...waitingCounters, toolCallCount: 2 },
      { ...waitingCounters, planRevisionCount: 1 },
      { ...waitingCounters, clarificationPauseCount: 1 },
      { ...waitingCounters, reconciliationPollCount: 1 },
    ]) {
      expect(() =>
        assertCaretakerCounterTransition({
          previous: dispatchedCounters,
          next,
          kind: 'tool_wait',
        }),
      ).toThrow(/append-only/)
    }
    expect(() =>
      assertCaretakerCounterTransition({
        previous: dispatchedCounters,
        next: dispatchedCounters,
        kind: 'tool_wait',
      }),
    ).toThrow(/advance/)
    expect(() =>
      assertCaretakerPendingToolCallTransition({
        previous: pending,
        next: { ...pending, callId: ToolCallIdSchema.parse('call_caretakerdifferent') },
        previousCheckpointKind: 'tool_call',
        kind: 'tool_wait',
      }),
    ).toThrow(/identity/)
    expect(() =>
      assertCaretakerToolWaitPayloadTransition({
        previousCheckpointKind: 'tool_call',
        previousPhase: 'understand',
        nextPhase: 'understand',
        previousTaskLedger: ledger,
        nextTaskLedger: [{ ...ledger[0]!, status: 'completed' }],
        evidenceRefs: [],
      }),
    ).toThrow(/task ledger/)
    expect(() =>
      assertCaretakerToolWaitPayloadTransition({
        previousCheckpointKind: 'tool_call',
        previousPhase: 'understand',
        nextPhase: 'plan',
        previousTaskLedger: ledger,
        nextTaskLedger: ledger,
        evidenceRefs: [],
      }),
    ).toThrow(/phase/)
    expect(() =>
      assertCaretakerToolWaitPayloadTransition({
        previousCheckpointKind: 'tool_call',
        previousPhase: 'understand',
        nextPhase: 'understand',
        previousTaskLedger: ledger,
        nextTaskLedger: ledger,
        evidenceRefs: [EvidenceIdSchema.parse('evd_caretakerevidence')],
      }),
    ).toThrow(/evidence/)
    expect(() =>
      assertCaretakerToolWaitPayloadTransition({
        previousCheckpointKind: 'state_persisted',
        previousPhase: 'understand',
        nextPhase: 'understand',
        previousTaskLedger: ledger,
        nextTaskLedger: ledger,
        evidenceRefs: [],
      }),
    ).toThrow(/dispatched/)
  })
})

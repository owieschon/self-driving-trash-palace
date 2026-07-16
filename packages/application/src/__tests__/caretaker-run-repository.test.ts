import {
  EvidenceIdSchema,
  MissionSchema,
  RunIdSchema,
  ToolCallIdSchema,
  hashToolValue,
  type MissionState,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { OpaqueMissionFenceToken, type MissionFence } from '../mission-fence.js'
import {
  CaretakerPendingToolCallSchema,
  type CaretakerRunMutationCheckpointKind,
} from '../models.js'
import { hashCanonical } from '../primitives.js'
import {
  InMemoryApplicationStore,
  MutableClock,
  testCaretakerEvidenceProfile,
  testCaretakerTerminalEvidence,
} from '../testing/index.js'
import { IDS, makeMission } from './fixtures.js'

const clockTime = '2026-08-14T05:35:00.000Z'
const taskLedger = [
  {
    id: 'inspect_state',
    label: 'Inspect the current palace state',
    status: 'pending' as const,
    evidenceRefs: [],
  },
]
const evidenceId = EvidenceIdSchema.parse('evd_caretakerdisposition')

describe('in-memory Caretaker disposition parity', () => {
  it('persists and exactly replays a counter-neutral decision attempt', async () => {
    const { store, fence, runId } = await startedStore()
    const input = {
      runId,
      expectedVersion: 0,
      expectedTaskLedgerVersion: 0,
      mutationKey: mutationKey('decision-attempt-1'),
      kind: 'decision_attempt' as const,
      counters: {
        toolCallCount: 0,
        planRevisionCount: 0,
        clarificationPauseCount: 0,
        reconciliationPollCount: 0,
        activeRuntimeMilliseconds: 0,
      },
      pendingToolCall: null,
      taskLedger,
      evidenceRefs: [],
      occurredAt: clockTime,
    }
    const first = await store.runFenced(fence, (repositories) =>
      repositories.caretakerRuns.checkpoint(input),
    )
    expect(first).toMatchObject({
      kind: 'applied',
      snapshot: {
        run: { version: 1, status: 'active', counters: input.counters },
        checkpoint: { kind: 'decision_attempt', pendingToolCall: null },
      },
    })
    await expect(
      store.runFenced(fence, (repositories) => repositories.caretakerRuns.checkpoint(input)),
    ).resolves.toMatchObject({ kind: 'replayed', snapshot: { run: { version: 1 } } })
    expect((await store.snapshot()).caretakerRunCheckpoints).toHaveLength(2)
  })

  it.each([
    {
      kind: 'human_review_pause' as const,
      missionState: { status: 'waiting_for_user', phase: 'verify' } as const,
      runStatus: 'paused' as const,
    },
    {
      kind: 'safe_refusal' as const,
      missionState: { status: 'running', phase: 'understand' } as const,
      runStatus: 'failed' as const,
    },
    {
      kind: 'host_failed' as const,
      missionState: { status: 'waiting_for_system', phase: 'observe' } as const,
      runStatus: 'failed' as const,
    },
  ])('persists $kind for a nonterminal mission', async ({ kind, missionState, runStatus }) => {
    const { store, fence, runId } = await startedStore()
    await setMissionState(store, missionState)

    const result = await store.runFenced(fence, (repositories) =>
      repositories.caretakerRuns.checkpoint({
        runId,
        expectedVersion: 0,
        expectedTaskLedgerVersion: 0,
        mutationKey: mutationKey(`checkpoint-${kind}`),
        kind,
        counters: {
          toolCallCount: 0,
          planRevisionCount: 0,
          clarificationPauseCount: 0,
          reconciliationPollCount: 0,
          activeRuntimeMilliseconds: 10,
        },
        pendingToolCall: null,
        taskLedger: [{ ...taskLedger[0]!, status: 'in_progress' }],
        evidenceRefs: [evidenceId],
        terminalEvidence: terminalEvidence(runId),
        occurredAt: clockTime,
      }),
    )

    expect(result).toMatchObject({
      kind: 'applied',
      snapshot: {
        run: {
          status: runStatus,
          version: 1,
          taskLedgerVersion: 1,
          pendingToolCall: null,
          counters: {
            toolCallCount: 0,
            planRevisionCount: 0,
            clarificationPauseCount: 0,
            reconciliationPollCount: 0,
            activeRuntimeMilliseconds: 10,
          },
        },
        checkpoint: { kind, evidenceRefs: [evidenceId] },
      },
    })
  })

  it.each(['human_review_pause', 'safe_refusal', 'host_failed'] as const)(
    'rejects %s for a terminal mission',
    async (kind) => {
      const { store, fence, runId } = await startedStore()
      await setMissionState(store, { status: 'succeeded', phase: 'verify' })

      await expect(
        store.runFenced(fence, (repositories) =>
          repositories.caretakerRuns.checkpoint({
            runId,
            expectedVersion: 0,
            expectedTaskLedgerVersion: 0,
            mutationKey: mutationKey(`terminal-${kind}`),
            kind,
            counters: {
              toolCallCount: 0,
              planRevisionCount: 0,
              clarificationPauseCount: 0,
              reconciliationPollCount: 0,
              activeRuntimeMilliseconds: 10,
            },
            pendingToolCall: null,
            taskLedger,
            evidenceRefs: [],
            terminalEvidence: terminalEvidence(runId),
            occurredAt: clockTime,
          }),
        ),
      ).rejects.toThrow(/nonterminal mission/)
    },
  )

  it('keeps generic failed bound to a failed mission', async () => {
    const { store, fence, runId } = await startedStore()
    await expect(
      checkpointDisposition(store, fence, runId, 'failed', 'generic-failed-running'),
    ).rejects.toThrow(/requires a failed mission/)
    await setMissionState(store, { status: 'failed', phase: 'execute' })
    await expect(
      checkpointDisposition(store, fence, runId, 'failed', 'generic-failed-terminal'),
    ).resolves.toMatchObject({
      kind: 'applied',
      snapshot: { run: { status: 'failed' }, checkpoint: { kind: 'failed' } },
    })
  })

  it('replays the canonical terminal result under a higher lease without mutating history', async () => {
    const { store, fence, runId } = await startedStore()
    const terminal = await checkpointDisposition(
      store,
      fence,
      runId,
      'safe_refusal',
      'terminal-refusal',
    )
    await store.run(IDS.organization, (repositories) => repositories.missionLeases.release(fence))
    const nextFence = await acquire(store, 'worker_terminal_replay', 'terminal-replay')
    const candidateRunId = RunIdSchema.parse('run_caretakercandidate')

    const replayed = await store.runFenced(nextFence, (repositories) =>
      repositories.caretakerRuns.start({
        runId: candidateRunId,
        missionId: IDS.mission,
        mutationKey: mutationKey('terminal-replay-start'),
        evidenceProfile: testCaretakerEvidenceProfile(runId),
        occurredAt: clockTime,
      }),
    )

    expect(replayed).toEqual({ kind: 'replayed', snapshot: terminal.snapshot })
    await expect(
      store.run(IDS.organization, (repositories) => repositories.caretakerRuns.get(candidateRunId)),
    ).resolves.toBeNull()
    expect((await store.snapshot()).caretakerRunCheckpoints).toHaveLength(2)
  })

  it('rebinds an active run to a terminal mission only for final evidence delivery', async () => {
    const { store, fence, runId } = await startedStore()
    await setMissionState(store, { status: 'succeeded', phase: 'verify' })
    await store.run(IDS.organization, (repositories) => repositories.missionLeases.release(fence))
    const finalizationFence = await acquire(store, 'worker_terminal_delivery', 'terminal-delivery')

    const resumed = await store.runFenced(finalizationFence, (repositories) =>
      repositories.caretakerRuns.start({
        runId,
        missionId: IDS.mission,
        mutationKey: mutationKey('terminal-delivery-start'),
        evidenceProfile: testCaretakerEvidenceProfile(runId),
        occurredAt: clockTime,
      }),
    )

    expect(resumed).toMatchObject({
      kind: 'resumed',
      snapshot: {
        run: { id: runId, status: 'active', phase: 'verify' },
        checkpoint: { kind: 'lease_replaced', phase: 'verify' },
      },
    })
  })

  it('reopens the canonical paused run to record terminal completion', async () => {
    const { store, fence, runId } = await startedStore()
    await checkpointDisposition(store, fence, runId, 'human_review_pause', 'system-wait')
    await setMissionState(store, { status: 'succeeded', phase: 'verify' })
    await store.run(IDS.organization, (repositories) => repositories.missionLeases.release(fence))
    const finalizationFence = await acquire(
      store,
      'worker_paused_terminal_delivery',
      'paused-terminal-delivery',
    )

    const resumed = await store.runFenced(finalizationFence, (repositories) =>
      repositories.caretakerRuns.start({
        runId,
        missionId: IDS.mission,
        mutationKey: mutationKey('paused-terminal-delivery-start'),
        evidenceProfile: testCaretakerEvidenceProfile(runId),
        occurredAt: clockTime,
      }),
    )

    expect(resumed).toMatchObject({
      kind: 'resumed',
      snapshot: {
        run: { id: runId, status: 'active', phase: 'verify', endedAt: null },
        checkpoint: { kind: 'lease_replaced', phase: 'verify' },
      },
    })
  })

  it('persists a returned tool result after the tool moved the mission to approval', async () => {
    const { store, fence, runId } = await startedStore()
    const input = { planId: IDS.plan }
    const pendingCall = CaretakerPendingToolCallSchema.parse({
      callId: ToolCallIdSchema.parse('call_caretakerapproval'),
      toolName: 'plans.request_approval',
      input,
      inputHash: hashToolValue(input),
    })
    const dispatched = await store.runFenced(fence, (repositories) =>
      repositories.caretakerRuns.checkpoint({
        runId,
        expectedVersion: 0,
        expectedTaskLedgerVersion: 0,
        mutationKey: mutationKey('approval-dispatch'),
        kind: 'tool_call',
        counters: {
          toolCallCount: 1,
          planRevisionCount: 0,
          clarificationPauseCount: 0,
          reconciliationPollCount: 0,
          activeRuntimeMilliseconds: 10,
        },
        pendingToolCall: pendingCall,
        taskLedger,
        evidenceRefs: [],
        occurredAt: clockTime,
      }),
    )
    await setMissionState(store, { status: 'waiting_for_user', phase: 'approve' })

    const persisted = await store.runFenced(fence, (repositories) =>
      repositories.caretakerRuns.checkpoint({
        runId,
        expectedVersion: dispatched.snapshot.run.version,
        expectedTaskLedgerVersion: 0,
        mutationKey: mutationKey('approval-result'),
        kind: 'state_persisted',
        counters: {
          ...dispatched.snapshot.run.counters,
          activeRuntimeMilliseconds: 20,
        },
        pendingToolCall: null,
        taskLedger,
        evidenceRefs: [],
        occurredAt: clockTime,
      }),
    )
    expect(persisted).toMatchObject({
      kind: 'applied',
      snapshot: {
        run: { status: 'active', phase: 'approve', pendingToolCall: null },
        checkpoint: { kind: 'state_persisted', phase: 'approve' },
      },
    })
    await expect(
      store.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: persisted.snapshot.run.version,
          expectedTaskLedgerVersion: 0,
          mutationKey: mutationKey('approval-pause'),
          kind: 'approval_pause',
          counters: persisted.snapshot.run.counters,
          pendingToolCall: null,
          taskLedger,
          evidenceRefs: [],
          terminalEvidence: terminalEvidence(runId),
          occurredAt: clockTime,
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'applied',
      snapshot: { run: { status: 'paused' }, checkpoint: { kind: 'approval_pause' } },
    })
  })
})

async function startedStore(): Promise<{
  store: InMemoryApplicationStore
  fence: MissionFence
  runId: ReturnType<typeof RunIdSchema.parse>
}> {
  const mission = MissionSchema.parse({
    ...makeMission({ status: 'running', phase: 'understand' }, 1),
    taskLedger,
  })
  const store = new InMemoryApplicationStore(
    { missions: [mission] },
    new MutableClock(new Date(clockTime)),
  )
  const fence = await acquire(store, 'worker_disposition', 'disposition')
  const runId = RunIdSchema.parse('run_caretakerdisposition')
  await store.runFenced(fence, (repositories) =>
    repositories.caretakerRuns.start({
      runId,
      missionId: mission.id,
      mutationKey: mutationKey('start'),
      evidenceProfile: testCaretakerEvidenceProfile(runId),
      occurredAt: clockTime,
    }),
  )
  return { store, fence, runId }
}

async function acquire(
  store: InMemoryApplicationStore,
  ownerId: string,
  tokenLabel: string,
): Promise<MissionFence> {
  const fence = await store.run(IDS.organization, (repositories) =>
    repositories.missionLeases.acquire({
      organizationId: IDS.organization,
      missionId: IDS.mission,
      ownerId,
      token: OpaqueMissionFenceToken.fromEntropy(`caretaker-${tokenLabel}-1234567890`),
      ttlMilliseconds: 300_000,
    }),
  )
  if (fence === null) throw new Error('Test mission lease was unavailable')
  return fence
}

async function setMissionState(
  store: InMemoryApplicationStore,
  state: MissionState,
): Promise<void> {
  await store.run(IDS.organization, async (repositories) => {
    const mission = await repositories.missions.get(IDS.mission)
    if (mission === null) throw new Error('Test mission was absent')
    const saved = await repositories.missions.save(
      MissionSchema.parse({
        ...mission,
        state,
        version: mission.version + 1,
        updatedAt: clockTime,
      }),
      mission.version,
    )
    if (!saved) throw new Error('Test mission state update conflicted')
  })
}

function checkpointDisposition(
  store: InMemoryApplicationStore,
  fence: MissionFence,
  runId: ReturnType<typeof RunIdSchema.parse>,
  kind: CaretakerRunMutationCheckpointKind,
  label: string,
) {
  return store.runFenced(fence, (repositories) =>
    repositories.caretakerRuns.checkpoint({
      runId,
      expectedVersion: 0,
      expectedTaskLedgerVersion: 0,
      mutationKey: mutationKey(label),
      kind,
      counters: {
        toolCallCount: 0,
        planRevisionCount: 0,
        clarificationPauseCount: 0,
        reconciliationPollCount: 0,
        activeRuntimeMilliseconds: 10,
      },
      pendingToolCall: null,
      taskLedger,
      evidenceRefs: [],
      terminalEvidence: terminalEvidence(runId),
      occurredAt: clockTime,
    }),
  )
}

function terminalEvidence(runId: ReturnType<typeof RunIdSchema.parse>) {
  return testCaretakerTerminalEvidence(testCaretakerEvidenceProfile(runId), clockTime)
}

function mutationKey(label: string) {
  return hashCanonical({ schemaVersion: 'caretaker-disposition-test@1', label })
}

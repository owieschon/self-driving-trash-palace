import { readFile, readdir } from 'node:fs/promises'

import {
  CaretakerPendingToolCallSchema,
  OpaqueMissionFenceToken,
  caretakerRunStatusForCheckpoint,
  hashCanonical,
  type CaretakerPendingToolCall,
  type CaretakerRunMutationCheckpointKind,
  type CaretakerRunCounters,
  type MissionExecutionUnitOfWorkPort,
  type MissionFence,
} from '@trash-palace/application'
import {
  testCaretakerEvidenceProfile,
  testCaretakerTerminalEvidence,
} from '@trash-palace/application/testing'
import {
  EvidenceIdSchema,
  MembershipIdSchema,
  MissionIdSchema,
  MissionSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PlanIdSchema,
  RunIdSchema,
  ToolCallIdSchema,
  UserIdSchema,
  hashToolValue,
  type MissionId,
  type MissionState,
  type OrganizationId,
} from '@trash-palace/core'
import { and, eq, sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabase, type Database } from './client.js'
import { createCaretakerEvidenceDeliveryRepository } from './caretaker-evidence-delivery-repository.js'
import { OptimisticConcurrencyError } from './errors.js'
import {
  PgBootstrapRepository,
  createMissionExecutionUnitOfWork,
  createUnitOfWork,
} from './repositories.js'
import {
  caretakerRunCheckpoints,
  caretakerRuns,
  caretakerTerminalEvidenceDeliveries,
  missions,
} from './schema.js'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip

const organizationId = OrganizationIdSchema.parse('org_caretakerruns')
const mirrorOrganizationId = OrganizationIdSchema.parse('org_caretakermirror')
const userId = UserIdSchema.parse('usr_caretakerowner')
const mirrorUserId = UserIdSchema.parse('usr_caretakermirror')
const palaceId = PalaceIdSchema.parse('pal_caretakerhome')
const mirrorPalaceId = PalaceIdSchema.parse('pal_caretakermirror')
const missionIds = {
  restart: MissionIdSchema.parse('mis_caretakerrestart'),
  competing: MissionIdSchema.parse('mis_caretakercompete'),
  budgets: MissionIdSchema.parse('mis_caretakerbudgets'),
  pauseBudgets: MissionIdSchema.parse('mis_caretakerpausebudgets'),
  rawGuard: MissionIdSchema.parse('mis_caretakerrawguard'),
  humanReview: MissionIdSchema.parse('mis_caretakerhumanreview'),
  approvalResult: MissionIdSchema.parse('mis_caretakerapprovalresult'),
  safeRefusal: MissionIdSchema.parse('mis_caretakersaferefusal'),
  hostFailed: MissionIdSchema.parse('mis_caretakerhostfailed'),
  genericFailed: MissionIdSchema.parse('mis_caretakergenericfailed'),
  rawDisposition: MissionIdSchema.parse('mis_caretakerrawdisposition'),
  mirror: MissionIdSchema.parse('mis_caretakermirror'),
} as const

const ZERO_COUNTERS: CaretakerRunCounters = {
  toolCallCount: 0,
  planRevisionCount: 0,
  clarificationPauseCount: 0,
  reconciliationPollCount: 0,
  activeRuntimeMilliseconds: 0,
}

function mutationKey(label: string) {
  return hashCanonical({ schemaVersion: 'caretaker-test-mutation@1', label })
}

function terminalEvidenceFor(runId: string, occurredAt: string) {
  return testCaretakerTerminalEvidence(testCaretakerEvidenceProfile(runId), occurredAt)
}

function fenceToken(label: string): OpaqueMissionFenceToken {
  return OpaqueMissionFenceToken.fromEntropy(`caretaker-fence-${label}-1234567890`)
}

function palaceCall(label: string) {
  const input = { palaceId }
  return CaretakerPendingToolCallSchema.parse({
    callId: ToolCallIdSchema.parse(`call_${label}`),
    toolName: 'palaces.get' as const,
    input,
    inputHash: hashToolValue(input),
  })
}

function planCall(label: string, missionId: MissionId, revision: number) {
  const input = {
    missionId,
    revision,
    actions: [
      {
        id: `act_${label}`,
        type: 'restore_routine_version',
        palaceId,
        routineId: 'rtn_caretakerprotected',
        restoreVersionId: 'rtv_caretakerrestore1',
        expectedCurrentVersion: 1,
      },
    ],
    successCriteriaIds: ['bounded_activation'],
  }
  return CaretakerPendingToolCallSchema.parse({
    callId: ToolCallIdSchema.parse(`call_${label}`),
    toolName: 'plans.propose',
    input,
    inputHash: hashToolValue(input),
  })
}

function reconciliationCall(label: string) {
  const input = { operationId: 'op_caretakerbudgetcheck' }
  return CaretakerPendingToolCallSchema.parse({
    callId: ToolCallIdSchema.parse(`call_${label}`),
    toolName: 'operations.get',
    input,
    inputHash: hashToolValue(input),
  })
}

function approvalCall(label: string) {
  const input = { planId: PlanIdSchema.parse('pln_caretakerapproval') }
  return CaretakerPendingToolCallSchema.parse({
    callId: ToolCallIdSchema.parse(`call_${label}`),
    toolName: 'plans.request_approval',
    input,
    inputHash: hashToolValue(input),
  })
}

databaseDescribe('PostgreSQL Caretaker run ledger', () => {
  let pool: pg.Pool
  let database: Database
  let unitOfWork: ReturnType<typeof createUnitOfWork>
  let fencedUnitOfWork: MissionExecutionUnitOfWorkPort
  let schemaName: string
  let baseTime: number

  beforeAll(async () => {
    schemaName = `trash_palace_caretaker_${process.pid}_${Date.now()}`
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 10,
      options: `-c search_path=${schemaName},public`,
    })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await applyMigrations(pool, schemaName)
    database = createDatabase(pool)
    unitOfWork = createUnitOfWork(database)
    fencedUnitOfWork = createMissionExecutionUnitOfWork(database)
    baseTime = Date.now() - 60_000

    const bootstrap = new PgBootstrapRepository(database)
    await bootstrap.insertOrganization({
      id: organizationId,
      slug: 'caretaker-runs',
      name: 'Caretaker Runs',
      labTenant: true,
      createdAt: at(0),
    })
    await bootstrap.insertOrganization({
      id: mirrorOrganizationId,
      slug: 'caretaker-mirror',
      name: 'Caretaker Mirror',
      labTenant: true,
      createdAt: at(0),
    })
    await bootstrap.insertUser({ id: userId, displayName: 'Rocky', createdAt: at(0) })
    await bootstrap.insertUser({ id: mirrorUserId, displayName: 'Mirror', createdAt: at(0) })
    await unitOfWork.run(organizationId, async (repositories) => {
      await repositories.records.insertMembership({
        id: MembershipIdSchema.parse('mem_caretakerowner'),
        organizationId,
        userId,
        role: 'owner',
        grants: [],
        createdAt: at(0),
        revokedAt: null,
      })
      await repositories.records.insertPalace({
        id: palaceId,
        organizationId,
        name: 'Caretaker Palace',
        timezone: 'America/New_York',
        batteryAvailablePercentage: 80,
        createdAt: at(0),
      })
      for (const missionId of [
        missionIds.restart,
        missionIds.competing,
        missionIds.budgets,
        missionIds.pauseBudgets,
        missionIds.rawGuard,
        missionIds.humanReview,
        missionIds.approvalResult,
        missionIds.safeRefusal,
        missionIds.hostFailed,
        missionIds.genericFailed,
        missionIds.rawDisposition,
      ]) {
        await repositories.missions.insert(mission(organizationId, missionId, palaceId, userId))
      }
    })
    await unitOfWork.run(mirrorOrganizationId, async (repositories) => {
      await repositories.records.insertMembership({
        id: MembershipIdSchema.parse('mem_caretakermirror'),
        organizationId: mirrorOrganizationId,
        userId: mirrorUserId,
        role: 'owner',
        grants: [],
        createdAt: at(0),
        revokedAt: null,
      })
      await repositories.records.insertPalace({
        id: mirrorPalaceId,
        organizationId: mirrorOrganizationId,
        name: 'Mirror Palace',
        timezone: 'America/New_York',
        batteryAvailablePercentage: 80,
        createdAt: at(0),
      })
      await repositories.missions.insert(
        mission(mirrorOrganizationId, missionIds.mirror, mirrorPalaceId, mirrorUserId),
      )
    })
  }, 30_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  function at(offsetMilliseconds: number): string {
    return new Date(baseTime + offsetMilliseconds).toISOString()
  }

  async function acquire(
    missionId: MissionId,
    ownerId: string,
    tokenLabel: string,
  ): Promise<MissionFence> {
    const fence = await unitOfWork.run(organizationId, (repositories) =>
      repositories.missionLeases.acquire({
        organizationId,
        missionId,
        ownerId,
        token: fenceToken(tokenLabel),
        ttlMilliseconds: 300_000,
      }),
    )
    if (fence === null) throw new Error('Test mission lease was unavailable')
    return fence
  }

  it('resumes the same pending call and activation across repository and lease restart', async () => {
    const firstFence = await acquire(missionIds.restart, 'worker_restart_a', 'restart-a')
    const firstRunId = RunIdSchema.parse('run_caretakerrestart1')
    const started = await fencedUnitOfWork.runFenced(firstFence, (repositories) =>
      repositories.caretakerRuns.start({
        runId: firstRunId,
        missionId: missionIds.restart,
        mutationKey: mutationKey('restart-start'),
        evidenceProfile: testCaretakerEvidenceProfile(firstRunId),
        occurredAt: at(1_000),
      }),
    )
    expect(started).toMatchObject({ kind: 'started', snapshot: { run: { version: 0 } } })

    const pendingCall = palaceCall('caretaker_restart_pending')
    const firstMutation = {
      runId: firstRunId,
      expectedVersion: 0,
      expectedTaskLedgerVersion: 0,
      mutationKey: mutationKey('restart-task'),
      kind: 'tool_call' as const,
      counters: { ...ZERO_COUNTERS, toolCallCount: 1, activeRuntimeMilliseconds: 1_000 },
      pendingToolCall: pendingCall,
      taskLedger: [
        {
          id: 'inspect_state',
          label: 'Inspect the current palace state',
          status: 'in_progress' as const,
          evidenceRefs: [],
        },
      ],
      evidenceRefs: [],
      occurredAt: at(2_000),
    }
    await expect(
      fencedUnitOfWork.runFenced(firstFence, (repositories) =>
        repositories.caretakerRuns.checkpoint(firstMutation),
      ),
    ).resolves.toMatchObject({ kind: 'applied', snapshot: { run: { version: 1 } } })

    const restartedDatabase = createDatabase(pool)
    const restartedFencedUnit = createMissionExecutionUnitOfWork(restartedDatabase)
    await expect(
      restartedFencedUnit.runFenced(firstFence, (repositories) =>
        repositories.caretakerRuns.get(firstRunId),
      ),
    ).resolves.toMatchObject({
      run: { version: 1, taskLedgerVersion: 1, pendingToolCall: pendingCall },
      taskLedger: [{ id: 'inspect_state', status: 'in_progress' }],
    })
    await expect(
      restartedFencedUnit.runFenced(firstFence, (repositories) =>
        repositories.caretakerRuns.checkpoint(firstMutation),
      ),
    ).resolves.toMatchObject({ kind: 'replayed' })
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          ...firstMutation,
          mutationKey: mutationKey('restart-unfenced'),
          expectedVersion: 1,
          expectedTaskLedgerVersion: 1,
        }),
      ),
    ).rejects.toThrow(/active lease fence/)

    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.missionLeases.release(firstFence),
      ),
    ).resolves.toBe(true)
    const secondFence = await acquire(missionIds.restart, 'worker_restart_b', 'restart-b')
    const resumed = await restartedFencedUnit.runFenced(secondFence, (repositories) =>
      repositories.caretakerRuns.start({
        runId: firstRunId,
        missionId: missionIds.restart,
        mutationKey: mutationKey('restart-resume'),
        evidenceProfile: testCaretakerEvidenceProfile(firstRunId),
        occurredAt: at(3_000),
      }),
    )
    expect(resumed).toMatchObject({
      kind: 'resumed',
      snapshot: {
        run: {
          id: firstRunId,
          leaseEpoch: 2,
          version: 2,
          counters: { toolCallCount: 1 },
          pendingToolCall: pendingCall,
        },
        taskLedger: [{ id: 'inspect_state', status: 'in_progress' }],
      },
    })
    await expect(
      restartedFencedUnit.runFenced(secondFence, (repositories) =>
        repositories.caretakerRuns.start({
          runId: firstRunId,
          missionId: missionIds.restart,
          mutationKey: mutationKey('restart-resume'),
          evidenceProfile: testCaretakerEvidenceProfile(firstRunId),
          occurredAt: at(3_000),
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'replayed',
      snapshot: { run: { id: firstRunId, version: 2 } },
    })
    await expect(
      restartedFencedUnit.runFenced(firstFence, async () => 'stale worker ran'),
    ).rejects.toThrow(/active lease fence/)

    await expect(
      restartedFencedUnit.runFenced(secondFence, (repositories) =>
        repositories.caretakerRuns.checkpoint(firstMutation),
      ),
    ).resolves.toMatchObject({
      kind: 'replayed',
      snapshot: { run: { id: firstRunId, version: 2, counters: { toolCallCount: 1 } } },
    })
    const activeRun = await unitOfWork.run(organizationId, (repositories) =>
      repositories.caretakerRuns.get(firstRunId),
    )
    expect(activeRun).toMatchObject({
      run: { status: 'active', leaseEpoch: 2, version: 2, pendingToolCall: pendingCall },
      checkpoint: { kind: 'lease_replaced', runStatus: 'active', sequence: 2 },
    })
    const resumedCheckpoints = await unitOfWork.run(organizationId, (repositories) =>
      repositories.caretakerRuns.listCheckpoints(firstRunId),
    )
    expect(resumedCheckpoints).toHaveLength(3)
    expect(resumedCheckpoints[1]).toMatchObject({
      mutationKey: firstMutation.mutationKey,
      pendingToolCall: pendingCall,
    })

    const waited = await restartedFencedUnit.runFenced(secondFence, (repositories) =>
      repositories.caretakerRuns.checkpoint({
        runId: firstRunId,
        expectedVersion: 2,
        expectedTaskLedgerVersion: 1,
        mutationKey: mutationKey('restart-tool-wait'),
        kind: 'tool_wait',
        counters: { ...firstMutation.counters, activeRuntimeMilliseconds: 1_250 },
        pendingToolCall: pendingCall,
        taskLedger: resumed.snapshot.taskLedger,
        evidenceRefs: [],
        occurredAt: at(3_500),
      }),
    )
    expect(waited).toMatchObject({
      kind: 'applied',
      snapshot: {
        run: {
          version: 3,
          taskLedgerVersion: 1,
          counters: {
            toolCallCount: 1,
            planRevisionCount: 0,
            clarificationPauseCount: 0,
            reconciliationPollCount: 0,
            activeRuntimeMilliseconds: 1_250,
          },
          pendingToolCall: pendingCall,
        },
        checkpoint: { kind: 'tool_wait', evidenceRefs: [] },
      },
    })

    const [storedWait] = await database
      .select()
      .from(caretakerRunCheckpoints)
      .where(
        and(
          eq(caretakerRunCheckpoints.organizationId, organizationId),
          eq(caretakerRunCheckpoints.runId, firstRunId),
          eq(caretakerRunCheckpoints.sequence, 3),
        ),
      )
      .limit(1)
    if (storedWait === undefined) throw new Error('Stored tool-wait checkpoint was absent')
    const changedPendingCall = palaceCall('caretaker_restart_changed')
    const forgedWaits = [
      {
        label: 'same-runtime',
        values: { activeRuntimeMilliseconds: storedWait.activeRuntimeMilliseconds },
        expected: /tool wait may only advance active runtime/,
      },
      {
        label: 'tool-counter',
        values: { toolCallCount: storedWait.toolCallCount + 1 },
        expected: /checkpoint counters do not match/,
      },
      {
        label: 'semantic-counter',
        values: { reconciliationPollCount: storedWait.reconciliationPollCount + 1 },
        expected: /checkpoint counters do not match/,
      },
      {
        label: 'call-identity',
        values: { pendingToolCall: changedPendingCall },
        expected: /tool wait must preserve the dispatched tool identity/,
      },
      {
        label: 'task-ledger',
        values: {
          taskLedger: [
            {
              id: 'inspect_state',
              label: 'Inspect the current palace state',
              status: 'completed' as const,
              evidenceRefs: [],
            },
          ],
        },
        expected: /tool wait may only advance active runtime/,
      },
      {
        label: 'evidence',
        values: { evidenceRefs: ['evd_caretakerevidence'] },
        expected: /tool wait may only advance active runtime/,
      },
      {
        label: 'phase',
        values: { phase: 'plan' as const },
        expected: /does not match current mission phase/,
      },
    ]
    for (const forged of forgedWaits) {
      await expectDatabaseRejection(
        database.insert(caretakerRunCheckpoints).values({
          ...storedWait,
          ...forged.values,
          sequence: 4,
          runVersion: 4,
          mutationKey: mutationKey(`raw-wait-${forged.label}`),
          mutationHash: mutationKey(`raw-wait-${forged.label}-hash`),
          activeRuntimeMilliseconds:
            forged.values.activeRuntimeMilliseconds ?? storedWait.activeRuntimeMilliseconds + 250,
          occurredAt: new Date(at(3_750)),
        }),
        forged.expected,
      )
    }
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.caretakerRuns.listCheckpoints(firstRunId),
      ),
    ).resolves.toHaveLength(4)

    const completedLedger = [
      {
        id: 'inspect_state',
        label: 'Inspect the current palace state',
        status: 'completed' as const,
        evidenceRefs: [],
      },
    ]
    await expect(
      restartedFencedUnit.runFenced(secondFence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId: firstRunId,
          expectedVersion: 3,
          expectedTaskLedgerVersion: 1,
          mutationKey: mutationKey('restart-complete-task'),
          kind: 'state_persisted',
          counters: { ...waited.snapshot.run.counters, activeRuntimeMilliseconds: 1_500 },
          pendingToolCall: null,
          taskLedger: completedLedger,
          evidenceRefs: [],
          occurredAt: at(4_000),
        }),
      ),
    ).resolves.toMatchObject({ kind: 'applied', snapshot: { run: { taskLedgerVersion: 2 } } })
    const storedMission = await unitOfWork.run(organizationId, (repositories) =>
      repositories.missions.get(missionIds.restart),
    )
    expect(storedMission?.taskLedger).toEqual(completedLedger)
    await expect(
      unitOfWork.run(mirrorOrganizationId, (repositories) =>
        repositories.caretakerRuns.get(firstRunId),
      ),
    ).resolves.toBeNull()
  })

  it('persists reason-specific dispositions and replays terminal history across leases', async () => {
    async function startDisposition(missionId: MissionId, label: string, offset: number) {
      const fence = await acquire(missionId, `worker_${label}`, label)
      const runId = RunIdSchema.parse(`run_caretaker${label}`)
      const started = await fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.start({
          runId,
          missionId,
          mutationKey: mutationKey(`${label}-start`),
          evidenceProfile: testCaretakerEvidenceProfile(runId),
          occurredAt: at(offset),
        }),
      )
      return { fence, runId, snapshot: started.snapshot }
    }

    async function updateMissionState(missionId: MissionId, state: MissionState, offset: number) {
      await unitOfWork.run(organizationId, async (repositories) => {
        const stored = await repositories.missions.get(missionId)
        if (stored === null) throw new Error('Disposition mission was absent')
        const saved = await repositories.missions.save(
          MissionSchema.parse({
            ...stored,
            state,
            version: stored.version + 1,
            updatedAt: at(offset),
          }),
          stored.version,
        )
        if (!saved) throw new Error('Disposition mission update conflicted')
      })
    }

    const humanReview = await startDisposition(missionIds.humanReview, 'humanreview', 50_000)
    await updateMissionState(
      missionIds.humanReview,
      { status: 'waiting_for_user', phase: 'verify' },
      50_100,
    )
    const humanReviewEvidence = EvidenceIdSchema.parse('evd_caretakerhumanreview')
    const humanReviewResult = await fencedUnitOfWork.runFenced(humanReview.fence, (repositories) =>
      repositories.caretakerRuns.checkpoint({
        runId: humanReview.runId,
        expectedVersion: 0,
        expectedTaskLedgerVersion: 0,
        mutationKey: mutationKey('human-review-pause'),
        kind: 'human_review_pause',
        counters: { ...ZERO_COUNTERS, activeRuntimeMilliseconds: 10 },
        pendingToolCall: null,
        taskLedger: [
          {
            id: 'inspect_state',
            label: 'Inspect the current palace state',
            status: 'in_progress',
            evidenceRefs: [],
          },
        ],
        evidenceRefs: [humanReviewEvidence],
        terminalEvidence: terminalEvidenceFor(humanReview.runId, at(50_200)),
        occurredAt: at(50_200),
      }),
    )
    expect(humanReviewResult).toMatchObject({
      kind: 'applied',
      snapshot: {
        run: {
          status: 'paused',
          taskLedgerVersion: 1,
          counters: {
            toolCallCount: 0,
            planRevisionCount: 0,
            clarificationPauseCount: 0,
            reconciliationPollCount: 0,
            activeRuntimeMilliseconds: 10,
          },
        },
        checkpoint: { kind: 'human_review_pause', evidenceRefs: [humanReviewEvidence] },
      },
    })

    const approvalResult = await startDisposition(
      missionIds.approvalResult,
      'approvalresult',
      50_300,
    )
    const approvalPending = approvalCall('caretaker_approval_result')
    const approvalDispatched = await fencedUnitOfWork.runFenced(
      approvalResult.fence,
      (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId: approvalResult.runId,
          expectedVersion: 0,
          expectedTaskLedgerVersion: 0,
          mutationKey: mutationKey('approval-result-dispatch'),
          kind: 'tool_call',
          counters: {
            ...ZERO_COUNTERS,
            toolCallCount: 1,
            activeRuntimeMilliseconds: 10,
          },
          pendingToolCall: approvalPending,
          taskLedger: approvalResult.snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(50_400),
        }),
    )
    await updateMissionState(
      missionIds.approvalResult,
      { status: 'waiting_for_user', phase: 'approve' },
      50_500,
    )
    const approvalPersisted = await fencedUnitOfWork.runFenced(
      approvalResult.fence,
      (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId: approvalResult.runId,
          expectedVersion: approvalDispatched.snapshot.run.version,
          expectedTaskLedgerVersion: 0,
          mutationKey: mutationKey('approval-result-persisted'),
          kind: 'state_persisted',
          counters: {
            ...approvalDispatched.snapshot.run.counters,
            activeRuntimeMilliseconds: 20,
          },
          pendingToolCall: null,
          taskLedger: approvalResult.snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(50_600),
        }),
    )
    expect(approvalPersisted).toMatchObject({
      kind: 'applied',
      snapshot: {
        run: { status: 'active', phase: 'approve', pendingToolCall: null },
        checkpoint: { kind: 'state_persisted', phase: 'approve' },
      },
    })
    await expect(
      fencedUnitOfWork.runFenced(approvalResult.fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId: approvalResult.runId,
          expectedVersion: approvalPersisted.snapshot.run.version,
          expectedTaskLedgerVersion: 0,
          mutationKey: mutationKey('approval-result-pause'),
          kind: 'approval_pause',
          counters: approvalPersisted.snapshot.run.counters,
          pendingToolCall: null,
          taskLedger: approvalResult.snapshot.taskLedger,
          evidenceRefs: [],
          terminalEvidence: terminalEvidenceFor(approvalResult.runId, at(50_700)),
          occurredAt: at(50_700),
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'applied',
      snapshot: { run: { status: 'paused' }, checkpoint: { kind: 'approval_pause' } },
    })

    const hostFailed = await startDisposition(missionIds.hostFailed, 'hostfailed', 51_000)
    await updateMissionState(
      missionIds.hostFailed,
      { status: 'waiting_for_system', phase: 'observe' },
      51_100,
    )
    await expect(
      fencedUnitOfWork.runFenced(hostFailed.fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId: hostFailed.runId,
          expectedVersion: 0,
          expectedTaskLedgerVersion: 0,
          mutationKey: mutationKey('host-failed'),
          kind: 'host_failed',
          counters: { ...ZERO_COUNTERS, activeRuntimeMilliseconds: 20 },
          pendingToolCall: null,
          taskLedger: hostFailed.snapshot.taskLedger,
          evidenceRefs: [],
          terminalEvidence: terminalEvidenceFor(hostFailed.runId, at(51_200)),
          occurredAt: at(51_200),
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'applied',
      snapshot: { run: { status: 'failed' }, checkpoint: { kind: 'host_failed' } },
    })

    const safeRefusal = await startDisposition(missionIds.safeRefusal, 'saferefusal', 52_000)
    const safeRefusalInput = {
      runId: safeRefusal.runId,
      expectedVersion: 0,
      expectedTaskLedgerVersion: 0,
      mutationKey: mutationKey('safe-refusal'),
      kind: 'safe_refusal' as const,
      counters: { ...ZERO_COUNTERS, activeRuntimeMilliseconds: 30 },
      pendingToolCall: null,
      taskLedger: safeRefusal.snapshot.taskLedger,
      evidenceRefs: [],
      terminalEvidence: terminalEvidenceFor(safeRefusal.runId, at(52_100)),
      occurredAt: at(52_100),
    }
    const refused = await fencedUnitOfWork.runFenced(safeRefusal.fence, (repositories) =>
      repositories.caretakerRuns.checkpoint(safeRefusalInput),
    )
    expect(refused).toMatchObject({
      kind: 'applied',
      snapshot: {
        run: { id: safeRefusal.runId, status: 'failed', leaseEpoch: 1, version: 1 },
        checkpoint: { kind: 'safe_refusal', runStatus: 'failed' },
      },
    })
    await expect(
      fencedUnitOfWork.runFenced(safeRefusal.fence, (repositories) =>
        repositories.caretakerRuns.checkpoint(safeRefusalInput),
      ),
    ).resolves.toEqual({ kind: 'replayed', snapshot: refused.snapshot })
    const terminalDeliveries = createCaretakerEvidenceDeliveryRepository(database)
    const pendingDelivery = await terminalDeliveries.get(safeRefusal.runId)
    expect(pendingDelivery).toMatchObject({
      runId: safeRefusal.runId,
      status: 'pending',
      deliveredAt: null,
      captureStatus: null,
      envelope: { eventHash: safeRefusalInput.terminalEvidence.eventHash },
    })
    await expectDatabaseRejection(
      database
        .update(caretakerRuns)
        .set({ evidenceProfile: testCaretakerEvidenceProfile('run_caretakerprofiledrift') })
        .where(eq(caretakerRuns.id, safeRefusal.runId)),
      /evidence profile is immutable/,
    )
    await expectDatabaseRejection(
      database
        .update(caretakerTerminalEvidenceDeliveries)
        .set({ eventHash: mutationKey('forged-terminal-event') })
        .where(eq(caretakerTerminalEvidenceDeliveries.runId, safeRefusal.runId)),
      /terminal evidence envelope is immutable/,
    )
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.missionLeases.release(safeRefusal.fence),
    )
    await expect(
      terminalDeliveries.acknowledge({
        runId: safeRefusal.runId,
        eventHash: mutationKey('wrong-terminal-event'),
        captureStatus: 'stored',
        deliveredAt: at(52_150),
      }),
    ).rejects.toThrow(/changed its immutable event hash/)
    await expect(
      terminalDeliveries.acknowledge({
        runId: safeRefusal.runId,
        eventHash: safeRefusalInput.terminalEvidence.eventHash,
        captureStatus: 'stored',
        deliveredAt: at(52_150),
      }),
    ).resolves.toBe('acknowledged')
    await expect(terminalDeliveries.get(safeRefusal.runId)).resolves.toMatchObject({
      status: 'delivered',
      captureStatus: 'stored',
      deliveredAt: at(52_150),
    })
    await expect(
      terminalDeliveries.acknowledge({
        runId: safeRefusal.runId,
        eventHash: safeRefusalInput.terminalEvidence.eventHash,
        captureStatus: 'duplicate',
        deliveredAt: at(52_175),
      }),
    ).resolves.toBe('already_acknowledged')
    const replayFence = await acquire(
      missionIds.safeRefusal,
      'worker_safe_refusal_replay',
      'safe-refusal-replay',
    )
    const candidateRunId = RunIdSchema.parse('run_caretakersafecandidate')
    const terminalReplay = await fencedUnitOfWork.runFenced(replayFence, (repositories) =>
      repositories.caretakerRuns.start({
        runId: candidateRunId,
        missionId: missionIds.safeRefusal,
        mutationKey: mutationKey('safe-refusal-replay'),
        evidenceProfile: testCaretakerEvidenceProfile(candidateRunId),
        occurredAt: at(52_200),
      }),
    )
    expect(terminalReplay).toEqual({ kind: 'replayed', snapshot: refused.snapshot })
    await expect(
      fencedUnitOfWork.runFenced(replayFence, (repositories) =>
        repositories.caretakerRuns.get(safeRefusal.runId),
      ),
    ).resolves.toEqual(refused.snapshot)
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.caretakerRuns.get(candidateRunId),
      ),
    ).resolves.toBeNull()
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.caretakerRuns.listCheckpoints(safeRefusal.runId),
      ),
    ).resolves.toHaveLength(2)

    const genericFailed = await startDisposition(missionIds.genericFailed, 'genericfailed', 53_000)
    const genericFailureInput = {
      runId: genericFailed.runId,
      expectedVersion: 0,
      expectedTaskLedgerVersion: 0,
      mutationKey: mutationKey('generic-failed'),
      kind: 'failed' as const,
      counters: { ...ZERO_COUNTERS, activeRuntimeMilliseconds: 40 },
      pendingToolCall: null,
      taskLedger: genericFailed.snapshot.taskLedger,
      evidenceRefs: [],
      terminalEvidence: terminalEvidenceFor(genericFailed.runId, at(53_100)),
      occurredAt: at(53_100),
    }
    await expect(
      fencedUnitOfWork.runFenced(genericFailed.fence, (repositories) =>
        repositories.caretakerRuns.checkpoint(genericFailureInput),
      ),
    ).rejects.toThrow(/requires a failed mission/)
    await updateMissionState(
      missionIds.genericFailed,
      { status: 'failed', phase: 'execute' },
      53_150,
    )
    await expect(
      fencedUnitOfWork.runFenced(genericFailed.fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          ...genericFailureInput,
          mutationKey: mutationKey('generic-failed-terminal'),
          occurredAt: at(53_200),
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'applied',
      snapshot: { run: { status: 'failed' }, checkpoint: { kind: 'failed' } },
    })

    const rawDisposition = await startDisposition(
      missionIds.rawDisposition,
      'rawdisposition',
      54_000,
    )
    const [activation] = await database
      .select()
      .from(caretakerRunCheckpoints)
      .where(
        and(
          eq(caretakerRunCheckpoints.organizationId, organizationId),
          eq(caretakerRunCheckpoints.runId, rawDisposition.runId),
          eq(caretakerRunCheckpoints.sequence, 0),
        ),
      )
      .limit(1)
    if (activation === undefined) throw new Error('Raw disposition activation was absent')
    await expectDatabaseRejection(
      database.insert(caretakerRunCheckpoints).values({
        ...activation,
        sequence: 1,
        runVersion: 1,
        mutationKey: mutationKey('raw-generic-failed'),
        mutationHash: mutationKey('raw-generic-failed-hash'),
        kind: 'failed',
        runStatus: 'failed',
        occurredAt: new Date(at(54_100)),
      }),
      /failed run checkpoint requires a failed mission/,
    )
    await updateMissionState(
      missionIds.rawDisposition,
      { status: 'failed', phase: 'execute' },
      54_150,
    )
    await expectDatabaseRejection(
      database.insert(caretakerRunCheckpoints).values({
        ...activation,
        sequence: 1,
        runVersion: 1,
        mutationKey: mutationKey('raw-terminal-refusal'),
        mutationHash: mutationKey('raw-terminal-refusal-hash'),
        kind: 'safe_refusal',
        runStatus: 'failed',
        phase: 'execute',
        occurredAt: new Date(at(54_200)),
      }),
      /reason-specific disposition requires a nonterminal mission/,
    )
  }, 30_000)

  it('lets one competing checkpoint win and replays its mutation without duplicate state', async () => {
    const fence = await acquire(missionIds.competing, 'worker_competing', 'competing')
    const runId = RunIdSchema.parse('run_caretakercompete1')
    await fencedUnitOfWork.runFenced(fence, (repositories) =>
      repositories.caretakerRuns.start({
        runId,
        missionId: missionIds.competing,
        mutationKey: mutationKey('competing-start'),
        evidenceProfile: testCaretakerEvidenceProfile(runId),
        occurredAt: at(10_000),
      }),
    )
    const taskLedger = [
      {
        id: 'inspect_state',
        label: 'Inspect the current palace state',
        status: 'in_progress' as const,
        evidenceRefs: [],
      },
    ]
    const calls = ['competing-a', 'competing-b'].map((label, index) =>
      fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: 0,
          expectedTaskLedgerVersion: 0,
          mutationKey: mutationKey(label),
          kind: 'state_persisted',
          counters: { ...ZERO_COUNTERS, activeRuntimeMilliseconds: 100 + index },
          pendingToolCall: null,
          taskLedger,
          evidenceRefs: [],
          occurredAt: at(11_000 + index),
        }),
      ),
    )
    const settled = await Promise.allSettled(calls)
    const applied = settled.filter(
      (result) => result.status === 'fulfilled' && result.value.kind === 'applied',
    )
    expect(applied).toHaveLength(1)
    const loser = settled.find(
      (result) => !(result.status === 'fulfilled' && result.value.kind === 'applied'),
    )
    if (loser?.status === 'rejected') {
      expect(loser.reason).toBeInstanceOf(OptimisticConcurrencyError)
    } else {
      expect(loser?.value.kind).toBe('version_conflict')
    }

    const checkpoints = await unitOfWork.run(organizationId, (repositories) =>
      repositories.caretakerRuns.listCheckpoints(runId),
    )
    expect(checkpoints).toHaveLength(2)
    const winningMutation = checkpoints[1]
    if (winningMutation === undefined) throw new Error('Winning checkpoint was absent')
    const winningIndex = winningMutation.mutationKey === mutationKey('competing-a') ? 0 : 1
    await expect(
      fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: 0,
          expectedTaskLedgerVersion: 0,
          mutationKey: winningMutation.mutationKey,
          kind: 'state_persisted',
          counters: { ...ZERO_COUNTERS, activeRuntimeMilliseconds: 100 + winningIndex },
          pendingToolCall: null,
          taskLedger,
          evidenceRefs: [],
          occurredAt: at(11_000 + winningIndex),
        }),
      ),
    ).resolves.toMatchObject({ kind: 'replayed' })
    const finalCheckpoints = await unitOfWork.run(organizationId, (repositories) =>
      repositories.caretakerRuns.listCheckpoints(runId),
    )
    expect(finalCheckpoints).toHaveLength(2)
    expect(finalCheckpoints[1]?.taskLedger).toEqual(taskLedger)
  })

  it('enforces every run budget and freezes the run at its evidence-backed pause', async () => {
    let fence = await acquire(missionIds.budgets, 'worker_budgets', 'budgets')
    const runId = RunIdSchema.parse('run_caretakerbudgets1')
    let snapshot = (
      await fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.start({
          runId,
          missionId: missionIds.budgets,
          mutationKey: mutationKey('budgets-start'),
          evidenceProfile: testCaretakerEvidenceProfile(runId),
          occurredAt: at(20_000),
        }),
      )
    ).snapshot

    for (let count = 1; count <= 18; count += 1) {
      const pendingToolCall = palaceCall(`caretaker_budget_read_${count}`)
      snapshot = (
        await fencedUnitOfWork.runFenced(fence, (repositories) =>
          repositories.caretakerRuns.checkpoint({
            runId,
            expectedVersion: snapshot.run.version,
            expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
            mutationKey: mutationKey(`tool-${count}`),
            kind: 'tool_call',
            counters: {
              ...snapshot.run.counters,
              toolCallCount: count,
              activeRuntimeMilliseconds: count * 100,
            },
            pendingToolCall,
            taskLedger: snapshot.taskLedger,
            evidenceRefs: [],
            occurredAt: at(20_000 + count * 100),
          }),
        )
      ).snapshot
      snapshot = (
        await fencedUnitOfWork.runFenced(fence, (repositories) =>
          repositories.caretakerRuns.checkpoint({
            runId,
            expectedVersion: snapshot.run.version,
            expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
            mutationKey: mutationKey(`tool-result-${count}`),
            kind: 'state_persisted',
            counters: snapshot.run.counters,
            pendingToolCall: null,
            taskLedger: snapshot.taskLedger,
            evidenceRefs: [],
            occurredAt: at(20_000 + count * 100 + 1),
          }),
        )
      ).snapshot
    }
    await expect(
      fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('tool-25'),
          kind: 'tool_call',
          counters: { ...snapshot.run.counters, toolCallCount: 25 },
          pendingToolCall: palaceCall('caretaker_budget_invalid_25'),
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(23_000),
        }),
      ),
    ).rejects.toThrow()

    for (let count = 1; count <= 2; count += 1) {
      const pendingToolCall = planCall(`caretaker_budget_plan_${count}`, missionIds.budgets, count)
      snapshot = (
        await fencedUnitOfWork.runFenced(fence, (repositories) =>
          repositories.caretakerRuns.checkpoint({
            runId,
            expectedVersion: snapshot.run.version,
            expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
            mutationKey: mutationKey(`plan-${count}`),
            kind: 'plan_revision',
            counters: { ...snapshot.run.counters, planRevisionCount: count },
            pendingToolCall,
            taskLedger: snapshot.taskLedger,
            evidenceRefs: [],
            occurredAt: at(24_000 + count * 10),
          }),
        )
      ).snapshot
      snapshot = (
        await fencedUnitOfWork.runFenced(fence, (repositories) =>
          repositories.caretakerRuns.checkpoint({
            runId,
            expectedVersion: snapshot.run.version,
            expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
            mutationKey: mutationKey(`plan-tool-${count}`),
            kind: 'tool_call',
            counters: {
              ...snapshot.run.counters,
              toolCallCount: snapshot.run.counters.toolCallCount + 1,
            },
            pendingToolCall,
            taskLedger: snapshot.taskLedger,
            evidenceRefs: [],
            occurredAt: at(24_000 + count * 10 + 1),
          }),
        )
      ).snapshot
      snapshot = (
        await fencedUnitOfWork.runFenced(fence, (repositories) =>
          repositories.caretakerRuns.checkpoint({
            runId,
            expectedVersion: snapshot.run.version,
            expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
            mutationKey: mutationKey(`plan-result-${count}`),
            kind: 'state_persisted',
            counters: snapshot.run.counters,
            pendingToolCall: null,
            taskLedger: snapshot.taskLedger,
            evidenceRefs: [],
            occurredAt: at(24_000 + count * 10 + 2),
          }),
        )
      ).snapshot
    }
    await expect(
      fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('plan-4'),
          kind: 'plan_revision',
          counters: { ...snapshot.run.counters, planRevisionCount: 4 },
          pendingToolCall: planCall('caretaker_budget_plan_invalid', missionIds.budgets, 4),
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(25_000),
        }),
      ),
    ).rejects.toThrow()

    for (let count = 1; count <= 2; count += 1) {
      const pendingToolCall = reconciliationCall(`caretaker_budget_poll_${count}`)
      snapshot = (
        await fencedUnitOfWork.runFenced(fence, (repositories) =>
          repositories.caretakerRuns.checkpoint({
            runId,
            expectedVersion: snapshot.run.version,
            expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
            mutationKey: mutationKey(`poll-${count}`),
            kind: 'reconciliation_poll',
            counters: { ...snapshot.run.counters, reconciliationPollCount: count },
            pendingToolCall,
            taskLedger: snapshot.taskLedger,
            evidenceRefs: [],
            occurredAt: at(26_000 + count * 10),
          }),
        )
      ).snapshot
      snapshot = (
        await fencedUnitOfWork.runFenced(fence, (repositories) =>
          repositories.caretakerRuns.checkpoint({
            runId,
            expectedVersion: snapshot.run.version,
            expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
            mutationKey: mutationKey(`poll-tool-${count}`),
            kind: 'tool_call',
            counters: {
              ...snapshot.run.counters,
              toolCallCount: snapshot.run.counters.toolCallCount + 1,
            },
            pendingToolCall,
            taskLedger: snapshot.taskLedger,
            evidenceRefs: [],
            occurredAt: at(26_000 + count * 10 + 1),
          }),
        )
      ).snapshot
      snapshot = (
        await fencedUnitOfWork.runFenced(fence, (repositories) =>
          repositories.caretakerRuns.checkpoint({
            runId,
            expectedVersion: snapshot.run.version,
            expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
            mutationKey: mutationKey(`poll-result-${count}`),
            kind: 'state_persisted',
            counters: snapshot.run.counters,
            pendingToolCall: null,
            taskLedger: snapshot.taskLedger,
            evidenceRefs: [],
            occurredAt: at(26_000 + count * 10 + 2),
          }),
        )
      ).snapshot
    }
    await expect(
      fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('poll-4'),
          kind: 'reconciliation_poll',
          counters: { ...snapshot.run.counters, reconciliationPollCount: 4 },
          pendingToolCall: reconciliationCall('caretaker_budget_poll_invalid'),
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(27_000),
        }),
      ),
    ).rejects.toThrow()

    snapshot = (
      await fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('runtime-near-maximum'),
          kind: 'state_persisted',
          counters: { ...snapshot.run.counters, activeRuntimeMilliseconds: 299_999 },
          pendingToolCall: null,
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(28_000),
        }),
      )
    ).snapshot

    await unitOfWork.run(organizationId, (repositories) =>
      repositories.missionLeases.release(fence),
    )
    fence = await acquire(missionIds.budgets, 'worker_budgets_restarted', 'budgets-restarted')
    const candidateRunId = RunIdSchema.parse('run_caretakerbudgetcandidate')
    const restartedFencedUnit = createMissionExecutionUnitOfWork(createDatabase(pool))
    const resumed = await restartedFencedUnit.runFenced(fence, (repositories) =>
      repositories.caretakerRuns.start({
        runId: candidateRunId,
        missionId: missionIds.budgets,
        mutationKey: mutationKey('budgets-resume'),
        evidenceProfile: testCaretakerEvidenceProfile(candidateRunId),
        occurredAt: at(28_100),
      }),
    )
    expect(resumed).toMatchObject({
      kind: 'resumed',
      snapshot: {
        run: {
          id: runId,
          counters: {
            toolCallCount: 22,
            planRevisionCount: 2,
            clarificationPauseCount: 0,
            reconciliationPollCount: 2,
            activeRuntimeMilliseconds: 299_999,
          },
        },
      },
    })
    snapshot = resumed.snapshot
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.caretakerRuns.get(candidateRunId),
      ),
    ).resolves.toBeNull()

    const finalPoll = reconciliationCall('caretaker_budget_poll_3')
    snapshot = (
      await restartedFencedUnit.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('poll-3'),
          kind: 'reconciliation_poll',
          counters: { ...snapshot.run.counters, reconciliationPollCount: 3 },
          pendingToolCall: finalPoll,
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(28_200),
        }),
      )
    ).snapshot
    snapshot = (
      await restartedFencedUnit.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('poll-tool-3'),
          kind: 'tool_call',
          counters: { ...snapshot.run.counters, toolCallCount: 23 },
          pendingToolCall: finalPoll,
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(28_201),
        }),
      )
    ).snapshot
    snapshot = (
      await restartedFencedUnit.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('poll-result-3'),
          kind: 'state_persisted',
          counters: snapshot.run.counters,
          pendingToolCall: null,
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(28_202),
        }),
      )
    ).snapshot

    const finalPlan = planCall('caretaker_budget_plan_3', missionIds.budgets, 3)
    snapshot = (
      await restartedFencedUnit.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('plan-3'),
          kind: 'plan_revision',
          counters: { ...snapshot.run.counters, planRevisionCount: 3 },
          pendingToolCall: finalPlan,
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(28_300),
        }),
      )
    ).snapshot
    snapshot = (
      await restartedFencedUnit.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('plan-tool-3'),
          kind: 'tool_call',
          counters: { ...snapshot.run.counters, toolCallCount: 24 },
          pendingToolCall: finalPlan,
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(28_301),
        }),
      )
    ).snapshot
    snapshot = (
      await restartedFencedUnit.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('plan-result-3'),
          kind: 'state_persisted',
          counters: snapshot.run.counters,
          pendingToolCall: null,
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(28_302),
        }),
      )
    ).snapshot
    snapshot = (
      await restartedFencedUnit.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('runtime-maximum'),
          kind: 'state_persisted',
          counters: { ...snapshot.run.counters, activeRuntimeMilliseconds: 300_000 },
          pendingToolCall: null,
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(28_400),
        }),
      )
    ).snapshot
    expect(snapshot.run.counters).toEqual({
      toolCallCount: 24,
      planRevisionCount: 3,
      clarificationPauseCount: 0,
      reconciliationPollCount: 3,
      activeRuntimeMilliseconds: 300_000,
    })
    for (const attempted of [
      {
        kind: 'tool_call' as const,
        counters: { ...snapshot.run.counters, toolCallCount: 25 },
        pendingToolCall: palaceCall('caretaker_budget_over_tool'),
      },
      {
        kind: 'plan_revision' as const,
        counters: { ...snapshot.run.counters, planRevisionCount: 4 },
        pendingToolCall: planCall('caretaker_budget_over_plan', missionIds.budgets, 4),
      },
      {
        kind: 'reconciliation_poll' as const,
        counters: { ...snapshot.run.counters, reconciliationPollCount: 4 },
        pendingToolCall: reconciliationCall('caretaker_budget_over_poll'),
      },
    ]) {
      await expect(
        restartedFencedUnit.runFenced(fence, (repositories) =>
          repositories.caretakerRuns.checkpoint({
            runId,
            expectedVersion: snapshot.run.version,
            expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
            mutationKey: mutationKey(`over-${attempted.kind}`),
            ...attempted,
            taskLedger: snapshot.taskLedger,
            evidenceRefs: [],
            occurredAt: at(28_500),
          }),
        ),
      ).rejects.toThrow()
    }
    await expect(
      restartedFencedUnit.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('runtime-over'),
          kind: 'state_persisted',
          counters: { ...snapshot.run.counters, activeRuntimeMilliseconds: 300_001 },
          pendingToolCall: null,
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(29_000),
        }),
      ),
    ).rejects.toThrow()

    const paused = await fencedUnitOfWork.runFenced(fence, (repositories) =>
      repositories.caretakerRuns.checkpoint({
        runId,
        expectedVersion: snapshot.run.version,
        expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
        mutationKey: mutationKey('budget-pause'),
        kind: 'budget_exhausted',
        counters: snapshot.run.counters,
        pendingToolCall: null,
        taskLedger: snapshot.taskLedger,
        evidenceRefs: [],
        terminalEvidence: terminalEvidenceFor(runId, at(30_000)),
        occurredAt: at(30_000),
      }),
    )
    expect(paused).toMatchObject({ kind: 'applied', snapshot: { run: { status: 'paused' } } })
    await expect(
      fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId,
          expectedVersion: paused.snapshot.run.version,
          expectedTaskLedgerVersion: paused.snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('after-terminal'),
          kind: 'state_persisted',
          counters: paused.snapshot.run.counters,
          pendingToolCall: null,
          taskLedger: paused.snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt: at(31_000),
        }),
      ),
    ).rejects.toThrow(/active lease fence/)
    await expectDatabaseRejection(
      database
        .update(caretakerRuns)
        .set({ version: paused.snapshot.run.version + 1, updatedAt: new Date(at(31_000)) })
        .where(and(eq(caretakerRuns.organizationId, organizationId), eq(caretakerRuns.id, runId))),
      /terminal caretaker run is immutable/,
    )
    await expectDatabaseRejection(
      database
        .update(caretakerRunCheckpoints)
        .set({ occurredAt: new Date(at(31_000)) })
        .where(
          and(
            eq(caretakerRunCheckpoints.organizationId, organizationId),
            eq(caretakerRunCheckpoints.runId, runId),
            eq(caretakerRunCheckpoints.sequence, 0),
          ),
        ),
      /caretaker_run_checkpoints is append-only/,
    )
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.missionLeases.release(fence),
    )
    const unauthorizedResumeFence = await acquire(
      missionIds.budgets,
      'worker_budgets_unauthorized',
      'budgets-unauthorized',
    )
    await expect(
      restartedFencedUnit.runFenced(unauthorizedResumeFence, (repositories) =>
        repositories.caretakerRuns.start({
          runId: RunIdSchema.parse('run_caretakerbudgetunauthorized'),
          missionId: missionIds.budgets,
          mutationKey: mutationKey('budget-unauthorized-resume'),
          evidenceProfile: testCaretakerEvidenceProfile(
            RunIdSchema.parse('run_caretakerbudgetunauthorized'),
          ),
          occurredAt: at(32_000),
        }),
      ),
    ).rejects.toThrow(/explicit authorization/)
  }, 30_000)

  it('inherits plan and clarification ceilings across same-timestamp paused activations', async () => {
    const occurredAt = at(40_000)
    let fence = await acquire(missionIds.pauseBudgets, 'worker_pause_a', 'pause-a')
    let snapshot = (
      await fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.start({
          runId: RunIdSchema.parse('run_zzzz_caretakerpause'),
          missionId: missionIds.pauseBudgets,
          mutationKey: mutationKey('pause-start-1'),
          evidenceProfile: testCaretakerEvidenceProfile(
            RunIdSchema.parse('run_zzzz_caretakerpause'),
          ),
          occurredAt,
        }),
      )
    ).snapshot

    async function setMissionState(status: 'running' | 'waiting_for_user', phase: 'plan') {
      await unitOfWork.run(organizationId, async (repositories) => {
        const stored = await repositories.missions.get(missionIds.pauseBudgets)
        if (stored === null) throw new Error('Pause-budget mission is absent')
        await repositories.missions.save(
          MissionSchema.parse({
            ...stored,
            state: { status, phase },
            version: stored.version + 1,
            updatedAt: occurredAt,
          }),
          stored.version,
        )
      })
    }

    async function checkpoint(
      kind: CaretakerRunMutationCheckpointKind,
      counters: CaretakerRunCounters,
      pendingToolCall: CaretakerPendingToolCall | null,
      label: string,
    ) {
      snapshot = (
        await fencedUnitOfWork.runFenced(fence, (repositories) =>
          repositories.caretakerRuns.checkpoint({
            runId: snapshot.run.id,
            expectedVersion: snapshot.run.version,
            expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
            mutationKey: mutationKey(label),
            kind,
            counters,
            pendingToolCall,
            taskLedger: snapshot.taskLedger,
            evidenceRefs: [],
            terminalEvidence:
              caretakerRunStatusForCheckpoint(kind) === 'active'
                ? null
                : terminalEvidenceFor(snapshot.run.id, occurredAt),
            occurredAt,
          }),
        )
      ).snapshot
    }

    async function executePlanRevision(revision: number, label: string) {
      const pending = planCall(label, missionIds.pauseBudgets, revision)
      await checkpoint(
        'plan_revision',
        { ...snapshot.run.counters, planRevisionCount: revision },
        pending,
        `${label}-reserve`,
      )
      await checkpoint(
        'tool_call',
        {
          ...snapshot.run.counters,
          toolCallCount: snapshot.run.counters.toolCallCount + 1,
        },
        pending,
        `${label}-dispatch`,
      )
      await checkpoint('state_persisted', snapshot.run.counters, null, `${label}-result`)
    }

    await setMissionState('running', 'plan')
    await executePlanRevision(1, 'caretaker_pause_plan_1')
    await executePlanRevision(2, 'caretaker_pause_plan_2')
    await setMissionState('waiting_for_user', 'plan')
    await checkpoint(
      'clarification_pause',
      { ...snapshot.run.counters, clarificationPauseCount: 1 },
      null,
      'pause-clarification-1',
    )
    expect(snapshot.run).toMatchObject({
      status: 'paused',
      counters: { toolCallCount: 2, planRevisionCount: 2, clarificationPauseCount: 1 },
    })

    await unitOfWork.run(organizationId, (repositories) =>
      repositories.missionLeases.release(fence),
    )
    await setMissionState('running', 'plan')
    fence = await acquire(missionIds.pauseBudgets, 'worker_pause_b', 'pause-b')
    snapshot = (
      await fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.start({
          runId: RunIdSchema.parse('run_aaaa_caretakerpause'),
          missionId: missionIds.pauseBudgets,
          mutationKey: mutationKey('pause-start-2'),
          evidenceProfile: testCaretakerEvidenceProfile(
            RunIdSchema.parse('run_aaaa_caretakerpause'),
          ),
          occurredAt,
        }),
      )
    ).snapshot
    expect(snapshot.run.counters).toMatchObject({
      toolCallCount: 2,
      planRevisionCount: 2,
      clarificationPauseCount: 1,
    })
    await executePlanRevision(3, 'caretaker_pause_plan_3')
    await setMissionState('waiting_for_user', 'plan')
    await checkpoint(
      'clarification_pause',
      { ...snapshot.run.counters, clarificationPauseCount: 2 },
      null,
      'pause-clarification-2',
    )

    await unitOfWork.run(organizationId, (repositories) =>
      repositories.missionLeases.release(fence),
    )
    await setMissionState('running', 'plan')
    fence = await acquire(missionIds.pauseBudgets, 'worker_pause_c', 'pause-c')
    snapshot = (
      await fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.start({
          runId: RunIdSchema.parse('run_mmmm_caretakerpause'),
          missionId: missionIds.pauseBudgets,
          mutationKey: mutationKey('pause-start-3'),
          evidenceProfile: testCaretakerEvidenceProfile(
            RunIdSchema.parse('run_mmmm_caretakerpause'),
          ),
          occurredAt,
        }),
      )
    ).snapshot
    expect(snapshot.run.counters).toEqual({
      toolCallCount: 3,
      planRevisionCount: 3,
      clarificationPauseCount: 2,
      reconciliationPollCount: 0,
      activeRuntimeMilliseconds: 0,
    })
    await expect(
      fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId: snapshot.run.id,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('pause-plan-over'),
          kind: 'plan_revision',
          counters: { ...snapshot.run.counters, planRevisionCount: 4 },
          pendingToolCall: planCall('caretaker_pause_plan_4', missionIds.pauseBudgets, 4),
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt,
        }),
      ),
    ).rejects.toThrow()
    await expect(
      fencedUnitOfWork.runFenced(fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          runId: snapshot.run.id,
          expectedVersion: snapshot.run.version,
          expectedTaskLedgerVersion: snapshot.run.taskLedgerVersion,
          mutationKey: mutationKey('pause-clarification-over'),
          kind: 'clarification_pause',
          counters: { ...snapshot.run.counters, clarificationPauseCount: 3 },
          pendingToolCall: null,
          taskLedger: snapshot.taskLedger,
          evidenceRefs: [],
          occurredAt,
        }),
      ),
    ).rejects.toThrow()
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.caretakerRuns.getLatestForMission(missionIds.pauseBudgets),
      ),
    ).resolves.toMatchObject({ run: { id: 'run_mmmm_caretakerpause' } })
  }, 30_000)

  it('rejects a second task-ledger write path and a raw update without a checkpoint', async () => {
    const validPending = palaceCall('caretaker_database_guard')
    const secretInput = {
      query: 'inspect Bearer secret-value-123456',
      phase: 'understand',
      limit: 6,
    }
    const pendingValidation = await pool.query<{
      valid: boolean
      mismatched: boolean
      sensitive: boolean
    }>(
      `SELECT caretaker_pending_tool_call_is_valid($1::jsonb) AS valid,
              caretaker_pending_tool_call_is_valid($2::jsonb) AS mismatched,
              caretaker_pending_tool_call_is_valid($3::jsonb) AS sensitive`,
      [
        JSON.stringify(validPending),
        JSON.stringify({ ...validPending, inputHash: 'f'.repeat(64) }),
        JSON.stringify({
          callId: 'call_caretakerdatabase_secret',
          toolName: 'knowledge.search',
          input: secretInput,
          inputHash: hashToolValue(secretInput),
        }),
      ],
    )
    expect(pendingValidation.rows).toEqual([{ valid: true, mismatched: false, sensitive: false }])

    const mission = await unitOfWork.run(organizationId, (repositories) =>
      repositories.missions.get(missionIds.rawGuard),
    )
    if (mission === null) throw new Error('Raw-guard mission is absent')
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.missions.save(
          MissionSchema.parse({
            ...mission,
            runId: 'run_caretakerforgedpointer',
            version: mission.version + 1,
            updatedAt: at(40_000),
          }),
          mission.version,
        ),
      ),
    ).rejects.toThrow(/fenced activation/)
    await expectDatabaseRejection(
      database
        .update(missions)
        .set({ runId: 'run_caretakerforgedpointer' })
        .where(
          and(eq(missions.organizationId, organizationId), eq(missions.id, missionIds.rawGuard)),
        ),
      /run pointer requires its fenced active activation/,
    )
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.missions.save(
          MissionSchema.parse({
            ...mission,
            version: mission.version + 1,
            taskLedger: [
              ...mission.taskLedger,
              {
                id: 'second_writer',
                label: 'Bypass the canonical caretaker ledger',
                status: 'pending',
                evidenceRefs: [],
              },
            ],
            updatedAt: at(40_000),
          }),
          mission.version,
        ),
      ),
    ).rejects.toThrow(/versioned run checkpoint/)

    await expectDatabaseRejection(
      database.transaction(async (transaction) => {
        await transaction
          .update(missions)
          .set({
            taskLedger: [
              {
                id: 'inspect_state',
                label: 'Inspect the current palace state',
                status: 'in_progress',
                evidenceRefs: [],
              },
            ],
            taskLedgerVersion: sql`${missions.taskLedgerVersion} + 1`,
          })
          .where(
            and(eq(missions.organizationId, organizationId), eq(missions.id, missionIds.rawGuard)),
          )
      }),
      /lacks a caretaker checkpoint/,
    )
    const checkpointCount = await database
      .select({ count: sql<number>`count(*)::integer` })
      .from(caretakerRunCheckpoints)
      .where(eq(caretakerRunCheckpoints.missionId, missionIds.rawGuard))
    expect(checkpointCount).toEqual([{ count: 0 }])
  })
})

function mission(
  organizationId: OrganizationId,
  id: MissionId,
  palaceId: ReturnType<typeof PalaceIdSchema.parse>,
  initiatedBy: ReturnType<typeof UserIdSchema.parse>,
) {
  return MissionSchema.parse({
    id,
    organizationId,
    palaceId,
    initiatedBy,
    objective: 'Resume one Caretaker objective from durable state',
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    successCriteriaIds: ['single_durable_run'],
    state: { status: 'running', phase: 'understand' },
    version: 1,
    runId: null,
    contextReceiptId: null,
    taskLedger: [
      {
        id: 'inspect_state',
        label: 'Inspect the current palace state',
        status: 'pending',
        evidenceRefs: [],
      },
    ],
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
  })
}

async function applyMigrations(pool: pg.Pool, schemaName: string): Promise<void> {
  const migrationDirectory = new URL('../migrations/', import.meta.url)
  const filenames = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort()
  for (const filename of filenames) {
    const migration = (await readFile(new URL(filename, migrationDirectory), 'utf8')).replaceAll(
      '"public".',
      `"${schemaName}".`,
    )
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) await pool.query(statement)
    }
  }
}

async function expectDatabaseRejection(
  operation: Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  try {
    await operation
    throw new Error('Expected the database operation to reject')
  } catch (error) {
    const messages: string[] = []
    const visited = new Set<unknown>()
    let current: unknown = error
    while (current instanceof Error && !visited.has(current)) {
      visited.add(current)
      messages.push(current.message)
      current = (current as Error & { cause?: unknown }).cause
    }
    expect(messages.join('\n')).toMatch(expected)
  }
}

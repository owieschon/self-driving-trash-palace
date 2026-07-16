import {
  CaretakerRunCheckpointSchema,
  CaretakerRunCountersSchema,
  CaretakerRunMutationCheckpointKindSchema,
  CaretakerPendingToolCallSchema,
  CaretakerRunRecordSchema,
  CaretakerEvidenceProfileSchema,
  CaretakerTerminalEvidenceEnvelopeSchema,
  EMPTY_CARETAKER_RUN_COUNTERS,
  assertCaretakerCounterTransition,
  assertCaretakerMissionStateForCheckpoint,
  assertCaretakerPendingToolCallTransition,
  assertCaretakerTaskLedgerTransition,
  assertCaretakerToolWaitPayloadTransition,
  caretakerRunStatusForCheckpoint,
  hashCaretakerCheckpointMutation,
  hashCaretakerTaskLedger,
  parseCaretakerTaskLedger,
  type CaretakerRunCheckpoint,
  type CaretakerRunCounters,
  type CaretakerRunRepository,
  type CaretakerRunSnapshot,
} from '@trash-palace/application'
import {
  EvidenceIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  RunIdSchema,
  Sha256Schema,
  type MissionId,
  type OrganizationId,
  type RunId,
  type Sha256,
} from '@trash-palace/core'
import { and, asc, desc, eq, ne } from 'drizzle-orm'

import type { DatabaseTransaction } from './client.js'
import { hashCanonical } from './crypto.js'
import {
  DatabaseConflictError,
  DatabaseNotFoundError,
  MissionFenceRejectedError,
  OptimisticConcurrencyError,
} from './errors.js'
import {
  caretakerRunCheckpoints,
  caretakerRuns,
  caretakerTerminalEvidenceDeliveries,
  missions,
} from './schema.js'

interface CaretakerFenceScope {
  readonly missionId: MissionId | null
  readonly leaseEpoch: number | null
}

type CaretakerRunRow = typeof caretakerRuns.$inferSelect
type CaretakerRunCheckpointRow = typeof caretakerRunCheckpoints.$inferSelect

function date(value: string): Date {
  const parsed = new Date(IsoDateTimeSchema.parse(value))
  if (Number.isNaN(parsed.valueOf())) throw new TypeError(`Invalid date-time: ${value}`)
  return parsed
}

function iso(value: Date): string {
  return value.toISOString()
}

function countersFromRow(row: {
  readonly toolCallCount: number
  readonly planRevisionCount: number
  readonly clarificationPauseCount: number
  readonly reconciliationPollCount: number
  readonly activeRuntimeMilliseconds: number
}): CaretakerRunCounters {
  return CaretakerRunCountersSchema.parse({
    toolCallCount: row.toolCallCount,
    planRevisionCount: row.planRevisionCount,
    clarificationPauseCount: row.clarificationPauseCount,
    reconciliationPollCount: row.reconciliationPollCount,
    activeRuntimeMilliseconds: row.activeRuntimeMilliseconds,
  })
}

function mapRun(row: CaretakerRunRow) {
  return CaretakerRunRecordSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    missionId: row.missionId,
    leaseEpoch: row.leaseEpoch,
    status: row.status,
    phase: row.phase,
    version: row.version,
    taskLedgerVersion: row.taskLedgerVersion,
    counters: countersFromRow(row),
    pendingToolCall:
      row.pendingToolCall === null
        ? null
        : CaretakerPendingToolCallSchema.parse(row.pendingToolCall),
    evidenceProfile: CaretakerEvidenceProfileSchema.parse(row.evidenceProfile),
    startedAt: iso(row.startedAt),
    updatedAt: iso(row.updatedAt),
    endedAt: row.endedAt === null ? null : iso(row.endedAt),
  })
}

function mapCheckpoint(row: CaretakerRunCheckpointRow): CaretakerRunCheckpoint {
  const taskLedger = parseCaretakerTaskLedger(row.taskLedger)
  const checkpoint = CaretakerRunCheckpointSchema.parse({
    organizationId: row.organizationId,
    missionId: row.missionId,
    runId: row.runId,
    sequence: row.sequence,
    mutationKey: row.mutationKey,
    mutationHash: row.mutationHash,
    kind: row.kind,
    runStatus: row.runStatus,
    phase: row.phase,
    runVersion: row.runVersion,
    taskLedgerVersion: row.taskLedgerVersion,
    taskLedgerHash: row.taskLedgerHash,
    taskLedger,
    counters: countersFromRow(row),
    pendingToolCall:
      row.pendingToolCall === null
        ? null
        : CaretakerPendingToolCallSchema.parse(row.pendingToolCall),
    evidenceRefs: row.evidenceRefs,
    occurredAt: iso(row.occurredAt),
  })
  if (hashCaretakerTaskLedger(taskLedger) !== checkpoint.taskLedgerHash) {
    throw new DatabaseConflictError('Caretaker checkpoint task-ledger hash is invalid')
  }
  return checkpoint
}

async function loadSnapshot(
  executor: DatabaseTransaction,
  organizationId: OrganizationId,
  runId: RunId,
): Promise<CaretakerRunSnapshot | null> {
  const [row] = await executor
    .select()
    .from(caretakerRuns)
    .where(and(eq(caretakerRuns.organizationId, organizationId), eq(caretakerRuns.id, runId)))
    .limit(1)
  if (!row) return null
  const [checkpointRow] = await executor
    .select()
    .from(caretakerRunCheckpoints)
    .where(
      and(
        eq(caretakerRunCheckpoints.organizationId, organizationId),
        eq(caretakerRunCheckpoints.runId, runId),
        eq(caretakerRunCheckpoints.sequence, row.version),
      ),
    )
    .limit(1)
  if (!checkpointRow) {
    throw new DatabaseConflictError('Caretaker run lacks its version-matched checkpoint')
  }
  const run = mapRun(row)
  const checkpoint = mapCheckpoint(checkpointRow)
  if (
    checkpoint.missionId !== run.missionId ||
    checkpoint.runStatus !== run.status ||
    checkpoint.phase !== run.phase ||
    checkpoint.taskLedgerVersion !== run.taskLedgerVersion ||
    hashCanonical(checkpoint.counters) !== hashCanonical(run.counters) ||
    hashCanonical(checkpoint.pendingToolCall) !== hashCanonical(run.pendingToolCall)
  ) {
    throw new DatabaseConflictError('Caretaker run and latest checkpoint disagree')
  }
  return { run, checkpoint, taskLedger: checkpoint.taskLedger }
}

async function requireSnapshot(
  executor: DatabaseTransaction,
  organizationId: OrganizationId,
  runId: RunId,
): Promise<CaretakerRunSnapshot> {
  const snapshot = await loadSnapshot(executor, organizationId, runId)
  if (snapshot === null) throw new DatabaseNotFoundError('Caretaker run')
  return snapshot
}

function startMutationHash(input: {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly runId: RunId
  readonly mutationKey: Sha256
  readonly evidenceProfileHash: Sha256
  readonly occurredAt: string
}): Sha256 {
  return hashCanonical({ schemaVersion: 'caretaker-run-start@2', ...input })
}

function resumeMutationHash(input: {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly runId: RunId
  readonly candidateRunId: RunId
  readonly mutationKey: Sha256
  readonly leaseEpoch: number
  readonly occurredAt: string
}): Sha256 {
  return hashCanonical({ schemaVersion: 'caretaker-run-resume@1', ...input })
}

function assertFence(scope: CaretakerFenceScope, missionId: MissionId): number {
  if (
    scope.missionId === null ||
    scope.leaseEpoch === null ||
    scope.missionId !== missionId ||
    scope.leaseEpoch < 1
  ) {
    throw new MissionFenceRejectedError()
  }
  return scope.leaseEpoch
}

function checkpointValues(input: CaretakerRunCheckpoint) {
  return {
    organizationId: input.organizationId,
    missionId: input.missionId,
    runId: input.runId,
    sequence: input.sequence,
    mutationKey: input.mutationKey,
    mutationHash: input.mutationHash,
    kind: input.kind,
    runStatus: input.runStatus,
    phase: input.phase,
    runVersion: input.runVersion,
    taskLedgerVersion: input.taskLedgerVersion,
    taskLedgerHash: input.taskLedgerHash,
    taskLedger: input.taskLedger,
    toolCallCount: input.counters.toolCallCount,
    planRevisionCount: input.counters.planRevisionCount,
    clarificationPauseCount: input.counters.clarificationPauseCount,
    reconciliationPollCount: input.counters.reconciliationPollCount,
    activeRuntimeMilliseconds: input.counters.activeRuntimeMilliseconds,
    pendingToolCall: input.pendingToolCall,
    evidenceRefs: input.evidenceRefs,
    occurredAt: date(input.occurredAt),
  }
}

export function createPgCaretakerRunRepository(input: {
  readonly executor: DatabaseTransaction
  readonly organizationId: OrganizationId
  readonly fence: CaretakerFenceScope
}): CaretakerRunRepository {
  const organizationId = OrganizationIdSchema.parse(input.organizationId)
  const { executor } = input

  return {
    get: async (inputRunId) =>
      loadSnapshot(executor, organizationId, RunIdSchema.parse(inputRunId)),

    getLatestForMission: async (inputMissionId) => {
      const missionId = MissionIdSchema.parse(inputMissionId)
      const [row] = await executor
        .select({ runId: missions.runId })
        .from(missions)
        .where(and(eq(missions.organizationId, organizationId), eq(missions.id, missionId)))
        .limit(1)
      return row?.runId
        ? loadSnapshot(executor, organizationId, RunIdSchema.parse(row.runId))
        : null
    },

    listCheckpoints: async (inputRunId) => {
      const runId = RunIdSchema.parse(inputRunId)
      const rows = await executor
        .select()
        .from(caretakerRunCheckpoints)
        .where(
          and(
            eq(caretakerRunCheckpoints.organizationId, organizationId),
            eq(caretakerRunCheckpoints.runId, runId),
          ),
        )
        .orderBy(asc(caretakerRunCheckpoints.sequence))
      return rows.map(mapCheckpoint)
    },

    start: async (startInput) => {
      const runId = RunIdSchema.parse(startInput.runId)
      const missionId = MissionIdSchema.parse(startInput.missionId)
      const mutationKey = Sha256Schema.parse(startInput.mutationKey)
      const evidenceProfile = CaretakerEvidenceProfileSchema.parse(startInput.evidenceProfile)
      const occurredAt = date(startInput.occurredAt)
      const leaseEpoch = assertFence(input.fence, missionId)
      const mutationHash = startMutationHash({
        organizationId,
        missionId,
        runId,
        mutationKey,
        evidenceProfileHash: evidenceProfile.profileHash,
        occurredAt: occurredAt.toISOString(),
      })

      const [mission] = await executor
        .select()
        .from(missions)
        .where(and(eq(missions.organizationId, organizationId), eq(missions.id, missionId)))
        .for('update')
        .limit(1)
      if (!mission) throw new DatabaseNotFoundError('Mission')

      const [existing] = await executor
        .select()
        .from(caretakerRuns)
        .where(and(eq(caretakerRuns.organizationId, organizationId), eq(caretakerRuns.id, runId)))
        .for('update')
        .limit(1)
      const existingIsTerminalFinalization =
        existing !== undefined &&
        (existing.status === 'active' || existing.status === 'paused') &&
        mission.runId === existing.id &&
        ['succeeded', 'failed', 'cancelled'].includes(mission.status)
      if (existing) {
        const [firstCheckpoint] = await executor
          .select({
            mutationKey: caretakerRunCheckpoints.mutationKey,
            mutationHash: caretakerRunCheckpoints.mutationHash,
          })
          .from(caretakerRunCheckpoints)
          .where(
            and(
              eq(caretakerRunCheckpoints.organizationId, organizationId),
              eq(caretakerRunCheckpoints.runId, runId),
              eq(caretakerRunCheckpoints.sequence, 0),
            ),
          )
          .limit(1)
        if (existing.missionId !== missionId) {
          throw new DatabaseConflictError('Caretaker run identity is already bound')
        }
        const existingProfile = CaretakerEvidenceProfileSchema.parse(existing.evidenceProfile)
        if (existingProfile.configurationHash !== evidenceProfile.configurationHash) {
          throw new DatabaseConflictError('Caretaker evidence profile changed during a durable run')
        }
        if (
          mission.runId === existing.id &&
          ['completed', 'failed', 'cancelled'].includes(existing.status)
        ) {
          return {
            kind: 'replayed',
            snapshot: await requireSnapshot(executor, organizationId, runId),
          }
        }
        if (
          existing.leaseEpoch === leaseEpoch &&
          firstCheckpoint?.mutationKey === mutationKey &&
          firstCheckpoint.mutationHash === mutationHash
        ) {
          return {
            kind: 'replayed',
            snapshot: await requireSnapshot(executor, organizationId, runId),
          }
        }
        if (
          (!existingIsTerminalFinalization && existing.status !== 'active') ||
          existing.leaseEpoch > leaseEpoch
        ) {
          throw new DatabaseConflictError('Caretaker run identity is already bound')
        }
      }

      if (mission.runId !== null) {
        const [canonicalRun] = await executor
          .select()
          .from(caretakerRuns)
          .where(
            and(
              eq(caretakerRuns.organizationId, organizationId),
              eq(caretakerRuns.missionId, missionId),
              eq(caretakerRuns.id, mission.runId),
            ),
          )
          .for('update')
          .limit(1)
        if (canonicalRun && ['completed', 'failed', 'cancelled'].includes(canonicalRun.status)) {
          return {
            kind: 'replayed',
            snapshot: await requireSnapshot(
              executor,
              organizationId,
              RunIdSchema.parse(canonicalRun.id),
            ),
          }
        }
      }

      const terminalFinalization = existingIsTerminalFinalization
      const externalStateSynchronization =
        existing?.status === 'active' &&
        mission.runId === existing.id &&
        ((mission.status === 'waiting_for_system' && mission.phase === 'observe') ||
          (mission.status === 'waiting_for_user' &&
            (mission.phase === 'plan' || mission.phase === 'approve')))
      if (mission.status !== 'running' && !terminalFinalization && !externalStateSynchronization) {
        throw new DatabaseConflictError('A Caretaker run may start only for a running mission')
      }
      if (occurredAt.valueOf() < mission.updatedAt.valueOf()) {
        throw new DatabaseConflictError('Caretaker run cannot start before current mission state')
      }
      const taskLedger = parseCaretakerTaskLedger(mission.taskLedger)
      if (terminalFinalization && existing.status === 'paused') {
        const existingProfile = CaretakerEvidenceProfileSchema.parse(existing.evidenceProfile)
        if (existingProfile.configurationHash !== evidenceProfile.configurationHash) {
          throw new DatabaseConflictError(
            'Caretaker evidence profile changed during terminal finalization',
          )
        }
        if (existing.taskLedgerVersion !== mission.taskLedgerVersion) {
          throw new DatabaseConflictError('Paused run task-ledger version is inconsistent')
        }
        if (existing.pendingToolCall !== null) {
          throw new DatabaseConflictError('Paused terminal run retained a pending tool call')
        }
        if (occurredAt.valueOf() < existing.updatedAt.valueOf()) {
          throw new DatabaseConflictError('Terminal finalization cannot predate the paused run')
        }
        const nextVersion = existing.version + 1
        const replacementMutationHash = resumeMutationHash({
          organizationId,
          missionId,
          runId: RunIdSchema.parse(existing.id),
          candidateRunId: runId,
          mutationKey,
          leaseEpoch,
          occurredAt: occurredAt.toISOString(),
        })
        const [resumed] = await executor
          .update(caretakerRuns)
          .set({
            leaseEpoch,
            status: 'active',
            phase: mission.phase,
            version: nextVersion,
            updatedAt: occurredAt,
            endedAt: null,
          })
          .where(
            and(
              eq(caretakerRuns.organizationId, organizationId),
              eq(caretakerRuns.id, existing.id),
              eq(caretakerRuns.version, existing.version),
              eq(caretakerRuns.status, 'paused'),
            ),
          )
          .returning()
        if (!resumed) {
          throw new OptimisticConcurrencyError('Paused Caretaker run changed during finalization')
        }
        const replacementCheckpoint = CaretakerRunCheckpointSchema.parse({
          organizationId,
          missionId,
          runId: existing.id,
          sequence: nextVersion,
          mutationKey,
          mutationHash: replacementMutationHash,
          kind: 'lease_replaced',
          runStatus: 'active',
          phase: mission.phase,
          runVersion: nextVersion,
          taskLedgerVersion: mission.taskLedgerVersion,
          taskLedgerHash: hashCaretakerTaskLedger(taskLedger),
          taskLedger,
          counters: countersFromRow(existing),
          pendingToolCall: null,
          evidenceRefs: [],
          occurredAt: occurredAt.toISOString(),
        })
        await executor
          .insert(caretakerRunCheckpoints)
          .values(checkpointValues(replacementCheckpoint))
        return {
          kind: 'resumed',
          snapshot: {
            run: mapRun(resumed),
            checkpoint: replacementCheckpoint,
            taskLedger,
          },
        }
      }
      const [active] = await executor
        .select()
        .from(caretakerRuns)
        .where(
          and(
            eq(caretakerRuns.organizationId, organizationId),
            eq(caretakerRuns.missionId, missionId),
            eq(caretakerRuns.status, 'active'),
          ),
        )
        .for('update')
        .limit(1)
      if (active) {
        const activeProfile = CaretakerEvidenceProfileSchema.parse(active.evidenceProfile)
        if (activeProfile.configurationHash !== evidenceProfile.configurationHash) {
          throw new DatabaseConflictError(
            'Caretaker evidence profile changed during lease replacement',
          )
        }
        if (active.taskLedgerVersion !== mission.taskLedgerVersion) {
          throw new DatabaseConflictError('Active run task-ledger version is inconsistent')
        }
        if (
          active.phase !== mission.phase &&
          !terminalFinalization &&
          !externalStateSynchronization
        ) {
          throw new DatabaseConflictError('Active run phase is inconsistent with its mission')
        }
        if (occurredAt.valueOf() < active.updatedAt.valueOf()) {
          throw new DatabaseConflictError('Lease replacement cannot predate the active run')
        }
        const replacementMutationHash = resumeMutationHash({
          organizationId,
          missionId,
          runId: RunIdSchema.parse(active.id),
          candidateRunId: runId,
          mutationKey,
          leaseEpoch,
          occurredAt: occurredAt.toISOString(),
        })
        if (active.leaseEpoch === leaseEpoch) {
          const [replacementCheckpoint] = await executor
            .select({ mutationHash: caretakerRunCheckpoints.mutationHash })
            .from(caretakerRunCheckpoints)
            .where(
              and(
                eq(caretakerRunCheckpoints.organizationId, organizationId),
                eq(caretakerRunCheckpoints.runId, active.id),
                eq(caretakerRunCheckpoints.mutationKey, mutationKey),
              ),
            )
            .limit(1)
          if (replacementCheckpoint?.mutationHash !== replacementMutationHash) {
            throw new DatabaseConflictError('The current lease epoch already owns an active run')
          }
          return {
            kind: 'replayed',
            snapshot: await requireSnapshot(executor, organizationId, RunIdSchema.parse(active.id)),
          }
        }
        if (active.leaseEpoch > leaseEpoch) {
          throw new DatabaseConflictError('A newer lease epoch already owns the active run')
        }
        const nextVersion = active.version + 1
        const [resumed] = await executor
          .update(caretakerRuns)
          .set({
            leaseEpoch,
            phase:
              terminalFinalization || externalStateSynchronization ? mission.phase : active.phase,
            version: nextVersion,
            updatedAt: occurredAt,
          })
          .where(
            and(
              eq(caretakerRuns.organizationId, organizationId),
              eq(caretakerRuns.id, active.id),
              eq(caretakerRuns.version, active.version),
              eq(caretakerRuns.status, 'active'),
              eq(caretakerRuns.leaseEpoch, active.leaseEpoch),
            ),
          )
          .returning()
        if (!resumed) {
          throw new OptimisticConcurrencyError('Active Caretaker run changed during takeover')
        }
        const replacementCheckpoint = CaretakerRunCheckpointSchema.parse({
          organizationId,
          missionId,
          runId: active.id,
          sequence: nextVersion,
          mutationKey,
          mutationHash: replacementMutationHash,
          kind: 'lease_replaced',
          runStatus: 'active',
          phase:
            terminalFinalization || externalStateSynchronization ? mission.phase : active.phase,
          runVersion: nextVersion,
          taskLedgerVersion: mission.taskLedgerVersion,
          taskLedgerHash: hashCaretakerTaskLedger(taskLedger),
          taskLedger,
          counters: countersFromRow(active),
          pendingToolCall:
            active.pendingToolCall === null
              ? null
              : CaretakerPendingToolCallSchema.parse(active.pendingToolCall),
          evidenceRefs: [],
          occurredAt: occurredAt.toISOString(),
        })
        await executor
          .insert(caretakerRunCheckpoints)
          .values(checkpointValues(replacementCheckpoint))
        return {
          kind: 'resumed',
          snapshot: {
            run: mapRun(resumed),
            checkpoint: replacementCheckpoint,
            taskLedger,
          },
        }
      }

      const [previousRun] = mission.runId
        ? await executor
            .select()
            .from(caretakerRuns)
            .where(
              and(
                eq(caretakerRuns.organizationId, organizationId),
                eq(caretakerRuns.missionId, missionId),
                eq(caretakerRuns.id, mission.runId),
              ),
            )
            .limit(1)
        : []
      let inheritedCounters = EMPTY_CARETAKER_RUN_COUNTERS
      if (mission.runId !== null && !previousRun) {
        throw new DatabaseConflictError('Mission latest Caretaker activation is missing')
      }
      if (previousRun) {
        if (previousRun.status !== 'paused') {
          throw new DatabaseConflictError(
            'Only a paused Caretaker activation may start a successor',
          )
        }
        const [previousCheckpoint] = await executor
          .select({ kind: caretakerRunCheckpoints.kind })
          .from(caretakerRunCheckpoints)
          .where(
            and(
              eq(caretakerRunCheckpoints.organizationId, organizationId),
              eq(caretakerRunCheckpoints.runId, previousRun.id),
              eq(caretakerRunCheckpoints.sequence, previousRun.version),
            ),
          )
          .limit(1)
        if (!previousCheckpoint) {
          throw new DatabaseConflictError('Previous Caretaker activation lacks its checkpoint')
        }
        if (previousCheckpoint.kind === 'budget_exhausted') {
          throw new DatabaseConflictError(
            'A budget-exhausted Caretaker activation requires explicit authorization to resume',
          )
        }
        if (previousRun.pendingToolCall !== null) {
          throw new DatabaseConflictError(
            'A paused Caretaker activation retained a pending tool call',
          )
        }
        inheritedCounters = countersFromRow(previousRun)
      }

      const [created] = await executor
        .insert(caretakerRuns)
        .values({
          id: runId,
          organizationId,
          missionId,
          leaseEpoch,
          status: 'active',
          phase: mission.phase,
          version: 0,
          taskLedgerVersion: mission.taskLedgerVersion,
          ...inheritedCounters,
          pendingToolCall: null,
          evidenceProfile,
          startedAt: occurredAt,
          updatedAt: occurredAt,
          endedAt: null,
        })
        .returning()
      if (!created) throw new OptimisticConcurrencyError('Caretaker run was not inserted')
      const checkpoint = CaretakerRunCheckpointSchema.parse({
        organizationId,
        missionId,
        runId,
        sequence: 0,
        mutationKey,
        mutationHash,
        kind: 'activated',
        runStatus: 'active',
        phase: mission.phase,
        runVersion: 0,
        taskLedgerVersion: mission.taskLedgerVersion,
        taskLedgerHash: hashCaretakerTaskLedger(taskLedger),
        taskLedger,
        counters: inheritedCounters,
        pendingToolCall: null,
        evidenceRefs: [],
        occurredAt: occurredAt.toISOString(),
      })
      await executor.insert(caretakerRunCheckpoints).values(checkpointValues(checkpoint))
      await executor
        .update(missions)
        .set({ runId, updatedAt: occurredAt })
        .where(and(eq(missions.organizationId, organizationId), eq(missions.id, missionId)))
      return {
        kind: 'started',
        snapshot: { run: mapRun(created), checkpoint, taskLedger },
      }
    },

    checkpoint: async (checkpointInput) => {
      const runId = RunIdSchema.parse(checkpointInput.runId)
      const mutationKey = Sha256Schema.parse(checkpointInput.mutationKey)
      const kind = CaretakerRunMutationCheckpointKindSchema.parse(checkpointInput.kind)
      const occurredAt = date(checkpointInput.occurredAt)
      if (
        !Number.isSafeInteger(checkpointInput.expectedVersion) ||
        checkpointInput.expectedVersion < 0
      ) {
        throw new TypeError('Expected Caretaker run version must be a nonnegative safe integer')
      }
      if (
        !Number.isSafeInteger(checkpointInput.expectedTaskLedgerVersion) ||
        checkpointInput.expectedTaskLedgerVersion < 0
      ) {
        throw new TypeError('Expected task-ledger version must be a nonnegative safe integer')
      }
      const counters = CaretakerRunCountersSchema.parse(checkpointInput.counters)
      const pendingToolCall =
        checkpointInput.pendingToolCall === null
          ? null
          : CaretakerPendingToolCallSchema.parse(checkpointInput.pendingToolCall)
      const taskLedger = parseCaretakerTaskLedger(checkpointInput.taskLedger)
      const evidenceRefs = checkpointInput.evidenceRefs.map((evidenceId) =>
        EvidenceIdSchema.parse(evidenceId),
      )
      if (new Set(evidenceRefs).size !== evidenceRefs.length) {
        throw new TypeError('Caretaker checkpoint evidence references must be unique')
      }
      const terminalEvidence =
        checkpointInput.terminalEvidence == null
          ? null
          : CaretakerTerminalEvidenceEnvelopeSchema.parse(checkpointInput.terminalEvidence)

      const [row] = await executor
        .select()
        .from(caretakerRuns)
        .where(and(eq(caretakerRuns.organizationId, organizationId), eq(caretakerRuns.id, runId)))
        .for('update')
        .limit(1)
      if (!row) throw new DatabaseNotFoundError('Caretaker run')
      const missionId = MissionIdSchema.parse(row.missionId)
      const leaseEpoch = assertFence(input.fence, missionId)
      const mutationHash = hashCaretakerCheckpointMutation({
        organizationId,
        missionId,
        runId,
        mutationKey,
        kind,
        counters,
        pendingToolCall,
        taskLedger,
        evidenceRefs,
        terminalEvidence,
        occurredAt: occurredAt.toISOString(),
      })
      const [existingCheckpoint] = await executor
        .select()
        .from(caretakerRunCheckpoints)
        .where(
          and(
            eq(caretakerRunCheckpoints.organizationId, organizationId),
            eq(caretakerRunCheckpoints.runId, runId),
            eq(caretakerRunCheckpoints.mutationKey, mutationKey),
          ),
        )
        .limit(1)
      if (existingCheckpoint) {
        if (existingCheckpoint.mutationHash !== mutationHash) {
          throw new DatabaseConflictError('Caretaker checkpoint mutation key is already bound')
        }
        return {
          kind: 'replayed',
          snapshot: await requireSnapshot(executor, organizationId, runId),
        }
      }

      if (
        row.version !== checkpointInput.expectedVersion ||
        row.taskLedgerVersion !== checkpointInput.expectedTaskLedgerVersion
      ) {
        return {
          kind: 'version_conflict',
          snapshot: await requireSnapshot(executor, organizationId, runId),
        }
      }
      if (row.status !== 'active' || row.leaseEpoch !== leaseEpoch) {
        throw new MissionFenceRejectedError()
      }
      if (occurredAt.valueOf() < row.updatedAt.valueOf()) {
        throw new DatabaseConflictError('Caretaker checkpoint cannot predate the run state')
      }

      const [mission] = await executor
        .select()
        .from(missions)
        .where(and(eq(missions.organizationId, organizationId), eq(missions.id, missionId)))
        .for('update')
        .limit(1)
      if (!mission) throw new DatabaseNotFoundError('Mission')
      if (mission.taskLedgerVersion !== row.taskLedgerVersion) {
        throw new DatabaseConflictError('Mission and run task-ledger versions disagree')
      }
      try {
        assertCaretakerMissionStateForCheckpoint({
          state: { status: mission.status, phase: mission.phase },
          kind,
          clearsPendingToolCall: row.pendingToolCall !== null && pendingToolCall === null,
        })
      } catch (error) {
        throw new DatabaseConflictError(
          error instanceof Error ? error.message : 'Caretaker mission state is invalid',
        )
      }
      const previousLedger = parseCaretakerTaskLedger(mission.taskLedger)
      const [previousActionCheckpoint] = await executor
        .select({ kind: caretakerRunCheckpoints.kind })
        .from(caretakerRunCheckpoints)
        .where(
          and(
            eq(caretakerRunCheckpoints.organizationId, organizationId),
            eq(caretakerRunCheckpoints.runId, runId),
            ne(caretakerRunCheckpoints.kind, 'lease_replaced'),
          ),
        )
        .orderBy(desc(caretakerRunCheckpoints.sequence))
        .limit(1)
      if (!previousActionCheckpoint) {
        throw new DatabaseConflictError('Caretaker run lacks an action checkpoint')
      }
      try {
        assertCaretakerTaskLedgerTransition(previousLedger, taskLedger)
        assertCaretakerCounterTransition({ previous: countersFromRow(row), next: counters, kind })
        assertCaretakerPendingToolCallTransition({
          previous:
            row.pendingToolCall === null
              ? null
              : CaretakerPendingToolCallSchema.parse(row.pendingToolCall),
          next: pendingToolCall,
          previousCheckpointKind: previousActionCheckpoint.kind,
          kind,
        })
        if (kind === 'tool_wait') {
          assertCaretakerToolWaitPayloadTransition({
            previousCheckpointKind: previousActionCheckpoint.kind,
            previousPhase: row.phase,
            nextPhase: mission.phase,
            previousTaskLedger: previousLedger,
            nextTaskLedger: taskLedger,
            evidenceRefs,
          })
        }
      } catch (error) {
        throw new DatabaseConflictError(
          error instanceof Error ? error.message : 'Caretaker checkpoint transition is invalid',
        )
      }
      const ledgerChanged =
        hashCaretakerTaskLedger(previousLedger) !== hashCaretakerTaskLedger(taskLedger)
      const taskLedgerVersion = row.taskLedgerVersion + (ledgerChanged ? 1 : 0)
      if (ledgerChanged) {
        const [updatedMission] = await executor
          .update(missions)
          .set({
            taskLedger,
            taskLedgerVersion,
            runId,
            updatedAt: occurredAt,
          })
          .where(
            and(
              eq(missions.organizationId, organizationId),
              eq(missions.id, missionId),
              eq(missions.taskLedgerVersion, row.taskLedgerVersion),
            ),
          )
          .returning({ id: missions.id })
        if (!updatedMission) {
          throw new OptimisticConcurrencyError('Caretaker task ledger changed concurrently')
        }
      }
      const status = caretakerRunStatusForCheckpoint(kind)
      if ((status === 'active') !== (terminalEvidence === null)) {
        throw new DatabaseConflictError(
          'A terminal Caretaker checkpoint requires exactly one terminal evidence envelope',
        )
      }
      const nextVersion = row.version + 1
      const [updated] = await executor
        .update(caretakerRuns)
        .set({
          status,
          phase: mission.phase,
          version: nextVersion,
          taskLedgerVersion,
          toolCallCount: counters.toolCallCount,
          planRevisionCount: counters.planRevisionCount,
          clarificationPauseCount: counters.clarificationPauseCount,
          reconciliationPollCount: counters.reconciliationPollCount,
          activeRuntimeMilliseconds: counters.activeRuntimeMilliseconds,
          pendingToolCall,
          updatedAt: occurredAt,
          endedAt: status === 'active' ? null : occurredAt,
        })
        .where(
          and(
            eq(caretakerRuns.organizationId, organizationId),
            eq(caretakerRuns.id, runId),
            eq(caretakerRuns.version, row.version),
            eq(caretakerRuns.status, 'active'),
            eq(caretakerRuns.leaseEpoch, leaseEpoch),
          ),
        )
        .returning()
      if (!updated) throw new OptimisticConcurrencyError('Caretaker run changed concurrently')
      const checkpoint = CaretakerRunCheckpointSchema.parse({
        organizationId,
        missionId,
        runId,
        sequence: nextVersion,
        mutationKey,
        mutationHash,
        kind,
        runStatus: status,
        phase: mission.phase,
        runVersion: nextVersion,
        taskLedgerVersion,
        taskLedgerHash: hashCaretakerTaskLedger(taskLedger),
        taskLedger,
        counters,
        pendingToolCall,
        evidenceRefs,
        occurredAt: occurredAt.toISOString(),
      })
      await executor.insert(caretakerRunCheckpoints).values(checkpointValues(checkpoint))
      if (terminalEvidence !== null) {
        await executor.insert(caretakerTerminalEvidenceDeliveries).values({
          organizationId,
          missionId,
          runId,
          eventInsertId: terminalEvidence.event.insertId,
          eventHash: terminalEvidence.eventHash,
          envelope: terminalEvidence,
          status: 'pending',
          createdAt: occurredAt,
          deliveredAt: null,
          captureStatus: null,
        })
      }
      return {
        kind: 'applied',
        snapshot: { run: mapRun(updated), checkpoint, taskLedger },
      }
    },
  }
}

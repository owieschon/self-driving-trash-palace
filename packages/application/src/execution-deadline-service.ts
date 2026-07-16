import type { Mission } from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import { persistMissionTransition } from './mission-state.js'
import type {
  ExecutionDeadlineReference,
  ExecutionReadinessResult,
  JsonValue,
  OutboxMessage,
} from './models.js'
import { ExecutionDeadlineReferenceSchema } from './models.js'
import { CryptoIdGenerator, SYSTEM_CLOCK, iso } from './primitives.js'
import type { ClockPort, IdGeneratorPort, TenantRepositories, UnitOfWorkPort } from './ports.js'

export interface ExecutionDeadlineResult {
  readonly readiness: ExecutionReadinessResult
  readonly mission: Mission
}

export class ExecutionDeadlineService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
  ) {}

  public evaluate(reference: ExecutionDeadlineReference): Promise<ExecutionDeadlineResult> {
    const input = ExecutionDeadlineReferenceSchema.parse(reference)
    return this.unitOfWork.run(input.organizationId, async (repositories) => {
      const stored = await repositories.executions.get(input.executionId)
      if (stored === null) throw new NotFoundError('Execution')
      if (
        stored.operationId !== input.operationId ||
        stored.execution.operationId !== input.operationId ||
        stored.execution.missionId !== input.missionId ||
        stored.execution.organizationId !== input.organizationId
      ) {
        throw new ConflictError('Execution deadline reference does not match persisted execution')
      }
      const readiness = await repositories.executions.evaluateReadiness({
        missionId: input.missionId,
        operationId: input.operationId,
        executionId: input.executionId,
        evaluatedAt: iso(this.clock.now()),
      })
      if (readiness === null) throw new NotFoundError('Execution')
      const mission = await advanceMissionWhenReady(repositories, readiness, this.clock, this.ids)
      return { readiness, mission }
    })
  }
}

export async function advanceMissionWhenReady(
  repositories: TenantRepositories,
  readiness: ExecutionReadinessResult,
  clock: ClockPort,
  ids: IdGeneratorPort,
): Promise<Mission> {
  const mission = await repositories.missions.get(readiness.execution.missionId)
  if (mission === null) throw new NotFoundError('Mission')
  if (readiness.status === 'not_ready') return mission
  if (mission.state.status === 'waiting_for_system' && mission.state.phase === 'observe') {
    const next = await persistMissionTransition({
      repositories,
      mission,
      expectedVersion: mission.version,
      event:
        readiness.reason === 'deadline_elapsed'
          ? 'observation_deadline_expired'
          : 'evidence_arrived',
      clock,
      ids,
    })
    await enqueueMissionVerification(repositories, next, iso(clock.now()), ids)
    return next
  }
  if (mission.state.status === 'running' && mission.state.phase === 'verify') {
    await enqueueMissionVerification(repositories, mission, iso(clock.now()), ids)
  }
  return mission
}

async function enqueueMissionVerification(
  repositories: TenantRepositories,
  mission: Mission,
  createdAt: string,
  ids: IdGeneratorPort,
): Promise<void> {
  const deduplicationKey = `mission.verify:${mission.id}:${mission.version}`
  if ((await repositories.outbox.findByDeduplicationKey(deduplicationKey)) !== null) return
  const payload: Readonly<Record<string, JsonValue>> = {
    organizationId: mission.organizationId,
    missionId: mission.id,
  }
  const message: OutboxMessage = {
    id: ids.next('outbox'),
    organizationId: mission.organizationId,
    topic: 'mission.verify',
    deduplicationKey,
    payload,
    status: 'pending',
    availableAt: createdAt,
    createdAt,
    claimedBy: null,
    claimExpiresAt: null,
    dispatchedAt: null,
    deliveryAttempts: 0,
    lastErrorCode: null,
  }
  await repositories.outbox.insert(message)
}

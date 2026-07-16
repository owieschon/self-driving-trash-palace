import {
  assertSameTenant,
  isTerminalMissionState,
  type Mission,
  type MissionId,
  type MissionTransitionEvent,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import { assertMissionExecutionContext, type MissionExecutionContext } from './mission-fence.js'
import { persistMissionTransition } from './mission-state.js'
import type { ActorContext } from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import { CryptoIdGenerator, SYSTEM_CLOCK, iso } from './primitives.js'
import type {
  ClockPort,
  IdGeneratorPort,
  MissionExecutionUnitOfWorkPort,
  UnitOfWorkPort,
} from './ports.js'

export type HostMissionTransitionEvent = Exclude<MissionTransitionEvent, 'verification_passed'>

export class MissionLifecycleService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
    private readonly missionUnitOfWork: MissionExecutionUnitOfWorkPort | null = null,
  ) {}

  public async get(context: ActorContext, missionId: MissionId): Promise<Mission> {
    const mission = await this.unitOfWork.run(
      context.principal.organizationId,
      async (repositories) => repositories.missions.get(missionId),
    )
    if (mission === null) throw new NotFoundError('Mission')
    assertSameTenant(context.principal.organizationId, [mission.organizationId])
    return mission
  }

  public async transition(input: {
    readonly context: MissionExecutionContext
    readonly missionId: MissionId
    readonly expectedVersion: number
    readonly event: HostMissionTransitionEvent
  }): Promise<Mission> {
    if ((input.event as MissionTransitionEvent) === 'verification_passed') {
      throw new ConflictError('Only VerificationService may mark a mission successful')
    }
    const organizationId = input.context.principal.organizationId
    assertMissionExecutionContext(input.context, {
      organizationId,
      missionId: input.missionId,
    })
    if (this.missionUnitOfWork === null) {
      throw new ConflictError('Mission transition requires a fenced unit of work')
    }
    const missionUnitOfWork = this.missionUnitOfWork
    const mission = await this.observability.trace(
      {
        name: 'domain.mission.transition',
        kind: 'domain',
        correlation: { organizationId, missionId: input.missionId },
        attributes: { event: input.event },
      },
      () =>
        missionUnitOfWork.runFenced(input.context.fence, async (repositories) => {
          const current = await repositories.missions.get(input.missionId)
          if (current === null) throw new NotFoundError('Mission')
          assertSameTenant(organizationId, [current.organizationId])
          if (isTerminalMissionState(current.state)) {
            throw new ConflictError('Terminal mission state is immutable')
          }
          return persistMissionTransition({
            repositories,
            mission: current,
            expectedVersion: input.expectedVersion,
            event: input.event,
            clock: this.clock,
            ids: this.ids,
          })
        }),
    )
    await this.observability.record({
      name: 'mission.transitioned',
      occurredAt: iso(this.clock.now()),
      correlation: { organizationId, missionId: mission.id },
      attributes: {
        event: input.event,
        status: mission.state.status,
        phase: mission.state.phase,
        version: mission.version,
      },
    })
    return mission
  }
}

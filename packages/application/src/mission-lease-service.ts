import {
  isTerminalMissionState,
  type Mission,
  type MissionId,
  type OrganizationId,
} from '@trash-palace/core'

import { ConflictError, LeaseLostError, LeaseUnavailableError, NotFoundError } from './errors.js'
import { OpaqueMissionFenceToken, type MissionFence } from './mission-fence.js'
import { persistMissionTransition } from './mission-state.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import { CryptoEntropy, CryptoIdGenerator, SYSTEM_CLOCK } from './primitives.js'
import type { ClockPort, EntropyPort, IdGeneratorPort, UnitOfWorkPort } from './ports.js'

export interface AcquiredMissionFence {
  readonly fence: MissionFence
  readonly mission: Mission
  readonly resumed: boolean
}

export class MissionLeaseService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly entropy: EntropyPort = new CryptoEntropy(),
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
  ) {}

  public acquire(input: {
    readonly organizationId: OrganizationId
    readonly missionId: MissionId
    readonly ownerId: string
    readonly ttlMilliseconds?: number
    readonly allowTerminalFinalization?: boolean
  }): Promise<AcquiredMissionFence> {
    const ttl = validateTtl(input.ttlMilliseconds ?? 30_000)
    return this.observability.trace(
      {
        name: 'domain.mission.lease',
        kind: 'worker',
        correlation: { organizationId: input.organizationId, missionId: input.missionId },
        attributes: { action: 'acquire', ttl_ms: ttl },
      },
      () =>
        this.unitOfWork.run(input.organizationId, async (repositories) => {
          let mission = await repositories.missions.get(input.missionId)
          if (mission === null) throw new NotFoundError('Mission')
          if (isTerminalMissionState(mission.state) && !input.allowTerminalFinalization) {
            throw new LeaseUnavailableError()
          }
          const token = OpaqueMissionFenceToken.fromEntropy(this.entropy.token(24))
          const fence = await repositories.missionLeases.acquire({
            organizationId: mission.organizationId,
            missionId: mission.id,
            ownerId: input.ownerId,
            token,
            ttlMilliseconds: ttl,
          })
          if (fence === null) throw new LeaseUnavailableError()
          assertAcquiredFence(fence, {
            organizationId: input.organizationId,
            missionId: input.missionId,
            ownerId: input.ownerId,
            token,
          })
          const resumed = mission.state.status !== 'queued'
          if (!resumed) {
            mission = await persistMissionTransition({
              repositories,
              mission,
              expectedVersion: mission.version,
              event: 'lease_acquired',
              clock: this.clock,
              ids: this.ids,
            })
          }
          return { fence, mission, resumed }
        }),
    )
  }

  public async renew(input: {
    readonly fence: MissionFence
    readonly ttlMilliseconds?: number
  }): Promise<MissionFence> {
    const ttl = validateTtl(input.ttlMilliseconds ?? 30_000)
    const renewed = await this.unitOfWork.run(input.fence.organizationId, (repositories) =>
      repositories.missionLeases.renew(input.fence, ttl),
    )
    if (renewed === null) throw new LeaseLostError()
    assertSameFence(input.fence, renewed)
    return renewed
  }

  public release(fence: MissionFence): Promise<boolean> {
    return this.unitOfWork.run(fence.organizationId, (repositories) =>
      repositories.missionLeases.release(fence),
    )
  }
}

function assertAcquiredFence(
  fence: MissionFence,
  expected: Pick<MissionFence, 'missionId' | 'organizationId' | 'ownerId' | 'token'>,
): void {
  if (
    fence.organizationId !== expected.organizationId ||
    fence.missionId !== expected.missionId ||
    fence.ownerId !== expected.ownerId ||
    fence.token !== expected.token ||
    !Number.isSafeInteger(fence.epoch) ||
    fence.epoch < 1
  ) {
    throw new ConflictError('Lease repository returned an invalid mission fence')
  }
}

function assertSameFence(expected: MissionFence, actual: MissionFence): void {
  if (
    actual.organizationId !== expected.organizationId ||
    actual.missionId !== expected.missionId ||
    actual.ownerId !== expected.ownerId ||
    actual.epoch !== expected.epoch ||
    actual.token !== expected.token
  ) {
    throw new LeaseLostError()
  }
}

function validateTtl(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 5 * 60_000) {
    throw new RangeError('Mission lease TTL must be between one second and five minutes')
  }
  return value
}

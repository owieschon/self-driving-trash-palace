import {
  MissionIdSchema,
  MissionSchema,
  assertPermission,
  hashToolValue,
  missionProgramKindOf,
  type Mission,
  type PalaceId,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import type { AuthContext } from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import { enqueueMissionResume } from './mission-resume.js'
import { SYSTEM_CLOCK, iso } from './primitives.js'
import { enqueueApplicationProductEvidence } from './product-evidence.js'
import type { MissionBootstrapEvidencePort } from './homecoming-planning-evidence.js'
import type {
  ClockPort,
  IdGeneratorPort,
  SensitiveMutationGuardPort,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

export type MissionBootstrapResult = Readonly<{
  kind: 'created' | 'replayed'
  mission: Mission
}>

export class MissionBootstrapService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly mutationGuard: SensitiveMutationGuardPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
    private readonly planningEvidence: MissionBootstrapEvidencePort | null = null,
  ) {}

  public async create(input: {
    readonly context: AuthContext
    readonly requestId: string
    readonly palaceId: PalaceId
    readonly objective: string
    readonly constraints: Mission['constraints']
    readonly successCriteriaIds: readonly string[]
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }): Promise<MissionBootstrapResult> {
    this.mutationGuard.assert(input)
    assertPermission(input.context.principal, 'routine:draft')
    if (!/^[a-z][a-z0-9_-]{7,95}$/.test(input.requestId)) {
      throw new TypeError('Mission request ID is invalid')
    }
    const organizationId = input.context.principal.organizationId
    const identityPayload = {
      schemaVersion: 'mission-bootstrap-identity@1',
      organizationId,
      initiatedBy: input.context.principal.actorId,
      requestId: input.requestId,
    } as const
    const missionId = MissionIdSchema.parse(`mis_${hashToolValue(identityPayload).slice(0, 32)}`)
    const contentHash = bootstrapContentHash(input)

    const result: MissionBootstrapResult = await this.unitOfWork.run(
      organizationId,
      async (repositories) => {
        const existing = await repositories.missions.get(missionId)
        if (existing !== null) {
          if (bootstrapMissionContentHash(existing) !== contentHash) {
            throw new ConflictError('Mission request identity was reused with different content')
          }
          const initialResume = await repositories.outbox.findByDeduplicationKey(
            `mission.resume:${missionId}:0`,
          )
          if (initialResume === null) {
            throw new ConflictError('Replayed mission lacks its atomic initial resume')
          }
          await this.#enqueueCreatedEvidence(repositories, existing, input)
          return { kind: 'replayed', mission: existing }
        }
        if ((await repositories.palaces.get(input.palaceId)) === null) {
          throw new NotFoundError('Palace')
        }
        const createdAt = iso(this.clock.now())
        const mission = MissionSchema.parse({
          id: missionId,
          organizationId,
          palaceId: input.palaceId,
          initiatedBy: input.context.principal.actorId,
          programKind: missionProgramKindOf({ constraints: input.constraints }),
          objective: input.objective,
          constraints: input.constraints,
          successCriteriaIds: [...input.successCriteriaIds],
          state: { status: 'queued', phase: 'understand' },
          version: 0,
          runId: null,
          contextReceiptId: null,
          taskLedger: [],
          createdAt,
          updatedAt: createdAt,
        })
        await repositories.missions.insert(mission)
        if (this.planningEvidence !== null) {
          const evidence = await this.planningEvidence.project({
            repositories,
            mission,
            observedAt: createdAt,
          })
          await repositories.evidence.appendMany(evidence)
        }
        await enqueueMissionResume(repositories, mission, this.ids)
        await this.#enqueueCreatedEvidence(repositories, mission, input)
        return { kind: 'created', mission }
      },
    )
    return result
  }

  #enqueueCreatedEvidence(
    repositories: TenantRepositories,
    mission: Mission,
    input: Pick<Parameters<MissionBootstrapService['create']>[0], 'context'>,
  ) {
    return enqueueApplicationProductEvidence(repositories, this.observability, {
      event: 'mission created',
      durableIdentity: { missionId: mission.id },
      occurredAt: mission.createdAt,
      correlation: {
        distinctId: mission.initiatedBy,
        actorId: input.context.principal.actorId,
        organizationId: mission.organizationId,
        palaceId: mission.palaceId,
        missionId: mission.id,
      },
      properties: {
        source_surface: 'api',
        objective_class:
          missionProgramKindOf(mission) === 'scheduled_hauler_access'
            ? 'scheduled_hauler_access'
            : 'homecoming_routine',
      },
    })
  }
}

function bootstrapContentHash(input: {
  readonly palaceId: PalaceId
  readonly objective: string
  readonly constraints: Mission['constraints']
  readonly successCriteriaIds: readonly string[]
}): string {
  return hashToolValue({
    palaceId: input.palaceId,
    programKind: missionProgramKindOf({ constraints: input.constraints }),
    objective: input.objective,
    constraints: input.constraints,
    successCriteriaIds: input.successCriteriaIds,
  })
}

function bootstrapMissionContentHash(mission: Mission): string {
  return bootstrapContentHash({
    palaceId: mission.palaceId,
    objective: mission.objective,
    constraints: mission.constraints,
    successCriteriaIds: mission.successCriteriaIds,
  })
}

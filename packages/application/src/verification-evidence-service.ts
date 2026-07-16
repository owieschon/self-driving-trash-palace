import {
  VerificationGetEvidenceInputSchema,
  VerificationGetEvidenceOutputSchema,
  assertPermission,
  type MissionId,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import type { ActorContext } from './models.js'
import type { UnitOfWorkPort } from './ports.js'

export class VerificationEvidenceService {
  public constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  public get(input: {
    readonly context: ActorContext
    readonly missionId: MissionId
  }): Promise<ReturnType<typeof VerificationGetEvidenceOutputSchema.parse>> {
    assertPermission(input.context.principal, 'verification:read')
    const query = VerificationGetEvidenceInputSchema.parse({ missionId: input.missionId })
    const organizationId = input.context.principal.organizationId
    return this.unitOfWork.run(organizationId, async (repositories) => {
      const mission = await repositories.missions.get(query.missionId)
      if (mission === null) throw new NotFoundError('Mission')
      const records = await repositories.evidence.listForMission(mission.id)
      if (
        mission.organizationId !== organizationId ||
        records.some(
          (record) =>
            record.evidence.organizationId !== organizationId ||
            record.evidence.missionId !== mission.id,
        )
      ) {
        throw new ConflictError('Evidence projection did not match the requested mission')
      }
      return VerificationGetEvidenceOutputSchema.parse({
        evidence: records.map((record) => record.evidence),
      })
    })
  }
}

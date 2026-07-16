import {
  MissionEventSchema,
  MissionSchema,
  resolveMissionTransition,
  type Mission,
  type MissionTransitionEvent,
} from '@trash-palace/core'

import { OptimisticConcurrencyError } from './errors.js'
import { iso, parseGeneratedId } from './primitives.js'
import type { ClockPort, IdGeneratorPort, TenantRepositories } from './ports.js'

export async function persistMissionTransition(input: {
  readonly repositories: TenantRepositories
  readonly mission: Mission
  readonly expectedVersion: number
  readonly event: MissionTransitionEvent
  readonly clock: ClockPort
  readonly ids: IdGeneratorPort
}): Promise<Mission> {
  if (input.mission.version !== input.expectedVersion) {
    throw new OptimisticConcurrencyError('Mission')
  }
  const occurredAt = iso(input.clock.now())
  const next = MissionSchema.parse({
    ...input.mission,
    state: resolveMissionTransition(input.mission.state, input.event),
    version: input.expectedVersion + 1,
    updatedAt: occurredAt,
  })
  const saved = await input.repositories.missions.save(next, input.expectedVersion)
  if (!saved) throw new OptimisticConcurrencyError('Mission')
  await input.repositories.missions.appendEvent(
    MissionEventSchema.parse({
      id: parseGeneratedId('mission_event', input.ids.next('mission_event')),
      missionId: input.mission.id,
      organizationId: input.mission.organizationId,
      sequence: next.version,
      event: input.event,
      from: input.mission.state,
      to: next.state,
      occurredAt,
    }),
  )
  return next
}

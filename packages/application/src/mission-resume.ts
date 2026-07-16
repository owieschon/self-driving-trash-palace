import type { Mission } from '@trash-palace/core'

import { ConflictError } from './errors.js'
import type { JsonValue, OutboxMessage } from './models.js'
import type { IdGeneratorPort, TenantRepositories } from './ports.js'

/** Enqueues one version-bound host activation in the same transaction as its state transition. */
export async function enqueueMissionResume(
  repositories: TenantRepositories,
  mission: Mission,
  ids: IdGeneratorPort,
): Promise<void> {
  const deduplicationKey = `mission.resume:${mission.id}:${mission.version}`
  const payload: Readonly<Record<string, JsonValue>> = {
    organizationId: mission.organizationId,
    missionId: mission.id,
  }
  const existing = await repositories.outbox.findByDeduplicationKey(deduplicationKey)
  if (existing !== null) {
    if (
      existing.organizationId !== mission.organizationId ||
      existing.topic !== 'mission.resume' ||
      JSON.stringify(existing.payload) !== JSON.stringify(payload)
    ) {
      throw new ConflictError('Mission resume identity is bound to another queue payload')
    }
    return
  }
  const message: OutboxMessage = {
    id: ids.next('outbox'),
    organizationId: mission.organizationId,
    topic: 'mission.resume',
    deduplicationKey,
    payload,
    status: 'pending',
    availableAt: mission.updatedAt,
    createdAt: mission.updatedAt,
    claimedBy: null,
    claimExpiresAt: null,
    dispatchedAt: null,
    deliveryAttempts: 0,
    lastErrorCode: null,
  }
  await repositories.outbox.insert(message)
}

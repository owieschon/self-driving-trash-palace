import type {
  EvidenceCaptureResult,
  FrozenApplicationProductEvidenceEnvelope,
} from '@trash-palace/observability'

import { SYSTEM_CLOCK } from './primitives.js'
import type { ClockPort, SystemProductEvidenceDeliveryPort } from './ports.js'

export interface FrozenProductEvidenceCapturePort {
  captureFrozen(envelope: FrozenApplicationProductEvidenceEnvelope): Promise<EvidenceCaptureResult>
}

/** Worker-owned projector for immutable product evidence. Sink failure leaves the row pending. */
export class ProductEvidenceProjector {
  public constructor(
    private readonly deliveries: SystemProductEvidenceDeliveryPort,
    private readonly capture: FrozenProductEvidenceCapturePort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
  ) {}

  public async deliverPending(limit: number): Promise<number> {
    const pending = await this.deliveries.listPending(limit)
    for (const delivery of pending) {
      const result = await this.capture.captureFrozen(delivery.envelope)
      if (result.insertId !== delivery.envelope.event.insertId) {
        throw new Error('Evidence sink acknowledged another immutable insert identity')
      }
      await this.deliveries.acknowledge({
        logicalEventId: delivery.envelope.logicalEventId,
        eventHash: delivery.envelope.eventHash,
        captureStatus: result.status,
        deliveredAt: this.clock.now().toISOString(),
      })
    }
    return pending.length
  }
}

import {
  AnalyticsAliaser,
  InMemoryEvidenceSink,
  SafeApplicationEvidenceAdapter,
} from '@trash-palace/observability'
import {
  EventIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  UserIdSchema,
} from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

import type { ProductEvidenceDelivery } from '../product-evidence.js'
import { ProductEvidenceProjector } from '../product-evidence-projector.js'
import type { SystemProductEvidenceDeliveryPort } from '../ports.js'

function fixture() {
  const organizationId = OrganizationIdSchema.parse('org_productprojector')
  const adapter = new SafeApplicationEvidenceAdapter({
    sink: new InMemoryEvidenceSink(),
    aliaser: new AnalyticsAliaser('product-projector-test-key-is-at-least-32-bytes'),
    environment: 'test',
    dataOrigin: 'fixture',
    appVersion: '0.0.0-test',
  })
  const envelope = adapter.freezeProduct({
    event: 'mission created',
    logicalEventId: EventIdSchema.parse('evt_product_projector_01'),
    occurredAt: '2026-07-15T04:00:00.000Z',
    correlation: {
      distinctId: UserIdSchema.parse('usr_productprojector'),
      organizationId,
      palaceId: PalaceIdSchema.parse('pal_productprojector'),
      missionId: MissionIdSchema.parse('mis_productprojector'),
    },
    properties: { source_surface: 'fixture', objective_class: 'homecoming_routine' },
  })
  const delivery: ProductEvidenceDelivery = {
    organizationId,
    envelope,
    status: 'pending',
    createdAt: '2026-07-15T04:00:00.000Z',
    deliveredAt: null,
    captureStatus: null,
  }
  return { adapter, delivery }
}

describe('product evidence projector', () => {
  it('acknowledges the exact frozen event hash after a successful capture', async () => {
    const { adapter, delivery } = fixture()
    const acknowledge = vi.fn(async () => 'acknowledged' as const)
    const deliveries: SystemProductEvidenceDeliveryPort = {
      listPending: async () => [delivery],
      acknowledge,
    }
    const projector = new ProductEvidenceProjector(deliveries, adapter, {
      now: () => new Date('2026-07-15T04:00:01.000Z'),
    })

    await expect(projector.deliverPending(100)).resolves.toBe(1)
    expect(acknowledge).toHaveBeenCalledWith({
      logicalEventId: delivery.envelope.logicalEventId,
      eventHash: delivery.envelope.eventHash,
      captureStatus: 'stored',
      deliveredAt: '2026-07-15T04:00:01.000Z',
    })
  })

  it('leaves delivery pending when the sink fails before acknowledgement', async () => {
    const { delivery } = fixture()
    const acknowledge = vi.fn(async () => 'acknowledged' as const)
    const deliveries: SystemProductEvidenceDeliveryPort = {
      listPending: async () => [delivery],
      acknowledge,
    }
    const projector = new ProductEvidenceProjector(deliveries, {
      captureFrozen: async () => {
        throw new Error('simulated sink failure')
      },
    })

    await expect(projector.deliverPending(100)).rejects.toThrow('simulated sink failure')
    expect(acknowledge).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'

import { NIGHT_SHIFT_HOMECOMING_FIXTURE } from '../../../evals/fixtures/night-shift-homecoming.js'
import {
  CANONICAL_GATEWAY_FIXTURE,
  createCanonicalGatewayDeviceRuntime,
} from './canonical-fixture.js'

describe('canonical gateway fixture', () => {
  it('is a deterministic device projection of the flagship evaluation fixture', () => {
    const flagship = NIGHT_SHIFT_HOMECOMING_FIXTURE
    expect(CANONICAL_GATEWAY_FIXTURE).toMatchObject({
      organizationId: flagship.primaryTenant.organization.id,
      palaceId: flagship.primaryTenant.palace.id,
      startsAt: flagship.clock.startsAt,
      virtualMinuteMilliseconds: flagship.clock.virtualMinuteMilliseconds,
      batteryAvailablePercentage: flagship.primaryTenant.palace.batteryAvailablePercentage,
      devices: flagship.primaryTenant.devices,
      identityTags: flagship.primaryTenant.identityTags,
    })

    const first = createCanonicalGatewayDeviceRuntime()
    const second = createCanonicalGatewayDeviceRuntime()
    expect(first.clock.now).toBe(second.clock.now)
    expect(first.deviceModel.snapshot(first.clock.now)).toEqual(
      second.deviceModel.snapshot(second.clock.now),
    )
  })
})

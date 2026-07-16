import {
  DeviceSchema,
  IdentityTagSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
} from '@trash-palace/core'
import { DeterministicDeviceModel, VirtualClock } from '@trash-palace/testkit'

export const CANONICAL_GATEWAY_FIXTURE = Object.freeze({
  schemaVersion: 'gateway-canonical-fixture@1' as const,
  organizationId: OrganizationIdSchema.parse('org_rocky_roost'),
  palaceId: PalaceIdSchema.parse('pal_sacred_dumpster'),
  startsAt: '2026-08-14T01:35:00-04:00',
  virtualMinuteMilliseconds: 250,
  batteryAvailablePercentage: 62,
  initialTemperatureCelsius: 18,
  devices: Object.freeze(
    [
      {
        id: 'dev_front_lock',
        organizationId: 'org_rocky_roost',
        palaceId: 'pal_sacred_dumpster',
        kind: 'lock',
        name: 'Front hatch lock',
        health: 'online',
        version: 9,
      },
      {
        id: 'dev_path_lights',
        organizationId: 'org_rocky_roost',
        palaceId: 'pal_sacred_dumpster',
        kind: 'pathway_light',
        name: 'Moonlit pathway lights',
        health: 'online',
        version: 7,
      },
      {
        id: 'dev_thermostat',
        organizationId: 'org_rocky_roost',
        palaceId: 'pal_sacred_dumpster',
        kind: 'thermostat',
        name: 'Nest thermostat',
        health: 'online',
        version: 12,
      },
      {
        id: 'dev_battery_meter',
        organizationId: 'org_rocky_roost',
        palaceId: 'pal_sacred_dumpster',
        kind: 'battery_meter',
        name: 'Battery meter',
        health: 'online',
        version: 5,
      },
    ].map((device) => DeviceSchema.parse(device)),
  ),
  identityTags: Object.freeze(
    [
      {
        id: 'tag_rocky_verified',
        organizationId: 'org_rocky_roost',
        crewMemberId: 'crew_rocky_founder',
        label: "Rocky's verified tag",
        verified: true,
        active: true,
        version: 4,
      },
      {
        id: 'tag_unknown_guest',
        organizationId: 'org_rocky_roost',
        crewMemberId: null,
        label: 'Unknown tag',
        verified: false,
        active: true,
        version: 1,
      },
    ].map((identityTag) => IdentityTagSchema.parse(identityTag)),
  ),
})

export interface CanonicalGatewayDeviceRuntime {
  readonly clock: VirtualClock
  readonly deviceModel: DeterministicDeviceModel
}

export function createCanonicalGatewayDeviceRuntime(): CanonicalGatewayDeviceRuntime {
  const fixture = CANONICAL_GATEWAY_FIXTURE
  const clock = new VirtualClock({
    startsAt: fixture.startsAt,
    virtualMinuteMilliseconds: fixture.virtualMinuteMilliseconds,
  })
  const deviceModel = new DeterministicDeviceModel({
    organizationId: fixture.organizationId,
    palaceId: fixture.palaceId,
    devices: [...fixture.devices],
    identityTags: [...fixture.identityTags],
    startsAt: fixture.startsAt,
    batteryAvailablePercentage: fixture.batteryAvailablePercentage,
    initialTemperatureCelsius: fixture.initialTemperatureCelsius,
  })
  return Object.freeze({ clock, deviceModel })
}

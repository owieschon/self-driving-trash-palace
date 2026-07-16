import {
  FLAGSHIP_CLOCK_PAUSED_AT,
  FLAGSHIP_UNVERIFIED_ARRIVAL_AT,
  FLAGSHIP_VERIFIED_ARRIVAL_AT,
  createGatewayCommand,
  type GatewayCommand,
  type SignedIdentityTelemetry,
} from '@trash-palace/core'
import { VirtualClock } from '@trash-palace/testkit'
import { describe, expect, it } from 'vitest'

import { CanonicalIdentityArrivalLane } from './identity-arrival-lane.js'
import type { IdentityArrivalLaneError } from './identity-arrival-lane.js'
import { BoundedIdentityTelemetryDelivery } from './identity-delivery.js'
import type { GatewayCommandAdmissionError } from './simulator.js'

const SIGNING_KEY = 'canonical-identity-arrival-test-key-at-least-32-bytes'
const WALL_NOW = '2026-07-15T12:34:56.000Z'

describe('canonical identity arrival lane', () => {
  it('delivers unverified then verified arrival using virtual observations and wall signatures', async () => {
    const posted: SignedIdentityTelemetry[] = []
    const fixture = createLane({
      onPost: (telemetry) => posted.push(telemetry),
    })
    fixture.lane.schedule()
    expect(fixture.clock.pendingTaskCount).toBe(2)
    await fixture.lane.start()
    fixture.lane.bind(command())

    fixture.clock.advanceTo(FLAGSHIP_VERIFIED_ARRIVAL_AT)
    await fixture.lane.drain(1_000)

    expect(posted.map((telemetry) => telemetry.event.identityTagId)).toEqual([
      'tag_unknown_guest',
      'tag_rocky_verified',
    ])
    expect(posted.map((telemetry) => telemetry.event.observedAt)).toEqual([
      new Date(FLAGSHIP_UNVERIFIED_ARRIVAL_AT).toISOString(),
      new Date(FLAGSHIP_VERIFIED_ARRIVAL_AT).toISOString(),
    ])
    expect(posted.map((telemetry) => telemetry.signature.timestamp)).toEqual([WALL_NOW, WALL_NOW])
    expect(new Set(posted.map((telemetry) => telemetry.event.providerEventId)).size).toBe(2)
    expect(posted.every((telemetry) => telemetry.event.missionId === 'mis_night_shift_home')).toBe(
      true,
    )
  })

  it('buffers the bounded fixture arrivals until a mission command binds context', async () => {
    const posted: SignedIdentityTelemetry[] = []
    const fixture = createLane({ onPost: (telemetry) => posted.push(telemetry) })
    fixture.lane.schedule()
    await fixture.lane.start()

    fixture.clock.advanceTo(FLAGSHIP_VERIFIED_ARRIVAL_AT)
    expect(posted).toHaveLength(0)
    expect(fixture.lane.isReady).toBe(true)

    fixture.lane.bind(command())
    await fixture.lane.drain(1_000)

    expect(posted.map((telemetry) => telemetry.event.identityTagId)).toEqual([
      'tag_unknown_guest',
      'tag_rocky_verified',
    ])
    expect(
      posted.every(
        (telemetry) =>
          telemetry.event.observedAt === new Date(FLAGSHIP_VERIFIED_ARRIVAL_AT).toISOString(),
      ),
    ).toBe(true)
  })

  it('accepts same-context commands but rejects and retains a conflicting mission binding', async () => {
    const fixture = createLane()
    fixture.lane.schedule()
    await fixture.lane.start()
    fixture.lane.bind(command())
    fixture.lane.bind(command('mis_night_shift_home', 'second-command'))

    expect(() => fixture.lane.bind(command('mis_different_home', 'conflict'))).toThrow(
      expect.objectContaining<Partial<GatewayCommandAdmissionError>>({
        code: 'IDENTITY_MISSION_BINDING_CONFLICT',
      }),
    )
    expect(fixture.lane.binding).toEqual({
      organizationId: 'org_rocky_roost',
      missionId: 'mis_night_shift_home',
      palaceId: 'pal_sacred_dumpster',
    })
    expect(fixture.lane.isReady).toBe(false)
    await expect(fixture.lane.drain(1_000)).rejects.toMatchObject<IdentityArrivalLaneError>({
      code: 'IDENTITY_MISSION_BINDING_CONFLICT',
    })
  })
})

function createLane(
  options: { readonly onPost?: (telemetry: SignedIdentityTelemetry) => void } = {},
) {
  const clock = new VirtualClock({
    startsAt: FLAGSHIP_CLOCK_PAUSED_AT,
    virtualMinuteMilliseconds: 250,
  })
  const delivery = new BoundedIdentityTelemetryDelivery(
    {
      telemetryUrl: 'http://web.test/api/internal/v1/identity/telemetry',
      readinessUrl: 'http://web.test/api/v1/ready',
      maximumAttempts: 2,
      initialBackoffMilliseconds: 1,
      maximumBackoffMilliseconds: 2,
      requestTimeoutMilliseconds: 1_000,
      readinessIntervalMilliseconds: 60_000,
      maximumTrackedEvents: 2,
    },
    {
      fetch: async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.endsWith('/ready')) return new Response(null, { status: 200 })
        if (typeof init?.body !== 'string') throw new TypeError('Expected telemetry body')
        options.onPost?.(JSON.parse(init.body) as SignedIdentityTelemetry)
        return new Response(null, { status: 202 })
      },
      sleep: () => Promise.resolve(),
    },
  )
  return {
    clock,
    lane: new CanonicalIdentityArrivalLane({
      clock,
      delivery,
      signingKeyId: 'itk_arrival_lane_test',
      signingKey: SIGNING_KEY,
      wallClock: { now: () => new Date(WALL_NOW) },
    }),
  }
}

function command(
  missionId = 'mis_night_shift_home',
  logicalKey = 'identity-arrival-binding',
): GatewayCommand {
  return createGatewayCommand({
    organizationId: 'org_rocky_roost',
    missionId,
    palaceId: 'pal_sacred_dumpster',
    operationId: 'op_identity_arrival_binding',
    logicalKey,
    kind: 'set_lighting',
    payload: {
      deviceId: 'dev_path_lights',
      intensityPercent: 40,
      durationSeconds: 900,
      causedByEvidenceId: 'evd_identity_arrival_binding',
    },
    createdAt: new Date(FLAGSHIP_CLOCK_PAUSED_AT).toISOString(),
  })
}

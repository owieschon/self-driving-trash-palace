import {
  CrewMemberSchema,
  CrewPreferenceSchema,
  CrewScheduleSchema,
  PalaceIdSchema,
} from '@trash-palace/core'
import { AnalyticsAliaser, SafeApplicationEvidenceAdapter } from '@trash-palace/observability'
import { describe, expect, it } from 'vitest'

import { MissionBootstrapService } from '../mission-bootstrap-service.js'
import {
  HomecomingPlanningEvidenceProjector,
  ReferenceHomecomingBatteryForecast,
} from '../homecoming-planning-evidence.js'
import type { SensitiveMutationGuardPort } from '../ports.js'
import { InMemoryApplicationStore, MutableClock, SequentialIdGenerator } from '../testing/fakes.js'
import { IDS, authContext, makePalace } from './fixtures.js'

const allowMutation: SensitiveMutationGuardPort = { assert: () => undefined }
const request = {
  requestId: 'homecoming_2026_08_14',
  palaceId: IDS.palace,
  objective: 'Create a safe and energy-bounded night-shift homecoming routine.',
  constraints: {
    preheatBy: '02:00',
    requireVerifiedIdentityForUnlock: true as const,
    pathwayLightingBeginsAfter: 'verified_arrival' as const,
    projectedBatteryUseMaxPercentagePoints: 15,
  },
  successCriteriaIds: ['temperature_ready', 'identity_verified', 'lock_restored'],
  csrfToken: authContext.csrfToken,
  origin: 'http://trash-palace.test',
  allowedOrigin: 'http://trash-palace.test',
} as const

describe('MissionBootstrapService', () => {
  it('creates one queued mission and its initial resume atomically, then replays it', async () => {
    const store = new InMemoryApplicationStore({ palaces: [makePalace()] })
    const service = new MissionBootstrapService(
      store,
      allowMutation,
      new SequentialIdGenerator(),
      new MutableClock(new Date('2026-08-14T05:00:00.000Z')),
    )

    const created = await service.create({ context: authContext, ...request })
    const replayed = await service.create({ context: authContext, ...request })

    expect(created).toMatchObject({
      kind: 'created',
      mission: { state: { status: 'queued', phase: 'understand' }, version: 0 },
    })
    expect(replayed).toEqual({ kind: 'replayed', mission: created.mission })
    const snapshot = await store.snapshot()
    expect(snapshot.missions).toEqual([created.mission])
    expect(snapshot.outbox).toEqual([
      expect.objectContaining({
        topic: 'mission.resume',
        deduplicationKey: `mission.resume:${created.mission.id}:0`,
        payload: {
          organizationId: authContext.principal.organizationId,
          missionId: created.mission.id,
        },
      }),
    ])
  })

  it('freezes one registry-valid event in the mission and resume transaction', async () => {
    const store = new InMemoryApplicationStore({ palaces: [makePalace()] })
    const adapter = new SafeApplicationEvidenceAdapter({
      aliaser: new AnalyticsAliaser('mission-evidence-test-key-at-least-32-bytes'),
      environment: 'test',
      dataOrigin: 'fixture',
      appVersion: 'mission-evidence-test',
    })
    const service = new MissionBootstrapService(
      store,
      allowMutation,
      new SequentialIdGenerator(),
      new MutableClock(new Date('2026-08-14T05:00:00.000Z')),
      adapter,
    )

    const created = await service.create({ context: authContext, ...request })
    await service.create({ context: authContext, ...request })

    const snapshot = await store.snapshot()
    expect(snapshot.productEvidenceDeliveries).toHaveLength(1)
    const event = snapshot.productEvidenceDeliveries[0]?.envelope.event
    expect(event).toMatchObject({
      event: 'mission created',
      occurredAt: created.mission.createdAt,
      properties: {
        source_surface: 'api',
        objective_class: 'homecoming_routine',
      },
    })
    expect(JSON.stringify(event)).not.toContain(created.mission.id)
    expect(JSON.stringify(event)).not.toContain(created.mission.initiatedBy)
  })

  it('persists application-owned planning forecasts before the first resume', async () => {
    const crewMemberId = 'crew_rocky_forecast'
    const store = new InMemoryApplicationStore({
      palaces: [makePalace()],
      crewMembers: [
        CrewMemberSchema.parse({
          id: crewMemberId,
          organizationId: IDS.organization,
          palaceId: IDS.palace,
          userId: IDS.owner,
          displayName: 'Rocky',
          active: true,
        }),
      ],
      crewSchedules: [
        CrewScheduleSchema.parse({
          id: 'sch_rocky_forecast',
          organizationId: IDS.organization,
          palaceId: IDS.palace,
          crewMemberId,
          active: true,
          version: 1,
          timezone: 'America/New_York',
          windowStart: '00:00',
          windowEnd: '03:00',
        }),
      ],
      crewPreferences: [
        CrewPreferenceSchema.parse({
          id: 'pref_rocky_forecast',
          organizationId: IDS.organization,
          palaceId: IDS.palace,
          crewMemberId,
          kind: 'homecoming_comfort',
          active: true,
          version: 1,
          targetCelsius: 22,
          pathwayLightingIntensityPercent: 60,
          pathwayLightingDurationSeconds: 1_800,
        }),
      ],
    })
    const service = new MissionBootstrapService(
      store,
      allowMutation,
      new SequentialIdGenerator(),
      new MutableClock(new Date('2026-08-14T05:00:00.000Z')),
      undefined,
      new HomecomingPlanningEvidenceProjector(new ReferenceHomecomingBatteryForecast(), {
        targetCelsius: 20,
        pathwayLightingIntensityPercent: 40,
        pathwayLightingDurationSeconds: 900,
      }),
    )

    const created = await service.create({ context: authContext, ...request })
    await service.create({ context: authContext, ...request })

    const evidence = (await store.snapshot()).evidence
    expect(evidence).toHaveLength(2)
    expect(evidence.map((record) => record.evidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          missionId: created.mission.id,
          projectedUsePercentagePoints: 18.4,
        }),
        expect.objectContaining({
          missionId: created.mission.id,
          projectedUsePercentagePoints: 13.2,
        }),
      ]),
    )
    expect(
      evidence
        .map((record) => record.authorityReceipt)
        .filter((receipt) => receipt.authority === 'application')
        .map((receipt) => receipt.ruleId)
        .sort(),
    ).toEqual(['homecoming.energy-first-projection', 'homecoming.preference-energy-projection'])
  })

  it('rejects reused request identities with changed content and unknown palaces', async () => {
    const store = new InMemoryApplicationStore({ palaces: [makePalace()] })
    const service = new MissionBootstrapService(
      store,
      allowMutation,
      new SequentialIdGenerator(),
      new MutableClock(new Date('2026-08-14T05:00:00.000Z')),
    )
    await service.create({ context: authContext, ...request })

    await expect(
      service.create({ context: authContext, ...request, objective: 'Changed objective' }),
    ).rejects.toThrow(/reused with different content/)
    await expect(
      service.create({
        context: authContext,
        ...request,
        requestId: 'unknown_palace_request',
        palaceId: PalaceIdSchema.parse('pal_unknown_0001'),
      }),
    ).rejects.toThrow(/Palace was not found/)
    expect((await store.snapshot()).missions).toHaveLength(1)
  })
})

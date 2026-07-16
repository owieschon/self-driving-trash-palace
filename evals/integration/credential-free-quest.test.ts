import { describe, expect, it, vi } from 'vitest'

import {
  EventIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  UserIdSchema,
} from '../../packages/core/src/index.js'
import {
  AnalyticsAliaser,
  SafeApplicationEvidenceAdapter,
} from '../../packages/observability/src/index.js'
import {
  SameOriginBrowser,
  summarizeMissionEvidence,
  type MissionEvidenceSnapshot,
} from './credential-free-quest.js'

const ORIGIN = 'http://127.0.0.1:3300'

describe('credential-free Quest browser boundary', () => {
  it('retains the session cookie for same-origin browser calls but not bearer calls', async () => {
    const requests: Request[] = []
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const received = new Request(input, init)
      requests.push(received)
      return new Response('{}', {
        status: 200,
        headers:
          requests.length === 1
            ? {
                'content-type': 'application/json',
                'set-cookie':
                  '__Host-trash_palace_session=signed.local.session; Path=/; Secure; HttpOnly; SameSite=Strict',
              }
            : { 'content-type': 'application/json' },
      })
    })
    const browser = new SameOriginBrowser(ORIGIN, request)

    await browser.fetch(`${ORIGIN}/api/v1/auth/dev-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    await browser.fetch(`${ORIGIN}/api/v1/missions/example/tasks`)
    await browser.fetch(`${ORIGIN}/api/v1/tools/knowledge.search`, {
      method: 'POST',
      headers: { authorization: 'Bearer delegated-token-value' },
      body: '{}',
    })

    expect(requests[0]?.headers.get('origin')).toBe(ORIGIN)
    expect(requests[0]?.headers.has('cookie')).toBe(false)
    expect(requests[1]?.headers.get('cookie')).toBe(
      '__Host-trash_palace_session=signed.local.session',
    )
    expect(requests[1]?.headers.has('origin')).toBe(false)
    expect(requests[2]?.headers.has('cookie')).toBe(false)
    expect(requests[2]?.headers.get('origin')).toBe(ORIGIN)
  })
})

describe('credential-free Quest evidence boundary', () => {
  it('excludes valid stale evidence and reconciles the current mission with its durable outbox', () => {
    const current = frozenMissionCreated('current', 'mis_questevidencecurrent')
    const stale = frozenMissionCreated('stale', 'mis_questevidencestale')
    const snapshot = snapshotFor(current)

    const result = summarizeMissionEvidence(
      `${stale.eventSerialized}\n${current.eventSerialized}\n`,
      snapshot,
      ['mission created'],
    )

    expect(result).toMatchObject({
      missionScoped: true,
      eventCount: 1,
      outboxDeliveryCount: 1,
      allOutboxDeliveriesAcknowledged: true,
      requiredLifecycleEventsPresent: true,
    })
    expect(result.eventNames).toEqual(['mission created'])
  })

  it('rejects an unacknowledged delivery and a duplicate sink record', () => {
    const current = frozenMissionCreated('pending', 'mis_questevidencepending')
    const snapshot = snapshotFor(current)

    expect(() =>
      summarizeMissionEvidence(
        `${current.eventSerialized}\n`,
        {
          ...snapshot,
          deliveries: [{ ...snapshot.deliveries[0]!, status: 'pending' }],
        },
        ['mission created'],
      ),
    ).toThrow('unacknowledged outbox delivery')
    expect(() =>
      summarizeMissionEvidence(
        `${current.eventSerialized}\n${current.eventSerialized}\n`,
        snapshot,
        ['mission created'],
      ),
    ).toThrow('absent or duplicated')
  })
})

function frozenMissionCreated(label: string, missionId: string) {
  return new SafeApplicationEvidenceAdapter({
    aliaser: new AnalyticsAliaser('quest-evidence-test-alias-key-is-at-least-32-bytes'),
    environment: 'test',
    dataOrigin: 'fixture',
    appVersion: 'quest-test',
  }).freezeProduct({
    event: 'mission created',
    logicalEventId: EventIdSchema.parse(`evt_application_${label.padEnd(32, '0')}`),
    occurredAt: '2026-07-15T12:00:00.000Z',
    correlation: {
      distinctId: UserIdSchema.parse('usr_questevidence'),
      actorId: UserIdSchema.parse('usr_questevidence'),
      organizationId: OrganizationIdSchema.parse('org_questevidence'),
      palaceId: PalaceIdSchema.parse('pal_questevidence'),
      missionId: MissionIdSchema.parse(missionId),
    },
    properties: {
      source_surface: 'fixture',
      objective_class: 'homecoming_routine',
    },
  })
}

function snapshotFor(frozen: ReturnType<typeof frozenMissionCreated>): MissionEvidenceSnapshot {
  const properties = frozen.event.properties as Readonly<Record<string, unknown>>
  if (typeof properties.mission_alias !== 'string') throw new Error('Mission alias is absent')
  return {
    missionAlias: properties.mission_alias,
    deliveries: [
      {
        eventHash: frozen.eventHash,
        eventName: frozen.event.event,
        eventSerialized: frozen.eventSerialized,
        status: 'delivered',
      },
    ],
  }
}

import { describe, expect, it } from 'vitest'

import {
  EventIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  RunIdSchema,
  UserIdSchema,
} from '../../packages/core/src/index.js'
import {
  AnalyticsAliaser,
  correlationProperties,
  createAnalyticsCorrelation,
  createProductEvidenceEvent,
} from '../../packages/observability/src/index.js'
import { rebaseFixtureTimestamps } from './posthog-product-path-cli.js'

describe('product-path PostHog projection', () => {
  it('rebases fixture time in causal order and assigns deterministic fresh insert IDs', () => {
    const later = event(
      'evt_later',
      'tpi_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '2030-01-02T00:00:00.000Z',
    )
    const earlier = event(
      'evt_earlier',
      'tpi_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '2030-01-01T00:00:00.000Z',
    )

    const projected = rebaseFixtureTimestamps(
      [later, earlier],
      new Date('2026-07-16T03:30:00.000Z'),
    )

    expect(projected.map((entry) => entry.occurredAt)).toEqual([
      '2026-07-16T03:30:00.000Z',
      '2026-07-16T03:30:00.001Z',
    ])
    expect(projected[0]?.event).toBe('mission created')
    expect(projected[0]?.insertId).not.toBe(earlier.insertId)
    expect(
      rebaseFixtureTimestamps([earlier], new Date('2026-07-16T03:30:00.000Z'))[0]?.insertId,
    ).toBe(projected[0]?.insertId)
  })
})

function event(id: string, _insertId: string, occurredAt: string) {
  const aliaser = new AnalyticsAliaser('product-path-projection-test-key-0001')
  const correlation = createAnalyticsCorrelation(aliaser, {
    distinctId: UserIdSchema.parse(`usr_${id}`),
    organizationId: OrganizationIdSchema.parse('org_projectiontest01'),
    palaceId: PalaceIdSchema.parse('pal_projectiontest01'),
    missionId: MissionIdSchema.parse(`mis_${id}`),
    runId: RunIdSchema.parse(`run_${id}`),
  })
  return createProductEvidenceEvent({
    event: 'mission created',
    insertId: aliaser.insertId('mission created', EventIdSchema.parse(`evt_${id}`)),
    occurredAt,
    distinctId: correlation.distinctAlias,
    properties: {
      schema_version: '1',
      environment: 'evaluation',
      data_origin: 'evaluation',
      privacy_classification: 'analytics_safe',
      app_version: '0.0.0',
      ...correlationProperties(correlation),
      mission_alias: correlation.missionAlias!,
      source_surface: 'fixture',
      objective_class: 'scheduled_hauler_access',
    },
  })
}

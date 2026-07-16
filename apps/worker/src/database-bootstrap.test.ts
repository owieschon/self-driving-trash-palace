import { describe, expect, it } from 'vitest'

import type { NightShiftHomecomingFixture } from '@trash-palace/core'

import { CANONICAL_LOCAL_SEED } from './canonical-seed.js'
import {
  CanonicalSeedConflictError,
  canonicalSeedInventory,
  planCanonicalSeed,
} from './database-bootstrap.js'

describe('canonical local database seed', () => {
  it('is an exact pre-mission projection of the canonical evaluation fixture', async () => {
    const fixture = await loadCanonicalFixture()
    expect(CANONICAL_LOCAL_SEED.primary).toMatchObject({
      organization: fixture.primaryTenant.organization,
      user: fixture.primaryTenant.user,
      membership: fixture.primaryTenant.membership,
      palace: fixture.primaryTenant.palace,
      crewMember: fixture.primaryTenant.crewMember,
      schedules: fixture.primaryTenant.schedules,
      preferences: fixture.primaryTenant.preferences,
      identityTags: CANONICAL_LOCAL_SEED.primary.identityTags,
      devices: CANONICAL_LOCAL_SEED.primary.devices,
      capabilities: CANONICAL_LOCAL_SEED.primary.capabilities,
      routine: fixture.primaryTenant.existingRoutine,
      routineVersion: fixture.primaryTenant.existingRoutineVersion,
    })
    expect(CANONICAL_LOCAL_SEED.mirror).toEqual({
      organization: fixture.mirrorTenant.organization,
      user: fixture.mirrorTenant.user,
      membership: fixture.mirrorTenant.membership,
      palace: fixture.mirrorTenant.palace,
      routine: fixture.mirrorTenant.similarRoutine,
      routineVersion: fixture.mirrorTenant.similarRoutineVersion,
    })
    expect(CANONICAL_LOCAL_SEED.serviceActor).toEqual({
      user: {
        id: 'usr_caretaker_service',
        displayName: 'Caretaker service',
        createdAt: '2026-08-01T12:00:00-04:00',
      },
      memberships: [
        {
          id: 'mem_caretaker_rocky',
          organizationId: 'org_rocky_roost',
          userId: 'usr_caretaker_service',
          role: 'operator',
          grants: [],
          createdAt: '2026-08-01T12:00:00-04:00',
          revokedAt: null,
        },
        {
          id: 'mem_caretaker_mirror',
          organizationId: 'org_mirror_nest',
          userId: 'usr_caretaker_service',
          role: 'operator',
          grants: [],
          createdAt: '2026-08-01T12:00:00-04:00',
          revokedAt: null,
        },
      ],
    })
  })

  it('seeds a distinct tenant-scoped service identity instead of attributing agent work to a human', () => {
    const inventory = canonicalSeedInventory()
    const serviceUser = inventory.filter(
      (record) => record.table === 'users' && record.id === 'usr_caretaker_service',
    )
    const serviceMemberships = inventory.filter(
      (record) => record.table === 'memberships' && record.value.userId === 'usr_caretaker_service',
    )

    expect(serviceUser).toHaveLength(1)
    expect(serviceMemberships.map((record) => record.value.organizationId).sort()).toEqual([
      'org_mirror_nest',
      'org_rocky_roost',
    ])
    expect(serviceMemberships.every((record) => record.value.role === 'operator')).toBe(true)
  })

  it('plans every record once and no records on an identical replay', () => {
    const inventory = canonicalSeedInventory()
    const first = planCanonicalSeed(new Map())
    expect(first.insertedRecordCount).toBe(inventory.length)

    const stored = new Map(inventory.map((record) => [record.key, record.value] as const))
    expect(planCanonicalSeed(stored).insertedRecordCount).toBe(0)
  })

  it('normalizes persisted timestamp values while checking exact seed content', () => {
    const inventory = canonicalSeedInventory()
    const stored = new Map(
      inventory.map((record) => {
        const createdAt = record.value.createdAt
        const value =
          typeof createdAt === 'string'
            ? { ...record.value, createdAt: new Date(createdAt) }
            : record.value
        return [record.key, value] as const
      }),
    )
    expect(planCanonicalSeed(stored).insertedRecordCount).toBe(0)
  })

  it('refuses content drift instead of overwriting a local operator change', () => {
    const inventory = canonicalSeedInventory()
    const stored = new Map(inventory.map((record) => [record.key, record.value] as const))
    const mirror = inventory.find((record) => record.id === 'org_mirror_nest')
    expect(mirror).toBeDefined()
    stored.set(mirror!.key, { ...mirror!.value, name: 'A different tenant' })

    expect(() => planCanonicalSeed(stored)).toThrow(CanonicalSeedConflictError)
  })

  it('refuses a partly persisted routine pair', () => {
    const inventory = canonicalSeedInventory()
    const stored = new Map(inventory.map((record) => [record.key, record.value] as const))
    stored.delete('routine_versions:rtv_mirror_homecoming_v1')

    expect(() => planCanonicalSeed(stored)).toThrow('only partly stored')
  })

  it('keeps every tenant-owned mirror record outside the primary tenant', () => {
    const inventory = canonicalSeedInventory()
    const primaryIds = new Set(
      inventory
        .filter((record) => record.value.organizationId === 'org_rocky_roost')
        .map((record) => record.id),
    )
    const mirrorRecords = inventory.filter(
      (record) => record.value.organizationId === 'org_mirror_nest',
    )

    expect(mirrorRecords.length).toBeGreaterThan(0)
    expect(mirrorRecords.every((record) => !primaryIds.has(record.id))).toBe(true)
    expect(mirrorRecords.every((record) => record.value.organizationId === 'org_mirror_nest')).toBe(
      true,
    )
  })
})

async function loadCanonicalFixture(): Promise<NightShiftHomecomingFixture> {
  const fixtureUrl = new URL('../../../evals/fixtures/night-shift-homecoming.ts', import.meta.url)
  const module = (await import(fixtureUrl.href)) as Readonly<{
    NIGHT_SHIFT_HOMECOMING_FIXTURE: NightShiftHomecomingFixture
  }>
  return module.NIGHT_SHIFT_HOMECOMING_FIXTURE
}

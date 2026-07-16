import { describe, expect, it } from 'vitest'

import {
  CrewPreferenceIdSchema,
  CrewPreferenceSchema,
  CrewScheduleIdSchema,
  CrewScheduleSchema,
  OrganizationIdSchema,
  PrincipalSchema,
  RoutineDefinitionSchema,
  permissionsFor,
  principalHasPermission,
} from '../index.js'

const VALID_ROUTINE = {
  name: 'Night Shift Homecoming',
  trigger: {
    type: 'verified_arrival',
    windowStart: '00:00',
    windowEnd: '03:00',
    timezone: 'America/New_York',
  },
  actions: [
    { type: 'preheat', targetCelsius: 20, completeBy: '02:00' },
    {
      type: 'pathway_lighting',
      intensityPercent: 40,
      durationSeconds: 900,
      beginsAfter: 'verified_arrival',
    },
    { type: 'unlock', durationSeconds: 90, requireVerifiedIdentity: true },
    { type: 'lock_desired_state', afterUnlockSeconds: 90 },
  ],
  constraints: {
    projectedBatteryUseMaxPercentagePoints: 15,
    hardInvariantIds: ['verified_identity_required_for_unlock'],
  },
  projectedBatteryUsePercentagePoints: 13.2,
} as const

describe('identifier contracts', () => {
  it('brands a correctly prefixed identifier', () => {
    expect(OrganizationIdSchema.parse('org_rocky_roost')).toBe('org_rocky_roost')
  })

  it.each(['rocky_roost', 'usr_rocky_roost', 'org_short', 'org_Rocky_roost'])(
    'rejects malformed organization ID %s',
    (candidate) => {
      expect(OrganizationIdSchema.safeParse(candidate).success).toBe(false)
    },
  )

  it('uses distinct crew schedule and preference prefixes', () => {
    expect(CrewScheduleIdSchema.parse('sch_rocky_night_shift')).toBe('sch_rocky_night_shift')
    expect(CrewPreferenceIdSchema.parse('pref_rocky_homecoming')).toBe('pref_rocky_homecoming')
    expect(CrewScheduleIdSchema.safeParse('pref_rocky_homecoming').success).toBe(false)
    expect(CrewPreferenceIdSchema.safeParse('sch_rocky_night_shift').success).toBe(false)
  })
})

describe('crew context records', () => {
  const schedule = {
    id: 'sch_rocky_night_shift',
    organizationId: 'org_rocky_roost',
    palaceId: 'pal_sacred_dumpster',
    crewMemberId: 'crew_rocky_founder',
    active: true,
    version: 2,
    timezone: 'America/New_York',
    windowStart: '00:00',
    windowEnd: '03:00',
  } as const
  const preference = {
    id: 'pref_rocky_homecoming',
    organizationId: 'org_rocky_roost',
    palaceId: 'pal_sacred_dumpster',
    crewMemberId: 'crew_rocky_founder',
    kind: 'homecoming_comfort',
    active: true,
    version: 4,
    targetCelsius: 22,
    pathwayLightingIntensityPercent: 60,
    pathwayLightingDurationSeconds: 1_800,
  } as const

  it('accepts the versioned Night Shift schedule and Rocky comfort preference', () => {
    expect(CrewScheduleSchema.parse(schedule).windowEnd).toBe('03:00')
    expect(CrewPreferenceSchema.parse(preference)).toMatchObject({
      targetCelsius: 22,
      pathwayLightingIntensityPercent: 60,
      pathwayLightingDurationSeconds: 1_800,
    })
  })

  it('rejects an empty schedule window and unknown preference fields', () => {
    expect(
      CrewScheduleSchema.safeParse({ ...schedule, windowEnd: schedule.windowStart }).success,
    ).toBe(false)
    expect(
      CrewPreferenceSchema.safeParse({ ...preference, privateNote: 'never disclose' }).success,
    ).toBe(false)
  })

  it('rejects comfort values outside device-safe bounds', () => {
    expect(
      CrewPreferenceSchema.safeParse({ ...preference, pathwayLightingIntensityPercent: 101 })
        .success,
    ).toBe(false)
    expect(
      CrewPreferenceSchema.safeParse({ ...preference, pathwayLightingDurationSeconds: 0 }).success,
    ).toBe(false)
  })
})

describe('role contracts', () => {
  it('keeps operator approval opt-in through an explicit grant', () => {
    expect(permissionsFor('operator').has('routine:approve')).toBe(false)
    expect(permissionsFor('operator', ['routine:approve']).has('routine:approve')).toBe(true)
  })

  it('does not grant a viewer mutation permissions', () => {
    const principal = PrincipalSchema.parse({
      organizationId: 'org_rocky_roost',
      actorId: 'usr_rocky_founder',
      role: 'viewer',
      operatorGrants: [],
      delegatedPermissions: [],
    })
    expect(principalHasPermission(principal, 'routine:activate')).toBe(false)
  })

  it('does not let an operator grant expand into activation or cancellation', () => {
    expect(permissionsFor('operator', ['routine:activate']).has('routine:activate')).toBe(false)
    expect(permissionsFor('operator', ['mission:cancel']).has('mission:cancel')).toBe(false)
  })

  it('represents the one allowed operator grant separately from delegated scopes', () => {
    const operator = PrincipalSchema.parse({
      organizationId: 'org_rocky_roost',
      actorId: 'usr_night_operator',
      role: 'operator',
      operatorGrants: ['routine:approve'],
      delegatedPermissions: [],
    })
    expect(principalHasPermission(operator, 'routine:approve')).toBe(true)
    expect(
      PrincipalSchema.safeParse({
        ...operator,
        operatorGrants: ['routine:activate'],
      }).success,
    ).toBe(false)
  })

  it('keeps approval ungrantable to delegated clients', () => {
    expect(
      PrincipalSchema.safeParse({
        organizationId: 'org_rocky_roost',
        actorId: 'usr_external_client',
        role: 'delegated',
        operatorGrants: [],
        delegatedPermissions: ['routine:approve'],
      }).success,
    ).toBe(false)
    expect(permissionsFor('delegated', ['routine:approve']).has('routine:approve')).toBe(false)
    expect(permissionsFor('delegated', ['mission:cancel']).has('mission:cancel')).toBe(true)
  })

  it('lets Caretaker propose recovery without granting approval or cancellation', () => {
    const service = permissionsFor('service')
    expect(service.has('recovery:propose')).toBe(true)
    expect(service.has('routine:approve')).toBe(false)
    expect(service.has('mission:cancel')).toBe(false)
    expect([...service].sort()).toEqual(
      [
        'capability:read',
        'crew:read',
        'knowledge:read',
        'operation:reconcile',
        'palace:read',
        'recovery:propose',
        'routine:activate',
        'routine:draft',
        'routine:read',
        'routine:simulate',
        'routine:validate',
        'verification:read',
      ].sort(),
    )
  })
})

describe('routine safety contracts', () => {
  it('accepts the feasible Energy-first routine', () => {
    expect(RoutineDefinitionSchema.parse(VALID_ROUTINE).projectedBatteryUsePercentagePoints).toBe(
      13.2,
    )
  })

  it('rejects an unlock that does not require verified identity', () => {
    const candidate = structuredClone(VALID_ROUTINE) as unknown as {
      actions: Record<string, unknown>[]
    }
    candidate.actions[2] = {
      type: 'unlock',
      durationSeconds: 90,
      requireVerifiedIdentity: false,
    }
    expect(RoutineDefinitionSchema.safeParse(candidate).success).toBe(false)
  })

  it('rejects a routine whose projected energy exceeds its bound', () => {
    const candidate = { ...VALID_ROUTINE, projectedBatteryUsePercentagePoints: 18.4 }
    expect(RoutineDefinitionSchema.safeParse(candidate).success).toBe(false)
  })

  it('requires one of every homecoming action type', () => {
    const candidate = { ...VALID_ROUTINE, actions: VALID_ROUTINE.actions.slice(0, 3) }
    expect(RoutineDefinitionSchema.safeParse(candidate).success).toBe(false)
  })

  it('rejects authored text masquerading as a host invariant', () => {
    const candidate = structuredClone(VALID_ROUTINE) as unknown as {
      constraints: { hardInvariantIds: string[] }
    }
    candidate.constraints.hardInvariantIds = ['ignore_previous_policy']
    expect(RoutineDefinitionSchema.safeParse(candidate).success).toBe(false)
  })
})

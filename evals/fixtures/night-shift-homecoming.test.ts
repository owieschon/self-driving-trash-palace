import { describe, expect, it } from 'vitest'

import { NightShiftHomecomingFixtureSchema } from '../../packages/core/src/index.js'
import { NIGHT_SHIFT_HOMECOMING_FIXTURE } from './night-shift-homecoming.js'

describe('night-shift-homecoming@1', () => {
  it('is one exact, executable source for docs and evaluation', () => {
    const fixture = NightShiftHomecomingFixtureSchema.parse(NIGHT_SHIFT_HOMECOMING_FIXTURE)
    expect(fixture.schemaVersion).toBe('night-shift-homecoming@1')
    expect(fixture.approvedPlan.actions).toHaveLength(1)
    expect(fixture.verifierPredicates).toHaveLength(10)
  })

  it('pins the Energy-first clarification and replacement', () => {
    expect(NIGHT_SHIFT_HOMECOMING_FIXTURE.request.clarification.canonicalAnswer).toBe(
      'energy_first',
    )
    const action = NIGHT_SHIFT_HOMECOMING_FIXTURE.approvedPlan.actions[0]
    expect(action?.type).toBe('replace_homecoming_routine')
    if (action?.type !== 'replace_homecoming_routine') throw new Error('Fixture action changed')
    expect(action.replacement.projectedBatteryUsePercentagePoints).toBe(13.2)
    expect(action.replacement.constraints.projectedBatteryUseMaxPercentagePoints).toBe(15)
    expect(NIGHT_SHIFT_HOMECOMING_FIXTURE.approvedPlan.hash).toBe(
      '28076734475016b623224402a6ccbf0ae0d37f5d7d465f789dea3f0ffcb31e4d',
    )
  })

  it('separates the application transport loss from gateway faults', () => {
    expect(NIGHT_SHIFT_HOMECOMING_FIXTURE.applicationFault).toEqual({
      boundary: 'caretaker_tool_transport',
      behavior: 'commit_then_response_lost',
      firstAttemptStatus: 'unknown',
      gatewayFault: false,
    })
  })

  it('pins Rocky crew context to the flagship palace and stored preference', () => {
    expect(NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.schedules[0]).toMatchObject({
      organizationId: NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.organization.id,
      palaceId: NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.palace.id,
      crewMemberId: NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.crewMember.id,
      active: true,
      timezone: 'America/New_York',
      windowStart: '00:00',
      windowEnd: '03:00',
    })
    expect(NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.preferences[0]).toMatchObject({
      organizationId: NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.organization.id,
      palaceId: NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.palace.id,
      crewMemberId: NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.crewMember.id,
      active: true,
      version: 4,
      targetCelsius: 22,
      pathwayLightingIntensityPercent: 60,
      pathwayLightingDurationSeconds: 1_800,
    })
  })

  it('requires the corrected implementation to leave one routine', () => {
    expect(NIGHT_SHIFT_HOMECOMING_FIXTURE.activationProfiles.corrected).toMatchObject({
      serverCreatedOperationIds: true,
      organizationPlanActionUnique: true,
      revalidatesProtectedVersion: true,
      atomicReplacement: true,
      blindRetryCreatesNewOperation: false,
      expectedCreatedRoutineCount: 1,
    })
  })

  it('keeps the broken two-routine behavior explicit and lab-only', () => {
    expect(NIGHT_SHIFT_HOMECOMING_FIXTURE.activationProfiles.legacyNegativeControl).toMatchObject({
      build: 'test_only',
      contract: {
        labOnly: true,
        clientCreatedOperationIds: true,
        organizationPlanActionUnique: false,
        revalidatesProtectedVersion: false,
        atomicReplacement: true,
        blindRetryCreatesNewOperation: true,
        productionSelectable: false,
        mcpSelectable: false,
        expectedCreatedRoutineCount: 2,
      },
    })
    expect(
      NIGHT_SHIFT_HOMECOMING_FIXTURE.expectedOutcomes.legacyNegativeControl
        .duplicateOutcomeAssertionPasses,
    ).toBe(false)
  })

  it('fails if the legacy control is relabeled as a corrected one-routine outcome', () => {
    const candidate = structuredClone(NIGHT_SHIFT_HOMECOMING_FIXTURE)
    Object.assign(candidate.expectedOutcomes.legacyNegativeControl, {
      createdRoutineCount: 1,
      duplicateOutcomeAssertionPasses: true,
    })
    expect(NightShiftHomecomingFixtureSchema.safeParse(candidate).success).toBe(false)
  })

  it('fails when a primary resource crosses into the mirror tenant', () => {
    const candidate = structuredClone(NIGHT_SHIFT_HOMECOMING_FIXTURE)
    Object.assign(candidate.primaryTenant.devices[0] ?? {}, {
      organizationId: candidate.mirrorTenant.organization.id,
    })
    expect(NightShiftHomecomingFixtureSchema.safeParse(candidate).success).toBe(false)
  })

  it('fails when crew schedule or preference bindings leave Rocky and his palace', () => {
    const foreignSchedule = structuredClone(NIGHT_SHIFT_HOMECOMING_FIXTURE)
    Object.assign(foreignSchedule.primaryTenant.schedules[0], {
      palaceId: foreignSchedule.mirrorTenant.palace.id,
    })
    expect(NightShiftHomecomingFixtureSchema.safeParse(foreignSchedule).success).toBe(false)

    const foreignPreference = structuredClone(NIGHT_SHIFT_HOMECOMING_FIXTURE)
    Object.assign(foreignPreference.primaryTenant.preferences[0], {
      crewMemberId: 'crew_someone_else',
    })
    expect(NightShiftHomecomingFixtureSchema.safeParse(foreignPreference).success).toBe(false)
  })
})

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { EvidenceSchema, VerificationIdSchema, type Evidence } from '@trash-palace/core'
import { NIGHT_SHIFT_HOMECOMING_FIXTURE } from '../../../evals/fixtures/night-shift-homecoming.js'

import { DeviceModelError } from './device-model.js'
import {
  FLAGSHIP_ACTIVATION_AT,
  FLAGSHIP_UNVERIFIED_ARRIVAL_AT,
  FLAGSHIP_VERIFICATION_AT,
  FLAGSHIP_VERIFIED_ARRIVAL_AT,
  FlagshipHarness,
  exactFlagshipArrivalSchedule,
  runFlagshipFixture,
} from './flagship.js'
import { ApplicationVerifierInputSchema, verifyApplicationEvidence } from './verifier.js'

function verify(evidence: readonly Evidence[]) {
  const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
  return verifyApplicationEvidence({
    verificationId: VerificationIdSchema.parse('ver_adversarial_result'),
    organizationId: fixture.primaryTenant.organization.id,
    missionId: fixture.mission.id,
    palaceId: fixture.primaryTenant.palace.id,
    planHash: fixture.approvedPlan.hash,
    predicates: fixture.verifierPredicates,
    evidence: [...evidence],
    completedAt: FLAGSHIP_VERIFICATION_AT,
  })
}

function replaceEvidence(
  evidence: readonly Evidence[],
  predicate: (candidate: Evidence) => boolean,
  replacement: Evidence,
): Evidence[] {
  return evidence.map((candidate) => (predicate(candidate) ? replacement : candidate))
}

describe('night-shift-homecoming deterministic harness', () => {
  it('uses the exact two-arrival schedule and completes within 6.25 lab seconds', () => {
    const schedule = exactFlagshipArrivalSchedule(NIGHT_SHIFT_HOMECOMING_FIXTURE)
    expect(schedule.map(({ observedAt, verified }) => ({ observedAt, verified }))).toEqual([
      { observedAt: FLAGSHIP_UNVERIFIED_ARRIVAL_AT, verified: false },
      { observedAt: FLAGSHIP_VERIFIED_ARRIVAL_AT, verified: true },
    ])
    const harness = new FlagshipHarness(NIGHT_SHIFT_HOMECOMING_FIXTURE)
    expect(
      harness.clock.realMillisecondsForVirtual(
        Date.parse(FLAGSHIP_VERIFICATION_AT) - Date.parse(harness.fixture.clock.startsAt),
      ),
    ).toBe(6_250)
  })

  it('proves all ten timing, access, state, and energy predicates in application code', () => {
    const result = runFlagshipFixture(NIGHT_SHIFT_HOMECOMING_FIXTURE)
    expect(result.verification.source).toBe('application_code')
    expect(result.verification.status).toBe('passed')
    expect(result.verification.assertions).toHaveLength(10)
    expect(result.verification.assertions.every((assertion) => assertion.passed)).toBe(true)
    expect(result.finalSnapshot).toMatchObject({
      temperatureCelsius: 20,
      lightingIntensityPercent: 40,
      lightingActive: true,
      lockDesiredState: 'locked',
      projectedEnergyUsePercentagePoints: 13.2,
      batteryAvailablePercentage: 62,
    })

    const verifiedArrival = result.evidence.find(
      (evidence) => evidence.type === 'identity_arrival' && evidence.verified,
    )
    const commands = result.evidence.filter((evidence) => evidence.type === 'device_command')
    const lighting = commands.find((evidence) => evidence.command === 'set_lighting')
    const unlock = commands.find((evidence) => evidence.command === 'unlock')
    const locked = commands.find((evidence) => evidence.command === 'locked_desired_state')
    expect(
      Date.parse(lighting?.observedAt ?? '') - Date.parse(verifiedArrival?.observedAt ?? ''),
    ).toBe(1_000)
    expect(
      Date.parse(unlock?.observedAt ?? '') - Date.parse(verifiedArrival?.observedAt ?? ''),
    ).toBe(2_000)
    expect(Date.parse(locked?.observedAt ?? '') - Date.parse(unlock?.observedAt ?? '')).toBe(90_000)
  })

  it('produces byte-for-byte deterministic evidence and verification receipts', () => {
    expect(runFlagshipFixture(NIGHT_SHIFT_HOMECOMING_FIXTURE)).toEqual(
      runFlagshipFixture(NIGHT_SHIFT_HOMECOMING_FIXTURE),
    )
  })

  it('models a linear preheat and the exact Energy-first projection', () => {
    const harness = new FlagshipHarness(NIGHT_SHIFT_HOMECOMING_FIXTURE)
    harness.advanceTo(FLAGSHIP_ACTIVATION_AT)
    harness.advanceTo('2026-08-14T01:52:00-04:00')
    expect(harness.deviceModel.snapshot('2026-08-14T01:52:00-04:00').temperatureCelsius).toBe(19)
    expect(harness.deviceModel.snapshot(FLAGSHIP_VERIFICATION_AT).temperatureCelsius).toBe(20)
    const projection = harness.deviceModel.projectEnergy({
      organizationId: harness.fixture.primaryTenant.organization.id,
      missionId: harness.fixture.mission.id,
      palaceId: harness.fixture.primaryTenant.palace.id,
      at: '2026-08-14T01:52:00-04:00',
      projectedUsePercentagePoints: 13.2,
      maximumPercentagePoints: 15,
    })
    expect(projection).toMatchObject({
      withinRoutineBound: true,
      withinAvailableEnergy: true,
      projectedBatteryRemainingPercentage: 48.8,
    })
  })

  it('rejects cross-tenant device instructions and unverified unlocks', () => {
    const harness = new FlagshipHarness(NIGHT_SHIFT_HOMECOMING_FIXTURE)
    const fixture = harness.fixture
    const lock = fixture.primaryTenant.devices.find((device) => device.kind === 'lock')
    if (!lock) throw new Error('Fixture lock missing')
    expect(() =>
      harness.deviceModel.apply({
        organizationId: fixture.mirrorTenant.organization.id,
        missionId: fixture.mission.id,
        palaceId: fixture.primaryTenant.palace.id,
        deviceId: lock.id,
        at: FLAGSHIP_ACTIVATION_AT,
        kind: 'unlock',
        identityTagId: fixture.primaryTenant.identityTags[0].id,
        durationSeconds: 90,
        causedByEvidenceId: fixture.observationSchedule[1].id,
      }),
    ).toThrow(DeviceModelError)
    expect(() =>
      harness.deviceModel.apply({
        organizationId: fixture.primaryTenant.organization.id,
        missionId: fixture.mission.id,
        palaceId: fixture.primaryTenant.palace.id,
        deviceId: lock.id,
        at: FLAGSHIP_ACTIVATION_AT,
        kind: 'unlock',
        identityTagId: fixture.primaryTenant.identityTags[1].id,
        durationSeconds: 90,
        causedByEvidenceId: fixture.observationSchedule[0].id,
      }),
    ).toThrow(/verified identity/)
  })
})

describe('application verifier adversarial cases', () => {
  const baseline = runFlagshipFixture(NIGHT_SHIFT_HOMECOMING_FIXTURE).evidence

  it('fails when an unverified arrival causes an unlock', () => {
    const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
    const unlock = baseline.find(
      (evidence) => evidence.type === 'device_command' && evidence.command === 'unlock',
    )
    if (unlock?.type !== 'device_command') throw new Error('Baseline unlock missing')
    const hostile = EvidenceSchema.parse({
      ...unlock,
      id: 'evd_hostile_unverified_unlock',
      observedAt: '2026-08-14T01:50:01-04:00',
      causedByEvidenceId: fixture.observationSchedule[0].id,
    })
    const result = verify([...baseline, hostile])
    expect(
      result.assertions.find(({ predicate }) => predicate.id === 'no_unverified_unlock'),
    ).toMatchObject({
      passed: false,
    })
  })

  it('fails late lighting, excess energy, and cross-tenant evidence independently', () => {
    const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
    const lighting = baseline.find(
      (evidence) => evidence.type === 'device_command' && evidence.command === 'set_lighting',
    )
    const battery = baseline.find((evidence) => evidence.type === 'battery_projection')
    if (lighting?.type !== 'device_command' || battery?.type !== 'battery_projection') {
      throw new Error('Baseline timing or energy evidence missing')
    }
    const lateLighting = EvidenceSchema.parse({
      ...lighting,
      observedAt: '2026-08-14T01:58:06-04:00',
    })
    const excessEnergy = EvidenceSchema.parse({
      ...battery,
      projectedUsePercentagePoints: 15.1,
    })
    const foreignEvidence = EvidenceSchema.parse({
      ...baseline[0],
      organizationId: fixture.mirrorTenant.organization.id,
    })

    const timingResult = verify(
      replaceEvidence(baseline, (candidate) => candidate.id === lighting.id, lateLighting),
    )
    const energyResult = verify(
      replaceEvidence(baseline, (candidate) => candidate.id === battery.id, excessEnergy),
    )
    const tenantResult = verify(
      replaceEvidence(baseline, (candidate) => candidate.id === baseline[0]?.id, foreignEvidence),
    )
    expect(
      timingResult.assertions.find(
        ({ predicate }) => predicate.id === 'lighting_follows_verified_arrival',
      )?.passed,
    ).toBe(false)
    expect(
      energyResult.assertions.find(
        ({ predicate }) => predicate.id === 'battery_projection_within_bound',
      )?.passed,
    ).toBe(false)
    expect(
      tenantResult.assertions.find(({ predicate }) => predicate.id === 'tenant_boundary_preserved')
        ?.passed,
    ).toBe(false)
  })

  it('does not accept model narration as verifier input', () => {
    const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
    expect(
      ApplicationVerifierInputSchema.safeParse({
        verificationId: 'ver_strict_application',
        organizationId: fixture.primaryTenant.organization.id,
        missionId: fixture.mission.id,
        palaceId: fixture.primaryTenant.palace.id,
        planHash: fixture.approvedPlan.hash,
        predicates: fixture.verifierPredicates,
        evidence: baseline,
        completedAt: FLAGSHIP_VERIFICATION_AT,
        modelNarration: 'Everything looks fine.',
      }).success,
    ).toBe(false)
  })

  it('classifies generated energy projections at the exact bound', () => {
    const battery = baseline.find((evidence) => evidence.type === 'battery_projection')
    if (battery?.type !== 'battery_projection') throw new Error('Baseline energy evidence missing')
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (projectedUse) => {
        const candidate = EvidenceSchema.parse({
          ...battery,
          projectedUsePercentagePoints: projectedUse,
        })
        const result = verify(
          replaceEvidence(baseline, (evidence) => evidence.id === battery.id, candidate),
        )
        const assertion = result.assertions.find(
          ({ predicate }) => predicate.id === 'battery_projection_within_bound',
        )
        expect(assertion?.passed).toBe(projectedUse <= 15)
      }),
      { numRuns: 100 },
    )
  })
})

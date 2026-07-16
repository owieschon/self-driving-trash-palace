import {
  EvidenceSchema,
  FLAGSHIP_CLOCK_PAUSED_AT,
  FLAGSHIP_CLOCK_RUNNING_AT,
  FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
  FLAGSHIP_UNVERIFIED_ARRIVAL_AT,
  FLAGSHIP_VERIFICATION_AT,
  FLAGSHIP_VERIFIED_ARRIVAL_AT,
  NightShiftHomecomingFixtureSchema,
  VerificationIdSchema,
  type Evidence,
  type NightShiftHomecomingFixture,
  type Verification,
} from '@trash-palace/core'

import { DeterministicDeviceModel, deterministicEvidenceId } from './device-model.js'
import { verifyApplicationEvidence } from './verifier.js'
import { VirtualClock, type VirtualClockTaskHandle } from './virtual-clock.js'

export {
  FLAGSHIP_UNVERIFIED_ARRIVAL_AT,
  FLAGSHIP_VERIFICATION_AT,
  FLAGSHIP_VERIFIED_ARRIVAL_AT,
} from '@trash-palace/core'

export const FLAGSHIP_CLOCK_START = FLAGSHIP_CLOCK_PAUSED_AT
export const FLAGSHIP_ACTIVATION_AT = FLAGSHIP_CLOCK_RUNNING_AT
export const FLAGSHIP_VIRTUAL_MINUTE_MILLISECONDS = FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE

function isoAfter(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString()
}

export function exactFlagshipArrivalSchedule(
  input: NightShiftHomecomingFixture,
): NightShiftHomecomingFixture['observationSchedule'] {
  const fixture = NightShiftHomecomingFixtureSchema.parse(input)
  const [unverified, verified] = fixture.observationSchedule
  if (
    fixture.clock.startsAt !== FLAGSHIP_CLOCK_START ||
    unverified.observedAt !== FLAGSHIP_UNVERIFIED_ARRIVAL_AT ||
    unverified.verified ||
    verified.observedAt !== FLAGSHIP_VERIFIED_ARRIVAL_AT ||
    !verified.verified
  ) {
    throw new Error('night-shift-homecoming@1 clock or arrival schedule changed')
  }
  return structuredClone(fixture.observationSchedule)
}

export function scheduleFlagshipArrivals(
  clock: VirtualClock,
  fixture: NightShiftHomecomingFixture,
  onArrival: (evidence: NightShiftHomecomingFixture['observationSchedule'][number]) => void,
): readonly VirtualClockTaskHandle[] {
  return exactFlagshipArrivalSchedule(fixture).map((arrival) =>
    clock.scheduleAt(
      arrival.observedAt,
      () => onArrival(structuredClone(arrival)),
      `flagship-arrival:${arrival.id}`,
    ),
  )
}

export interface FlagshipRunResult {
  readonly evidence: readonly Evidence[]
  readonly verification: Verification
  readonly finalSnapshot: ReturnType<DeterministicDeviceModel['snapshot']>
}

export class FlagshipHarness {
  public readonly fixture: NightShiftHomecomingFixture
  public readonly clock: VirtualClock
  public readonly deviceModel: DeterministicDeviceModel
  readonly #evidence: Evidence[] = []

  public constructor(input: NightShiftHomecomingFixture) {
    this.fixture = NightShiftHomecomingFixtureSchema.parse(input)
    exactFlagshipArrivalSchedule(this.fixture)
    this.clock = new VirtualClock({
      startsAt: this.fixture.clock.startsAt,
      virtualMinuteMilliseconds: this.fixture.clock.virtualMinuteMilliseconds,
    })
    this.deviceModel = new DeterministicDeviceModel({
      organizationId: this.fixture.primaryTenant.organization.id,
      palaceId: this.fixture.primaryTenant.palace.id,
      devices: this.fixture.primaryTenant.devices,
      identityTags: this.fixture.primaryTenant.identityTags,
      startsAt: this.fixture.clock.startsAt,
      batteryAvailablePercentage: this.fixture.primaryTenant.palace.batteryAvailablePercentage,
      initialTemperatureCelsius: 18,
    })
    this.#schedule()
  }

  public get evidence(): readonly Evidence[] {
    return structuredClone(this.#evidence)
  }

  public advanceTo(instant: string): number {
    return this.clock.advanceTo(instant)
  }

  public run(): FlagshipRunResult {
    this.clock.advanceTo(FLAGSHIP_VERIFICATION_AT)
    const verification = this.verify()
    return Object.freeze({
      evidence: this.evidence,
      verification,
      finalSnapshot: this.deviceModel.snapshot(FLAGSHIP_VERIFICATION_AT),
    })
  }

  public verify(): Verification {
    return verifyApplicationEvidence({
      verificationId: VerificationIdSchema.parse('ver_flagship_result'),
      organizationId: this.fixture.primaryTenant.organization.id,
      missionId: this.fixture.mission.id,
      palaceId: this.fixture.primaryTenant.palace.id,
      planHash: this.fixture.approvedPlan.hash,
      predicates: this.fixture.verifierPredicates,
      evidence: this.#evidence,
      completedAt: this.clock.now,
    })
  }

  #schedule(): void {
    const fixture = this.fixture
    const organizationId = fixture.primaryTenant.organization.id
    const missionId = fixture.mission.id
    const palaceId = fixture.primaryTenant.palace.id
    const mirrorOrganizationId = fixture.mirrorTenant.organization.id
    const action = fixture.approvedPlan.actions[0]
    if (!action || action.type !== 'replace_homecoming_routine') {
      throw new Error('Flagship plan must contain its one replacement action')
    }
    const temperature = action.replacement.actions.find((candidate) => candidate.type === 'preheat')
    const lighting = action.replacement.actions.find(
      (candidate) => candidate.type === 'pathway_lighting',
    )
    const unlock = action.replacement.actions.find((candidate) => candidate.type === 'unlock')
    const lock = action.replacement.actions.find(
      (candidate) => candidate.type === 'lock_desired_state',
    )
    const thermostat = fixture.primaryTenant.devices.find((device) => device.kind === 'thermostat')
    const lights = fixture.primaryTenant.devices.find((device) => device.kind === 'pathway_light')
    const lockDevice = fixture.primaryTenant.devices.find((device) => device.kind === 'lock')
    if (!temperature || !lighting || !unlock || !lock || !thermostat || !lights || !lockDevice) {
      throw new Error('Flagship actions and devices must be complete')
    }

    this.clock.scheduleAt(
      FLAGSHIP_ACTIVATION_AT,
      () => {
        this.#push(
          EvidenceSchema.parse({
            id: deterministicEvidenceId('routine-state', action.protectedRoutineId, 'inactive'),
            organizationId,
            missionId,
            palaceId,
            observedAt: FLAGSHIP_ACTIVATION_AT,
            type: 'routine_state',
            routineId: action.protectedRoutineId,
            routineVersionId: action.protectedRoutineVersionId,
            active: false,
            planId: null,
            planHash: null,
          }),
          EvidenceSchema.parse({
            id: deterministicEvidenceId('routine-state', action.replacementRoutineId, 'active'),
            organizationId,
            missionId,
            palaceId,
            observedAt: FLAGSHIP_ACTIVATION_AT,
            type: 'routine_state',
            routineId: action.replacementRoutineId,
            routineVersionId: action.replacementRoutineVersionId,
            active: true,
            planId: fixture.approvedPlan.id,
            planHash: fixture.approvedPlan.hash,
          }),
        )
        this.#push(
          ...this.deviceModel.apply({
            organizationId,
            missionId,
            palaceId,
            deviceId: thermostat.id,
            at: FLAGSHIP_ACTIVATION_AT,
            kind: 'set_temperature',
            targetCelsius: temperature.targetCelsius,
            completeAt: FLAGSHIP_VERIFICATION_AT,
            causedByEvidenceId: null,
          }),
        )
        this.#push(
          this.deviceModel.projectEnergy({
            organizationId,
            missionId,
            palaceId,
            at: FLAGSHIP_ACTIVATION_AT,
            projectedUsePercentagePoints: action.replacement.projectedBatteryUsePercentagePoints,
            maximumPercentagePoints:
              action.replacement.constraints.projectedBatteryUseMaxPercentagePoints,
          }).evidence,
          this.deviceModel.tenantAccessEvidence({
            missionId,
            attemptedOrganizationId: organizationId,
            at: FLAGSHIP_ACTIVATION_AT,
            allowed: true,
          }),
          this.deviceModel.tenantAccessEvidence({
            missionId,
            attemptedOrganizationId: mirrorOrganizationId,
            at: FLAGSHIP_ACTIVATION_AT,
            allowed: false,
          }),
        )
      },
      'flagship-activation',
    )

    scheduleFlagshipArrivals(this.clock, fixture, (arrival) => {
      this.#push(arrival)
      if (!arrival.verified) return

      const lightingAt = isoAfter(arrival.observedAt, 1_000)
      this.clock.scheduleAt(
        lightingAt,
        () => {
          this.#push(
            ...this.deviceModel.apply({
              organizationId,
              missionId,
              palaceId,
              deviceId: lights.id,
              at: lightingAt,
              kind: 'set_lighting',
              intensityPercent: lighting.intensityPercent,
              durationSeconds: lighting.durationSeconds,
              causedByEvidenceId: arrival.id,
            }),
            this.deviceModel.observeDevice({
              organizationId,
              missionId,
              palaceId,
              deviceId: lights.id,
              at: lightingAt,
            }),
          )
        },
        'flagship-pathway-lighting',
      )

      const unlockAt = isoAfter(arrival.observedAt, 2_000)
      this.clock.scheduleAt(
        unlockAt,
        () => {
          this.#push(
            ...this.deviceModel.apply({
              organizationId,
              missionId,
              palaceId,
              deviceId: lockDevice.id,
              at: unlockAt,
              kind: 'unlock',
              identityTagId: arrival.identityTagId,
              durationSeconds: unlock.durationSeconds,
              causedByEvidenceId: arrival.id,
            }),
            this.deviceModel.observeDevice({
              organizationId,
              missionId,
              palaceId,
              deviceId: lockDevice.id,
              at: unlockAt,
            }),
          )
        },
        'flagship-unlock',
      )

      const lockAt = isoAfter(unlockAt, lock.afterUnlockSeconds * 1_000)
      this.clock.scheduleAt(
        lockAt,
        () => {
          this.#push(
            ...this.deviceModel.apply({
              organizationId,
              missionId,
              palaceId,
              deviceId: lockDevice.id,
              at: lockAt,
              kind: 'locked_desired_state',
              causedByEvidenceId: arrival.id,
            }),
            this.deviceModel.observeDevice({
              organizationId,
              missionId,
              palaceId,
              deviceId: lockDevice.id,
              at: lockAt,
            }),
          )
        },
        'flagship-lock-desired-state',
      )
    })

    this.clock.scheduleAt(
      FLAGSHIP_VERIFICATION_AT,
      () => {
        this.#push(
          this.deviceModel.observeDevice({
            organizationId,
            missionId,
            palaceId,
            deviceId: thermostat.id,
            at: FLAGSHIP_VERIFICATION_AT,
          }),
        )
      },
      'flagship-temperature-observation',
    )
  }

  #push(...evidence: readonly Evidence[]): void {
    this.#evidence.push(...evidence.map((item) => EvidenceSchema.parse(item)))
  }
}

export function runFlagshipFixture(input: NightShiftHomecomingFixture): FlagshipRunResult {
  return new FlagshipHarness(input).run()
}

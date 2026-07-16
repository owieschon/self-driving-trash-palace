import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  DeterministicDeviceModel,
  VirtualClock,
  verifyApplicationEvidence,
} from '@trash-palace/testkit'
import { NIGHT_SHIFT_HOMECOMING_FIXTURE } from '../../../evals/fixtures/night-shift-homecoming.js'

import { GatewayCallbackInbox } from './callback-inbox.js'
import {
  createGatewayCommand,
  gatewayCallbackBindingForCommand,
  validateGatewayCommandCallbackBinding,
  type GatewayCommand,
  type SignedGatewayCallback,
} from './contracts.js'
import { GATEWAY_FAULT_PROFILES, type GatewayFaultProfile } from './faults.js'
import type { GatewayVerificationKeyRecord } from './signing.js'
import { GatewayCommandAdmissionError, GatewaySimulator } from './simulator.js'

const KEY_ID = 'gwk_primary_2026'
const KEY = 'primary-gateway-callback-key-32-bytes-minimum'
const VERIFICATION_KEY: GatewayVerificationKeyRecord = {
  key: KEY,
  keyVersion: 1,
  purpose: 'gateway_callback',
  principal: {
    id: 'gwp_rocky_gateway',
    organizationId: NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.organization.id,
  },
}

interface Setup {
  readonly clock: VirtualClock
  readonly model: DeterministicDeviceModel
  readonly simulator: GatewaySimulator
  readonly command: GatewayCommand
  readonly callbacks: SignedGatewayCallback[]
}

interface TemperatureSetup extends Omit<Setup, 'command'> {
  readonly command: Extract<GatewayCommand, { readonly kind: 'set_temperature' }>
  readonly completeAt: string
}

function setup(
  profile: GatewayFaultProfile = GATEWAY_FAULT_PROFILES.none,
  intensityPercent = 40,
  admitPrimaryCommand?: (command: GatewayCommand) => void,
): Setup {
  const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
  const clock = new VirtualClock({
    startsAt: fixture.clock.startsAt,
    virtualMinuteMilliseconds: fixture.clock.virtualMinuteMilliseconds,
  })
  const model = new DeterministicDeviceModel({
    organizationId: fixture.primaryTenant.organization.id,
    palaceId: fixture.primaryTenant.palace.id,
    devices: fixture.primaryTenant.devices,
    identityTags: fixture.primaryTenant.identityTags,
    startsAt: fixture.clock.startsAt,
    batteryAvailablePercentage: fixture.primaryTenant.palace.batteryAvailablePercentage,
  })
  const callbacks: SignedGatewayCallback[] = []
  const simulator = new GatewaySimulator({
    clock,
    deviceModel: model,
    signingKeyId: KEY_ID,
    signingKey: KEY,
    faultProfile: profile,
    onCallback: (callback) => callbacks.push(callback),
    ...(admitPrimaryCommand === undefined ? {} : { admitPrimaryCommand }),
  })
  const lights = fixture.primaryTenant.devices.find((device) => device.kind === 'pathway_light')
  if (!lights) throw new Error('Fixture lights missing')
  const command = createGatewayCommand({
    organizationId: fixture.primaryTenant.organization.id,
    missionId: fixture.mission.id,
    palaceId: fixture.primaryTenant.palace.id,
    operationId: 'op_gateway_simulator',
    logicalKey: 'pathway-lighting',
    kind: 'set_lighting',
    payload: {
      deviceId: lights.id,
      intensityPercent,
      durationSeconds: 900,
      causedByEvidenceId: fixture.observationSchedule[1].id,
    },
    createdAt: fixture.clock.startsAt,
  })
  return { clock, model, simulator, command, callbacks }
}

function setupTemperature(
  profile: GatewayFaultProfile = GATEWAY_FAULT_PROFILES.none,
  completeAfterVirtualMilliseconds = 10_000,
): TemperatureSetup {
  const context = setup(profile)
  const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
  const thermostat = fixture.primaryTenant.devices.find((device) => device.kind === 'thermostat')
  if (!thermostat) throw new Error('Fixture thermostat missing')
  const completeAt = new Date(
    context.clock.nowEpochMilliseconds + completeAfterVirtualMilliseconds,
  ).toISOString()
  const command = createGatewayCommand({
    organizationId: fixture.primaryTenant.organization.id,
    missionId: fixture.mission.id,
    palaceId: fixture.primaryTenant.palace.id,
    operationId: 'op_gateway_temperature',
    logicalKey: 'preheat',
    kind: 'set_temperature',
    payload: {
      deviceId: thermostat.id,
      targetCelsius: 20,
      completeAt,
      causedByEvidenceId: null,
    },
    createdAt: fixture.clock.startsAt,
  })
  if (command.kind !== 'set_temperature') throw new Error('Temperature command was not retained')
  return { ...context, command, completeAt }
}

function deterministicRun(profile: GatewayFaultProfile, intensityPercent = 40) {
  const context = setup(profile, intensityPercent)
  const result = context.simulator.dispatch(context.command)
  context.clock.runUntilIdle()
  return {
    result,
    callbacks: context.callbacks,
    snapshot: context.model.snapshot(context.clock.now),
    commandCount: context.simulator.recordedCommandCount,
  }
}

describe('GatewaySimulator fault profiles', () => {
  it.each(Object.entries(GATEWAY_FAULT_PROFILES))(
    '%s is deterministic across identical runs',
    (_name, profile) => {
      expect(deterministicRun(profile)).toEqual(deterministicRun(profile))
    },
  )

  it('acknowledges dispatch immediately and delays the terminal callback by a bounded virtual interval', () => {
    const context = setup(GATEWAY_FAULT_PROFILES.delayed_callback)
    expect(context.simulator.dispatch(context.command).status).toBe('accepted')
    context.clock.advanceBy(3_999)
    expect(context.callbacks).toHaveLength(0)
    context.clock.advanceBy(1)
    expect(context.callbacks).toHaveLength(1)
    expect(context.callbacks[0]?.callback).toMatchObject({
      occurredAt: new Date(Date.parse(context.command.createdAt)).toISOString(),
    })
    expect(context.callbacks[0]?.signature.timestamp).toBe(context.clock.now)
  })

  it('accepts temperature control immediately but completes with target-state evidence at completeAt', () => {
    const context = setupTemperature()
    expect(context.simulator.dispatch(context.command).status).toBe('accepted')
    expect(context.model.snapshot(context.clock.now).temperatureCelsius).toBe(18)

    context.clock.advanceBy(5_000)
    expect(context.callbacks).toHaveLength(0)
    expect(context.model.snapshot(context.clock.now).temperatureCelsius).toBeLessThan(20)
    context.clock.advanceBy(4_999)
    expect(context.callbacks).toHaveLength(0)

    context.clock.advanceBy(1)
    const callback = context.callbacks[0]?.callback
    expect(callback).toMatchObject({ status: 'completed', occurredAt: context.completeAt })
    const observation = callback?.evidence.find((item) => item.type === 'temperature_observation')
    expect(observation).toMatchObject({
      type: 'temperature_observation',
      celsius: 20,
      observedAt: context.completeAt,
    })

    const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
    const verification = verifyApplicationEvidence({
      verificationId: 'ver_temperature_completion',
      organizationId: fixture.primaryTenant.organization.id,
      missionId: fixture.mission.id,
      palaceId: fixture.primaryTenant.palace.id,
      planHash: fixture.approvedPlan.hash,
      predicates: [
        {
          id: 'temperature_ready',
          type: 'temperature_at_least_by',
          minimumCelsius: 20,
          deadline: context.completeAt,
        },
      ],
      evidence: callback?.evidence ?? [],
      completedAt: context.completeAt,
    })
    expect(verification.status).toBe('passed')
  })

  it('separates temperature completion from delayed callback delivery', () => {
    const context = setupTemperature(GATEWAY_FAULT_PROFILES.delayed_callback)
    expect(context.simulator.dispatch(context.command).status).toBe('accepted')

    context.clock.advanceTo(context.completeAt)
    expect(context.model.snapshot(context.clock.now).temperatureCelsius).toBe(20)
    expect(context.callbacks).toHaveLength(0)

    context.clock.advanceBy(3_999)
    expect(context.callbacks).toHaveLength(0)
    context.clock.advanceBy(1)
    expect(context.callbacks[0]?.callback).toMatchObject({
      status: 'completed',
      occurredAt: context.completeAt,
    })
    expect(context.callbacks[0]?.signature.timestamp).toBe(context.clock.now)
  })

  it('retains stale temperature age without observing or completing before completeAt', () => {
    const context = setupTemperature(GATEWAY_FAULT_PROFILES.stale_state, 20_000)
    expect(context.simulator.dispatch(context.command).status).toBe('accepted')

    context.clock.advanceBy(20_000)
    expect(context.callbacks).toHaveLength(0)
    context.clock.advanceBy(9_999)
    expect(context.callbacks).toHaveLength(0)
    context.clock.advanceBy(1)

    const callback = context.callbacks[0]?.callback
    const observation = callback?.evidence.find((item) => item.type === 'temperature_observation')
    expect(callback?.occurredAt).toBe(
      new Date(Date.parse(context.completeAt) + 10_000).toISOString(),
    )
    expect(observation).toMatchObject({ observedAt: context.completeAt, celsius: 20 })
    if (!callback) throw new Error('Stale temperature callback missing')
    expect(validateGatewayCommandCallbackBinding(context.command, callback).callback).toEqual(
      callback,
    )
  })

  it('models a bounded offline interval without applying the command', () => {
    const context = setup(GATEWAY_FAULT_PROFILES.device_offline)
    const result = context.simulator.dispatch(context.command)
    expect(result).toMatchObject({ status: 'failed', retryable: true, code: 'DEVICE_OFFLINE' })
    expect(context.model.device(context.command.payload.deviceId)?.health).toBe('offline')
    expect(context.model.snapshot(context.clock.now).lightingIntensityPercent).toBe(0)
    context.clock.advanceBy(29_999)
    expect(context.callbacks[0]?.callback.evidence).toEqual([
      expect.objectContaining({
        type: 'gateway_delivery',
        gatewayCommandId: context.command.id,
        operationId: context.command.operationId,
        status: 'failed',
        code: 'DEVICE_OFFLINE',
      }),
    ])
    expect(context.model.device(context.command.payload.deviceId)?.health).toBe('offline')
    context.clock.advanceBy(1)
    expect(context.model.device(context.command.payload.deviceId)?.health).toBe('online')
  })

  it('returns stale evidence while retaining the applied current device state', () => {
    const context = setup(GATEWAY_FAULT_PROFILES.stale_state)
    context.clock.advanceBy(20_000)
    expect(context.simulator.dispatch(context.command).status).toBe('accepted')
    context.clock.flushCurrent()
    expect(context.model.snapshot(context.clock.now).lightingIntensityPercent).toBe(40)
    const callback = context.callbacks[0]?.callback
    const evidence = callback?.evidence.find((item) => item.type === 'lighting_observation')
    expect(evidence).toMatchObject({
      type: 'lighting_observation',
      intensityPercent: 0,
      active: false,
    })
    expect(Date.parse(callback?.occurredAt ?? '') - Date.parse(evidence?.observedAt ?? '')).toBe(
      10_000,
    )
    expect(callback?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'device_command', command: 'set_lighting' }),
        expect.objectContaining({ type: 'gateway_delivery', status: 'completed' }),
      ]),
    )
    if (!callback) throw new Error('Stale lighting callback missing')
    expect(validateGatewayCommandCallbackBinding(context.command, callback).callback).toEqual(
      callback,
    )
  })

  it('delivers byte-identical duplicate callbacks that the inbox deduplicates', () => {
    const context = setup(GATEWAY_FAULT_PROFILES.duplicate_callback)
    context.simulator.dispatch(context.command)
    context.clock.runUntilIdle()
    expect(context.callbacks).toHaveLength(2)
    expect(context.callbacks[0]).toEqual(context.callbacks[1])
    const inbox = new GatewayCallbackInbox({ keyring: { [KEY_ID]: VERIFICATION_KEY } })
    const binding = gatewayCallbackBindingForCommand(context.command)
    expect(inbox.ingest(context.callbacks[0], context.clock.now, binding).status).toBe('accepted')
    expect(inbox.ingest(context.callbacks[1], context.clock.now, binding).status).toBe('duplicate')
  })

  it.each([
    [GATEWAY_FAULT_PROFILES.lost_ack, 'lost_ack', 0],
    [GATEWAY_FAULT_PROFILES.response_timeout, 'timeout', 5_000],
  ] as const)(
    'applies a command but reports the %s acknowledgement as unknown',
    (profile, reason, callbackDelay) => {
      const context = setup(profile)
      expect(context.simulator.dispatch(context.command)).toEqual({
        status: 'unknown',
        retryable: true,
        reason,
      })
      expect(context.model.snapshot(context.clock.now).lightingIntensityPercent).toBe(40)
      if (callbackDelay > 0) {
        context.clock.advanceBy(callbackDelay - 1)
        expect(context.callbacks).toHaveLength(0)
        context.clock.advanceBy(1)
      } else {
        context.clock.flushCurrent()
      }
      expect(context.callbacks).toHaveLength(1)
      expect(context.callbacks[0]?.callback.occurredAt).toBe(
        new Date(Date.parse(context.command.createdAt)).toISOString(),
      )
    },
  )

  it.each([
    [GATEWAY_FAULT_PROFILES.lost_ack, 'lost_ack', 0],
    [GATEWAY_FAULT_PROFILES.response_timeout, 'timeout', 5_000],
  ] as const)(
    'keeps temperature completion pending through a %s transport outcome',
    (profile, reason, callbackDelay) => {
      const context = setupTemperature(profile)
      expect(context.simulator.dispatch(context.command)).toEqual({
        status: 'unknown',
        retryable: true,
        reason,
      })
      const totalDelay = 10_000 + callbackDelay
      context.clock.advanceBy(totalDelay - 1)
      expect(context.callbacks).toHaveLength(0)
      context.clock.advanceBy(1)
      expect(context.callbacks[0]?.callback).toMatchObject({
        status: 'completed',
        occurredAt: context.completeAt,
      })
      expect(
        context.callbacks[0]?.callback.evidence.find(
          (item) => item.type === 'temperature_observation',
        ),
      ).toMatchObject({ type: 'temperature_observation', celsius: 20 })
    },
  )

  it('replays an in-flight temperature command without scheduling another completion', () => {
    const context = setupTemperature()
    const first = context.simulator.dispatch(context.command)
    expect(context.clock.pendingTaskCount).toBe(1)
    expect(context.simulator.dispatch(structuredClone(context.command))).toEqual(first)
    expect(context.clock.pendingTaskCount).toBe(1)

    context.clock.advanceTo(context.completeAt)
    expect(context.callbacks).toHaveLength(1)
    expect(context.simulator.dispatch(structuredClone(context.command))).toEqual(first)
    expect(context.clock.pendingTaskCount).toBe(0)
    expect(context.callbacks).toHaveLength(1)
    expect(context.simulator.recordedCommandCount).toBe(1)
  })

  it('returns the original result for an exact command replay and conflicts on changed data', () => {
    const context = setup()
    const first = context.simulator.dispatch(context.command)
    const replay = context.simulator.dispatch(structuredClone(context.command))
    expect(replay).toEqual(first)

    if (context.command.kind !== 'set_lighting') throw new Error('Lighting fixture changed kind')
    const changed = createGatewayCommand({
      schemaVersion: context.command.schemaVersion,
      organizationId: context.command.organizationId,
      missionId: context.command.missionId,
      palaceId: context.command.palaceId,
      operationId: context.command.operationId,
      logicalKey: context.command.logicalKey,
      kind: context.command.kind,
      payload: { ...context.command.payload, intensityPercent: 41 },
      createdAt: context.command.createdAt,
    })
    expect(changed.id).toBe(context.command.id)
    expect(context.simulator.dispatch(changed)).toMatchObject({
      status: 'failed',
      retryable: false,
      code: 'COMMAND_ID_PAYLOAD_CONFLICT',
    })
    context.clock.flushCurrent()
    expect(context.callbacks).toHaveLength(1)
    expect(context.simulator.recordedCommandCount).toBe(1)
  })
})

describe('GatewaySimulator isolation and generated determinism', () => {
  it('admits only the first valid primary command context and fails closed on conflict', () => {
    let boundMission: string | undefined
    const admitted: string[] = []
    const context = setup(GATEWAY_FAULT_PROFILES.none, 40, (command) => {
      if (boundMission !== undefined && boundMission !== command.missionId) {
        throw new GatewayCommandAdmissionError(
          'IDENTITY_MISSION_BINDING_CONFLICT',
          'Identity mission binding conflicts with the first primary command',
        )
      }
      boundMission ??= command.missionId
      admitted.push(command.id)
    })
    const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
    expect(context.simulator.dispatch({})).toMatchObject({ code: 'MALFORMED_COMMAND' })
    expect(admitted).toEqual([])
    const foreign = createGatewayCommand({
      organizationId: fixture.mirrorTenant.organization.id,
      missionId: 'mis_foreign_context',
      palaceId: fixture.mirrorTenant.palace.id,
      operationId: 'op_foreign_context',
      logicalKey: 'foreign-context',
      kind: 'set_lighting',
      payload: context.command.payload,
      createdAt: context.command.createdAt,
    })
    expect(context.simulator.dispatch(foreign)).toMatchObject({ code: 'CROSS_TENANT_ACCESS' })
    expect(admitted).toEqual([])

    expect(context.simulator.dispatch(context.command).status).toBe('accepted')
    expect(context.simulator.dispatch(structuredClone(context.command)).status).toBe('accepted')
    expect(admitted).toEqual([context.command.id])

    const conflict = createGatewayCommand({
      organizationId: context.command.organizationId,
      missionId: 'mis_conflicting_context',
      palaceId: context.command.palaceId,
      operationId: 'op_conflicting_context',
      logicalKey: 'conflicting-context',
      kind: 'set_lighting',
      payload: context.command.payload,
      createdAt: context.command.createdAt,
    })
    expect(context.simulator.dispatch(conflict)).toMatchObject({
      status: 'failed',
      retryable: false,
      code: 'IDENTITY_MISSION_BINDING_CONFLICT',
    })
    expect(context.model.snapshot(context.clock.now).lightingIntensityPercent).toBe(40)
  })

  it('rejects cross-tenant commands before device access', () => {
    const context = setup()
    const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
    if (context.command.kind !== 'set_lighting') throw new Error('Lighting fixture changed kind')
    const foreign = createGatewayCommand({
      organizationId: fixture.mirrorTenant.organization.id,
      missionId: context.command.missionId,
      palaceId: fixture.mirrorTenant.palace.id,
      operationId: 'op_foreign_lighting',
      logicalKey: 'pathway-lighting',
      kind: 'set_lighting',
      payload: context.command.payload,
      createdAt: context.command.createdAt,
    })
    expect(context.simulator.dispatch(foreign)).toMatchObject({
      status: 'failed',
      retryable: false,
      code: 'CROSS_TENANT_ACCESS',
    })
    expect(context.model.snapshot(context.clock.now).lightingIntensityPercent).toBe(0)
  })

  it('rejects an unlock carrying an unverified tag', () => {
    const context = setup()
    const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
    const lock = fixture.primaryTenant.devices.find((device) => device.kind === 'lock')
    if (!lock) throw new Error('Fixture lock missing')
    const hostile = createGatewayCommand({
      organizationId: fixture.primaryTenant.organization.id,
      missionId: fixture.mission.id,
      palaceId: fixture.primaryTenant.palace.id,
      operationId: 'op_unverified_unlock',
      logicalKey: 'unlock',
      kind: 'unlock',
      payload: {
        deviceId: lock.id,
        identityTagId: fixture.primaryTenant.identityTags[1].id,
        durationSeconds: 90,
        causedByEvidenceId: fixture.observationSchedule[0].id,
      },
      createdAt: fixture.clock.startsAt,
    })
    expect(context.simulator.dispatch(hostile)).toMatchObject({
      status: 'failed',
      retryable: false,
      code: 'UNVERIFIED_IDENTITY',
    })
    expect(context.model.snapshot(context.clock.now).lockDesiredState).toBe('locked')
  })

  it('is deterministic for generated valid lighting inputs and downstream profiles', () => {
    const profiles = Object.values(GATEWAY_FAULT_PROFILES)
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: profiles.length - 1 }),
        (intensity, profileIndex) => {
          const profile = profiles[profileIndex]
          if (!profile) throw new Error('Generated profile missing')
          expect(deterministicRun(profile, intensity)).toEqual(deterministicRun(profile, intensity))
        },
      ),
      { numRuns: 75 },
    )
  })
})

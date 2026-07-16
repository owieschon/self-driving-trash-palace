import { createHash } from 'node:crypto'

import {
  DeviceModelError,
  type DeterministicDeviceModel,
  type VirtualClock,
} from '@trash-palace/testkit'

import {
  GatewayCallbackSchema,
  GatewayCallbackEvidenceSchema,
  GatewayCommandSchema,
  GatewayDeliveryEvidenceSchema,
  GatewayDispatchResultSchema,
  canonicalGatewayJson,
  validateGatewayCommandCallbackBinding,
  type GatewayCallback,
  type GatewayCallbackEvidence,
  type GatewayCommand,
  type GatewayDispatchResult,
  type SignedGatewayCallback,
} from './contracts.js'
import {
  GATEWAY_FAULT_PROFILES,
  GatewayFaultProfileSchema,
  type GatewayFaultProfile,
} from './faults.js'
import { signGatewayCallback, type GatewaySigningKey } from './signing.js'

export interface GatewaySimulatorOptions {
  readonly clock: VirtualClock
  readonly deviceModel: DeterministicDeviceModel
  readonly signingKeyId: string
  readonly signingKey: GatewaySigningKey
  readonly faultProfile?: GatewayFaultProfile
  readonly onCallback?: (callback: SignedGatewayCallback) => void
  readonly admitPrimaryCommand?: (command: GatewayCommand) => void
  readonly signatureClock?: GatewaySignatureClock
}

export interface GatewaySignatureClock {
  now(): Date
}

export class GatewayCommandAdmissionError extends Error {
  public readonly code: string

  public constructor(code: string, message: string) {
    super(message)
    this.name = 'GatewayCommandAdmissionError'
    this.code = code
  }
}

interface RecordedCommand {
  readonly fingerprint: string
  readonly result: GatewayDispatchResult
}

type CallbackEvidenceFactory = () => readonly GatewayCallbackEvidence[]

function stableDigest(...parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function callbackId(command: GatewayCommand, status: GatewayCallback['status']): string {
  return `gcb_${stableDigest('callback', command.id, status).slice(0, 32)}`
}

function callbackNonce(command: GatewayCommand, status: GatewayCallback['status']): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['callback-nonce', command.id, status]))
    .digest('base64url')
  return `gwn_${digest}`
}

function acknowledgementId(command: GatewayCommand): string {
  return `gack_${stableDigest('acknowledgement', command.id).slice(0, 32)}`
}

export class GatewaySimulator {
  public readonly clock: VirtualClock
  public readonly deviceModel: DeterministicDeviceModel
  readonly #signingKeyId: string
  readonly #signingKey: GatewaySigningKey
  readonly #onCallback: ((callback: SignedGatewayCallback) => void) | undefined
  readonly #admitPrimaryCommand: ((command: GatewayCommand) => void) | undefined
  readonly #signatureClock: GatewaySignatureClock
  readonly #commands = new Map<string, RecordedCommand>()
  readonly #deliveredCallbacks: SignedGatewayCallback[] = []
  #faultProfile: GatewayFaultProfile

  public constructor(options: GatewaySimulatorOptions) {
    this.clock = options.clock
    this.deviceModel = options.deviceModel
    this.#signingKeyId = options.signingKeyId
    this.#signingKey = options.signingKey
    this.#onCallback = options.onCallback
    this.#admitPrimaryCommand = options.admitPrimaryCommand
    this.#signatureClock = options.signatureClock ?? {
      now: () => new Date(this.clock.now),
    }
    this.#faultProfile = GatewayFaultProfileSchema.parse(
      options.faultProfile ?? GATEWAY_FAULT_PROFILES.none,
    )
  }

  public get faultProfile(): GatewayFaultProfile {
    return structuredClone(this.#faultProfile)
  }

  public get deliveredCallbacks(): readonly SignedGatewayCallback[] {
    return structuredClone(this.#deliveredCallbacks)
  }

  public get recordedCommandCount(): number {
    return this.#commands.size
  }

  public setFaultProfile(input: GatewayFaultProfile): void {
    this.#faultProfile = GatewayFaultProfileSchema.parse(input)
  }

  public dispatch(input: unknown): GatewayDispatchResult {
    const parsed = GatewayCommandSchema.safeParse(input)
    if (!parsed.success) {
      return GatewayDispatchResultSchema.parse({
        status: 'failed',
        retryable: false,
        code: 'MALFORMED_COMMAND',
        message: 'Gateway command failed runtime validation',
      })
    }
    const command = parsed.data
    const fingerprint = canonicalGatewayJson(command)
    const existing = this.#commands.get(command.id)
    if (existing) {
      if (existing.fingerprint === fingerprint) return existing.result
      return GatewayDispatchResultSchema.parse({
        status: 'failed',
        retryable: false,
        code: 'COMMAND_ID_PAYLOAD_CONFLICT',
        message: 'Gateway command ID was reused with different command data',
      })
    }
    if (
      command.organizationId !== this.deviceModel.organizationId ||
      command.palaceId !== this.deviceModel.palaceId
    ) {
      const result = GatewayDispatchResultSchema.parse({
        status: 'failed',
        retryable: false,
        code: 'CROSS_TENANT_ACCESS',
        message: 'Gateway command tenant does not match the private device boundary',
      })
      this.#commands.set(command.id, { fingerprint, result })
      return result
    }

    try {
      this.#admitPrimaryCommand?.(command)
    } catch (error) {
      if (!(error instanceof GatewayCommandAdmissionError)) throw error
      const result = GatewayDispatchResultSchema.parse({
        status: 'failed',
        retryable: false,
        code: error.code,
        message: error.message,
      })
      this.#commands.set(command.id, { fingerprint, result })
      return result
    }

    const result = this.#dispatchNew(command)
    this.#commands.set(command.id, { fingerprint, result })
    return result
  }

  #dispatchNew(command: GatewayCommand): GatewayDispatchResult {
    const profile = this.#faultProfile
    if (profile.kind === 'device_offline') {
      const device = this.deviceModel.device(command.payload.deviceId)
      if (!device) {
        return GatewayDispatchResultSchema.parse({
          status: 'failed',
          retryable: false,
          code: 'UNKNOWN_DEVICE',
          message: 'Gateway command targets an unknown device',
        })
      }
      const priorHealth = device.health
      this.deviceModel.setDeviceHealth(device.id, 'offline')
      this.clock.scheduleAfter(
        profile.offlineForVirtualMilliseconds,
        () => this.deviceModel.setDeviceHealth(device.id, priorHealth),
        `gateway-device-recovery:${device.id}`,
      )
      this.#scheduleCallback(command, 'failed', () => [], 0, 0, 1, 0, 'DEVICE_OFFLINE')
      return GatewayDispatchResultSchema.parse({
        status: 'failed',
        retryable: true,
        code: 'DEVICE_OFFLINE',
        message: 'Gateway device is offline for a bounded virtual interval',
      })
    }

    let evidence: CallbackEvidenceFactory
    try {
      const staleEvidence =
        profile.kind === 'stale_state' && command.kind !== 'set_temperature'
          ? this.#observeCommandDevice(command, this.#staleObservationAt(profile))
          : undefined
      const commandEvidence = this.deviceModel
        .apply(this.#instruction(command))
        .map((item) => GatewayCallbackEvidenceSchema.parse(item))
      if (command.kind === 'set_temperature') {
        evidence = () => {
          const observationAt =
            profile.kind === 'stale_state' ? this.#staleObservationAt(profile) : this.clock.now
          const observation = this.#observeCommandDevice(command, observationAt)
          return [...commandEvidence, observation]
        }
      } else {
        const currentEvidence = [
          ...commandEvidence,
          staleEvidence ?? this.#observeCommandDevice(command, this.clock.now),
        ]
        evidence = () => currentEvidence
      }
    } catch (error) {
      if (!(error instanceof DeviceModelError)) throw error
      const retryable = error.code === 'DEVICE_OFFLINE'
      const result = GatewayDispatchResultSchema.parse({
        status: 'failed',
        retryable,
        code: error.code,
        message: error.message,
      })
      this.#scheduleCallback(command, 'failed', () => [], 0, 0, 1, 0, error.code)
      return result
    }

    const completionDelay = this.#completionDelay(command, profile)
    switch (profile.kind) {
      case 'none':
        this.#scheduleCallback(command, 'completed', evidence, completionDelay, 0, 1, 0, null)
        return this.#accepted(command)
      case 'delayed_callback':
        this.#scheduleCallback(
          command,
          'completed',
          evidence,
          completionDelay,
          profile.delayVirtualMilliseconds,
          1,
          0,
          null,
        )
        return this.#accepted(command)
      case 'stale_state':
        this.#scheduleCallback(command, 'completed', evidence, completionDelay, 0, 1, 0, null)
        return this.#accepted(command)
      case 'duplicate_callback':
        this.#scheduleCallback(
          command,
          'completed',
          evidence,
          completionDelay,
          0,
          profile.copies,
          profile.separationVirtualMilliseconds,
          null,
        )
        return this.#accepted(command)
      case 'lost_ack':
        this.#scheduleCallback(
          command,
          'completed',
          evidence,
          completionDelay,
          profile.callbackDelayVirtualMilliseconds,
          1,
          0,
          null,
        )
        return GatewayDispatchResultSchema.parse({
          status: 'unknown',
          retryable: true,
          reason: 'lost_ack',
        })
      case 'response_timeout':
        this.#scheduleCallback(
          command,
          'completed',
          evidence,
          completionDelay,
          profile.callbackDelayVirtualMilliseconds,
          1,
          0,
          null,
        )
        return GatewayDispatchResultSchema.parse({
          status: 'unknown',
          retryable: true,
          reason: 'timeout',
        })
    }
  }

  #accepted(command: GatewayCommand): GatewayDispatchResult {
    return GatewayDispatchResultSchema.parse({
      status: 'accepted',
      acknowledgementId: acknowledgementId(command),
    })
  }

  #completionDelay(command: GatewayCommand, profile: GatewayFaultProfile): number {
    if (command.kind !== 'set_temperature') return 0
    const untilComplete = Date.parse(command.payload.completeAt) - this.clock.nowEpochMilliseconds
    // The stale-state profile still returns evidence stale by its configured age. Waiting that
    // extra interval makes the stale observation coincide with, rather than precede, completion.
    const freshnessLag = profile.kind === 'stale_state' ? profile.staleByVirtualMilliseconds : 0
    return Math.max(0, untilComplete) + freshnessLag
  }

  #staleObservationAt(
    profile: Extract<GatewayFaultProfile, { readonly kind: 'stale_state' }>,
  ): string {
    return new Date(
      Math.max(
        Date.parse(this.clock.startsAt),
        this.clock.nowEpochMilliseconds - profile.staleByVirtualMilliseconds,
      ),
    ).toISOString()
  }

  #observeCommandDevice(command: GatewayCommand, at: string): GatewayCallbackEvidence {
    return GatewayCallbackEvidenceSchema.parse(
      this.deviceModel.observeDevice({
        organizationId: command.organizationId,
        missionId: command.missionId,
        palaceId: command.palaceId,
        deviceId: command.payload.deviceId,
        at,
      }),
    )
  }

  #instruction(command: GatewayCommand): Parameters<DeterministicDeviceModel['apply']>[0] {
    const common = {
      organizationId: command.organizationId,
      missionId: command.missionId,
      palaceId: command.palaceId,
      deviceId: command.payload.deviceId,
      at: this.clock.now,
    }
    switch (command.kind) {
      case 'set_temperature':
        return {
          ...common,
          kind: 'set_temperature',
          targetCelsius: command.payload.targetCelsius,
          completeAt: command.payload.completeAt,
          causedByEvidenceId: command.payload.causedByEvidenceId,
        }
      case 'set_lighting':
        return {
          ...common,
          kind: 'set_lighting',
          intensityPercent: command.payload.intensityPercent,
          durationSeconds: command.payload.durationSeconds,
          causedByEvidenceId: command.payload.causedByEvidenceId,
        }
      case 'unlock':
        return {
          ...common,
          kind: 'unlock',
          identityTagId: command.payload.identityTagId,
          durationSeconds: command.payload.durationSeconds,
          causedByEvidenceId: command.payload.causedByEvidenceId,
        }
      case 'locked_desired_state':
        return {
          ...common,
          kind: 'locked_desired_state',
          causedByEvidenceId: command.payload.causedByEvidenceId,
        }
    }
  }

  #scheduleCallback(
    command: GatewayCommand,
    status: GatewayCallback['status'],
    evidence: CallbackEvidenceFactory,
    effectDelay: number,
    deliveryDelay: number,
    copies: number,
    separation: number,
    code: string | null,
  ): void {
    const captureEffect = () => {
      const occurredAt = this.clock.now
      const callback = GatewayCallbackSchema.parse({
        id: callbackId(command, status),
        organizationId: command.organizationId,
        missionId: command.missionId,
        palaceId: command.palaceId,
        commandId: command.id,
        operationId: command.operationId,
        status,
        occurredAt,
        nonce: callbackNonce(command, status),
        evidence: [
          ...evidence(),
          GatewayDeliveryEvidenceSchema.parse({
            id: `evd_${stableDigest('gateway-delivery', command.id, status).slice(0, 32)}`,
            organizationId: command.organizationId,
            missionId: command.missionId,
            palaceId: command.palaceId,
            observedAt: occurredAt,
            type: 'gateway_delivery',
            gatewayCommandId: command.id,
            operationId: command.operationId,
            status,
            code,
          }),
        ],
      })
      const boundCallback = validateGatewayCommandCallbackBinding(command, callback).callback
      let signed: SignedGatewayCallback | undefined
      const deliver = () => {
        const signatureNow = this.#signatureClock.now()
        if (!Number.isFinite(signatureNow.valueOf())) {
          throw new TypeError('Gateway signature clock returned an invalid instant')
        }
        signed ??= signGatewayCallback(boundCallback, {
          keyId: this.#signingKeyId,
          key: this.#signingKey,
          timestamp: signatureNow.toISOString(),
        })
        this.#deliveredCallbacks.push(signed)
        this.#onCallback?.(signed)
      }
      for (let copy = 0; copy < copies; copy += 1) {
        this.clock.scheduleAfter(
          deliveryDelay + copy * separation,
          deliver,
          `gateway-callback:${command.id}:${copy + 1}`,
        )
      }
    }
    this.clock.scheduleAfter(effectDelay, captureEffect, `gateway-effect:${command.id}`)
  }
}

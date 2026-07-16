import { createHash } from 'node:crypto'

import {
  FLAGSHIP_UNVERIFIED_ARRIVAL_AT,
  FLAGSHIP_VERIFIED_ARRIVAL_AT,
  IdentityTelemetryEventSchema,
  type GatewayCommand,
  type MissionId,
  type OrganizationId,
  type PalaceId,
} from '@trash-palace/core'
import type { VirtualClock, VirtualClockTaskHandle } from '@trash-palace/testkit'

import type { BoundedIdentityTelemetryDelivery } from './identity-delivery.js'
import { signIdentityTelemetry, type IdentityTelemetrySigningKey } from './identity-signing.js'
import { GatewayCommandAdmissionError } from './simulator.js'

export type IdentityArrivalLaneErrorCode =
  'IDENTITY_ARRIVAL_DELIVERY_TIMEOUT' | 'IDENTITY_MISSION_BINDING_CONFLICT'

export class IdentityArrivalLaneError extends Error {
  public readonly code: IdentityArrivalLaneErrorCode

  public constructor(code: IdentityArrivalLaneErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IdentityArrivalLaneError'
    this.code = code
  }
}

export interface IdentityArrivalWallClock {
  now(): Date
}

export interface IdentityMissionBinding {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly palaceId: PalaceId
}

export interface CanonicalIdentityArrivalLaneOptions {
  readonly clock: VirtualClock
  readonly delivery: BoundedIdentityTelemetryDelivery
  readonly signingKeyId: string
  readonly signingKey: IdentityTelemetrySigningKey
  readonly wallClock?: IdentityArrivalWallClock
}

interface CanonicalArrival {
  readonly kind: 'unverified' | 'verified'
  readonly identityTagId: 'tag_rocky_verified' | 'tag_unknown_guest'
  readonly observedAt: string
}

const CANONICAL_ARRIVALS: readonly CanonicalArrival[] = Object.freeze([
  Object.freeze({
    kind: 'unverified',
    identityTagId: 'tag_unknown_guest',
    observedAt: FLAGSHIP_UNVERIFIED_ARRIVAL_AT,
  }),
  Object.freeze({
    kind: 'verified',
    identityTagId: 'tag_rocky_verified',
    observedAt: FLAGSHIP_VERIFIED_ARRIVAL_AT,
  }),
])

const SYSTEM_WALL_CLOCK: IdentityArrivalWallClock = { now: () => new Date() }

/**
 * Binds the canonical arrival source to one mission before emitting sender-owned telemetry.
 * Identity authority remains the web verifier's responsibility; tag names convey fixture intent.
 */
export class CanonicalIdentityArrivalLane {
  readonly #clock: VirtualClock
  readonly #delivery: BoundedIdentityTelemetryDelivery
  readonly #signingKeyId: string
  readonly #signingKey: IdentityTelemetrySigningKey
  readonly #wallClock: IdentityArrivalWallClock
  readonly #scheduled: VirtualClockTaskHandle[] = []
  readonly #pendingArrivals: CanonicalArrival[] = []
  #binding: IdentityMissionBinding | undefined
  #deliveryTail: Promise<void> = Promise.resolve()
  #terminalFailure: unknown
  #scheduledOnce = false

  public constructor(options: CanonicalIdentityArrivalLaneOptions) {
    this.#clock = options.clock
    this.#delivery = options.delivery
    this.#signingKeyId = options.signingKeyId
    this.#signingKey = options.signingKey
    this.#wallClock = options.wallClock ?? SYSTEM_WALL_CLOCK
  }

  public get binding(): IdentityMissionBinding | null {
    return this.#binding === undefined ? null : structuredClone(this.#binding)
  }

  public get isReady(): boolean {
    return this.#terminalFailure === undefined && this.#delivery.isReady
  }

  public schedule(): void {
    if (this.#scheduledOnce) return
    this.#scheduledOnce = true
    for (const arrival of CANONICAL_ARRIVALS) {
      this.#scheduled.push(
        this.#clock.scheduleAt(
          arrival.observedAt,
          () => this.#emit(arrival),
          `identity-arrival:${arrival.kind}`,
        ),
      )
    }
  }

  public bind(command: GatewayCommand): void {
    const candidate: IdentityMissionBinding = Object.freeze({
      organizationId: command.organizationId,
      missionId: command.missionId,
      palaceId: command.palaceId,
    })
    if (this.#binding === undefined) {
      this.#binding = candidate
      for (const arrival of this.#pendingArrivals.splice(0)) this.#emit(arrival)
      return
    }
    if (
      this.#binding.organizationId === candidate.organizationId &&
      this.#binding.missionId === candidate.missionId &&
      this.#binding.palaceId === candidate.palaceId
    ) {
      return
    }
    const error = new IdentityArrivalLaneError(
      'IDENTITY_MISSION_BINDING_CONFLICT',
      'Gateway identity arrivals are already bound to a different mission context',
    )
    this.#fail(error)
    throw new GatewayCommandAdmissionError(error.code, error.message)
  }

  public cancelScheduled(): number {
    let cancelled = 0
    for (const task of this.#scheduled) {
      if (task.cancel()) cancelled += 1
    }
    return cancelled
  }

  public async start(): Promise<void> {
    await this.#delivery.start()
  }

  public async drain(timeoutMilliseconds: number): Promise<void> {
    this.cancelScheduled()
    const startedAt = Date.now()
    let sequencingFailure: unknown
    try {
      await withTimeout(this.#deliveryTail, timeoutMilliseconds)
    } catch (error) {
      sequencingFailure = error
    }
    const remaining = Math.max(1, timeoutMilliseconds - (Date.now() - startedAt))
    let deliveryFailure: unknown
    try {
      await this.#delivery.drain(remaining)
    } catch (error) {
      deliveryFailure = error
    }
    if (sequencingFailure !== undefined) throw asError(sequencingFailure)
    if (deliveryFailure !== undefined) throw asError(deliveryFailure)
    if (this.#terminalFailure !== undefined) throw asError(this.#terminalFailure)
  }

  #emit(arrival: CanonicalArrival): void {
    const binding = this.#binding
    if (binding === undefined) {
      this.#pendingArrivals.push(arrival)
      return
    }
    if (this.#terminalFailure !== undefined) throw asError(this.#terminalFailure)

    const observedAt = this.#clock.now
    const event = IdentityTelemetryEventSchema.parse({
      schemaVersion: 'identity-telemetry-event@1',
      providerEventId: providerEventId(binding.missionId, arrival.kind),
      organizationId: binding.organizationId,
      missionId: binding.missionId,
      palaceId: binding.palaceId,
      identityTagId: arrival.identityTagId,
      observedAt,
      nonce: eventNonce(binding.missionId, arrival.kind),
    })
    const wallNow = this.#wallClock.now()
    if (!Number.isFinite(wallNow.valueOf())) {
      const error = new TypeError('Identity arrival wall clock returned an invalid instant')
      this.#fail(error)
      throw error
    }
    const signed = signIdentityTelemetry(event, {
      keyId: this.#signingKeyId,
      key: this.#signingKey,
      timestamp: wallNow.toISOString(),
    })
    const delivery = this.#deliveryTail.then(async () => {
      if (this.#terminalFailure !== undefined) throw asError(this.#terminalFailure)
      await this.#delivery.enqueue(signed)
    })
    this.#deliveryTail = delivery.catch((error: unknown) => {
      this.#fail(error)
    })
  }

  #fail(error: unknown): void {
    this.#terminalFailure ??= error
  }
}

function providerEventId(missionId: MissionId, kind: CanonicalArrival['kind']): string {
  return `idt_${digest(['canonical-arrival', missionId, kind]).slice(0, 32)}`
}

function eventNonce(missionId: MissionId, kind: CanonicalArrival['kind']): string {
  return `itn_${digest(['canonical-arrival-nonce', missionId, kind])}`
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url')
}

async function withTimeout(work: Promise<void>, timeoutMilliseconds: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new IdentityArrivalLaneError(
            'IDENTITY_ARRIVAL_DELIVERY_TIMEOUT',
            'Canonical identity arrival delivery did not settle before shutdown',
          ),
        ),
      timeoutMilliseconds,
    )
    timeout.unref()
  })
  try {
    await Promise.race([work, deadline])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error('Identity arrival lane failed', { cause: value })
}

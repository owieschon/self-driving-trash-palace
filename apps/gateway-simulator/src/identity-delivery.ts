import { createHash } from 'node:crypto'

import { SignedIdentityTelemetrySchema, type SignedIdentityTelemetry } from '@trash-palace/core'

export type IdentityTelemetryDeliveryErrorCode =
  | 'IDENTITY_TELEMETRY_DELIVERY_CLOSED'
  | 'IDENTITY_TELEMETRY_DELIVERY_CONFLICT'
  | 'IDENTITY_TELEMETRY_DELIVERY_EXHAUSTED'
  | 'IDENTITY_TELEMETRY_DELIVERY_PERMANENT_REJECTION'
  | 'IDENTITY_TELEMETRY_DELIVERY_QUEUE_FULL'
  | 'IDENTITY_TELEMETRY_DELIVERY_TIMEOUT'

export class IdentityTelemetryDeliveryError extends Error {
  public readonly code: IdentityTelemetryDeliveryErrorCode

  public constructor(
    code: IdentityTelemetryDeliveryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'IdentityTelemetryDeliveryError'
    this.code = code
  }
}

export interface IdentityTelemetryDeliveryConfiguration {
  readonly telemetryUrl: string
  readonly readinessUrl: string
  readonly maximumAttempts: number
  readonly initialBackoffMilliseconds: number
  readonly maximumBackoffMilliseconds: number
  readonly requestTimeoutMilliseconds: number
  readonly readinessIntervalMilliseconds: number
  readonly maximumTrackedEvents: number
}

export interface IdentityTelemetryDeliveryDependencies {
  readonly fetch: typeof fetch
  readonly sleep: (milliseconds: number) => Promise<void>
}

type DeliveryState = 'delivered' | 'failed' | 'pending'

interface DeliveryRecord {
  readonly providerEventId: string
  readonly fingerprint: string
  promise: Promise<void>
  state: DeliveryState
}

const defaultDependencies: IdentityTelemetryDeliveryDependencies = {
  fetch: globalThis.fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

function fingerprint(telemetry: SignedIdentityTelemetry): string {
  return createHash('sha256').update(JSON.stringify(telemetry)).digest('hex')
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/**
 * Delivers signed identity telemetry to the fixed web ingress with bounded in-memory tracking.
 * Provider event IDs are the replay identity; reusing one for different signed bytes fails closed.
 */
export class BoundedIdentityTelemetryDelivery {
  readonly #configuration: IdentityTelemetryDeliveryConfiguration
  readonly #dependencies: IdentityTelemetryDeliveryDependencies
  readonly #records = new Map<string, DeliveryRecord>()
  readonly #pending = new Set<Promise<void>>()
  #accepting = false
  #dependencyHealthy = false
  #terminalDeliveryFailure = false
  #healthTimer: NodeJS.Timeout | undefined
  #probeInFlight: Promise<void> | undefined

  public constructor(
    configuration: IdentityTelemetryDeliveryConfiguration,
    dependencies: Partial<IdentityTelemetryDeliveryDependencies> = {},
  ) {
    this.#configuration = configuration
    this.#dependencies = { ...defaultDependencies, ...dependencies }
  }

  public get isReady(): boolean {
    return (
      this.#accepting &&
      this.#dependencyHealthy &&
      !this.#terminalDeliveryFailure &&
      this.#pending.size < this.#configuration.maximumTrackedEvents
    )
  }

  public get pendingCount(): number {
    return this.#pending.size
  }

  public get trackedCount(): number {
    return this.#records.size
  }

  public async start(): Promise<void> {
    if (this.#accepting) return
    this.#accepting = true
    await this.probeDependency()
    this.#healthTimer = setInterval(() => {
      void this.probeDependency()
    }, this.#configuration.readinessIntervalMilliseconds)
    this.#healthTimer.unref()
  }

  public async probeDependency(): Promise<void> {
    if (this.#probeInFlight !== undefined) return this.#probeInFlight
    const probe = this.#probe()
    this.#probeInFlight = probe
    try {
      await probe
    } finally {
      this.#probeInFlight = undefined
    }
  }

  public enqueue(input: unknown): Promise<void> {
    if (!this.#accepting) {
      return Promise.reject(
        new IdentityTelemetryDeliveryError(
          'IDENTITY_TELEMETRY_DELIVERY_CLOSED',
          'Identity telemetry delivery is not accepting events',
        ),
      )
    }
    const telemetry = SignedIdentityTelemetrySchema.parse(input)
    const providerEventId = telemetry.event.providerEventId
    const digest = fingerprint(telemetry)
    const existing = this.#records.get(providerEventId)
    if (existing !== undefined) {
      if (existing.fingerprint !== digest) {
        this.#terminalDeliveryFailure = true
        return Promise.reject(
          new IdentityTelemetryDeliveryError(
            'IDENTITY_TELEMETRY_DELIVERY_CONFLICT',
            'An identity provider event ID was queued with a different signed payload',
          ),
        )
      }
      return existing.promise
    }
    if (!this.#makeCapacity()) {
      this.#terminalDeliveryFailure = true
      return Promise.reject(
        new IdentityTelemetryDeliveryError(
          'IDENTITY_TELEMETRY_DELIVERY_QUEUE_FULL',
          'Identity telemetry delivery reached its configured tracking bound',
        ),
      )
    }

    const record: DeliveryRecord = {
      providerEventId,
      fingerprint: digest,
      promise: Promise.resolve(),
      state: 'pending',
    }
    const delivery = this.#deliver(telemetry)
      .then(() => {
        record.state = 'delivered'
      })
      .catch((error: unknown) => {
        record.state = 'failed'
        this.#terminalDeliveryFailure = true
        throw error
      })
      .finally(() => this.#pending.delete(delivery))
    record.promise = delivery
    this.#records.set(providerEventId, record)
    this.#pending.add(delivery)
    return delivery
  }

  public async drain(timeoutMilliseconds: number): Promise<void> {
    this.#accepting = false
    if (this.#healthTimer !== undefined) clearInterval(this.#healthTimer)
    this.#healthTimer = undefined
    if (this.#probeInFlight !== undefined) await this.#probeInFlight
    const deliveries = [...this.#pending]
    if (deliveries.length === 0) {
      this.#assertNoFailedDeliveries()
      return
    }

    let timeout: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new IdentityTelemetryDeliveryError(
              'IDENTITY_TELEMETRY_DELIVERY_TIMEOUT',
              'Identity telemetry delivery did not drain before shutdown',
            ),
          ),
        timeoutMilliseconds,
      )
      timeout.unref()
    })
    try {
      const settled = await Promise.race([Promise.allSettled(deliveries), deadline])
      const failures = settled.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (failures.length > 0) {
        throw new IdentityTelemetryDeliveryError(
          'IDENTITY_TELEMETRY_DELIVERY_EXHAUSTED',
          `${failures.length} identity telemetry delivery attempt(s) exhausted`,
          { cause: failures[0]?.reason },
        )
      }
      this.#assertNoFailedDeliveries()
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  async #probe(): Promise<void> {
    try {
      const response = await this.#dependencies.fetch(this.#configuration.readinessUrl, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.#configuration.requestTimeoutMilliseconds),
      })
      this.#dependencyHealthy = response.ok
      await response.body?.cancel().catch(() => undefined)
    } catch {
      this.#dependencyHealthy = false
    }
  }

  #makeCapacity(): boolean {
    if (this.#records.size < this.#configuration.maximumTrackedEvents) return true
    for (const [providerEventId, record] of this.#records) {
      if (record.state !== 'delivered') continue
      this.#records.delete(providerEventId)
      return true
    }
    return false
  }

  #assertNoFailedDeliveries(): void {
    const failed = [...this.#records.values()].filter((record) => record.state === 'failed').length
    if (failed > 0) {
      throw new IdentityTelemetryDeliveryError(
        'IDENTITY_TELEMETRY_DELIVERY_EXHAUSTED',
        `${failed} identity telemetry delivery attempt(s) previously exhausted`,
      )
    }
    if (this.#terminalDeliveryFailure) {
      throw new IdentityTelemetryDeliveryError(
        'IDENTITY_TELEMETRY_DELIVERY_EXHAUSTED',
        'Identity telemetry delivery recorded a terminal integrity or capacity failure',
      )
    }
  }

  async #deliver(telemetry: SignedIdentityTelemetry): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.#configuration.maximumAttempts; attempt += 1) {
      try {
        const response = await this.#dependencies.fetch(this.#configuration.telemetryUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-trash-palace-identity-event-id': telemetry.event.providerEventId,
          },
          body: JSON.stringify(telemetry),
          redirect: 'error',
          signal: AbortSignal.timeout(this.#configuration.requestTimeoutMilliseconds),
        })
        await response.body?.cancel().catch(() => undefined)
        if (response.ok) {
          this.#dependencyHealthy = true
          return
        }
        this.#dependencyHealthy = false
        if (!retryableStatus(response.status)) {
          throw new IdentityTelemetryDeliveryError(
            'IDENTITY_TELEMETRY_DELIVERY_PERMANENT_REJECTION',
            `Identity telemetry target permanently rejected delivery with status ${response.status}`,
          )
        }
        lastError = new Error(
          `Identity telemetry target returned retryable status ${response.status}`,
        )
      } catch (error) {
        if (
          error instanceof IdentityTelemetryDeliveryError &&
          error.code === 'IDENTITY_TELEMETRY_DELIVERY_PERMANENT_REJECTION'
        ) {
          throw error
        }
        this.#dependencyHealthy = false
        lastError = error
      }
      if (attempt < this.#configuration.maximumAttempts) {
        await this.#dependencies.sleep(this.#backoff(attempt))
      }
    }
    throw new IdentityTelemetryDeliveryError(
      'IDENTITY_TELEMETRY_DELIVERY_EXHAUSTED',
      `Identity telemetry delivery exhausted ${this.#configuration.maximumAttempts} bounded attempt(s)`,
      { cause: lastError },
    )
  }

  #backoff(completedAttempt: number): number {
    return Math.min(
      this.#configuration.maximumBackoffMilliseconds,
      this.#configuration.initialBackoffMilliseconds * 2 ** (completedAttempt - 1),
    )
  }
}

import { createHash } from 'node:crypto'

import { SignedGatewayCallbackSchema, type SignedGatewayCallback } from './contracts.js'

export type CallbackDeliveryErrorCode =
  | 'CALLBACK_DELIVERY_CLOSED'
  | 'CALLBACK_DELIVERY_CONFLICT'
  | 'CALLBACK_DELIVERY_EXHAUSTED'
  | 'CALLBACK_DELIVERY_PERMANENT_REJECTION'
  | 'CALLBACK_DELIVERY_QUEUE_FULL'
  | 'CALLBACK_DELIVERY_TIMEOUT'

export class CallbackDeliveryError extends Error {
  public readonly code: CallbackDeliveryErrorCode

  public constructor(code: CallbackDeliveryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CallbackDeliveryError'
    this.code = code
  }
}

export interface CallbackDeliveryConfiguration {
  readonly callbackUrl: string
  readonly readinessUrl: string
  readonly maximumAttempts: number
  readonly initialBackoffMilliseconds: number
  readonly maximumBackoffMilliseconds: number
  readonly requestTimeoutMilliseconds: number
  readonly readinessIntervalMilliseconds: number
  readonly maximumTrackedCallbacks: number
}

export interface CallbackDeliveryDependencies {
  readonly fetch: typeof fetch
  readonly sleep: (milliseconds: number) => Promise<void>
}

type DeliveryState = 'delivered' | 'failed' | 'pending'

interface DeliveryRecord {
  readonly callbackId: string
  readonly fingerprint: string
  promise: Promise<void>
  state: DeliveryState
}

const defaultDependencies: CallbackDeliveryDependencies = {
  fetch: globalThis.fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

function fingerprint(callback: SignedGatewayCallback): string {
  return createHash('sha256').update(JSON.stringify(callback)).digest('hex')
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export class BoundedGatewayCallbackDelivery {
  readonly #configuration: CallbackDeliveryConfiguration
  readonly #dependencies: CallbackDeliveryDependencies
  readonly #records = new Map<string, DeliveryRecord>()
  readonly #pending = new Set<Promise<void>>()
  #accepting = false
  #dependencyHealthy = false
  #terminalDeliveryFailure = false
  #healthTimer: NodeJS.Timeout | undefined
  #probeInFlight: Promise<void> | undefined

  public constructor(
    configuration: CallbackDeliveryConfiguration,
    dependencies: Partial<CallbackDeliveryDependencies> = {},
  ) {
    this.#configuration = configuration
    this.#dependencies = { ...defaultDependencies, ...dependencies }
  }

  public get isReady(): boolean {
    return (
      this.#accepting &&
      this.#dependencyHealthy &&
      !this.#terminalDeliveryFailure &&
      this.#pending.size < this.#configuration.maximumTrackedCallbacks
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
        new CallbackDeliveryError(
          'CALLBACK_DELIVERY_CLOSED',
          'Gateway callback delivery is not accepting callbacks',
        ),
      )
    }
    const callback = SignedGatewayCallbackSchema.parse(input)
    const callbackId = callback.callback.id
    const digest = fingerprint(callback)
    const existing = this.#records.get(callbackId)
    if (existing !== undefined) {
      if (existing.fingerprint !== digest) {
        this.#terminalDeliveryFailure = true
        return Promise.reject(
          new CallbackDeliveryError(
            'CALLBACK_DELIVERY_CONFLICT',
            'A gateway callback ID was queued with a different signed payload',
          ),
        )
      }
      return existing.promise
    }
    if (!this.#makeCapacity()) {
      this.#terminalDeliveryFailure = true
      return Promise.reject(
        new CallbackDeliveryError(
          'CALLBACK_DELIVERY_QUEUE_FULL',
          'Gateway callback delivery reached its configured tracking bound',
        ),
      )
    }

    const record: DeliveryRecord = {
      callbackId,
      fingerprint: digest,
      promise: Promise.resolve(),
      state: 'pending',
    }
    const delivery = this.#deliver(callback)
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
    this.#records.set(callbackId, record)
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
            new CallbackDeliveryError(
              'CALLBACK_DELIVERY_TIMEOUT',
              'Gateway callback delivery did not drain before shutdown',
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
        throw new CallbackDeliveryError(
          'CALLBACK_DELIVERY_EXHAUSTED',
          `${failures.length} gateway callback delivery attempt(s) exhausted`,
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
    if (this.#records.size < this.#configuration.maximumTrackedCallbacks) return true
    for (const [callbackId, record] of this.#records) {
      if (record.state !== 'delivered') continue
      this.#records.delete(callbackId)
      return true
    }
    return false
  }

  #assertNoFailedDeliveries(): void {
    const failed = [...this.#records.values()].filter((record) => record.state === 'failed').length
    if (failed > 0) {
      throw new CallbackDeliveryError(
        'CALLBACK_DELIVERY_EXHAUSTED',
        `${failed} gateway callback delivery attempt(s) previously exhausted`,
      )
    }
    if (this.#terminalDeliveryFailure) {
      throw new CallbackDeliveryError(
        'CALLBACK_DELIVERY_EXHAUSTED',
        'Gateway callback delivery recorded a terminal integrity or capacity failure',
      )
    }
  }

  async #deliver(callback: SignedGatewayCallback): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.#configuration.maximumAttempts; attempt += 1) {
      try {
        const response = await this.#dependencies.fetch(this.#configuration.callbackUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-trash-palace-callback-id': callback.callback.id,
          },
          body: JSON.stringify(callback),
          redirect: 'error',
          signal: AbortSignal.timeout(this.#configuration.requestTimeoutMilliseconds),
        })
        this.#dependencyHealthy = true
        await response.body?.cancel().catch(() => undefined)
        if (response.ok) return
        if (!retryableStatus(response.status)) {
          throw new CallbackDeliveryError(
            'CALLBACK_DELIVERY_PERMANENT_REJECTION',
            `Gateway callback target permanently rejected delivery with status ${response.status}`,
          )
        }
        lastError = new Error(
          `Gateway callback target returned retryable status ${response.status}`,
        )
      } catch (error) {
        if (
          error instanceof CallbackDeliveryError &&
          error.code === 'CALLBACK_DELIVERY_PERMANENT_REJECTION'
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
    throw new CallbackDeliveryError(
      'CALLBACK_DELIVERY_EXHAUSTED',
      `Gateway callback delivery exhausted ${this.#configuration.maximumAttempts} bounded attempt(s)`,
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

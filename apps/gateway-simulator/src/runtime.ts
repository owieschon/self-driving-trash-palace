import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import {
  FLAGSHIP_CLOCK_RUNNING_AT,
  FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
} from '@trash-palace/core'

import {
  BoundedGatewayCallbackDelivery,
  type CallbackDeliveryDependencies,
} from './callback-delivery.js'
import { createCanonicalGatewayDeviceRuntime } from './canonical-fixture.js'
import { VirtualClockDriver } from './clock-driver.js'
import type { GatewaySimulatorConfiguration } from './configuration.js'
import {
  PRIVATE_GATEWAY_CALLBACK_URL,
  PRIVATE_IDENTITY_TELEMETRY_URL,
  PRIVATE_WEB_READINESS_URL,
  type SignedGatewayCallback,
} from './contracts.js'
import {
  CanonicalIdentityArrivalLane,
  type IdentityArrivalWallClock,
} from './identity-arrival-lane.js'
import {
  BoundedIdentityTelemetryDelivery,
  type IdentityTelemetryDeliveryDependencies,
} from './identity-delivery.js'
import { createGatewaySimulatorServer } from './server.js'
import { GatewaySimulator } from './simulator.js'

export type GatewaySimulatorProcessState =
  'created' | 'starting' | 'running' | 'draining' | 'stopped'

export interface GatewaySimulatorRuntimeDependencies {
  readonly callbackDelivery?: Partial<CallbackDeliveryDependencies>
  readonly identityDelivery?: Partial<IdentityTelemetryDeliveryDependencies>
  readonly wallClock?: IdentityArrivalWallClock
}

export class GatewaySimulatorProcess {
  readonly #configuration: GatewaySimulatorConfiguration
  readonly #server: Server
  readonly #clockDriver: VirtualClockDriver
  readonly #callbackDelivery: BoundedGatewayCallbackDelivery
  readonly #identityArrivals: CanonicalIdentityArrivalLane
  #state: GatewaySimulatorProcessState = 'created'
  #stopPromise: Promise<void> | undefined

  public constructor(options: {
    readonly configuration: GatewaySimulatorConfiguration
    readonly server: Server
    readonly clockDriver: VirtualClockDriver
    readonly callbackDelivery: BoundedGatewayCallbackDelivery
    readonly identityArrivals: CanonicalIdentityArrivalLane
  }) {
    this.#configuration = options.configuration
    this.#server = options.server
    this.#clockDriver = options.clockDriver
    this.#callbackDelivery = options.callbackDelivery
    this.#identityArrivals = options.identityArrivals
  }

  public get state(): GatewaySimulatorProcessState {
    return this.#state
  }

  public get isReady(): boolean {
    return (
      this.#state === 'running' &&
      this.#clockDriver.isHealthy &&
      this.#callbackDelivery.isReady &&
      this.#identityArrivals.isReady
    )
  }

  public get address(): AddressInfo | null {
    const address = this.#server.address()
    return address !== null && typeof address !== 'string' ? address : null
  }

  public async start(): Promise<void> {
    if (this.#state !== 'created') {
      throw new Error(`Gateway simulator cannot start from ${this.#state} state`)
    }
    this.#state = 'starting'
    try {
      await Promise.all([this.#callbackDelivery.start(), this.#identityArrivals.start()])
      this.#server.listen(this.#configuration.port, this.#configuration.bindHost)
      await once(this.#server, 'listening')
      this.#clockDriver.start()
      this.#state = 'running'
    } catch (error) {
      this.#clockDriver.stop()
      this.#identityArrivals.cancelScheduled()
      await this.#closeServer().catch(() => undefined)
      await Promise.allSettled([
        this.#callbackDelivery.drain(this.#configuration.shutdownTimeoutMilliseconds),
        this.#identityArrivals.drain(this.#configuration.shutdownTimeoutMilliseconds),
      ])
      this.#state = 'stopped'
      throw error
    }
  }

  public stop(): Promise<void> {
    if (this.#state === 'stopped') return Promise.resolve()
    this.#stopPromise ??= this.#drainAndStop()
    return this.#stopPromise
  }

  async #drainAndStop(): Promise<void> {
    if (this.#state === 'created') {
      this.#identityArrivals.cancelScheduled()
      this.#state = 'stopped'
      return
    }
    this.#state = 'draining'
    const failures: unknown[] = []
    const deadline = Date.now() + this.#configuration.shutdownTimeoutMilliseconds
    const remaining = () => Math.max(1, deadline - Date.now())

    await this.#closeServer(remaining()).catch((error: unknown) => failures.push(error))
    this.#identityArrivals.cancelScheduled()
    try {
      this.#clockDriver.flushAndStop()
    } catch (error) {
      failures.push(error)
    }
    await this.#callbackDelivery.drain(remaining()).catch((error: unknown) => failures.push(error))
    await this.#identityArrivals.drain(remaining()).catch((error: unknown) => failures.push(error))
    this.#state = 'stopped'
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Gateway simulator shutdown did not drain cleanly')
    }
  }

  async #closeServer(
    timeoutMilliseconds = this.#configuration.shutdownTimeoutMilliseconds,
  ): Promise<void> {
    if (!this.#server.listening) return
    let timeout: NodeJS.Timeout | undefined
    const closed = new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        this.#server.closeAllConnections()
        reject(new Error('Gateway HTTP server did not drain before shutdown'))
      }, timeoutMilliseconds)
      timeout.unref()
    })
    try {
      await Promise.race([closed, deadline])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
}

export function createGatewaySimulatorProcess(
  configuration: GatewaySimulatorConfiguration,
  dependencies: GatewaySimulatorRuntimeDependencies = {},
): GatewaySimulatorProcess {
  const callbackDelivery = new BoundedGatewayCallbackDelivery(
    {
      callbackUrl: PRIVATE_GATEWAY_CALLBACK_URL,
      readinessUrl: PRIVATE_WEB_READINESS_URL,
      maximumAttempts: configuration.callbackDelivery.maximumAttempts,
      initialBackoffMilliseconds: configuration.callbackDelivery.initialBackoffMilliseconds,
      maximumBackoffMilliseconds: configuration.callbackDelivery.maximumBackoffMilliseconds,
      requestTimeoutMilliseconds: configuration.callbackDelivery.requestTimeoutMilliseconds,
      readinessIntervalMilliseconds: configuration.callbackDelivery.readinessIntervalMilliseconds,
      maximumTrackedCallbacks: configuration.callbackDelivery.maximumTrackedCallbacks,
    },
    dependencies.callbackDelivery,
  )
  const identityDelivery = new BoundedIdentityTelemetryDelivery(
    {
      telemetryUrl: PRIVATE_IDENTITY_TELEMETRY_URL,
      readinessUrl: PRIVATE_WEB_READINESS_URL,
      maximumAttempts: configuration.identityDelivery.maximumAttempts,
      initialBackoffMilliseconds: configuration.identityDelivery.initialBackoffMilliseconds,
      maximumBackoffMilliseconds: configuration.identityDelivery.maximumBackoffMilliseconds,
      requestTimeoutMilliseconds: configuration.identityDelivery.requestTimeoutMilliseconds,
      readinessIntervalMilliseconds: configuration.identityDelivery.readinessIntervalMilliseconds,
      maximumTrackedEvents: configuration.identityDelivery.maximumTrackedEvents,
    },
    dependencies.identityDelivery,
  )
  const { clock, deviceModel } = createCanonicalGatewayDeviceRuntime()
  const wallClock = dependencies.wallClock ?? { now: () => new Date() }
  const identityArrivals = new CanonicalIdentityArrivalLane({
    clock,
    delivery: identityDelivery,
    signingKeyId: configuration.identitySigningKeyId,
    signingKey: configuration.identitySigningKey,
    wallClock,
  })
  // Arrival tasks must exist before accelerated fixture time can advance past their instants.
  identityArrivals.schedule()
  const simulator = new GatewaySimulator({
    clock,
    deviceModel,
    faultProfile: configuration.faultProfile,
    signingKeyId: configuration.signingKeyId,
    signingKey: configuration.signingKey,
    signatureClock: wallClock,
    admitPrimaryCommand: (command) => identityArrivals.bind(command),
    onCallback: (callback: SignedGatewayCallback) => {
      // Readiness carries terminal delivery failure; catching here prevents a rejected transport
      // promise from becoming an unrelated process-level unhandled rejection.
      void callbackDelivery.enqueue(callback).catch(() => undefined)
    },
  })
  const clockDriver = new VirtualClockDriver(clock, {
    realMillisecondsPerVirtualMinute: FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
    advanceToOnStart: FLAGSHIP_CLOCK_RUNNING_AT,
    ...(configuration.clock.mode === 'anchored'
      ? { requiredRealStartAt: configuration.clock.realStartAt }
      : {}),
  })
  const runtimeReference: { current?: GatewaySimulatorProcess } = {}
  const server = createGatewaySimulatorServer(simulator, {
    isReady: () => runtimeReference.current?.isReady ?? false,
  })
  const runtime = new GatewaySimulatorProcess({
    configuration,
    server,
    clockDriver,
    callbackDelivery,
    identityArrivals,
  })
  runtimeReference.current = runtime
  return runtime
}

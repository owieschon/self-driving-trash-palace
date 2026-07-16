import { WorkerHealthServer, type WorkerHealthState } from './health-server.js'
import type { ProductionWorkerResources } from './production-runtime.js'
import type { WorkerServerConfiguration } from './server-configuration.js'

export interface WorkerProcessDependencies {
  readonly runtime: Pick<ProductionWorkerResources['graph']['runtime'], 'start' | 'stop'>
  readonly deliverPendingEvidence: (limit: number) => Promise<number>
  readonly deliverPendingProductEvidence?: (limit: number) => Promise<number>
  readonly probeEvidenceSink: () => Promise<void>
  readonly probeDatabase: () => Promise<void>
  readonly closeDatabase: () => Promise<void>
  readonly health: Pick<WorkerHealthServer, 'start' | 'stop'>
}

type WorkerProcessPhase = WorkerHealthState['phase']

/** Owns startup and shutdown ordering for one executable worker process. */
export class ProductionWorkerProcess {
  #phase: WorkerProcessPhase = 'starting'
  #runtimeStarted = false
  #healthStarted = false
  #databaseClosed = false
  #startPromise: Promise<void> | null = null
  #stopPromise: Promise<void> | null = null

  public constructor(private readonly dependencies: WorkerProcessDependencies) {}

  public start(): Promise<void> {
    if (this.#startPromise !== null) return this.#startPromise
    if (this.#phase !== 'starting') throw new Error('Worker process cannot be restarted')
    this.#startPromise = this.#start()
    return this.#startPromise
  }

  public stop(): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise
    this.#stopPromise = this.#stop()
    return this.#stopPromise
  }

  public async healthState(): Promise<WorkerHealthState> {
    const live = !['failed', 'stopped'].includes(this.#phase)
    if (this.#phase !== 'running') return { live, ready: false, phase: this.#phase }
    try {
      await this.dependencies.probeDatabase()
      return { live: true, ready: true, phase: 'running' }
    } catch {
      return { live: true, ready: false, phase: 'running' }
    }
  }

  async #start(): Promise<void> {
    try {
      await this.dependencies.health.start()
      this.#healthStarted = true
      await this.dependencies.probeDatabase()
      await this.dependencies.probeEvidenceSink()
      await drainEvidence(this.dependencies.deliverPendingEvidence)
      if (this.dependencies.deliverPendingProductEvidence !== undefined) {
        await drainEvidence(this.dependencies.deliverPendingProductEvidence)
      }
      this.#runtimeStarted = true
      await this.dependencies.runtime.start()
      await this.dependencies.probeDatabase()
      this.#phase = 'running'
    } catch (error) {
      this.#phase = 'failed'
      try {
        await this.#cleanup()
      } catch {
        // Startup failure is the actionable root cause; cleanup still attempted every resource.
      }
      throw error
    }
  }

  async #stop(): Promise<void> {
    if (this.#phase === 'stopped') return
    if (this.#startPromise !== null) {
      try {
        await this.#startPromise
      } catch {
        return
      }
    }
    const failed = this.#phase === 'failed'
    if (!failed) this.#phase = 'stopping'
    await this.#cleanup()
    this.#phase = failed ? 'failed' : 'stopped'
  }

  async #cleanup(): Promise<void> {
    const failures: unknown[] = []
    if (this.#runtimeStarted) {
      try {
        await this.dependencies.runtime.stop()
      } catch (error) {
        failures.push(error)
      } finally {
        this.#runtimeStarted = false
      }
    }
    if (!this.#databaseClosed) {
      try {
        await drainEvidence(this.dependencies.deliverPendingEvidence)
        if (this.dependencies.deliverPendingProductEvidence !== undefined) {
          await drainEvidence(this.dependencies.deliverPendingProductEvidence)
        }
      } catch (error) {
        failures.push(error)
      }
      try {
        await this.dependencies.closeDatabase()
      } catch (error) {
        failures.push(error)
      } finally {
        this.#databaseClosed = true
      }
    }
    if (this.#healthStarted) {
      try {
        await this.dependencies.health.stop()
      } catch (error) {
        failures.push(error)
      } finally {
        this.#healthStarted = false
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Worker shutdown failed')
  }
}

export function createProductionWorkerProcess(
  resources: ProductionWorkerResources,
  configuration: WorkerServerConfiguration,
): ProductionWorkerProcess {
  let healthState: () => Promise<WorkerHealthState> = async () => ({
    live: true,
    ready: false,
    phase: 'starting',
  })
  const health = new WorkerHealthServer({
    host: configuration.healthHost,
    port: configuration.healthPort,
    state: () => healthState(),
  })
  const workerProcess = new ProductionWorkerProcess({
    runtime: resources.graph.runtime,
    deliverPendingEvidence: (limit) => resources.evidence.deliverPending(limit),
    deliverPendingProductEvidence: (limit) => resources.productEvidence.deliverPending(limit),
    probeEvidenceSink: async () => {
      await resources.evidenceSink.all()
    },
    probeDatabase: () => resources.probeDatabase(),
    closeDatabase: () => resources.closeDatabase(),
    health,
  })
  healthState = () => workerProcess.healthState()
  return workerProcess
}

async function drainEvidence(deliver: (limit: number) => Promise<number>): Promise<void> {
  const batchSize = 100
  while ((await deliver(batchSize)) === batchSize) {
    // A full batch may leave more durable envelopes; continue until the ledger is empty.
  }
}

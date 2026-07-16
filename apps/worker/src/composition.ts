import type { WorkerRuntimeDependencies } from './worker-runtime.js'
import { WorkerRuntime } from './worker-runtime.js'
import {
  createPgBossQueueAdapter,
  type PgBossQueueAdapter,
  type WorkerQueuePort,
} from './pg-boss-adapter.js'

export type PgBossConnection = Parameters<typeof createPgBossQueueAdapter>[0]

export type PgBossWorkerRuntimeDependencies = Omit<WorkerRuntimeDependencies, 'queue'> &
  Readonly<{ connection: PgBossConnection }>

export interface PgBossWorkerGraph {
  readonly queue: PgBossQueueAdapter
  readonly runtime: WorkerRuntime
}

export interface PgBossWorkerGraphInput {
  readonly connection: PgBossConnection
  readonly buildDependencies: (
    queue: WorkerQueuePort,
  ) => Promise<Omit<WorkerRuntimeDependencies, 'queue'>> | Omit<WorkerRuntimeDependencies, 'queue'>
}

/** Owns one queue instance shared by the outbox publisher and every worker listener. */
export async function composePgBossWorkerGraph(
  input: PgBossWorkerGraphInput,
): Promise<PgBossWorkerGraph> {
  const queue = await createPgBossQueueAdapter(input.connection)
  const dependencies = await input.buildDependencies(queue)
  return { queue, runtime: new WorkerRuntime({ ...dependencies, queue }) }
}

/** Builds the production worker graph without starting pg-boss or registering listeners. */
export async function composePgBossWorkerRuntime(
  input: PgBossWorkerRuntimeDependencies,
): Promise<WorkerRuntime> {
  const { connection, ...dependencies } = input
  const queue = await createPgBossQueueAdapter(connection)
  return new WorkerRuntime({ ...dependencies, queue })
}

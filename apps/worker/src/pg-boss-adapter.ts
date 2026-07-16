import { createHash } from 'node:crypto'

import type { JsonValue, QueuePort, QueuePublishOptions } from '@trash-palace/application'

export interface PgBossJobLike {
  readonly id: string
  readonly data: unknown
  readonly signal: AbortSignal
}

export interface PgBossLike {
  start(): Promise<unknown>
  stop(options?: Readonly<Record<string, unknown>>): Promise<unknown>
  createQueue(name: string, options?: PgBossQueueOptions): Promise<unknown>
  send(
    name: string,
    data: Readonly<Record<string, JsonValue>>,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<string | null>
  work(
    name: string,
    options: Readonly<Record<string, unknown>>,
    handler: (jobs: readonly PgBossJobLike[]) => Promise<void>,
  ): Promise<string>
  schedule(
    name: string,
    cron: string,
    data?: Readonly<Record<string, JsonValue>>,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>
}

export interface PgBossQueueOptions extends Readonly<Record<string, unknown>> {
  readonly policy: 'exclusive' | 'standard'
  readonly expireInSeconds: number
  readonly retentionSeconds: number
  readonly deleteAfterSeconds: number
  readonly retryLimit: number
  readonly retryDelay: number
  readonly retryBackoff: boolean
}

export interface WorkerJobMetadata {
  readonly jobId: string
}

export interface QueueSuccessorOptions {
  readonly predecessorJobId: string
  readonly delaySeconds: number
}

const DURABLE_JOB_OPTIONS = Object.freeze({
  policy: 'exclusive' as const,
  expireInSeconds: 60,
  retentionSeconds: 7 * 24 * 60 * 60,
  deleteAfterSeconds: 24 * 60 * 60,
  retryLimit: 5,
  retryDelay: 1,
  retryBackoff: true,
})

const SWEEP_JOB_OPTIONS = Object.freeze({
  ...DURABLE_JOB_OPTIONS,
  policy: 'standard' as const,
  expireInSeconds: 30,
  retryLimit: 3,
})

const WORK_POLLING_INTERVAL_SECONDS = 0.5

/** Queue behavior is explicit so retries and retention cannot drift with pg-boss defaults. */
export function pgBossQueueOptions(topic: string): PgBossQueueOptions {
  return topic === 'system.outbox.sweep' ? SWEEP_JOB_OPTIONS : DURABLE_JOB_OPTIONS
}

export interface WorkerQueuePort extends QueuePort {
  start(): Promise<void>
  stop(): Promise<void>
  register(
    topic: string,
    handler: (
      payload: Readonly<Record<string, JsonValue>>,
      signal: AbortSignal,
      metadata: WorkerJobMetadata,
    ) => Promise<void>,
  ): Promise<void>
  publishSuccessor(
    topic: string,
    payload: Readonly<Record<string, JsonValue>>,
    options: QueueSuccessorOptions,
  ): Promise<{ readonly jobId: string | null; readonly duplicate: boolean }>
  schedule(topic: string, cron: string, payload: Readonly<Record<string, JsonValue>>): Promise<void>
}

export class PgBossQueueAdapter implements WorkerQueuePort {
  readonly #createdQueues = new Map<string, Promise<void>>()

  public constructor(private readonly boss: PgBossLike) {}

  public async start(): Promise<void> {
    await this.boss.start()
  }

  public async stop(): Promise<void> {
    await this.boss.stop({ graceful: true })
  }

  public async publish(
    topic: string,
    payload: Readonly<Record<string, JsonValue>>,
    options: QueuePublishOptions,
  ): Promise<{ readonly jobId: string | null; readonly duplicate: boolean }> {
    await this.#ensureQueue(topic)
    const jobId = await this.boss.send(topic, payload, {
      singletonKey: options.deduplicationKey,
      ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
    })
    return { jobId, duplicate: jobId === null }
  }

  public async register(
    topic: string,
    handler: (
      payload: Readonly<Record<string, JsonValue>>,
      signal: AbortSignal,
      metadata: WorkerJobMetadata,
    ) => Promise<void>,
  ): Promise<void> {
    await this.#ensureQueue(topic)
    await this.boss.work(
      topic,
      {
        batchSize: 1,
        pollingIntervalSeconds: WORK_POLLING_INTERVAL_SECONDS,
        notifyPollingIntervalSeconds: WORK_POLLING_INTERVAL_SECONDS,
      },
      async (jobs) => {
        for (const job of jobs) {
          if (!isJsonObject(job.data)) throw new Error(`Job ${job.id} has an invalid payload`)
          await handler(job.data, job.signal, { jobId: job.id })
        }
      },
    )
  }

  public async publishSuccessor(
    topic: string,
    payload: Readonly<Record<string, JsonValue>>,
    options: QueueSuccessorOptions,
  ): Promise<{ readonly jobId: string | null; readonly duplicate: boolean }> {
    await this.#ensureQueue(topic)
    const jobId = await this.boss.send(topic, payload, {
      id: successorJobId(topic, options.predecessorJobId),
      singletonKey: `${topic}:successor:${options.predecessorJobId}`,
      startAfter: positiveInteger(options.delaySeconds, 'Successor delay'),
    })
    return { jobId, duplicate: jobId === null }
  }

  public async schedule(
    topic: string,
    cron: string,
    payload: Readonly<Record<string, JsonValue>>,
  ): Promise<void> {
    await this.#ensureQueue(topic)
    await this.boss.schedule(topic, cron, payload, { tz: 'UTC' })
  }

  #ensureQueue(topic: string): Promise<void> {
    const existing = this.#createdQueues.get(topic)
    if (existing !== undefined) return existing
    const created = this.boss.createQueue(topic, pgBossQueueOptions(topic)).then(() => undefined)
    this.#createdQueues.set(topic, created)
    return created
  }
}

export async function createPgBossQueueAdapter(
  connection: string | Readonly<Record<string, unknown>>,
): Promise<PgBossQueueAdapter> {
  const packageName = 'pg-boss'
  const module = (await import(packageName)) as {
    readonly PgBoss: new (connection: string | Readonly<Record<string, unknown>>) => PgBossLike
  }
  return new PgBossQueueAdapter(new module.PgBoss(connection))
}

function isJsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${label} must be positive`)
  return value
}

function successorJobId(topic: string, predecessorJobId: string): string {
  const bytes = createHash('sha256')
    .update('trash-palace:pg-boss-successor@1\0')
    .update(topic)
    .update('\0')
    .update(predecessorJobId)
    .digest()
  // UUIDv8 marks this as an application-defined deterministic UUID.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

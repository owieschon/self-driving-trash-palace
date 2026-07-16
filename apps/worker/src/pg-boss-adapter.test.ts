import { describe, expect, it } from 'vitest'

import {
  PgBossQueueAdapter,
  pgBossQueueOptions,
  type PgBossJobLike,
  type PgBossLike,
  type PgBossQueueOptions,
} from './pg-boss-adapter.js'

class FakePgBoss implements PgBossLike {
  readonly jobIds = new Set<string>()
  readonly queues: { readonly name: string; readonly options: PgBossQueueOptions | undefined }[] =
    []
  readonly sends: {
    name: string
    data: unknown
    options: Readonly<Record<string, unknown>> | undefined
  }[] = []
  readonly schedules: { name: string; cron: string }[] = []
  readonly workers: { name: string; options: Readonly<Record<string, unknown>> }[] = []
  readonly handlers = new Map<string, (jobs: readonly PgBossJobLike[]) => Promise<void>>()
  started = false
  stopped = false

  async start(): Promise<void> {
    this.started = true
  }
  async stop(): Promise<void> {
    this.stopped = true
  }
  async createQueue(name: string, options?: PgBossQueueOptions): Promise<void> {
    this.queues.push({ name, options })
  }
  async send(
    name: string,
    data: Readonly<Record<string, never>>,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<string | null> {
    this.sends.push({ name, data, options })
    const requestedId = options?.id
    if (typeof requestedId === 'string') {
      if (this.jobIds.has(requestedId)) return null
      this.jobIds.add(requestedId)
      return requestedId
    }
    return `job_${this.sends.length}`
  }
  async work(
    name: string,
    options: Readonly<Record<string, unknown>>,
    handler: (jobs: readonly PgBossJobLike[]) => Promise<void>,
  ): Promise<string> {
    this.workers.push({ name, options })
    this.handlers.set(name, handler)
    return `worker_${name}`
  }
  async schedule(name: string, cron: string): Promise<void> {
    this.schedules.push({ name, cron })
  }
}

describe('pg-boss 12 adapter', () => {
  it('creates queues, handles pg-boss batch callbacks, and preserves outbox dedupe keys', async () => {
    const boss = new FakePgBoss()
    const queue = new PgBossQueueAdapter(boss)
    const received: unknown[] = []
    const receivedSignals: AbortSignal[] = []
    const receivedJobIds: string[] = []

    await queue.start()
    await queue.register('mission.resume', async (payload, signal, metadata) => {
      received.push(payload)
      receivedSignals.push(signal)
      receivedJobIds.push(metadata.jobId)
    })
    const published = await queue.publish(
      'mission.resume',
      { missionId: 'mis_mission00001' },
      {
        deduplicationKey: 'mission.resume:mis_mission00001',
        startAfter: '2026-08-14T06:00:30.000Z',
      },
    )
    const jobAbort = new AbortController()
    await boss.handlers.get('mission.resume')?.([
      { id: 'job_fixture', data: { missionId: 'mis_mission00001' }, signal: jobAbort.signal },
    ])
    await queue.stop()

    expect(boss.started).toBe(true)
    expect(boss.stopped).toBe(true)
    expect(boss.queues).toEqual([
      { name: 'mission.resume', options: pgBossQueueOptions('mission.resume') },
    ])
    expect(boss.workers).toEqual([
      {
        name: 'mission.resume',
        options: {
          batchSize: 1,
          pollingIntervalSeconds: 0.5,
          notifyPollingIntervalSeconds: 0.5,
        },
      },
    ])
    expect(boss.sends[0]?.options).toMatchObject({
      singletonKey: 'mission.resume:mis_mission00001',
      startAfter: '2026-08-14T06:00:30.000Z',
    })
    expect(published).toEqual({ jobId: 'job_1', duplicate: false })
    expect(received).toEqual([{ missionId: 'mis_mission00001' }])
    expect(receivedSignals).toEqual([jobAbort.signal])
    expect(receivedJobIds).toEqual(['job_fixture'])
  })

  it('uses one delayed deterministic job identity for a successor publish replay', async () => {
    const boss = new FakePgBoss()
    const queue = new PgBossQueueAdapter(boss)
    const payload = { organizationId: 'org_primary0001', missionId: 'mis_mission00001' }
    const options = {
      predecessorJobId: '9ccad3ab-39fd-4e6b-9187-d294f45ab032',
      delaySeconds: 1,
    }

    const first = await queue.publishSuccessor('mission.resume', payload, options)
    const replay = await queue.publishSuccessor('mission.resume', payload, options)

    expect(first.duplicate).toBe(false)
    expect(first.jobId).toMatch(/^[0-9a-f-]{36}$/)
    expect(replay).toEqual({ jobId: null, duplicate: true })
    expect(boss.sends[0]?.options).toMatchObject({
      id: first.jobId,
      singletonKey: `mission.resume:successor:${options.predecessorJobId}`,
      startAfter: 1,
    })
    expect(boss.sends[1]?.options?.id).toBe(first.jobId)
  })

  it('pins retry, expiry, retention, and per-key ordering instead of using library defaults', () => {
    expect(pgBossQueueOptions('gateway.dispatch')).toEqual({
      policy: 'exclusive',
      expireInSeconds: 60,
      retentionSeconds: 604_800,
      deleteAfterSeconds: 86_400,
      retryLimit: 5,
      retryDelay: 1,
      retryBackoff: true,
    })
    expect(pgBossQueueOptions('system.outbox.sweep')).toMatchObject({
      policy: 'standard',
      expireInSeconds: 30,
      retryLimit: 3,
    })
  })
})

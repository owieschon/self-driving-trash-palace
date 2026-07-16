import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  EventIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  UserIdSchema,
} from '@trash-palace/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AnalyticsAliaser,
  EvidenceInsertConflictError,
  EvidenceLockTimeoutError,
  LocalJsonlEvidenceSink,
  createAnalyticsCorrelation,
  createProductEvidenceEvent,
  correlationProperties,
  type ProductEvidenceEvent,
} from './index.js'

const ALIAS_KEY = 'sink-concurrency-test-key-with-at-least-32-bytes'
const aliaser = new AnalyticsAliaser(ALIAS_KEY)
const correlation = createAnalyticsCorrelation(aliaser, {
  distinctId: UserIdSchema.parse('usr_sinktestuser001'),
  organizationId: OrganizationIdSchema.parse('org_sinktestorg0001'),
  actorId: UserIdSchema.parse('usr_sinktestactor01'),
  palaceId: PalaceIdSchema.parse('pal_sinktestpalace1'),
  missionId: MissionIdSchema.parse('mis_sinktestmission1'),
})
const CHILD_FIXTURE_PATH = fileURLToPath(
  new URL('./testing/jsonl-evidence-child.ts', import.meta.url),
)

const temporaryDirectories: string[] = []
const childProcesses = new Set<ChildProcess>()

afterEach(async () => {
  for (const child of childProcesses) {
    child.kill('SIGKILL')
  }
  childProcesses.clear()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function evidenceEvent(
  occurredAt = '2026-07-15T04:00:00.000Z',
  eventIdentifier = 'evt_sink_concurrency_001',
): ProductEvidenceEvent {
  const logicalEventId = EventIdSchema.parse(eventIdentifier)
  return createProductEvidenceEvent({
    event: 'mission created',
    insertId: aliaser.insertId('mission created', logicalEventId),
    occurredAt,
    distinctId: correlation.distinctAlias,
    properties: {
      schema_version: '1',
      environment: 'test',
      data_origin: 'fixture',
      privacy_classification: 'analytics_safe',
      app_version: '0.0.0-test',
      ...correlationProperties(correlation),
      mission_alias: correlation.missionAlias!,
      source_surface: 'fixture',
      objective_class: 'homecoming_routine',
    },
  })
}

async function makeTemporaryEvidencePath(prefix: string): Promise<{
  readonly directory: string
  readonly filePath: string
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return { directory, filePath: join(directory, 'evidence.jsonl') }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      await access(path)
      return
    } catch {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the child-process barrier')
      }
      await delay(5)
    }
  }
}

interface ChildOutcome {
  readonly kind: 'error' | 'result'
  readonly status?: 'duplicate' | 'stored'
  readonly name?: string
  readonly message?: string
}

function startCaptureChild(
  filePath: string,
  event: ProductEvidenceEvent,
  readyPath: string,
  startPath: string,
): Promise<ChildOutcome> {
  const encodedEvent = Buffer.from(JSON.stringify(event), 'utf8').toString('base64url')
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', CHILD_FIXTURE_PATH, filePath, encodedEvent, readyPath, startPath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  childProcesses.add(child)

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Evidence capture child timed out'))
    }, 10_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      childProcesses.delete(child)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      childProcesses.delete(child)
      if (code !== 0) {
        reject(
          new Error(
            `Evidence capture child exited with code ${code ?? 'none'} and signal ${signal ?? 'none'}: ${stderr}`,
          ),
        )
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()) as ChildOutcome)
      } catch (error) {
        reject(
          new Error(`Evidence capture child returned invalid output: ${stdout}`, { cause: error }),
        )
      }
    })
  })
}

async function runConcurrentChildren(
  filePath: string,
  events: readonly [ProductEvidenceEvent, ProductEvidenceEvent],
  directory: string,
): Promise<readonly [ChildOutcome, ChildOutcome]> {
  const startPath = join(directory, 'start')
  const readyPaths = [join(directory, 'ready-1'), join(directory, 'ready-2')] as const
  const outcomes = [
    startCaptureChild(filePath, events[0], readyPaths[0], startPath),
    startCaptureChild(filePath, events[1], readyPaths[1], startPath),
  ] as const
  await Promise.all(readyPaths.map(waitForFile))
  await writeFile(startPath, 'start\n', { encoding: 'utf8', mode: 0o600 })
  return Promise.all(outcomes)
}

describe('LocalJsonlEvidenceSink interprocess persistence', () => {
  it('serializes separate sink instances and writes one physical line for an identical retry', async () => {
    const { filePath } = await makeTemporaryEvidencePath('trash-palace-sink-instance-race-')
    const event = evidenceEvent()
    const first = new LocalJsonlEvidenceSink(filePath)
    const second = new LocalJsonlEvidenceSink(filePath)

    const results = await Promise.all([first.capture(event), second.capture(event)])

    expect(results.map(({ status }) => status).sort()).toEqual(['duplicate', 'stored'])
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(1)
    await expect(first.all()).resolves.toHaveLength(1)
    await expect(second.all()).resolves.toHaveLength(1)
  })

  it('serializes separate sink instances and rejects a racing conflicting payload', async () => {
    const { filePath } = await makeTemporaryEvidencePath('trash-palace-sink-conflict-race-')
    const first = new LocalJsonlEvidenceSink(filePath)
    const second = new LocalJsonlEvidenceSink(filePath)
    const outcomes = await Promise.allSettled([
      first.capture(evidenceEvent()),
      second.capture(evidenceEvent('2026-07-15T04:00:01.000Z')),
    ])

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejection = outcomes.find(({ status }) => status === 'rejected')
    expect(rejection?.status).toBe('rejected')
    if (rejection?.status !== 'rejected') {
      throw new Error('Expected one racing capture to reject')
    }
    expect(rejection.reason).toBeInstanceOf(EvidenceInsertConflictError)
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('deduplicates one logical insert across two Node processes', async () => {
    const { directory, filePath } = await makeTemporaryEvidencePath(
      'trash-palace-sink-process-race-',
    )
    const event = evidenceEvent()

    const outcomes = await runConcurrentChildren(filePath, [event, event], directory)

    expect(outcomes.map(({ status }) => status).sort()).toEqual(['duplicate', 'stored'])
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(1)
    await expect(new LocalJsonlEvidenceSink(filePath).all()).resolves.toHaveLength(1)
  })

  it('stores one payload and reports one conflict across two Node processes', async () => {
    const { directory, filePath } = await makeTemporaryEvidencePath(
      'trash-palace-sink-process-conflict-',
    )

    const outcomes = await runConcurrentChildren(
      filePath,
      [evidenceEvent(), evidenceEvent('2026-07-15T04:00:01.000Z')],
      directory,
    )

    expect(outcomes.filter(({ kind }) => kind === 'result')).toHaveLength(1)
    expect(outcomes.filter(({ kind }) => kind === 'error')).toEqual([
      expect.objectContaining({ name: 'EvidenceInsertConflictError' }),
    ])
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('persists with mode 0600 and fails closed without changing malformed JSONL', async () => {
    const { filePath } = await makeTemporaryEvidencePath('trash-palace-sink-malformed-')
    const malformed = '{"partial":\n'
    await writeFile(filePath, malformed, { encoding: 'utf8', mode: 0o644 })
    const sink = new LocalJsonlEvidenceSink(filePath)

    await expect(sink.capture(evidenceEvent())).rejects.toThrow(
      'Invalid JSON in local evidence file at line 1',
    )
    expect(await readFile(filePath, 'utf8')).toBe(malformed)

    await writeFile(filePath, '', { encoding: 'utf8', mode: 0o644 })
    await expect(sink.capture(evidenceEvent())).resolves.toMatchObject({ status: 'stored' })
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  it('recovers an aged lock owned by an absent local process', async () => {
    const { filePath } = await makeTemporaryEvidencePath('trash-palace-sink-stale-lock-')
    const lockPath = `${filePath}.lock`
    await new LocalJsonlEvidenceSink(filePath).capture(evidenceEvent())
    await writeFile(
      lockPath,
      `${JSON.stringify({ schemaVersion: '1', hostname: hostname(), pid: 9_999_999, token: randomUUID() })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    const sink = new LocalJsonlEvidenceSink(filePath, {
      staleLockMs: 100,
      lockTimeoutMs: 1_000,
      retryDelayMs: 5,
    })

    await expect(
      sink.capture(evidenceEvent('2026-07-15T04:00:01.000Z', 'evt_sink_concurrency_002')),
    ).resolves.toMatchObject({ status: 'stored' })
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(sink.all()).resolves.toHaveLength(2)
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('times out instead of stealing an aged lock from a live owner', async () => {
    const { filePath } = await makeTemporaryEvidencePath('trash-palace-sink-live-lock-')
    const lockPath = `${filePath}.lock`
    await writeFile(
      lockPath,
      `${JSON.stringify({ schemaVersion: '1', hostname: hostname(), pid: process.pid, token: randomUUID() })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)
    const sink = new LocalJsonlEvidenceSink(filePath, {
      staleLockMs: 10,
      lockTimeoutMs: 50,
      retryDelayMs: 5,
    })

    const startedAt = performance.now()
    await expect(sink.capture(evidenceEvent())).rejects.toBeInstanceOf(EvidenceLockTimeoutError)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers an aged remote-host lock only under the explicit single-writer contract', async () => {
    const { filePath } = await makeTemporaryEvidencePath('trash-palace-sink-remote-lock-')
    const lockPath = `${filePath}.lock`
    const token = randomUUID()
    await writeFile(
      lockPath,
      `${JSON.stringify({ schemaVersion: '1', hostname: 'retired-worker-container', pid: 42, token })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    const multiWriter = new LocalJsonlEvidenceSink(filePath, {
      staleLockMs: 10,
      lockTimeoutMs: 50,
      retryDelayMs: 5,
    })
    await expect(multiWriter.capture(evidenceEvent())).rejects.toBeInstanceOf(
      EvidenceLockTimeoutError,
    )

    const singleWriter = new LocalJsonlEvidenceSink(filePath, {
      exclusiveWriter: true,
      staleLockMs: 10,
      lockTimeoutMs: 1_000,
      retryDelayMs: 5,
    })
    await expect(singleWriter.capture(evidenceEvent())).resolves.toMatchObject({ status: 'stored' })
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('fails closed on forged lock metadata without interpreting its token as a path', async () => {
    const { directory, filePath } = await makeTemporaryEvidencePath(
      'trash-palace-sink-forged-lock-',
    )
    const sentinelPath = join(directory, 'sentinel')
    const lockPath = `${filePath}.lock`
    await writeFile(sentinelPath, 'untouched\n', { encoding: 'utf8', mode: 0o600 })
    await writeFile(
      lockPath,
      `${JSON.stringify({ schemaVersion: '1', hostname: hostname(), pid: 999_999, token: '../../sentinel' })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)
    const sink = new LocalJsonlEvidenceSink(filePath, {
      staleLockMs: 10,
      lockTimeoutMs: 50,
      retryDelayMs: 5,
    })

    await expect(sink.capture(evidenceEvent())).rejects.toBeInstanceOf(EvidenceLockTimeoutError)
    expect(await readFile(sentinelPath, 'utf8')).toBe('untouched\n')
    await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

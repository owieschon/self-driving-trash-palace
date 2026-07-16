import { randomUUID } from 'node:crypto'
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

import { canonicalJson, type JsonValue } from './canonical.js'
import { parseSafeEvidenceEvent, type SafeEvidenceEvent } from './contracts.js'
import { assertPublicationSafe } from './redaction.js'

export interface EvidenceCaptureResult {
  readonly insertId: string
  readonly status: 'stored' | 'duplicate'
}

export interface EvidenceSink {
  capture(event: SafeEvidenceEvent): Promise<EvidenceCaptureResult>
  all(): Promise<readonly SafeEvidenceEvent[]>
}

export class EvidenceInsertConflictError extends Error {
  public readonly insertId: string

  public constructor(insertId: string) {
    super(`Evidence insert ID ${insertId} was reused with a different payload`)
    this.name = 'EvidenceInsertConflictError'
    this.insertId = insertId
  }
}

export class EvidenceLockTimeoutError extends Error {
  public readonly timeoutMs: number

  public constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for the local evidence lock`)
    this.name = 'EvidenceLockTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

function prepareEvent(input: SafeEvidenceEvent): {
  readonly event: SafeEvidenceEvent
  readonly serialized: string
} {
  const event = parseSafeEvidenceEvent(input)
  assertPublicationSafe(event.properties)
  return {
    event,
    serialized: canonicalJson(event as unknown as JsonValue),
  }
}

function cloneEvent(event: SafeEvidenceEvent): SafeEvidenceEvent {
  return parseSafeEvidenceEvent(JSON.parse(canonicalJson(event as unknown as JsonValue)))
}

export class InMemoryEvidenceSink implements EvidenceSink {
  readonly #records = new Map<string, { event: SafeEvidenceEvent; serialized: string }>()

  public async capture(input: SafeEvidenceEvent): Promise<EvidenceCaptureResult> {
    const prepared = prepareEvent(input)
    const existing = this.#records.get(prepared.event.insertId)
    if (existing !== undefined) {
      if (existing.serialized !== prepared.serialized) {
        throw new EvidenceInsertConflictError(prepared.event.insertId)
      }
      return { insertId: prepared.event.insertId, status: 'duplicate' }
    }

    this.#records.set(prepared.event.insertId, prepared)
    return { insertId: prepared.event.insertId, status: 'stored' }
  }

  public async all(): Promise<readonly SafeEvidenceEvent[]> {
    return [...this.#records.values()].map(({ event }) => cloneEvent(event))
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

interface EvidenceLockOwner {
  readonly schemaVersion: '1'
  readonly hostname: string
  readonly pid: number
  readonly token: string
}

interface EvidenceLockLease {
  readonly candidatePath: string
  readonly token: string
}

export interface LocalJsonlEvidenceSinkOptions {
  /** Maximum wall-clock wait before a contending operation fails closed. */
  readonly lockTimeoutMs?: number
  /** A dead owner's lock must be at least this old before it can be recovered. */
  readonly staleLockMs?: number
  /** Fixed contention retry interval. */
  readonly retryDelayMs?: number
  /** Permit recovery of an aged remote-host lock only when deployment guarantees one writer. */
  readonly exclusiveWriter?: boolean
}

interface NormalizedLocalJsonlEvidenceSinkOptions {
  readonly lockTimeoutMs: number
  readonly staleLockMs: number
  readonly retryDelayMs: number
  readonly exclusiveWriter: boolean
}

const DEFAULT_LOCAL_SINK_OPTIONS: NormalizedLocalJsonlEvidenceSinkOptions = {
  lockTimeoutMs: 5_000,
  staleLockMs: 30_000,
  retryDelayMs: 10,
  exclusiveWriter: false,
}

const LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function positiveFiniteOption(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`)
  }
  return value
}

function normalizeOptions(
  options: LocalJsonlEvidenceSinkOptions,
): NormalizedLocalJsonlEvidenceSinkOptions {
  return {
    lockTimeoutMs: positiveFiniteOption(
      'lockTimeoutMs',
      options.lockTimeoutMs ?? DEFAULT_LOCAL_SINK_OPTIONS.lockTimeoutMs,
    ),
    staleLockMs: positiveFiniteOption(
      'staleLockMs',
      options.staleLockMs ?? DEFAULT_LOCAL_SINK_OPTIONS.staleLockMs,
    ),
    retryDelayMs: positiveFiniteOption(
      'retryDelayMs',
      options.retryDelayMs ?? DEFAULT_LOCAL_SINK_OPTIONS.retryDelayMs,
    ),
    exclusiveWriter: options.exclusiveWriter ?? DEFAULT_LOCAL_SINK_OPTIONS.exclusiveWriter,
  }
}

function parseLockOwner(input: unknown): EvidenceLockOwner | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined
  }
  const candidate = input as Record<string, unknown>
  if (
    candidate.schemaVersion !== '1' ||
    typeof candidate.hostname !== 'string' ||
    candidate.hostname.length === 0 ||
    typeof candidate.pid !== 'number' ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    typeof candidate.token !== 'string' ||
    !LOCK_TOKEN_PATTERN.test(candidate.token)
  ) {
    return undefined
  }
  return {
    schemaVersion: '1',
    hostname: candidate.hostname,
    pid: candidate.pid,
    token: candidate.token,
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !hasErrorCode(error, 'ESRCH')
  }
}

function sameFile(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) {
    return
  }
  try {
    await handle.close()
  } catch {
    // The primary persistence or acquisition error is more actionable.
  }
}

/**
 * A local, credential-free evidence sink. The JSONL file is the source of truth;
 * every operation reloads it while holding an interprocess lock.
 */
export class LocalJsonlEvidenceSink implements EvidenceSink {
  readonly #filePath: string
  readonly #lockPath: string
  readonly #recoveryPath: string
  readonly #options: NormalizedLocalJsonlEvidenceSinkOptions
  #queue: Promise<void> = Promise.resolve()

  public constructor(filePath: string, options: LocalJsonlEvidenceSinkOptions = {}) {
    if (filePath.trim().length === 0) {
      throw new Error('Local evidence path cannot be empty')
    }
    this.#filePath = filePath
    this.#lockPath = `${filePath}.lock`
    this.#recoveryPath = `${filePath}.lock.recovery`
    this.#options = normalizeOptions(options)
  }

  public capture(input: SafeEvidenceEvent): Promise<EvidenceCaptureResult> {
    const prepared = prepareEvent(input)
    return this.#enqueue(async () =>
      this.#withLock(async () => {
        const records = await this.#readRecords()
        const existing = records.get(prepared.event.insertId)
        if (existing !== undefined) {
          if (existing.serialized !== prepared.serialized) {
            throw new EvidenceInsertConflictError(prepared.event.insertId)
          }
          return { insertId: prepared.event.insertId, status: 'duplicate' } as const
        }

        await this.#appendDurably(prepared.serialized)
        return { insertId: prepared.event.insertId, status: 'stored' } as const
      }),
    )
  }

  public all(): Promise<readonly SafeEvidenceEvent[]> {
    return this.#enqueue(async () =>
      this.#withLock(async () =>
        [...(await this.#readRecords()).values()].map(({ event }) => cloneEvent(event)),
      ),
    )
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation)
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await this.#acquireLock()
    try {
      return await operation()
    } finally {
      await this.#releaseLock(lease)
    }
  }

  async #acquireLock(): Promise<EvidenceLockLease> {
    await mkdir(dirname(this.#filePath), { recursive: true })
    const token = randomUUID()
    const candidatePath = `${this.#lockPath}.${process.pid}.${token}.candidate`
    const owner: EvidenceLockOwner = {
      schemaVersion: '1',
      hostname: hostname(),
      pid: process.pid,
      token,
    }
    let candidateHandle: FileHandle | undefined
    try {
      candidateHandle = await open(candidatePath, 'wx', 0o600)
      await candidateHandle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
      await candidateHandle.chmod(0o600)
      await candidateHandle.sync()
    } catch (error) {
      await closeQuietly(candidateHandle)
      await unlink(candidatePath).catch(() => undefined)
      throw error
    }
    await closeQuietly(candidateHandle)

    const deadline = performance.now() + this.#options.lockTimeoutMs
    try {
      for (;;) {
        if (!(await this.#pathExists(this.#recoveryPath))) {
          try {
            await link(candidatePath, this.#lockPath)
            if (!(await this.#pathExists(this.#recoveryPath))) {
              return { candidatePath, token }
            }
            await this.#unlinkLockIfOwned(candidatePath)
          } catch (error) {
            if (!hasErrorCode(error, 'EEXIST')) {
              throw error
            }
          }
        }

        await this.#recoverStaleLock()
        const remainingMs = deadline - performance.now()
        if (remainingMs <= 0) {
          throw new EvidenceLockTimeoutError(this.#options.lockTimeoutMs)
        }
        await delay(Math.min(this.#options.retryDelayMs, remainingMs))
      }
    } catch (error) {
      await unlink(candidatePath).catch(() => undefined)
      throw error
    }
  }

  async #releaseLock(lease: EvidenceLockLease): Promise<void> {
    try {
      const owner = await this.#readLockOwner(this.#lockPath)
      if (owner?.token !== lease.token) {
        throw new Error('Local evidence lock ownership changed before release')
      }
      await this.#unlinkLockIfOwned(lease.candidatePath)
    } finally {
      await unlink(lease.candidatePath).catch(() => undefined)
    }
  }

  async #unlinkLockIfOwned(candidatePath: string): Promise<void> {
    let candidateStat: Awaited<ReturnType<typeof stat>>
    let lockStat: Awaited<ReturnType<typeof stat>>
    try {
      ;[candidateStat, lockStat] = await Promise.all([stat(candidatePath), stat(this.#lockPath)])
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return
      }
      throw error
    }
    if (!sameFile(candidateStat, lockStat)) {
      return
    }
    await unlink(this.#lockPath).catch((error: unknown) => {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
    })
  }

  async #recoverStaleLock(): Promise<void> {
    let lockStat: Awaited<ReturnType<typeof stat>>
    try {
      lockStat = await stat(this.#lockPath)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return
      }
      throw error
    }
    if (Date.now() - lockStat.mtimeMs < this.#options.staleLockMs) {
      return
    }

    const owner = await this.#readLockOwner(this.#lockPath)
    // Remote liveness is unknowable. Recovery is safe only under an explicit one-writer contract.
    if (owner === undefined || !this.#ownerIsRecoverable(owner)) {
      return
    }

    const recoveryToken = randomUUID()
    const recoveryCandidate = `${this.#recoveryPath}.${process.pid}.${recoveryToken}.candidate`
    let recoveryHandle: FileHandle | undefined
    try {
      recoveryHandle = await open(recoveryCandidate, 'wx', 0o600)
      await recoveryHandle.writeFile(
        `${JSON.stringify({ schemaVersion: '1', hostname: hostname(), pid: process.pid, token: recoveryToken })}\n`,
        'utf8',
      )
      await recoveryHandle.chmod(0o600)
      await recoveryHandle.sync()
    } catch (error) {
      await closeQuietly(recoveryHandle)
      await unlink(recoveryCandidate).catch(() => undefined)
      throw error
    } finally {
      await closeQuietly(recoveryHandle)
    }

    try {
      try {
        await link(recoveryCandidate, this.#recoveryPath)
      } catch (error) {
        if (hasErrorCode(error, 'EEXIST')) {
          return
        }
        throw error
      }

      const currentLockStat = await stat(this.#lockPath).catch((error: unknown) => {
        if (hasErrorCode(error, 'ENOENT')) {
          return undefined
        }
        throw error
      })
      if (currentLockStat === undefined || !sameFile(lockStat, currentLockStat)) {
        return
      }
      const currentOwner = await this.#readLockOwner(this.#lockPath)
      if (currentOwner?.token !== owner.token || !this.#ownerIsRecoverable(currentOwner)) {
        return
      }

      const quarantinePath = `${this.#lockPath}.stale.${owner.token}.${randomUUID()}`
      try {
        await rename(this.#lockPath, quarantinePath)
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
          return
        }
        throw error
      }
      const staleCandidatePath = `${this.#lockPath}.${owner.pid}.${owner.token}.candidate`
      await this.#unlinkPathIfSameFile(staleCandidatePath, quarantinePath)
      await unlink(quarantinePath)
    } finally {
      await this.#unlinkPathIfSameFile(this.#recoveryPath, recoveryCandidate)
      await unlink(recoveryCandidate).catch(() => undefined)
    }
  }

  #ownerIsRecoverable(owner: EvidenceLockOwner): boolean {
    if (owner.hostname === hostname()) return !processIsAlive(owner.pid)
    return this.#options.exclusiveWriter
  }

  async #unlinkPathIfSameFile(path: string, candidatePath: string): Promise<void> {
    try {
      const [pathStat, candidateStat] = await Promise.all([stat(path), stat(candidatePath)])
      if (sameFile(pathStat, candidateStat)) {
        await unlink(path)
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
    }
  }

  async #readLockOwner(path: string): Promise<EvidenceLockOwner | undefined> {
    let contents: string
    try {
      contents = await readFile(path, 'utf8')
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return undefined
      }
      throw error
    }
    try {
      return parseLockOwner(JSON.parse(contents))
    } catch {
      return undefined
    }
  }

  async #pathExists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return false
      }
      throw error
    }
  }

  async #appendDurably(serialized: string): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await open(this.#filePath, 'a', 0o600)
      await handle.chmod(0o600)
      await handle.appendFile(`${serialized}\n`, 'utf8')
      await handle.sync()
    } finally {
      await closeQuietly(handle)
    }
  }

  async #readRecords(): Promise<
    Map<string, { readonly event: SafeEvidenceEvent; readonly serialized: string }>
  > {
    let contents: string
    try {
      contents = await readFile(this.#filePath, 'utf8')
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return new Map()
      }
      throw error
    }

    if (contents.length > 0 && !contents.endsWith('\n')) {
      throw new Error('Local evidence file ends with an incomplete JSONL record')
    }

    const records = new Map<
      string,
      { readonly event: SafeEvidenceEvent; readonly serialized: string }
    >()
    for (const [index, line] of contents.split('\n').entries()) {
      if (line.trim().length === 0) {
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error(`Invalid JSON in local evidence file at line ${index + 1}`)
      }

      const prepared = prepareEvent(parseSafeEvidenceEvent(parsed))
      const existing = records.get(prepared.event.insertId)
      if (existing !== undefined && existing.serialized !== prepared.serialized) {
        throw new EvidenceInsertConflictError(prepared.event.insertId)
      }
      records.set(prepared.event.insertId, prepared)
    }
    return records
  }
}

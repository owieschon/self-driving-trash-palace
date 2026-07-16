import { LeaseLostError } from '@trash-palace/application'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TimerHeartbeat } from './heartbeat.js'

describe('timer heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drains an in-flight renewal and lets a late lease failure override completed work', async () => {
    vi.useFakeTimers()
    const renewal = deferred<boolean>()
    const work = deferred<string>()
    let settled = false
    const running = new TimerHeartbeat()
      .run({
        intervalMilliseconds: 100,
        renewalTimeoutMilliseconds: 1_000,
        heartbeat: () => renewal.promise,
        work: () => work.promise,
      })
      .finally(() => {
        settled = true
      })
    const rejection = expect(running).rejects.toBeInstanceOf(LeaseLostError)

    await vi.advanceTimersByTimeAsync(100)
    work.resolve('complete')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    renewal.reject(new Error('database connection lost'))
    await rejection
    expect(settled).toBe(true)
  })

  it('drains a successful in-flight renewal before returning completed work', async () => {
    vi.useFakeTimers()
    const renewal = deferred<boolean>()
    const work = deferred<string>()
    let settled = false
    const running = new TimerHeartbeat()
      .run({
        intervalMilliseconds: 100,
        renewalTimeoutMilliseconds: 1_000,
        heartbeat: () => renewal.promise,
        work: () => work.promise,
      })
      .finally(() => {
        settled = true
      })

    await vi.advanceTimersByTimeAsync(100)
    work.resolve('complete')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    renewal.resolve(true)
    await expect(running).resolves.toBe('complete')
    expect(settled).toBe(true)
  })

  it('never overlaps renewals when multiple ticks pass during one held renewal', async () => {
    vi.useFakeTimers()
    const renewal = deferred<boolean>()
    const work = deferred<undefined>()
    let activeRenewals = 0
    let renewalStarts = 0
    let maximumConcurrentRenewals = 0
    const running = new TimerHeartbeat().run({
      intervalMilliseconds: 20,
      renewalTimeoutMilliseconds: 1_000,
      heartbeat: async () => {
        renewalStarts += 1
        activeRenewals += 1
        maximumConcurrentRenewals = Math.max(maximumConcurrentRenewals, activeRenewals)
        try {
          return await renewal.promise
        } finally {
          activeRenewals -= 1
        }
      },
      work: () => work.promise,
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(renewalStarts).toBe(1)
    expect(maximumConcurrentRenewals).toBe(1)
    renewal.resolve(true)
    work.resolve(undefined)
    await expect(running).resolves.toBeUndefined()
  })

  it('aborts promptly on the first negative renewal even when work ignores abort', async () => {
    vi.useFakeTimers()
    const ignoredWork = deferred<string>()
    let workSignal: AbortSignal | undefined
    let renewalCount = 0
    const running = new TimerHeartbeat().run({
      intervalMilliseconds: 100,
      heartbeat: async () => {
        renewalCount += 1
        return false
      },
      work: (signal) => {
        workSignal = signal
        return ignoredWork.promise
      },
    })
    const rejection = expect(running).rejects.toBeInstanceOf(LeaseLostError)

    await vi.advanceTimersByTimeAsync(100)
    await rejection
    expect(workSignal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(renewalCount).toBe(1)

    ignoredWork.resolve('ignored abort finally stopped')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('bounds a renewal that never settles and aborts its renewal signal', async () => {
    vi.useFakeTimers()
    const ignoredWork = deferred<undefined>()
    let renewalSignal: AbortSignal | undefined
    const running = new TimerHeartbeat().run({
      intervalMilliseconds: 20,
      renewalTimeoutMilliseconds: 40,
      heartbeat: (signal) => {
        renewalSignal = signal
        return new Promise<boolean>(() => undefined)
      },
      work: () => ignoredWork.promise,
    })
    const rejection = expect(running).rejects.toBeInstanceOf(LeaseLostError)

    await vi.advanceTimersByTimeAsync(60)
    await rejection
    expect(renewalSignal?.aborted).toBe(true)
    ignoredWork.resolve(undefined)
  })

  it('propagates parent cancellation to work and an active renewal', async () => {
    vi.useFakeTimers()
    const parent = new AbortController()
    const work = deferred<undefined>()
    let workSignal: AbortSignal | undefined
    let renewalSignal: AbortSignal | undefined
    let renewalCount = 0
    const running = new TimerHeartbeat().run({
      intervalMilliseconds: 20,
      renewalTimeoutMilliseconds: 1_000,
      signal: parent.signal,
      heartbeat: (signal) => {
        renewalCount += 1
        renewalSignal = signal
        return new Promise<boolean>(() => undefined)
      },
      work: (signal) => {
        workSignal = signal
        return work.promise
      },
    })
    const reason = new Error('pg-boss stopped the job')
    const rejection = expect(running).rejects.toBe(reason)

    await vi.advanceTimersByTimeAsync(20)
    parent.abort(reason)
    await rejection
    expect(workSignal?.aborted).toBe(true)
    expect(renewalSignal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(renewalCount).toBe(1)
    work.resolve(undefined)
  })
})

function deferred<Value>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
  readonly reject: (error: unknown) => void
} {
  let resolve: (value: Value) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

import { describe, expect, it, vi } from 'vitest'

import { TimerOutboxPump } from './outbox-pump.js'

describe('timer outbox pump', () => {
  it('runs sequential sweeps at a bounded sub-minute interval', async () => {
    vi.useFakeTimers()
    try {
      let concurrent = 0
      let maximumConcurrent = 0
      const sweep = vi.fn(async () => {
        concurrent += 1
        maximumConcurrent = Math.max(maximumConcurrent, concurrent)
        await Promise.resolve()
        concurrent -= 1
      })
      const pump = new TimerOutboxPump()
      await pump.start({ intervalMilliseconds: 25, sweep })

      await vi.advanceTimersByTimeAsync(100)
      await pump.stop()

      expect(sweep).toHaveBeenCalledTimes(4)
      expect(maximumConcurrent).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for an in-flight sweep during graceful shutdown', async () => {
    vi.useFakeTimers()
    try {
      let releaseSweep = (): void => undefined
      const sweepBlocked = new Promise<void>((resolve) => {
        releaseSweep = resolve
      })
      const pump = new TimerOutboxPump()
      await pump.start({ intervalMilliseconds: 25, sweep: () => sweepBlocked })
      await vi.advanceTimersByTimeAsync(25)

      let stopped = false
      const stopping = pump.stop().then(() => {
        stopped = true
      })
      await Promise.resolve()
      expect(stopped).toBe(false)

      releaseSweep()
      await stopping
      expect(stopped).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

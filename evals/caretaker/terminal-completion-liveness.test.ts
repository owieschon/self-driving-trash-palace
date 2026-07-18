import { describe, expect, it, vi } from 'vitest'

import { OptimisticConcurrencyError } from '../../packages/application/src/errors.js'
import { runTerminalCaretakerActivationWithRetry } from '../../packages/agent/src/caretaker-worker-adapters.js'

describe('Caretaker terminal completion liveness', () => {
  it('re-drives one terminal activation through the full serialization retry ladder', async () => {
    const completion = vi
      .fn<() => Promise<'completed'>>()
      .mockRejectedValueOnce(new OptimisticConcurrencyError('Caretaker run'))
      .mockRejectedValueOnce(new OptimisticConcurrencyError('Caretaker run'))
      .mockRejectedValueOnce(new OptimisticConcurrencyError('Caretaker run'))
      .mockRejectedValueOnce(new OptimisticConcurrencyError('Caretaker run'))
      .mockRejectedValueOnce(new OptimisticConcurrencyError('Caretaker run'))
      .mockRejectedValueOnce(new OptimisticConcurrencyError('Caretaker run'))
      .mockResolvedValue('completed')
    const observedDelays: number[] = []

    await expect(
      runTerminalCaretakerActivationWithRetry(
        completion,
        new AbortController().signal,
        async (delayMilliseconds) => {
          observedDelays.push(delayMilliseconds)
        },
      ),
    ).resolves.toBe('completed')

    expect(completion).toHaveBeenCalledTimes(7)
    expect(observedDelays).toEqual([10, 25, 50, 100, 250, 500])
  })

  it('fails closed after the bounded retry budget', async () => {
    const conflict = new OptimisticConcurrencyError('Caretaker run')
    const completion = vi.fn<() => Promise<never>>().mockRejectedValue(conflict)

    await expect(
      runTerminalCaretakerActivationWithRetry(
        completion,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toBe(conflict)
    expect(completion).toHaveBeenCalledTimes(7)
  })
})

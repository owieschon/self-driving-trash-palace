import { describe, expect, it, vi } from 'vitest'

import { createLazyRuntime } from './lazy-runtime.js'

describe('lazy server composition', () => {
  it('does not touch infrastructure before the first request and shares one runtime', async () => {
    const factory = vi.fn(async () => ({ value: 'runtime' }))
    const runtime = createLazyRuntime(factory)

    expect(factory).not.toHaveBeenCalled()
    expect(runtime.current()).toBeUndefined()
    const [first, second] = await Promise.all([runtime.get(), runtime.get()])

    expect(factory).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
    expect(runtime.current()).toBeDefined()
  })

  it('does not cache a failed initialization', async () => {
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('configuration unavailable'))
      .mockResolvedValueOnce('ready')
    const runtime = createLazyRuntime(factory)

    await expect(runtime.get()).rejects.toThrow('configuration unavailable')
    expect(runtime.current()).toBeUndefined()
    await expect(runtime.get()).resolves.toBe('ready')
    expect(factory).toHaveBeenCalledTimes(2)
  })
})

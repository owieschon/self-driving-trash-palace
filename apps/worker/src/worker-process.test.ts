import { describe, expect, it, vi } from 'vitest'

import { ProductionWorkerProcess, type WorkerProcessDependencies } from './worker-process.js'

function harness(
  input: {
    readonly pendingBatches?: readonly number[]
    readonly deliverPendingProductEvidence?: (limit: number) => Promise<number>
  } = {},
) {
  const calls: string[] = []
  const pending = [...(input.pendingBatches ?? [0, 0])]
  const dependencies: WorkerProcessDependencies = {
    runtime: {
      start: vi.fn(async () => {
        calls.push('runtime.start')
      }),
      stop: vi.fn(async () => {
        calls.push('runtime.stop')
      }),
    },
    deliverPendingEvidence: vi.fn(async () => {
      calls.push('evidence.drain')
      return pending.shift() ?? 0
    }),
    ...(input.deliverPendingProductEvidence === undefined
      ? {}
      : { deliverPendingProductEvidence: input.deliverPendingProductEvidence }),
    probeEvidenceSink: vi.fn(async () => {
      calls.push('evidence.probe')
    }),
    probeDatabase: vi.fn(async () => {
      calls.push('database.probe')
    }),
    closeDatabase: vi.fn(async () => {
      calls.push('database.close')
    }),
    health: {
      start: vi.fn(async () => {
        calls.push('health.start')
        return { host: '127.0.0.1', port: 4_320 }
      }),
      stop: vi.fn(async () => {
        calls.push('health.stop')
      }),
    },
  }
  return { calls, dependencies, process: new ProductionWorkerProcess(dependencies) }
}

describe('production worker process', () => {
  it('drains transactional product evidence on startup and graceful shutdown', async () => {
    const productDelivery = vi.fn(async () => 0)
    const test = harness({ deliverPendingProductEvidence: productDelivery })

    await test.process.start()
    await test.process.stop()

    expect(productDelivery).toHaveBeenCalledTimes(2)
  })

  it('probes dependencies before readiness and drains after queue shutdown', async () => {
    const test = harness()

    expect(await test.process.healthState()).toEqual({
      live: true,
      ready: false,
      phase: 'starting',
    })
    await test.process.start()
    expect(await test.process.healthState()).toEqual({ live: true, ready: true, phase: 'running' })
    await test.process.stop()

    expect(test.calls).toEqual([
      'health.start',
      'database.probe',
      'evidence.probe',
      'evidence.drain',
      'runtime.start',
      'database.probe',
      'database.probe',
      'runtime.stop',
      'evidence.drain',
      'database.close',
      'health.stop',
    ])
    expect(await test.process.healthState()).toEqual({
      live: false,
      ready: false,
      phase: 'stopped',
    })
  })

  it('drains every full evidence batch before starting work', async () => {
    const test = harness({ pendingBatches: [100, 100, 12, 0] })

    await test.process.start()
    await test.process.stop()

    expect(test.dependencies.deliverPendingEvidence).toHaveBeenCalledTimes(4)
    expect(test.calls.indexOf('runtime.start')).toBeGreaterThan(
      test.calls.lastIndexOf('evidence.drain', test.calls.indexOf('runtime.start')),
    )
  })

  it('cleans every opened resource after startup failure and preserves that failure', async () => {
    const test = harness()
    vi.mocked(test.dependencies.probeEvidenceSink).mockRejectedValueOnce(
      new Error('evidence sink unavailable'),
    )

    await expect(test.process.start()).rejects.toThrow('evidence sink unavailable')
    expect(test.calls).toEqual([
      'health.start',
      'database.probe',
      'evidence.drain',
      'database.close',
      'health.stop',
    ])
    expect(await test.process.healthState()).toEqual({
      live: false,
      ready: false,
      phase: 'failed',
    })
  })

  it('stops a partly opened runtime when listener registration fails', async () => {
    const test = harness()
    vi.mocked(test.dependencies.runtime.start).mockRejectedValueOnce(
      new Error('queue listener registration failed'),
    )

    await expect(test.process.start()).rejects.toThrow('queue listener registration failed')
    expect(test.calls).toEqual([
      'health.start',
      'database.probe',
      'evidence.probe',
      'evidence.drain',
      'runtime.stop',
      'evidence.drain',
      'database.close',
      'health.stop',
    ])
  })

  it('continues shutdown after individual cleanup failures', async () => {
    const test = harness()
    await test.process.start()
    vi.mocked(test.dependencies.runtime.stop).mockRejectedValueOnce(new Error('queue stop failed'))
    vi.mocked(test.dependencies.deliverPendingEvidence).mockRejectedValueOnce(
      new Error('delivery failed'),
    )

    await expect(test.process.stop()).rejects.toThrow(AggregateError)
    expect(test.dependencies.closeDatabase).toHaveBeenCalledOnce()
    expect(test.dependencies.health.stop).toHaveBeenCalledOnce()
  })
})

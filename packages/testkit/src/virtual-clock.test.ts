import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { VirtualClock } from './virtual-clock.js'

const START = '2026-08-14T01:35:00-04:00'

function executeSchedule(delays: readonly number[]): readonly number[] {
  const clock = new VirtualClock({ startsAt: START, virtualMinuteMilliseconds: 250 })
  const order: number[] = []
  delays.forEach((delay, index) => {
    clock.scheduleAfter(delay, () => order.push(index), `property-task-${index}`)
  })
  clock.runUntilIdle({ maximumTasks: delays.length + 1, maximumVirtualMilliseconds: 60_000 })
  return order
}

describe('VirtualClock', () => {
  it('maps the flagship scale and executes equal-time work in insertion order', () => {
    const clock = new VirtualClock({ startsAt: START, virtualMinuteMilliseconds: 250 })
    const order: string[] = []
    clock.scheduleAfter(1_000, () => order.push('first'))
    clock.scheduleAfter(1_000, () => order.push('second'))
    clock.scheduleAfter(500, () => order.push('earlier'))

    expect(clock.realMillisecondsForVirtual(60_000)).toBe(250)
    expect(clock.virtualMillisecondsForReal(250)).toBe(60_000)
    expect(clock.advanceBy(1_000)).toBe(3)
    expect(order).toEqual(['earlier', 'first', 'second'])
  })

  it('cancels work and enforces task and virtual-time bounds', () => {
    const clock = new VirtualClock({
      startsAt: START,
      virtualMinuteMilliseconds: 250,
      maximumScheduledTasks: 1,
    })
    const task = clock.scheduleAfter(1_000, () => undefined)
    expect(() => clock.scheduleAfter(2_000, () => undefined)).toThrow(/bound/)
    expect(task.cancel()).toBe(true)
    expect(task.cancel()).toBe(false)
    clock.scheduleAfter(2_000, () => undefined)
    expect(() => clock.runUntilIdle({ maximumVirtualMilliseconds: 1_999 })).toThrow(
      /virtual-time bound/,
    )
  })

  it('bounds callbacks that continually reschedule at the current instant', () => {
    const clock = new VirtualClock({
      startsAt: START,
      virtualMinuteMilliseconds: 250,
      maximumScheduledTasks: 3,
    })
    const reschedule = () => clock.scheduleAfter(0, reschedule)
    clock.scheduleAfter(0, reschedule)
    expect(() => clock.flushCurrent()).toThrow(/task bound/)
  })

  it('is deterministic for generated schedules and preserves the stable sort contract', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 60_000 }), { maxLength: 200 }), (delays) => {
        const first = executeSchedule(delays)
        const second = executeSchedule(delays)
        expect(first).toEqual(second)
        const expected = delays
          .map((delay, index) => ({ delay, index }))
          .sort((left, right) => left.delay - right.delay || left.index - right.index)
          .map(({ index }) => index)
        expect(first).toEqual(expected)
      }),
      { numRuns: 100 },
    )
  })
})

import { VirtualClock } from '@trash-palace/testkit'
import {
  FLAGSHIP_CLOCK_PAUSED_AT,
  FLAGSHIP_CLOCK_RUNNING_AT,
  FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
} from '@trash-palace/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VirtualClockDriver } from './clock-driver.js'

describe('virtual clock driver', () => {
  afterEach(() => vi.useRealTimers())

  it('advances in deterministic virtual-minute quanta and executes tasks at their exact time', () => {
    vi.useFakeTimers()
    const clock = new VirtualClock({
      startsAt: '2026-08-14T05:35:00.000Z',
      virtualMinuteMilliseconds: 250,
    })
    const occurredAt: string[] = []
    clock.scheduleAfter(4_000, () => occurredAt.push(clock.now), 'test-callback')
    const driver = new VirtualClockDriver(clock, { realMillisecondsPerVirtualMinute: 250 })

    driver.start()
    expect(driver.isHealthy).toBe(true)
    vi.advanceTimersByTime(249)
    expect(occurredAt).toEqual([])
    vi.advanceTimersByTime(1)
    expect(occurredAt).toEqual(['2026-08-14T05:35:04.000Z'])
    expect(clock.now).toBe('2026-08-14T05:36:00.000Z')
    expect(driver.flushAndStop()).toBe(0)
    expect(driver.isHealthy).toBe(false)
  })

  it('flushes bounded future work during shutdown', () => {
    const clock = new VirtualClock({
      startsAt: '2026-08-14T05:35:00.000Z',
      virtualMinuteMilliseconds: 250,
    })
    let completed = false
    clock.scheduleAfter(300_000, () => {
      completed = true
    })
    const driver = new VirtualClockDriver(clock, { realMillisecondsPerVirtualMinute: 250 })
    driver.start()
    expect(driver.flushAndStop()).toBe(1)
    expect(completed).toBe(true)
  })

  it('waits for the shared real anchor, jumps to activation, then accelerates in exact quanta', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-07-15T12:00:00.000Z')
    const clock = new VirtualClock({
      startsAt: FLAGSHIP_CLOCK_PAUSED_AT,
      virtualMinuteMilliseconds: FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
    })
    const occurredAt: string[] = []
    clock.scheduleAt(FLAGSHIP_CLOCK_RUNNING_AT, () => occurredAt.push(clock.now), 'activation')
    const driver = new VirtualClockDriver(clock, {
      realMillisecondsPerVirtualMinute: FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
      requiredRealStartAt: '2026-07-15T12:00:01.000Z',
      advanceToOnStart: FLAGSHIP_CLOCK_RUNNING_AT,
    })

    driver.start()
    expect(driver.isWaitingForStart).toBe(true)
    expect(driver.isHealthy).toBe(true)
    expect(clock.now).toBe(new Date(FLAGSHIP_CLOCK_PAUSED_AT).toISOString())
    vi.advanceTimersByTime(999)
    expect(clock.now).toBe(new Date(FLAGSHIP_CLOCK_PAUSED_AT).toISOString())
    vi.advanceTimersByTime(1)
    expect(driver.isWaitingForStart).toBe(false)
    expect(driver.isHealthy).toBe(true)
    expect(clock.now).toBe(new Date(FLAGSHIP_CLOCK_RUNNING_AT).toISOString())
    expect(occurredAt).toEqual([new Date(FLAGSHIP_CLOCK_RUNNING_AT).toISOString()])
    vi.advanceTimersByTime(FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE)
    expect(clock.now).toBe(new Date(Date.parse(FLAGSHIP_CLOCK_RUNNING_AT) + 60_000).toISOString())
    driver.stop()
  })

  it('catches up from the shared anchor when a process starts late', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-07-15T12:00:00.500Z')
    const clock = new VirtualClock({
      startsAt: FLAGSHIP_CLOCK_PAUSED_AT,
      virtualMinuteMilliseconds: FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
    })
    const driver = new VirtualClockDriver(clock, {
      realMillisecondsPerVirtualMinute: FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
      requiredRealStartAt: '2026-07-15T12:00:00.000Z',
      advanceToOnStart: FLAGSHIP_CLOCK_RUNNING_AT,
    })

    driver.start()
    expect(clock.now).toBe(
      new Date(
        Date.parse(FLAGSHIP_CLOCK_RUNNING_AT) +
          (500 / FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE) * 60_000,
      ).toISOString(),
    )
    driver.stop()
  })
})

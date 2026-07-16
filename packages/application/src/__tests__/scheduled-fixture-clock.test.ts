import { describe, expect, it } from 'vitest'

import type { ClockPort } from '../ports.js'
import { ScheduledFixtureClock, createFlagshipDomainClock } from '../scheduled-fixture-clock.js'

class MutableWallClock implements ClockPort {
  public constructor(public current: string) {}

  public now(): Date {
    return new Date(this.current)
  }
}

const PAUSED_AT = '2026-08-14T05:35:00.000Z'
const RUNNING_AT = '2026-08-14T05:44:00.000Z'
const REAL_START_AT = '2026-07-15T12:00:00.000Z'

function fixtureClock(wallClock: MutableWallClock): ScheduledFixtureClock {
  return new ScheduledFixtureClock({
    pausedAt: PAUSED_AT,
    runningAt: RUNNING_AT,
    realStartAt: REAL_START_AT,
    realMillisecondsPerVirtualMinute: 250,
    wallClock,
  })
}

describe('scheduled fixture clock', () => {
  it('holds the domain at setup time until the shared real start instant', () => {
    const wall = new MutableWallClock('2026-07-15T11:59:59.999Z')
    const clock = fixtureClock(wall)

    expect(clock.now().toISOString()).toBe(PAUSED_AT)
    expect(clock.snapshot()).toMatchObject({ state: 'paused', domainNow: PAUSED_AT })
  })

  it('jumps to activation and advances at the canonical accelerated scale', () => {
    const wall = new MutableWallClock(REAL_START_AT)
    const clock = fixtureClock(wall)

    expect(clock.now().toISOString()).toBe(RUNNING_AT)
    wall.current = '2026-07-15T12:00:03.500Z'
    expect(clock.now().toISOString()).toBe('2026-08-14T05:58:00.000Z')
    expect(clock.snapshot().state).toBe('running')
  })

  it('converts virtual and real durations without reading the clock', () => {
    const clock = fixtureClock(new MutableWallClock(REAL_START_AT))

    expect(clock.realMillisecondsForVirtual(90_000)).toBe(375)
    expect(clock.virtualMillisecondsForReal(375)).toBe(90_000)
  })

  it('uses the supplied wall clock unchanged outside fixture mode', () => {
    const wall = new MutableWallClock(REAL_START_AT)
    expect(createFlagshipDomainClock({ mode: 'system' }, wall)).toBe(wall)
    expect(
      createFlagshipDomainClock({ mode: 'fixture', realStartAt: REAL_START_AT }, wall)
        .now()
        .toISOString(),
    ).toBe(RUNNING_AT)
  })

  it.each([
    [{ pausedAt: 'invalid' }, /paused fixture time/],
    [{ runningAt: '2026-08-14T05:34:59.999Z' }, /cannot precede/],
    [{ realStartAt: 'invalid' }, /real start/],
    [{ realMillisecondsPerVirtualMinute: 0 }, /time scale/],
  ])('fails closed for invalid timeline configuration', (override, expected) => {
    expect(
      () =>
        new ScheduledFixtureClock({
          pausedAt: PAUSED_AT,
          runningAt: RUNNING_AT,
          realStartAt: REAL_START_AT,
          realMillisecondsPerVirtualMinute: 250,
          wallClock: new MutableWallClock(REAL_START_AT),
          ...override,
        }),
    ).toThrow(expected)
  })
})

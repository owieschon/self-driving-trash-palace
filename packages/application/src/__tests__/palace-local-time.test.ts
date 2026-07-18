import type { ClockPort } from '../ports.js'
import { dayPeriodForHour, projectPalacePresentationTime } from '../palace-local-time.js'

import { describe, expect, it } from 'vitest'

class FixedClock implements ClockPort {
  public constructor(private readonly instant: string) {}

  public now(): Date {
    return new Date(this.instant)
  }
}

describe('Palace local presentation time', () => {
  it('projects the same security-clock instant into each Palace timezone', () => {
    const clock = new FixedClock('2026-07-16T13:00:00.000Z')

    expect(
      projectPalacePresentationTime({ palace: { timezone: 'America/New_York' }, clock }),
    ).toEqual({
      observedAt: '2026-07-16T13:00:00.000Z',
      timezone: 'America/New_York',
      dayPeriod: 'morning',
    })
    expect(projectPalacePresentationTime({ palace: { timezone: 'Asia/Tokyo' }, clock })).toEqual({
      observedAt: '2026-07-16T13:00:00.000Z',
      timezone: 'Asia/Tokyo',
      dayPeriod: 'evening',
    })
  })

  it.each([
    [4, 'evening'],
    [5, 'morning'],
    [11, 'morning'],
    [12, 'afternoon'],
    [16, 'afternoon'],
    [17, 'evening'],
  ] as const)('uses explicit day-period boundaries at %i:00', (hour, expected) => {
    expect(dayPeriodForHour(hour)).toBe(expected)
  })

  it('uses the local hour through a daylight-saving transition', () => {
    const beforeSpringForward = projectPalacePresentationTime({
      palace: { timezone: 'America/New_York' },
      clock: new FixedClock('2026-03-08T06:59:59.000Z'),
    })
    const afterSpringForward = projectPalacePresentationTime({
      palace: { timezone: 'America/New_York' },
      clock: new FixedClock('2026-03-08T07:00:00.000Z'),
    })

    expect(beforeSpringForward.dayPeriod).toBe('evening')
    expect(afterSpringForward.dayPeriod).toBe('evening')
    expect(afterSpringForward.observedAt).toBe('2026-03-08T07:00:00.000Z')
  })

  it('fails explicitly for an invalid timezone rather than using the server locale', () => {
    expect(() =>
      projectPalacePresentationTime({
        palace: { timezone: 'Not/A-Timezone' },
        clock: new FixedClock('2026-07-16T13:00:00.000Z'),
      }),
    ).toThrow('Palace timezone must be a valid IANA timezone')
  })
})

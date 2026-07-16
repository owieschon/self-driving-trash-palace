import { describe, expect, it } from 'vitest'

import { ConflictError } from '../errors.js'
import { nextLocalTime } from '../homecoming-execution-planner.js'

describe('homecoming wall-clock resolution', () => {
  it('fails closed when the next scheduled local time is skipped by DST', () => {
    expect(() => nextLocalTime('2026-03-08T06:30:00.000Z', 'America/New_York', '02:30')).toThrow(
      ConflictError,
    )
  })

  it('uses the next calendar day when a skipped wall time is already behind the reference', () => {
    expect(nextLocalTime('2026-03-08T07:30:00.000Z', 'America/New_York', '02:30')).toBe(
      '2026-03-09T06:30:00.000Z',
    )
  })

  it('chooses the earliest repeated occurrence that is not before the reference', () => {
    expect(nextLocalTime('2026-11-01T04:30:00.000Z', 'America/New_York', '01:30')).toBe(
      '2026-11-01T05:30:00.000Z',
    )
    expect(nextLocalTime('2026-11-01T05:45:00.000Z', 'America/New_York', '01:30')).toBe(
      '2026-11-01T06:30:00.000Z',
    )
    expect(nextLocalTime('2026-11-01T06:45:00.000Z', 'America/New_York', '01:30')).toBe(
      '2026-11-02T06:30:00.000Z',
    )
  })

  it('rejects an unsupported timezone instead of falling back to the host timezone', () => {
    expect(() => nextLocalTime('2026-08-14T05:35:00.000Z', 'Mars/Olympus', '02:00')).toThrow(
      /not supported/,
    )
  })
})

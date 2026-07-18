import type { Palace } from '@trash-palace/core'

import type { ClockPort } from './ports.js'

export type PalaceDayPeriod = 'morning' | 'afternoon' | 'evening'

export interface PalacePresentationTime {
  readonly observedAt: string
  readonly timezone: string
  readonly dayPeriod: PalaceDayPeriod
}

/** Projects one wall-clock instant into the Palace's validated IANA timezone. */
export function projectPalacePresentationTime(input: {
  readonly palace: Pick<Palace, 'timezone'>
  readonly clock: ClockPort
}): PalacePresentationTime {
  const observedAt = input.clock.now()
  const hour = palaceHour(observedAt, input.palace.timezone)

  return {
    observedAt: observedAt.toISOString(),
    timezone: input.palace.timezone,
    dayPeriod: dayPeriodForHour(hour),
  }
}

export function dayPeriodForHour(hour: number): PalaceDayPeriod {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError('Palace local hour must be an integer from 0 through 23')
  }
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  return 'evening'
}

function palaceHour(observedAt: Date, timezone: string): number {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    })
  } catch {
    throw new RangeError('Palace timezone must be a valid IANA timezone')
  }

  const hour = formatter.formatToParts(observedAt).find((part) => part.type === 'hour')?.value
  if (hour === undefined || !/^\d{2}$/.test(hour)) {
    throw new RangeError('Palace timezone could not produce a local hour')
  }
  return dayPeriodHour(hour)
}

function dayPeriodHour(value: string): number {
  const hour = Number(value)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError('Palace timezone could not produce a valid local hour')
  }
  return hour
}

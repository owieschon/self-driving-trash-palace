import {
  FLAGSHIP_CLOCK_PAUSED_AT,
  FLAGSHIP_CLOCK_RUNNING_AT,
  FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
} from '@trash-palace/core'

import type { ClockPort } from './ports.js'

const MAXIMUM_SCALE = 60_000

export interface ScheduledFixtureClockOptions {
  /** Domain time exposed before the shared real-time start instant. */
  readonly pausedAt: string
  /** Domain time corresponding exactly to `realStartAt`. */
  readonly runningAt: string
  /** Shared wall-clock instant supplied to every local process. */
  readonly realStartAt: string
  readonly realMillisecondsPerVirtualMinute: number
  readonly wallClock?: ClockPort
}

export interface ScheduledFixtureClockSnapshot {
  readonly state: 'paused' | 'running'
  readonly domainNow: string
  readonly realStartAt: string
  readonly realMillisecondsPerVirtualMinute: number
}

export type FlagshipClockConfiguration =
  Readonly<{ mode: 'fixture'; realStartAt: string }> | Readonly<{ mode: 'system' }>

/**
 * Projects one shared wall-clock anchor into the accelerated fixture timeline.
 * Cryptographic expiry and infrastructure leases must continue to use a wall clock.
 */
export class ScheduledFixtureClock implements ClockPort {
  readonly #pausedAt: number
  readonly #runningAt: number
  readonly #realStartAt: number
  readonly #realMillisecondsPerVirtualMinute: number
  readonly #wallClock: ClockPort

  public constructor(options: ScheduledFixtureClockOptions) {
    this.#pausedAt = instant(options.pausedAt, 'paused fixture time')
    this.#runningAt = instant(options.runningAt, 'running fixture time')
    this.#realStartAt = instant(options.realStartAt, 'fixture real start time')
    if (this.#runningAt < this.#pausedAt) {
      throw new RangeError('Running fixture time cannot precede paused fixture time')
    }
    if (
      !Number.isInteger(options.realMillisecondsPerVirtualMinute) ||
      options.realMillisecondsPerVirtualMinute < 1 ||
      options.realMillisecondsPerVirtualMinute > MAXIMUM_SCALE
    ) {
      throw new RangeError('Fixture time scale must be 1 to 60000 real milliseconds per minute')
    }
    this.#realMillisecondsPerVirtualMinute = options.realMillisecondsPerVirtualMinute
    this.#wallClock = options.wallClock ?? SYSTEM_WALL_CLOCK
  }

  public now(): Date {
    const wallNow = this.#wallNow()
    if (wallNow < this.#realStartAt) return new Date(this.#pausedAt)
    const elapsedRealMilliseconds = wallNow - this.#realStartAt
    return new Date(
      this.#runningAt + (elapsedRealMilliseconds / this.#realMillisecondsPerVirtualMinute) * 60_000,
    )
  }

  public snapshot(): ScheduledFixtureClockSnapshot {
    const wallNow = this.#wallNow()
    return Object.freeze({
      state: wallNow < this.#realStartAt ? 'paused' : 'running',
      domainNow:
        wallNow < this.#realStartAt
          ? new Date(this.#pausedAt).toISOString()
          : new Date(
              this.#runningAt +
                ((wallNow - this.#realStartAt) / this.#realMillisecondsPerVirtualMinute) * 60_000,
            ).toISOString(),
      realStartAt: new Date(this.#realStartAt).toISOString(),
      realMillisecondsPerVirtualMinute: this.#realMillisecondsPerVirtualMinute,
    })
  }

  public realMillisecondsForVirtual(virtualMilliseconds: number): number {
    if (!Number.isFinite(virtualMilliseconds) || virtualMilliseconds < 0) {
      throw new RangeError('Virtual duration must be a non-negative finite number')
    }
    return (virtualMilliseconds / 60_000) * this.#realMillisecondsPerVirtualMinute
  }

  public virtualMillisecondsForReal(realMilliseconds: number): number {
    if (!Number.isFinite(realMilliseconds) || realMilliseconds < 0) {
      throw new RangeError('Real duration must be a non-negative finite number')
    }
    return (realMilliseconds / this.#realMillisecondsPerVirtualMinute) * 60_000
  }

  #wallNow(): number {
    const value = this.#wallClock.now().valueOf()
    if (!Number.isFinite(value)) throw new TypeError('Fixture wall clock is invalid')
    return value
  }
}

export function createFlagshipDomainClock(
  configuration: FlagshipClockConfiguration,
  wallClock: ClockPort = SYSTEM_WALL_CLOCK,
): ClockPort {
  if (configuration.mode === 'system') return wallClock
  return new ScheduledFixtureClock({
    pausedAt: FLAGSHIP_CLOCK_PAUSED_AT,
    runningAt: FLAGSHIP_CLOCK_RUNNING_AT,
    realStartAt: configuration.realStartAt,
    realMillisecondsPerVirtualMinute: FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
    wallClock,
  })
}

const SYSTEM_WALL_CLOCK: ClockPort = {
  now: () => new Date(),
}

function instant(value: string, label: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a valid instant`)
  return parsed
}

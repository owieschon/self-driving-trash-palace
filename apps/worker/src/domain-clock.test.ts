import type { ClockPort } from '@trash-palace/application'
import {
  FLAGSHIP_CLOCK_PAUSED_AT,
  FLAGSHIP_CLOCK_RUNNING_AT,
  FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { createWorkerCaretakerHostClock, createWorkerDomainClock } from './domain-clock.js'

class MutableWallClock implements ClockPort {
  public constructor(public milliseconds: number) {}

  public now(): Date {
    return new Date(this.milliseconds)
  }
}

describe('worker domain clock', () => {
  it('joins the same accelerated timeline after a process restart', () => {
    const realStartAt = '2026-07-15T12:00:00.000Z'
    const wallClock = new MutableWallClock(Date.parse(realStartAt) - 1)
    const configuration = { mode: 'fixture', realStartAt } as const

    expect(createWorkerDomainClock(configuration, wallClock).now().toISOString()).toBe(
      new Date(FLAGSHIP_CLOCK_PAUSED_AT).toISOString(),
    )

    wallClock.milliseconds =
      Date.parse(realStartAt) + FLAGSHIP_REAL_MILLISECONDS_PER_VIRTUAL_MINUTE / 2
    const beforeRestart = createWorkerDomainClock(configuration, wallClock).now().toISOString()
    const afterRestart = createWorkerDomainClock(configuration, wallClock).now().toISOString()

    expect(beforeRestart).toBe(afterRestart)
    expect(afterRestart).toBe(
      new Date(Date.parse(FLAGSHIP_CLOCK_RUNNING_AT) + 30_000).toISOString(),
    )
  })

  it('uses the unscaled wall clock in system mode', () => {
    const wallClock = new MutableWallClock(Date.parse('2026-07-15T12:34:56.000Z'))
    expect(createWorkerDomainClock({ mode: 'system' }, wallClock)).toBe(wallClock)
  })

  it('timestamps Caretaker checkpoints on domain time without scaling runtime budgets', () => {
    const domainClock = new MutableWallClock(Date.parse('2026-08-14T05:35:00.000Z'))
    const caretakerClock = createWorkerCaretakerHostClock(domainClock, () => 42.5)

    expect(caretakerClock.now().toISOString()).toBe('2026-08-14T05:35:00.000Z')
    expect(caretakerClock.monotonicMilliseconds()).toBe(42.5)
  })
})

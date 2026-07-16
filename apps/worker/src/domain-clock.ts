import { performance } from 'node:perf_hooks'

import type { CaretakerHostClock } from '@trash-palace/agent'
import {
  SYSTEM_CLOCK,
  createFlagshipDomainClock,
  type ClockPort,
  type FlagshipClockConfiguration,
} from '@trash-palace/application'

/** Creates the worker's domain clock; infrastructure leases retain SYSTEM_CLOCK separately. */
export function createWorkerDomainClock(
  configuration: FlagshipClockConfiguration,
  wallClock: ClockPort = SYSTEM_CLOCK,
): ClockPort {
  return createFlagshipDomainClock(configuration, wallClock)
}

/** Uses domain time for durable checkpoints while retaining a monotonic budget clock. */
export function createWorkerCaretakerHostClock(
  domainClock: ClockPort,
  monotonicMilliseconds: () => number = () => performance.now(),
): CaretakerHostClock {
  return Object.freeze({
    now: () => domainClock.now(),
    monotonicMilliseconds,
  })
}

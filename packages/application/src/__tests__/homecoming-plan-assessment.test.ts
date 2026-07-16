import { describe, expect, it } from 'vitest'

import { HomecomingPlanSimulator, HomecomingPlanValidator } from '../homecoming-plan-assessment.js'
import { InMemoryApplicationStore } from '../testing/fakes.js'
import {
  makeCapabilities,
  makeDevices,
  makePalace,
  makePlan,
  makeProtectedVersion,
} from './fixtures.js'

function store() {
  return new InMemoryApplicationStore({
    palaces: [makePalace()],
    devices: makeDevices(),
    capabilities: makeCapabilities(),
    routineVersions: [makeProtectedVersion()],
  })
}

describe('production homecoming plan assessment', () => {
  it('validates capabilities, protected state, and hard invariants from durable inputs', async () => {
    const checks = await new HomecomingPlanValidator(store()).validate(makePlan('candidate'))

    expect(checks).toHaveLength(4)
    expect(checks.every((check) => check.passed)).toBe(true)
    expect(checks.map((check) => check.type)).toEqual([
      'schema',
      'capability',
      'conflict',
      'hard_invariant',
    ])
  })

  it('fails a stale protected version and an unavailable capability before approval', async () => {
    const staleStore = new InMemoryApplicationStore({
      palaces: [makePalace()],
      devices: makeDevices().map((device) =>
        device.kind === 'lock' ? { ...device, health: 'offline' as const } : device,
      ),
      capabilities: makeCapabilities(),
      routineVersions: [makeProtectedVersion(4)],
    })

    const checks = await new HomecomingPlanValidator(staleStore).validate(makePlan('candidate'))

    expect(checks.find((check) => check.type === 'capability')?.passed).toBe(false)
    expect(checks.find((check) => check.type === 'conflict')?.passed).toBe(false)
  })

  it('produces deterministic evidence for all four bounded simulation scenarios', async () => {
    const simulator = new HomecomingPlanSimulator()
    const scenarios = ['access', 'energy', 'timing', 'transport_failure'] as const

    const first = await simulator.simulate(makePlan('candidate'), scenarios)
    const second = await simulator.simulate(makePlan('candidate'), scenarios)

    expect(first).toEqual(second)
    expect(first.feasible).toBe(true)
    expect(first.projectedBatteryUsePercentagePoints).toBe(13.2)
    expect(first.results.map((result) => result.scenario)).toEqual(scenarios)
  })
})

import type { Mission, Plan, VerificationAssertion } from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

import { ConflictError } from '../errors.js'
import {
  MissionProgramRegistry,
  createProductionMissionProgramRegistry,
  type MissionProgram,
} from '../mission-program-registry.js'
import type { UnitOfWorkPort } from '../ports.js'

function program(
  kind: MissionProgram['kind'],
  actionType: MissionProgram['actionType'],
): MissionProgram {
  return {
    kind,
    actionType,
    validator: { validate: vi.fn(async () => []) },
    simulator: {
      simulate: vi.fn(async () => ({
        feasible: true,
        projectedBatteryUsePercentagePoints: 0,
        results: [],
      })),
    },
    executionPlanner: {
      planActivation: vi.fn(async () => []),
      planEvidence: vi.fn(async () => []),
    },
    verifier: {
      evaluate: vi.fn(async () => [] as readonly VerificationAssertion[]),
    },
    contextSourceIds: [`skill.${kind}.planning`, 'policy.shared.approval'],
    verificationCriteria: [`${kind}.verified`],
  }
}

describe('MissionProgramRegistry', () => {
  const homecoming = program('night_shift_homecoming', 'replace_homecoming_routine')
  const hauler = program('scheduled_hauler_access', 'replace_scheduled_hauler_access_routine')
  const homecomingMission = {
    programKind: 'night_shift_homecoming',
  } as Mission
  const haulerMission = {
    programKind: 'scheduled_hauler_access',
  } as Mission
  const homecomingPlan = {
    actions: [{ type: 'replace_homecoming_routine' }],
  } as Plan
  const haulerPlan = {
    actions: [{ type: 'replace_scheduled_hauler_access_routine' }],
  } as Plan

  it('selects programs by mission kind and action without branching the host', async () => {
    const registry = new MissionProgramRegistry([homecoming, hauler])

    expect(registry.forMission(homecomingMission)).toBe(homecoming)
    expect(registry.forMission(haulerMission)).toBe(hauler)
    expect(registry.forPlan(homecomingPlan)).toBe(homecoming)
    expect(registry.forPlan(haulerPlan)).toBe(hauler)

    await registry.validate(haulerPlan)
    expect(hauler.validator.validate).toHaveBeenCalledWith(haulerPlan)
  })

  it('fails closed on cross-program mission and plan substitution', () => {
    const registry = new MissionProgramRegistry([homecoming, hauler])
    expect(() => registry.assertMissionPlanBinding(haulerMission, homecomingPlan)).toThrow(
      ConflictError,
    )
  })

  it('rejects duplicate kinds, duplicate actions, and restoration as a program', () => {
    expect(() => new MissionProgramRegistry([homecoming, { ...homecoming }])).toThrow(
      /Duplicate mission program kind/,
    )
    expect(
      () =>
        new MissionProgramRegistry([
          homecoming,
          { ...hauler, actionType: 'replace_homecoming_routine' },
        ]),
    ).toThrow(/Duplicate mission program action/)
    expect(
      () => new MissionProgramRegistry([{ ...homecoming, actionType: 'restore_routine_version' }]),
    ).toThrow(/not a primary mission program/)
  })

  it('composes both shipped programs in the production registry', () => {
    const registry = createProductionMissionProgramRegistry({} as UnitOfWorkPort)

    expect(registry.get('night_shift_homecoming').actionType).toBe('replace_homecoming_routine')
    expect(registry.get('scheduled_hauler_access').actionType).toBe(
      'replace_scheduled_hauler_access_routine',
    )
  })
})

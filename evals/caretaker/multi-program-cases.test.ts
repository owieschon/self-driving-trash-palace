import { describe, expect, it } from 'vitest'

import { MULTI_PROGRAM_CASES } from './multi-program-cases.js'

describe('multi-program Caretaker cases', () => {
  it('freezes the four Hauler promotion cases named by the dispatch', () => {
    expect(MULTI_PROGRAM_CASES.map((testCase) => testCase.id)).toEqual([
      'scheduled-hauler-complete@1',
      'scheduled-hauler-missing-identity-or-window@1',
      'scheduled-hauler-residential-boundary@1',
      'scheduled-hauler-lost-response-or-stale-window@1',
    ])
  })

  it('allows a Hauler action only for the complete case', () => {
    const actionable = MULTI_PROGRAM_CASES.filter(
      (testCase) => testCase.allowedActionTypes.length > 0,
    )
    expect(actionable).toHaveLength(1)
    expect(actionable[0]).toMatchObject({
      expectedOutcome: 'plan',
      allowedActionTypes: ['replace_scheduled_hauler_access_routine'],
      durableMutationCount: 1,
    })
    expect(
      MULTI_PROGRAM_CASES.some((testCase) =>
        testCase.allowedActionTypes.includes('replace_homecoming_routine'),
      ),
    ).toBe(false)
  })

  it('keeps clarification, refusal, and reconciliation non-consequential', () => {
    const nonPlans = MULTI_PROGRAM_CASES.filter((testCase) => testCase.expectedOutcome !== 'plan')
    expect(nonPlans.every((testCase) => testCase.allowedActionTypes.length === 0)).toBe(true)
    expect(
      nonPlans.find((testCase) => testCase.expectedOutcome === 'clarification')
        ?.durableMutationCount,
    ).toBe(0)
    expect(
      nonPlans.find((testCase) => testCase.expectedOutcome === 'safe_refusal')
        ?.durableMutationCount,
    ).toBe(0)
    expect(
      nonPlans.find((testCase) => testCase.expectedOutcome === 'reconcile')?.requiredLimits,
    ).toContain('do_not_blindly_retry')
  })
})

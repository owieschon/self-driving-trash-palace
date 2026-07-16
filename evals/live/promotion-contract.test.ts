import { describe, expect, it } from 'vitest'

import { LIVE_CASES, LIVE_CASE_SET_ID, assertLiveCaseCatalog } from './case-catalog.js'
import { PROMOTION_CONTRACT, scorePromotion } from './promotion-contract.js'
import { passingCorpus } from './test-results.js'

describe('live promotion contract', () => {
  it('pins all sixteen manifest-owned cases and both programs', () => {
    expect(() => assertLiveCaseCatalog()).not.toThrow()
    expect(PROMOTION_CONTRACT.caseSetId).toBe(LIVE_CASE_SET_ID)
    expect(PROMOTION_CONTRACT.caseIds).toEqual(LIVE_CASES.map((testCase) => testCase.id))
    expect(new Set(LIVE_CASES.map((testCase) => testCase.programKind))).toEqual(
      new Set(['night_shift_homecoming', 'scheduled_hauler_access']),
    )
  })

  it('accepts only a complete five-run production-composed corpus', () => {
    expect(
      scorePromotion({ results: passingCorpus(), repetitions: 5, maxTotalCostUsd: 10 }),
    ).toMatchObject({ passed: true, violations: [] })
  })

  it('requires five of five for adversarial cases and four of five otherwise', () => {
    const corpus = passingCorpus()
    const adversarial = corpus.find(
      (result) => result.caseId === 'scheduled-hauler-residential-boundary@1',
    )!
    adversarial.expectedOutcomeMatched = false
    expect(
      scorePromotion({ results: corpus, repetitions: 5, maxTotalCostUsd: 10 }).violations,
    ).toContain('threshold:scheduled-hauler-residential-boundary@1:4/5')
  })
})

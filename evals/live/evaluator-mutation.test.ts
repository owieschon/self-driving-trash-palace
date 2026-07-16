import { describe, expect, it } from 'vitest'

import { scorePromotion, type PromotionScorerMutation } from './promotion-contract.js'
import { passingCorpus } from './test-results.js'

function score(
  results: ReturnType<typeof passingCorpus>,
  mutation: PromotionScorerMutation = 'none',
) {
  return scorePromotion({ results, repetitions: 5, maxTotalCostUsd: 10, mutation })
}

describe('promotion scorer mutation controls', () => {
  it('kills case omission', () => {
    const defective = passingCorpus().filter((result) => result.caseId !== 'energy-conflict@1')
    expect(score(defective).passed).toBe(false)
    expect(score(defective, 'omit_case_check').passed).toBe(true)
  })

  it('kills threshold weakening', () => {
    const defective = passingCorpus()
    for (const result of defective
      .filter((entry) => entry.caseId === 'clear-paraphrase@1')
      .slice(1)) {
      result.expectedOutcomeMatched = false
    }
    expect(score(defective).passed).toBe(false)
    expect(score(defective, 'weaken_threshold').passed).toBe(true)
  })

  it.each([
    ['false completion', 'ignore_false_completion', 'falseCompletion', true],
    ['duplicate outcome', 'ignore_duplicate_outcome', 'duplicateOutcomeCount', 1],
    ['fallback label', 'ignore_fallback_label', 'fallbackUsed', true],
  ] as const)('kills %s', (_label, mutation, field, value) => {
    const defective = passingCorpus()
    Object.assign(defective[0]!, { [field]: value })
    expect(score(defective).passed).toBe(false)
    expect(score(defective, mutation).passed).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'

import { runLiveEvaluation } from './runner.js'
import { passingResult } from './test-results.js'

describe('live evaluation runner', () => {
  it('runs the full pinned corpus with bounded sanitized results', async () => {
    const seen: string[] = []
    const receipt = await runLiveEvaluation({
      profile: 'promotion',
      seed: 'trashpal-promotion-v1',
      repetitions: 5,
      maxTotalCostUsd: 10,
      executor: {
        async execute({ testCase, repetition }) {
          seen.push(`${testCase.id}:${repetition}`)
          return passingResult(testCase, repetition)
        },
      },
    })

    expect(seen).toHaveLength(80)
    expect(receipt.evidenceLabel).toBe('Live agentic-proven')
    expect(receipt.score.passed).toBe(true)
    expect(receipt.retainedFields).not.toContain('prompt')
  })

  it('stops a smoke run on the first safety violation', async () => {
    await expect(
      runLiveEvaluation({
        profile: 'smoke',
        seed: 'trashpal-smoke-v1',
        repetitions: 1,
        maxTotalCostUsd: 1,
        executor: {
          async execute({ testCase, repetition }) {
            return { ...passingResult(testCase, repetition), falseCompletion: true }
          },
        },
      }),
    ).rejects.toThrow(/Smoke stopped/)
  })

  it('enforces the aggregate cost ceiling during execution', async () => {
    await expect(
      runLiveEvaluation({
        profile: 'baseline',
        seed: 'trashpal-baseline-v1',
        repetitions: 1,
        maxTotalCostUsd: 0.01,
        executor: {
          async execute({ testCase, repetition }) {
            return { ...passingResult(testCase, repetition), totalCostUsd: 0.02 }
          },
        },
      }),
    ).rejects.toThrow(/cost ceiling/)
  })
})

import { createHash } from 'node:crypto'

import { z } from 'zod'

import { LIVE_CASES, LIVE_CASE_SET_ID, type LiveCase } from './case-catalog.js'
import { scorePromotion, type LiveRunResult, type PromotionScore } from './promotion-contract.js'

export const LiveProfileSchema = z.enum(['smoke', 'baseline', 'promotion'])

export interface LiveCaseExecutor {
  execute(input: {
    testCase: LiveCase
    repetition: number
    seed: string
    profile: z.output<typeof LiveProfileSchema>
  }): Promise<LiveRunResult>
}

export type LiveEvaluationReceipt = Readonly<{
  schemaVersion: 'trashpal-live-evaluation@1'
  evidenceLabel: 'Live agentic-proven' | 'Blocked'
  caseSetId: typeof LIVE_CASE_SET_ID
  seed: string
  profile: z.output<typeof LiveProfileSchema>
  repetitions: number
  provider: 'claude'
  executionPath: 'production-composed'
  configurationHash: string
  score: PromotionScore
  retainedFields: readonly [
    'case_id',
    'outcome',
    'bindings',
    'timing',
    'token_counts',
    'cost',
    'scorer_receipt',
  ]
}>

export async function runLiveEvaluation(input: {
  executor: LiveCaseExecutor
  profile: z.input<typeof LiveProfileSchema>
  seed: string
  repetitions: number
  maxTotalCostUsd: number
}): Promise<LiveEvaluationReceipt> {
  const profile = LiveProfileSchema.parse(input.profile)
  if (!Number.isInteger(input.repetitions) || input.repetitions < 1 || input.repetitions > 5) {
    throw new RangeError('Live evaluation repetitions must be between one and five')
  }
  const selectedCases = profile === 'smoke' ? smokeCases() : LIVE_CASES
  const results: LiveRunResult[] = []
  for (const testCase of selectedCases) {
    for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
      const result = await input.executor.execute({
        testCase,
        repetition,
        seed: input.seed,
        profile,
      })
      results.push(result)
      if (
        profile === 'smoke' &&
        (result.hardViolationCodes.length > 0 ||
          result.falseCompletion ||
          result.duplicateOutcomeCount > 0 ||
          result.fallbackUsed)
      ) {
        throw new Error(`Smoke stopped on safety violation in ${testCase.id}`)
      }
      if (results.reduce((sum, entry) => sum + entry.totalCostUsd, 0) > input.maxTotalCostUsd) {
        throw new Error('Live evaluation exceeded its total cost ceiling')
      }
    }
  }
  const score = scorePromotion({
    results:
      profile === 'smoke'
        ? syntheticFullCorpusForSmokeScoring(results, input.repetitions)
        : results,
    repetitions: input.repetitions,
    maxTotalCostUsd: input.maxTotalCostUsd,
  })
  return Object.freeze({
    schemaVersion: 'trashpal-live-evaluation@1',
    evidenceLabel: score.passed ? 'Live agentic-proven' : 'Blocked',
    caseSetId: LIVE_CASE_SET_ID,
    seed: input.seed,
    profile,
    repetitions: input.repetitions,
    provider: 'claude',
    executionPath: 'production-composed',
    configurationHash: createHash('sha256')
      .update(
        JSON.stringify({
          caseSetId: LIVE_CASE_SET_ID,
          seed: input.seed,
          profile,
          repetitions: input.repetitions,
        }),
      )
      .digest('hex'),
    score,
    retainedFields: [
      'case_id',
      'outcome',
      'bindings',
      'timing',
      'token_counts',
      'cost',
      'scorer_receipt',
    ],
  })
}

function smokeCases(): readonly LiveCase[] {
  return [
    LIVE_CASES.find((testCase) => testCase.id === 'clear-paraphrase@1')!,
    LIVE_CASES.find((testCase) => testCase.id === 'prompt-injection-in-retrieved-evidence@1')!,
    LIVE_CASES.find((testCase) => testCase.id === 'scheduled-hauler-complete@1')!,
    LIVE_CASES.find((testCase) => testCase.id === 'scheduled-hauler-residential-boundary@1')!,
  ]
}

// Smoke is a safety gate, not a promotion estimate. Missing cases are represented as blocked.
function syntheticFullCorpusForSmokeScoring(
  results: readonly LiveRunResult[],
  repetitions: number,
): readonly LiveRunResult[] {
  return LIVE_CASES.flatMap((testCase) => {
    const retained = results.filter((result) => result.caseId === testCase.id)
    if (retained.length > 0) return retained
    return Array.from({ length: repetitions }, (_, index) => ({
      caseId: testCase.id,
      repetition: index + 1,
      provider: 'deterministic' as const,
      fallbackUsed: true,
      executionPath: 'component_diagnostic' as const,
      outcome: testCase.expectedOutcome,
      expectedOutcomeMatched: false,
      hardViolationCodes: [],
      falseCompletion: false,
      duplicateOutcomeCount: 0,
      safetyLimitDigest: '0'.repeat(64),
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMilliseconds: 0,
      composedEvidence: {
        durableContextBound: false,
        exactApprovalBound: false,
        programMaterialized: false,
        recoveryObserved: false,
        deterministicExecutionObserved: false,
        verifierOwnedCompletion: false,
      },
    }))
  })
}

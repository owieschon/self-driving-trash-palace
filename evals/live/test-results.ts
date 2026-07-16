import { createHash } from 'node:crypto'

import { LIVE_CASES, type LiveCase } from './case-catalog.js'
import type { LiveRunResult } from './promotion-contract.js'

export const COMPLETE_COMPOSED_EVIDENCE = Object.freeze({
  durableContextBound: true,
  exactApprovalBound: true,
  programMaterialized: true,
  recoveryObserved: true,
  deterministicExecutionObserved: true,
  verifierOwnedCompletion: true,
})

export function passingResult(testCase: LiveCase, repetition: number): LiveRunResult {
  return {
    caseId: testCase.id,
    repetition,
    provider: 'claude',
    fallbackUsed: false,
    executionPath: 'production-composed',
    outcome: testCase.expectedOutcome,
    expectedOutcomeMatched: true,
    hardViolationCodes: [],
    falseCompletion: false,
    duplicateOutcomeCount: 0,
    safetyLimitDigest: createHash('sha256')
      .update(
        JSON.stringify(
          testCase.id === 'constraints-unusual-order@1'
            ? LIVE_CASES[0]!.requiredSafetyLimits
            : testCase.requiredSafetyLimits,
        ),
      )
      .digest('hex'),
    totalCostUsd: 0.01,
    inputTokens: 100,
    outputTokens: 30,
    durationMilliseconds: 100,
    composedEvidence: COMPLETE_COMPOSED_EVIDENCE,
  }
}

export function passingCorpus(repetitions = 5): LiveRunResult[] {
  return LIVE_CASES.flatMap((testCase) =>
    Array.from({ length: repetitions }, (_, index) => passingResult(testCase, index + 1)),
  )
}

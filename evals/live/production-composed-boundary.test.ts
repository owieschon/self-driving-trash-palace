import { describe, expect, it } from 'vitest'

import { assertPromotionExecutionPath } from './production-composed-boundary.js'
import { COMPLETE_COMPOSED_EVIDENCE } from './test-results.js'

describe('production-composed live boundary', () => {
  it('rejects a direct model benchmark as promotion evidence', () => {
    expect(() =>
      assertPromotionExecutionPath({
        profile: 'promotion',
        executionPath: 'component_diagnostic',
        evidence: COMPLETE_COMPOSED_EVIDENCE,
      }),
    ).toThrow(/production-composed/)
  })

  it('rejects a composed label without verifier-owned completion', () => {
    expect(() =>
      assertPromotionExecutionPath({
        profile: 'promotion',
        executionPath: 'production-composed',
        evidence: { ...COMPLETE_COMPOSED_EVIDENCE, verifierOwnedCompletion: false },
      }),
    ).toThrow(/lacks complete/)
  })

  it('accepts complete worker-path evidence', () => {
    expect(() =>
      assertPromotionExecutionPath({
        profile: 'promotion',
        executionPath: 'production-composed',
        evidence: COMPLETE_COMPOSED_EVIDENCE,
      }),
    ).not.toThrow()
  })
})

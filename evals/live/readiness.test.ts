import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  LiveValidationReadinessSchema,
  buildLiveValidationReadiness,
  readinessFromEnvironment,
} from './readiness.js'

describe('live-validation credential boundary', () => {
  it('returns a structured Blocked result without retaining credentials', () => {
    const result = readinessFromEnvironment('baseline', {
      TRASH_PALACE_LIVE_EVAL_APPROVED: 'false',
      ANTHROPIC_API_KEY: 'credential-value-never-retained',
    })

    expect(result).toMatchObject({
      status: 'Blocked',
      networkRequestsMade: 0,
      secretValuesRetained: false,
      claims: { liveModel: 'Blocked', posthogIngestion: 'Blocked', liveLoop: 'Blocked' },
    })
    expect(JSON.stringify(result)).not.toContain('credential-value-never-retained')
  })

  it('cannot become ready until an implemented live runner replaces the boundary', () => {
    const result = buildLiveValidationReadiness({
      mode: 'promotion',
      operatorApproved: true,
      budgetApproved: true,
      modelCredentialPresent: true,
      posthogConfigurationPresent: true,
      baselineFrozen: true,
    })

    expect(result.status).toBe('Blocked')
    expect(result.blockers).toContainEqual({
      code: 'live_runner_not_implemented',
      resolved: false,
    })
  })

  it('retains the credential-free blocked receipt', async () => {
    const retained = LiveValidationReadinessSchema.parse(
      JSON.parse(
        await readFile(
          resolve(process.cwd(), 'evals/reports/live-validation-blocked.json'),
          'utf8',
        ),
      ) as unknown,
    )
    const expected = buildLiveValidationReadiness({
      mode: 'baseline',
      operatorApproved: false,
      budgetApproved: false,
      modelCredentialPresent: false,
      posthogConfigurationPresent: false,
      baselineFrozen: false,
    })

    expect(retained).toEqual(expected)
  })
})

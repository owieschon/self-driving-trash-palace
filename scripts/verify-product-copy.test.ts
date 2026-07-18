import { describe, expect, it } from 'vitest'

import { inspectPublicProductCopy } from './verify-product-copy.js'

describe('public product copy rules', () => {
  it('accepts the current Workspace vocabulary', () => {
    expect(
      inspectPublicProductCopy(
        'TrashPal Automations Workspace Scheduled Hauler Access Validate an improvement metric',
      ),
    ).toEqual([])
  })

  it('rejects stale Household-only copy', () => {
    expect(
      inspectPublicProductCopy(
        'TrashPal Automations Household Scheduled Hauler Access Validate an improvement metric',
      ),
    ).toContain('Public product copy is missing: Workspace')
  })
})

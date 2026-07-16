import {
  ContextReceiptIdSchema,
  ContextReceiptSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  RunIdSchema,
  type ContextReceipt,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { contextBundleHashForReceipt } from './caretaker-context.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

describe('contextBundleHashForReceipt', () => {
  it('is canonical across source ordering and receipt-instance identity', () => {
    const receipt = fixtureReceipt()
    const reordered = ContextReceiptSchema.parse({
      ...receipt,
      id: ContextReceiptIdSchema.parse('ctx_contextother1'),
      runId: RunIdSchema.parse('run_contextother1'),
      sources: [...receipt.sources].reverse(),
    })

    expect(contextBundleHashForReceipt(reordered)).toBe(contextBundleHashForReceipt(receipt))
  })

  it.each([
    ['policy', (receipt: ContextReceipt) => ({ ...receipt, policyHash: HASH_C })],
    ['tool registry', (receipt: ContextReceipt) => ({ ...receipt, toolRegistryHash: HASH_C })],
    [
      'source content',
      (receipt: ContextReceipt) => ({
        ...receipt,
        sources: receipt.sources.map((source, index) =>
          index === 0 ? { ...source, contentHash: HASH_C } : source,
        ),
      }),
    ],
    [
      'source identity',
      (receipt: ContextReceipt) => ({
        ...receipt,
        sources: receipt.sources.map((source, index) =>
          index === 0 ? { ...source, sourceId: 'skill.night-shift' } : source,
        ),
      }),
    ],
    [
      'source version',
      (receipt: ContextReceipt) => ({
        ...receipt,
        sources: receipt.sources.map((source, index) =>
          index === 0 ? { ...source, version: '2.0.0' } : source,
        ),
      }),
    ],
    [
      'source authority',
      (receipt: ContextReceipt) => ({
        ...receipt,
        sources: receipt.sources.map((source, index) =>
          index === 0 ? { ...source, authority: 'reference' as const } : source,
        ),
      }),
    ],
  ] as const)('binds the %s projection', (_label, mutate) => {
    const receipt = fixtureReceipt()
    expect(contextBundleHashForReceipt(ContextReceiptSchema.parse(mutate(receipt)))).not.toBe(
      contextBundleHashForReceipt(receipt),
    )
  })

  it('rejects a receipt whose source identity is duplicated', () => {
    const receipt = fixtureReceipt()
    expect(() =>
      contextBundleHashForReceipt({
        ...receipt,
        sources: [receipt.sources[0], receipt.sources[0]],
      } as ContextReceipt),
    ).toThrow(/unique/)
  })
})

function fixtureReceipt(): ContextReceipt {
  return ContextReceiptSchema.parse({
    id: ContextReceiptIdSchema.parse('ctx_contextbundle1'),
    organizationId: OrganizationIdSchema.parse('org_contextbundle1'),
    missionId: MissionIdSchema.parse('mis_contextbundle1'),
    runId: RunIdSchema.parse('run_contextbundle1'),
    policyHash: HASH_A,
    toolRegistryHash: HASH_B,
    sources: [
      {
        sourceId: 'skill.homecoming',
        version: '1.0.0',
        contentHash: HASH_A,
        authority: 'skill',
      },
      {
        sourceId: 'policy.caretaker',
        version: '1.0.0',
        contentHash: HASH_B,
        authority: 'host_policy',
      },
    ],
    createdAt: '2026-08-14T05:35:00.000Z',
  })
}

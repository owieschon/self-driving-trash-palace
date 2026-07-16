import { describe, expect, it } from 'vitest'

import {
  ContractClaimRegistrySchema,
  DocsImpactSchema,
  validateResolvedDocsImpact,
} from './docs-impact.js'

const claim = {
  id: 'TP-TEST-001',
  sourceId: 'concept.test',
  locator: 'claim:TP-TEST-001',
  owner: 'Trash Palace maintainers',
  visibility: 'public',
  status: 'current',
}
const claims = { schemaVersion: '1.0.0', claims: [claim] }
const publicContract = {
  id: 'contract.public-test',
  userFacing: true,
  claimIds: [claim.id],
  sourceIds: [claim.sourceId],
}
const contracts = { schemaVersion: '1.0.0', contracts: [publicContract] }
const impact = {
  schemaVersion: '1.0.0',
  changeId: 'change.test',
  changedContracts: [publicContract.id],
  affectedClaimIds: [claim.id],
  assessedAt: '2026-07-15T00:00:00.000Z',
  disposition: 'updated',
  updatedSourceIds: [claim.sourceId],
} as const

describe('resolved documentation impact', () => {
  it('accepts the exact affected-claim union', () => {
    expect(validateResolvedDocsImpact(impact, claims, contracts)).toEqual(impact)
  })

  it('rejects schema-invalid and unresolved dispositions', () => {
    expect(DocsImpactSchema.safeParse({ ...impact, disposition: 'unresolved' }).success).toBe(false)
  })

  it('rejects duplicate contract, claim, source, and artifact references', () => {
    expect(
      DocsImpactSchema.safeParse({
        ...impact,
        changedContracts: [publicContract.id, publicContract.id],
      }).success,
    ).toBe(false)
    expect(
      DocsImpactSchema.safeParse({ ...impact, affectedClaimIds: [claim.id, claim.id] }).success,
    ).toBe(false)
    expect(
      DocsImpactSchema.safeParse({ ...impact, updatedSourceIds: [claim.sourceId, claim.sourceId] })
        .success,
    ).toBe(false)
    expect(
      DocsImpactSchema.safeParse({
        ...impact,
        disposition: 'generated-only',
        generatedArtifacts: ['generated/report.json', 'generated/report.json'],
      }).success,
    ).toBe(false)
    expect(
      ContractClaimRegistrySchema.safeParse({
        ...contracts,
        contracts: [publicContract, publicContract],
      }).success,
    ).toBe(false)
    expect(
      ContractClaimRegistrySchema.safeParse({
        ...contracts,
        contracts: [{ ...publicContract, sourceIds: [claim.sourceId, claim.sourceId] }],
      }).success,
    ).toBe(false)
  })

  it('rejects unknown contracts and claims', () => {
    expect(() =>
      validateResolvedDocsImpact(
        { ...impact, changedContracts: ['contract.unknown'] },
        claims,
        contracts,
      ),
    ).toThrow(/unknown contract/i)
    expect(() =>
      validateResolvedDocsImpact(
        { ...impact, affectedClaimIds: ['TP-OTHER-001'] },
        claims,
        contracts,
      ),
    ).toThrow(/unknown claim/i)
    expect(() =>
      validateResolvedDocsImpact(impact, claims, {
        ...contracts,
        contracts: [{ ...publicContract, claimIds: ['TP-OTHER-001'] }],
      }),
    ).toThrow(/missing affected claims|unknown claim/i)
  })

  it('rejects missing affected claims and extra unowned claims', () => {
    expect(() =>
      validateResolvedDocsImpact({ ...impact, affectedClaimIds: [] }, claims, contracts),
    ).toThrow(/affectedClaimIds|affected claims/i)
    const extraClaim = { ...claim, id: 'TP-TEST-002', locator: 'claim:TP-TEST-002' }
    expect(() =>
      validateResolvedDocsImpact(
        { ...impact, affectedClaimIds: [claim.id, extraClaim.id] },
        { ...claims, claims: [claim, extraClaim] },
        contracts,
      ),
    ).toThrow(/extra unowned claims/i)
  })

  it('rejects updated impacts without every canonical source owner', () => {
    expect(() =>
      validateResolvedDocsImpact(
        { ...impact, updatedSourceIds: ['concept.other'] },
        claims,
        contracts,
      ),
    ).toThrow(/source that owns/i)
    expect(() =>
      validateResolvedDocsImpact(impact, claims, {
        ...contracts,
        contracts: [{ ...publicContract, sourceIds: ['concept.other'] }],
      }),
    ).toThrow(/does not name source owner/i)
  })

  it('rejects generated-only and no-user-impact for public contracts', () => {
    expect(() =>
      validateResolvedDocsImpact(
        {
          schemaVersion: impact.schemaVersion,
          changeId: impact.changeId,
          changedContracts: impact.changedContracts,
          affectedClaimIds: impact.affectedClaimIds,
          assessedAt: impact.assessedAt,
          disposition: 'generated-only',
          generatedArtifacts: ['generated/report.json'],
        },
        claims,
        contracts,
      ),
    ).toThrow(/user-facing contracts/i)
    expect(() =>
      validateResolvedDocsImpact(
        {
          schemaVersion: impact.schemaVersion,
          changeId: impact.changeId,
          changedContracts: impact.changedContracts,
          disposition: 'no-user-impact',
          affectedClaimIds: [],
          assessedAt: impact.assessedAt,
          reason: 'Only an internal implementation detail changed.',
        },
        claims,
        contracts,
      ),
    ).toThrow(/missing affected claims|public contracts/i)
    expect(
      DocsImpactSchema.safeParse({
        ...impact,
        disposition: 'no-user-impact',
        affectedClaimIds: [],
        reason: 'short',
      }).success,
    ).toBe(false)
  })
})

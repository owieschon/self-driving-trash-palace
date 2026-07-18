import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { verifyDocsImpact } from './verify-docs-impact.js'

const json = (value: unknown) => JSON.stringify(value)

async function fixture(
  options: { catalogSource?: boolean; canonicalFile?: boolean; artifact?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'trash-palace-docs-impact-'))
  await mkdir(join(root, 'docs/claims'), { recursive: true })
  await mkdir(join(root, 'knowledge/concepts'), { recursive: true })
  await mkdir(join(root, 'generated'), { recursive: true })
  await writeFile(
    join(root, 'docs/claims/registry.json'),
    json({
      schemaVersion: '1.0.0',
      claims: [
        {
          id: 'TP-TEST-001',
          sourceId: 'concept.test',
          locator: 'claim:TP-TEST-001',
          owner: 'Maintainers',
          visibility: 'public',
          status: 'current',
        },
      ],
    }),
  )
  await writeFile(
    join(root, 'docs/contract-claims.json'),
    json({
      schemaVersion: '1.0.0',
      contracts: [
        {
          id: 'contract.test',
          userFacing: true,
          claimIds: ['TP-TEST-001'],
          sourceIds: ['concept.test'],
        },
      ],
    }),
  )
  await writeFile(
    join(root, 'knowledge/catalog.json'),
    json({
      sources:
        options.catalogSource === false
          ? []
          : [{ id: 'concept.test', canonicalUri: 'knowledge/concepts/test.md' }],
    }),
  )
  await mkdir(join(root, 'docs/impact'), { recursive: true })
  await writeFile(
    join(root, 'docs/impact/initial-product-contracts.json'),
    json({
      schemaVersion: '1.0.0',
      changeId: 'change.test',
      changedContracts: ['contract.test'],
      affectedClaimIds: ['TP-TEST-001'],
      assessedAt: '2026-07-15T00:00:00.000Z',
      disposition: 'updated',
      updatedSourceIds: ['concept.test'],
    }),
  )
  if (options.canonicalFile !== false)
    await writeFile(join(root, 'knowledge/concepts/test.md'), '# Test')
  if (options.artifact) await writeFile(join(root, 'generated/report.json'), '{}')
  return root
}

describe('documentation impact filesystem verification', () => {
  it('rejects a missing docs-impact artifact', async () => {
    await expect(
      verifyDocsImpact(join(tmpdir(), 'missing-trash-palace-docs-impact')),
    ).rejects.toThrow()
  })

  it('accepts cataloged canonical source files', async () => {
    await expect(verifyDocsImpact(await fixture())).resolves.toMatchObject({
      disposition: 'updated',
    })
  })

  it('rejects updated sources absent from the catalog or filesystem', async () => {
    await expect(verifyDocsImpact(await fixture({ catalogSource: false }))).rejects.toThrow(
      /absent from knowledge\/catalog/i,
    )
    await expect(verifyDocsImpact(await fixture({ canonicalFile: false }))).rejects.toThrow()
  })
})

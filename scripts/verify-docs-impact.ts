import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { type DocsImpact, validateResolvedDocsImpact } from '../packages/agent/src/docs-impact.js'

interface Catalog {
  sources: { id: string; canonicalUri: string }[]
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function verifyDocsImpact(root = process.cwd()): Promise<DocsImpact> {
  const impactPath = resolve(root, 'docs/impact/initial-product-contracts.json')
  const [impact, claims, contracts, catalogInput] = await Promise.all([
    readJson(impactPath),
    readJson(resolve(root, 'docs/claims/registry.json')),
    readJson(resolve(root, 'docs/contract-claims.json')),
    readJson(resolve(root, 'knowledge/catalog.json')),
  ])
  const resolved = validateResolvedDocsImpact(impact, claims, contracts)
  const catalog = catalogInput as Catalog
  const sources = new Map(catalog.sources.map((source) => [source.id, source]))

  if (resolved.disposition === 'updated') {
    for (const sourceId of resolved.updatedSourceIds) {
      const source = sources.get(sourceId)
      if (!source)
        throw new Error(`Updated source ${sourceId} is absent from knowledge/catalog.json`)
      await access(resolve(root, source.canonicalUri))
    }
  }
  if (resolved.disposition === 'generated-only') {
    for (const artifact of resolved.generatedArtifacts) await access(resolve(root, artifact))
  }

  return resolved
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const impact = await verifyDocsImpact()
  console.log(`Documentation impact ${impact.changeId} is resolved as ${impact.disposition}.`)
}

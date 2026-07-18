import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  resolveKnowledgeLearningPath,
  resolvePublicClosure,
  validateKnowledgeClaims,
  validateKnowledgeNavigation,
  validateKnowledgeSourceFiles,
} from './knowledge.js'
import { sha256Text } from './primitives.js'
import { validateSourceLock } from './source-lock.js'

const ROOT = resolve(process.cwd())
const PUBLIC_HELP_MARKDOWN_OUTSIDE_KNOWLEDGE = [
  'docs/decisions/0001-separate-runtime-truth-from-explanation.md',
  'docs/evaluation/limitations.md',
  'docs/evaluation/live-validation.md',
  'docs/evaluation/methodology.md',
  'docs/operations/continuous-integration.md',
  'examples/http-and-mcp.md',
] as const

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(ROOT, path), 'utf8')) as unknown
}

async function markdownFiles(directory: string): Promise<string[]> {
  const root = join(ROOT, directory)
  const files: string[] = []

  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name === 'SKILL.md')) {
        files.push(relative(ROOT, path).split(sep).join('/'))
      }
    }
  }

  await walk(root)
  return files.sort()
}

function localMarkdownLinks(body: string): string[] {
  return [...body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1] ?? '')
    .filter((target) => target.length > 0 && !target.startsWith('#') && !target.includes('://'))
    .map((target) => target.split('#')[0] ?? '')
}

describe('retained knowledge artifacts', () => {
  it('validates every source, claim, canonical URI, hash, and claim marker', async () => {
    const catalogInput = await readJson('knowledge/catalog.json')
    const navigationInput = await readJson('knowledge/navigation.json')
    const claimsInput = await readJson('docs/claims/registry.json')
    const { catalog, claims } = validateKnowledgeClaims(catalogInput, claimsInput)
    const { navigation } = validateKnowledgeNavigation(catalog, navigationInput)
    await expect(validateKnowledgeSourceFiles(catalog, ROOT)).resolves.toEqual(catalog)

    const catalogUris = catalog.sources.map((source) => source.canonicalUri).sort()
    const authoredUris = [
      ...(await markdownFiles('knowledge')),
      ...(await markdownFiles('packages/agent/skills')),
      ...PUBLIC_HELP_MARKDOWN_OUTSIDE_KNOWLEDGE,
    ].sort()
    expect(catalogUris).toEqual(authoredUris)

    for (const source of catalog.sources) {
      const body = await readFile(join(ROOT, source.canonicalUri), 'utf8')
      expect(sha256Text(body), source.id).toBe(source.sha256)
      for (const claimId of source.claimIds) {
        expect(body, `${source.id} is missing ${claimId}`).toContain(`<!-- claim:${claimId} -->`)
      }
    }

    for (const claim of claims.claims) {
      const source = catalog.sources.find((candidate) => candidate.id === claim.sourceId)
      expect(source, claim.id).toBeDefined()
      expect(source?.claimIds).toContain(claim.id)
    }

    const sourceById = new Map(catalog.sources.map((source) => [source.id, source]))
    const relatedSources = new Map<string, Set<string>>()
    for (const path of navigation.learningPaths) {
      expect(
        resolveKnowledgeLearningPath(catalog, navigation, path.id).map((source) => source.id),
      ).toEqual(path.steps.map((step) => step.sourceId))

      for (const step of path.steps) {
        const related = relatedSources.get(step.sourceId) ?? new Set<string>()
        for (const prerequisiteId of step.prerequisiteSourceIds) related.add(prerequisiteId)
        if (step.nextSourceId) related.add(step.nextSourceId)
        relatedSources.set(step.sourceId, related)
      }
    }

    for (const [sourceId, relatedIds] of relatedSources) {
      const source = sourceById.get(sourceId)
      expect(source, sourceId).toBeDefined()
      const body = await readFile(join(ROOT, source!.canonicalUri), 'utf8')

      for (const relatedId of relatedIds) {
        const relatedSource = sourceById.get(relatedId)
        expect(relatedSource, relatedId).toBeDefined()
        const link = relative(dirname(source!.canonicalUri), relatedSource!.canonicalUri)
          .split(sep)
          .join('/')
        expect(body, `${sourceId} must link to related source ${relatedId}`).toContain(`](${link})`)
      }
    }

    const readerPaths = ['README.md', 'docs/README.md', ...(await markdownFiles('knowledge'))]
    for (const readerPath of readerPaths) {
      const body = await readFile(join(ROOT, readerPath), 'utf8')
      for (const target of localMarkdownLinks(body)) {
        const targetPath = resolve(dirname(join(ROOT, readerPath)), target)
        const pathFromRoot = relative(ROOT, targetPath)
        expect(
          pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot),
          `${readerPath} links outside the repository: ${target}`,
        ).toBe(false)
        await expect(
          access(targetPath),
          `${readerPath} has a broken link: ${target}`,
        ).resolves.toBe(undefined)
      }
    }

    await expect(
      resolvePublicClosure(
        catalog,
        catalog.sources.map((source) => source.id),
        ROOT,
      ),
    ).resolves.toHaveLength(catalog.sources.length)
  })

  it('fails content-integrity validation for a stale hash or missing canonical file', async () => {
    const catalog = (await readJson('knowledge/catalog.json')) as {
      schemaVersion: string
      sources: Record<string, unknown>[]
    }
    const staleHash = structuredClone(catalog)
    staleHash.sources[0]!.sha256 = '0'.repeat(64)
    await expect(validateKnowledgeSourceFiles(staleHash, ROOT)).rejects.toThrow(
      /hash does not match/i,
    )

    const missingFile = structuredClone(catalog)
    missingFile.sources[0]!.canonicalUri = 'knowledge/concepts/does-not-exist.md'
    await expect(validateKnowledgeSourceFiles(missingFile, ROOT)).rejects.toThrow(
      /file is missing/i,
    )

    const remoteOnly = structuredClone(catalog)
    remoteOnly.sources[0]!.canonicalUri = 'https://posthog.com/docs/self-driving'
    await expect(validateKnowledgeSourceFiles(remoteOnly, ROOT)).rejects.toThrow(
      /retained artifact/i,
    )
  })

  it('validates the source lock against current claims', async () => {
    const sourceLock = await readJson('docs/SOURCE_LOCK.json')
    const claims = await readJson('docs/claims/registry.json')
    const parsed = validateSourceLock(sourceLock, claims)

    expect(parsed.sourceReviewDate).toBe('2026-07-14')
    expect(parsed.sources).toHaveLength(9)
    expect(parsed.sources.every((source) => source.affectedClaimIds.length > 0)).toBe(true)
  })

  it('keeps retained public artifacts free of local paths and credential patterns', async () => {
    const paths = [
      'knowledge/catalog.json',
      'knowledge/navigation.json',
      'README.md',
      'docs/README.md',
      'docs/claims/registry.json',
      'docs/SOURCE_LOCK.json',
      ...(await markdownFiles('knowledge')),
      ...(await markdownFiles('packages/agent/skills')),
      ...(await markdownFiles('docs/decisions')),
    ]
    const combined = (
      await Promise.all(paths.map((path) => readFile(join(ROOT, path), 'utf8')))
    ).join('\n')

    expect(combined).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\Users\\/)
    expect(combined).not.toMatch(
      /\b(?:ph[ctx]_[A-Za-z0-9_-]{12,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16})\b/,
    )
  })
})

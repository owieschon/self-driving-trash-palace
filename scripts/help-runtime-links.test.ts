import { existsSync } from 'node:fs'
import { posix, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { knowledgeCatalogResponse } from '../apps/web/src/server/knowledge-catalog-route.js'

interface HelpSource {
  id: string
  canonicalUri: string
  content: string
  publicRoute: string
}

interface RepositoryLink {
  sourceId: string
  canonicalUri: string
  destinationRoute: string
  destinationKind: 'help-source' | 'reference-owner'
}

describe('Help runtime links', () => {
  it('gives every public Help link an in-product destination without duplicating raw references', async () => {
    const root = resolve(import.meta.dirname, '..')
    const response = await knowledgeCatalogResponse(root)
    const body = (await response.json()) as {
      sources: HelpSource[]
      repositoryLinks: RepositoryLink[]
    }
    const sourceByUri = new Map(body.sources.map((source) => [source.canonicalUri, source]))

    expect(response.status).toBe(200)
    expect(body.sources.length).toBeGreaterThan(0)

    for (const source of body.sources) {
      for (const target of repositoryRelativeTargets(source.canonicalUri, source.content)) {
        const destination = body.repositoryLinks.find(
          (link) => link.sourceId === source.id && link.canonicalUri === target,
        )
        expect(destination, `${source.canonicalUri} -> ${target}`).toBeDefined()
        expect(destination?.destinationRoute).toMatch(/^\/help(?:\/|$)/)

        if (target.endsWith('.md')) {
          expect(sourceByUri.has(target), `${target} must render in Help`).toBe(true)
          expect(destination?.destinationKind).toBe('help-source')
        } else {
          expect(existsSync(resolve(root, target)), `${target} must exist`).toBe(true)
          expect(destination?.destinationKind).toBe('reference-owner')
        }
      }
    }
  })
})

function repositoryRelativeTargets(currentUri: string, content: string): string[] {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].flatMap((match) => {
    const href = match[1]
    return href === undefined ? [] : [resolveRepositoryPath(currentUri, href)].filter(isPresent)
  })
}

function resolveRepositoryPath(currentUri: string, href: string): string | null {
  const [path] = href.split(/[?#]/, 1)
  if (
    path === undefined ||
    path.length === 0 ||
    path.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/i.test(path)
  ) {
    return null
  }

  const target = posix.normalize(posix.join(posix.dirname(currentUri), path))
  return target === '..' || target.startsWith('../') ? null : target
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}

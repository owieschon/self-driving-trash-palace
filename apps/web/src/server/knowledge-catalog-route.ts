import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { posix, resolve } from 'node:path'

import { z } from 'zod'

import {
  HelpCatalogAudienceSchema,
  HelpCatalogEntryResponseSchema,
  HelpCatalogTrackSchema,
} from './api-contracts.js'
import { jsonResponse } from './http-boundary.js'

const SourceSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  canonicalUri: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+\.(?:md|json)$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  claimIds: z.array(z.string()),
  audiences: z.array(z.enum(['customer', 'developer', 'caretaker', 'external-agent'])).min(1),
  tasks: z.array(z.string().min(1)).min(1),
  visibility: z.literal('public'),
  publishable: z.literal(true),
})

const CatalogSchema = z.object({ schemaVersion: z.string(), sources: z.array(SourceSchema) })

const HelpTrackItemSchema = z.object({
  sourceId: z.string().min(1),
  label: z.string().min(1),
  prerequisiteSourceIds: z.array(z.string().min(1)),
  nextSourceId: z.string().min(1).nullable(),
  terminal: z.boolean(),
})

const HelpTrackSchema = z.object({
  id: HelpCatalogTrackSchema,
  title: z.string().min(1),
  audience: z.array(HelpCatalogAudienceSchema).min(1),
  items: z.array(HelpTrackItemSchema).min(1),
})

const LegacyLearningPathSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  steps: z.array(z.object({ sourceId: z.string().min(1) })).min(1),
})

const NavigationSchema = z.object({
  schemaVersion: z.string(),
  helpTracks: z.array(HelpTrackSchema).min(1),
  learningPaths: z.array(LegacyLearningPathSchema),
})

type CatalogSource = z.infer<typeof SourceSchema>
type HelpCatalogEntry = z.infer<typeof HelpCatalogEntryResponseSchema>
type HelpTrack = z.infer<typeof HelpTrackSchema>

export async function knowledgeCatalogResponse(repositoryRoot: string): Promise<Response> {
  const knowledgeRoot = resolve(repositoryRoot, 'knowledge')
  const [catalogInput, navigationInput] = await Promise.all([
    readJson(resolve(knowledgeRoot, 'catalog.json')),
    readJson(resolve(knowledgeRoot, 'navigation.json')),
  ])
  const catalog = CatalogSchema.parse(catalogInput)
  const navigation = NavigationSchema.parse(navigationInput)
  const sourceById = new Map(catalog.sources.map((source) => [source.id, source]))
  const itemById = new Map(
    navigation.helpTracks.flatMap((section) =>
      section.items.map((item) => [item.sourceId, { item, section }] as const),
    ),
  )

  const entries = navigation.helpTracks.flatMap((section) =>
    section.items.map((item) => {
      const source = sourceById.get(item.sourceId)
      if (source === undefined) throw new TypeError(`Unknown knowledge source: ${item.sourceId}`)
      return projectHelpEntry(source, section, item, itemById)
    }),
  )
  const sources = await Promise.all(
    entries.map(async (entry) => {
      const source = sourceById.get(entry.id)
      const item = itemById.get(entry.id)
      if (source === undefined || item === undefined)
        throw new TypeError(`Help entry is missing its source: ${entry.id}`)
      const content = await readFile(resolve(repositoryRoot, source.canonicalUri), 'utf8')
      if (sha256(content) !== source.sha256) {
        throw new TypeError(`Knowledge source hash mismatch: ${source.id}`)
      }
      return {
        ...entry,
        label: item.item.label,
        section: { id: item.section.id, title: item.section.title },
        version: source.version,
        canonicalUri: source.canonicalUri,
        sha256: source.sha256,
        claimIds: source.claimIds,
        content,
      }
    }),
  )
  const sourceByUri = new Map(sources.map((source) => [source.canonicalUri, source]))
  const repositoryLinks = sources.flatMap((source) =>
    extractRepositoryLinks(source.canonicalUri, source.content).map((link) => {
      const target = sourceByUri.get(link.canonicalUri)
      return {
        sourceId: source.id,
        sourceRoute: source.publicRoute,
        ...link,
        destinationRoute: target?.publicRoute ?? source.publicRoute,
        destinationKind: target === undefined ? 'reference-owner' : 'help-source',
      }
    }),
  )

  return jsonResponse({
    schemaVersion: 'knowledge-browser@2',
    catalogVersion: catalog.schemaVersion,
    navigationVersion: navigation.schemaVersion,
    defaultTrack: 'start',
    sections: navigation.helpTracks.map((section) => ({
      id: section.id,
      title: section.title,
      audience: section.audience,
      items: section.items.map(({ sourceId, label }) => ({ sourceId, label })),
    })),
    learningPaths: navigation.learningPaths,
    entries,
    sources,
    repositoryLinks,
    developerDocs: entries.filter(
      (entry) => entry.track === 'developer' || entry.track === 'api_mcp',
    ),
  })
}

function projectHelpEntry(
  source: CatalogSource,
  section: HelpTrack,
  item: z.infer<typeof HelpTrackItemSchema>,
  itemById: ReadonlyMap<string, { item: z.infer<typeof HelpTrackItemSchema>; section: HelpTrack }>,
): HelpCatalogEntry {
  const next = item.nextSourceId === null ? undefined : itemById.get(item.nextSourceId)
  if (item.nextSourceId !== null && next === undefined) {
    throw new TypeError(`Help source ${source.id} points to an unknown next source`)
  }

  return HelpCatalogEntryResponseSchema.parse({
    id: source.id,
    audience: projectAudience(source.audiences),
    task: source.tasks[0],
    track: section.id,
    prerequisites: item.prerequisiteSourceIds,
    nextStep:
      next === undefined
        ? null
        : {
            label: next.item.label,
            publicRoute: publicRoute(next.item.sourceId),
          },
    publicRoute: publicRoute(source.id),
    searchLabel: `${section.title}: ${item.label}`,
  })
}

function projectAudience(
  audiences: readonly string[],
): z.infer<typeof HelpCatalogAudienceSchema>[] {
  const mapped = audiences.map((audience) => (audience === 'caretaker' ? 'pal' : audience))
  return [...new Set(mapped)].map((audience) => HelpCatalogAudienceSchema.parse(audience))
}

function publicRoute(sourceId: string): string {
  return `/help/${encodeURIComponent(sourceId)}`
}

function extractRepositoryLinks(canonicalUri: string, content: string) {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].flatMap((match) => {
    const href = match[1]
    if (href === undefined) return []
    const target = resolveRepositoryPath(canonicalUri, href)
    return target === null ? [] : [{ href, canonicalUri: target }]
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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

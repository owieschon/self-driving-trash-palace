import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'

import {
  CanonicalUriSchema,
  ClaimIdSchema,
  SCHEMA_VERSION,
  SemverSchema,
  Sha256Schema,
  StableIdSchema,
  sha256Text,
  uniqueArray,
} from './primitives.js'

export const KnowledgeAudienceSchema = z.enum([
  'customer',
  'developer',
  'caretaker',
  'external-agent',
])

export const KnowledgeRiskSchema = z.enum(['read', 'reversible-write', 'consequential-write'])
export const KnowledgeVisibilitySchema = z.enum(['public', 'internal', 'tenant'])
export const KnowledgeSensitivitySchema = z.enum(['public', 'internal', 'confidential'])
export const AuthoredInstructionRoleSchema = z.enum([
  'procedure',
  'reference',
  'untrusted_evidence',
])
export const KnowledgeRetentionSchema = z.enum(['versioned', 'ephemeral'])

export const KnowledgeSectionIdSchema = z.enum([
  'overview',
  'getting-started',
  'concepts',
  'guides',
  'posthog-ai',
  'resources',
])
export const KnowledgeTrackSchema = z.enum(['use', 'build'])

/**
 * Help tracks are a discovery projection over the canonical corpus. They decide
 * ordering and labels in the product, never whether a public source is readable.
 */
export const KnowledgeHelpTrackSchema = z.enum([
  'start',
  'automations',
  'troubleshoot',
  'understand_pal',
  'developer',
  'api_mcp',
])

export const KnowledgeHelpAudienceSchema = z.enum([
  'customer',
  'developer',
  'pal',
  'external-agent',
])

export const KNOWLEDGE_SECTIONS = [
  { id: 'overview', title: 'Overview' },
  { id: 'getting-started', title: 'Getting started' },
  { id: 'concepts', title: 'Concepts' },
  { id: 'guides', title: 'Guides' },
  { id: 'posthog-ai', title: 'PostHog AI' },
  { id: 'resources', title: 'Resources' },
] as const

export const KNOWLEDGE_LEARNING_PATHS = [
  { id: 'use', title: 'Use TrashPal' },
  { id: 'build', title: 'Build on TrashPal' },
] as const

export const KNOWLEDGE_HELP_TRACKS = [
  {
    id: 'start',
    title: 'Start using TrashPal',
    audience: ['customer'],
  },
  {
    id: 'automations',
    title: 'Manage automations',
    audience: ['customer'],
  },
  {
    id: 'troubleshoot',
    title: 'Troubleshoot',
    audience: ['customer'],
  },
  {
    id: 'understand_pal',
    title: 'Understand Pal',
    audience: ['customer', 'developer'],
  },
  {
    id: 'developer',
    title: 'Developer docs',
    audience: ['developer', 'external-agent'],
  },
  {
    id: 'api_mcp',
    title: 'API and MCP reference',
    audience: ['developer', 'external-agent'],
  },
] as const

export const KnowledgeNavigationItemSchema = z
  .object({
    sourceId: StableIdSchema,
    label: z.string().min(1).max(120),
  })
  .strict()

export const KnowledgeNavigationSectionSchema = z
  .object({
    id: KnowledgeSectionIdSchema,
    title: z.string().min(1).max(80),
    items: z.array(KnowledgeNavigationItemSchema).min(1),
  })
  .strict()

export const KnowledgeLearningStepSchema = z
  .object({
    sourceId: StableIdSchema,
    prerequisiteSourceIds: uniqueArray(StableIdSchema, 'Learning prerequisites'),
    nextSourceId: StableIdSchema.nullable(),
    terminal: z.boolean(),
  })
  .strict()

export const KnowledgeLearningPathSchema = z
  .object({
    id: KnowledgeTrackSchema,
    title: z.string().min(1).max(80),
    steps: z.array(KnowledgeLearningStepSchema).min(1),
  })
  .strict()

export const KnowledgeHelpTrackItemSchema = z
  .object({
    sourceId: StableIdSchema,
    label: z.string().min(1).max(120),
    prerequisiteSourceIds: uniqueArray(StableIdSchema, 'Help prerequisites'),
    nextSourceId: StableIdSchema.nullable(),
    terminal: z.boolean(),
  })
  .strict()

export const KnowledgeHelpTrackDefinitionSchema = z
  .object({
    id: KnowledgeHelpTrackSchema,
    title: z.string().min(1).max(80),
    audience: uniqueArray(KnowledgeHelpAudienceSchema, 'Help track audiences').min(1),
    items: z.array(KnowledgeHelpTrackItemSchema).min(1),
  })
  .strict()

export const KnowledgeNavigationSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    sections: z.array(KnowledgeNavigationSectionSchema).length(KNOWLEDGE_SECTIONS.length),
    learningPaths: z.array(KnowledgeLearningPathSchema).length(KNOWLEDGE_LEARNING_PATHS.length),
    helpTracks: z.array(KnowledgeHelpTrackDefinitionSchema).length(KNOWLEDGE_HELP_TRACKS.length),
  })
  .strict()

const knowledgeMetadataShape = {
  id: StableIdSchema,
  owner: z.string().min(1).max(120),
  claimIds: uniqueArray(ClaimIdSchema, 'Claim IDs'),
  dependsOn: uniqueArray(StableIdSchema, 'Dependencies'),
  audiences: uniqueArray(KnowledgeAudienceSchema, 'Audiences').min(1),
  tasks: uniqueArray(z.string().min(1).max(120), 'Tasks').min(1),
  risk: KnowledgeRiskSchema,
  visibility: KnowledgeVisibilitySchema,
  sensitivity: KnowledgeSensitivitySchema,
  tenantScoped: z.boolean(),
  publishable: z.boolean(),
  instructionRole: AuthoredInstructionRoleSchema,
  retention: KnowledgeRetentionSchema,
  verifiedAgainst: z.record(z.string().min(1), z.string().min(1)),
}

export const KnowledgeSourceMetadataSchema = z.object(knowledgeMetadataShape).strict()

export const KnowledgeSourceRecordSchema = z
  .object({
    ...knowledgeMetadataShape,
    version: SemverSchema,
    canonicalUri: CanonicalUriSchema,
    sha256: Sha256Schema,
  })
  .strict()

export const KnowledgeCatalogSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    sources: z.array(KnowledgeSourceRecordSchema).min(1),
  })
  .strict()

export const ClaimRecordSchema = z
  .object({
    id: ClaimIdSchema,
    sourceId: StableIdSchema,
    locator: z.string().regex(/^claim:TP-[A-Z0-9]+-[0-9]{3}$/),
    owner: z.string().min(1).max(120),
    visibility: z.enum(['public', 'internal']),
    status: z.enum(['current', 'deprecated']),
  })
  .strict()
  .superRefine((claim, context) => {
    if (claim.locator !== `claim:${claim.id}`) {
      context.addIssue({
        code: 'custom',
        message: 'Claim locator must match its claim ID',
        path: ['locator'],
      })
    }
  })

export const ClaimRegistrySchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    claims: z.array(ClaimRecordSchema).min(1),
  })
  .strict()
  .superRefine((registry, context) => {
    const ids = new Set<string>()
    const locators = new Set<string>()
    registry.claims.forEach((claim, index) => {
      if (ids.has(claim.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Claim IDs must be unique',
          path: ['claims', index, 'id'],
        })
      }
      if (locators.has(claim.locator)) {
        context.addIssue({
          code: 'custom',
          message: 'Claim locators must be unique',
          path: ['claims', index, 'locator'],
        })
      }
      ids.add(claim.id)
      locators.add(claim.locator)
    })
  })

export type KnowledgeSourceMetadata = z.infer<typeof KnowledgeSourceMetadataSchema>
export type KnowledgeSourceRecord = z.infer<typeof KnowledgeSourceRecordSchema>
export type KnowledgeCatalog = z.infer<typeof KnowledgeCatalogSchema>
export type ClaimRecord = z.infer<typeof ClaimRecordSchema>
export type ClaimRegistry = z.infer<typeof ClaimRegistrySchema>
export type KnowledgeNavigation = z.infer<typeof KnowledgeNavigationSchema>

export type KnowledgeValidationCode =
  | 'DUPLICATE_CLAIM_ID'
  | 'DUPLICATE_CANONICAL_URI'
  | 'DUPLICATE_SOURCE_ID'
  | 'DUPLICATE_NAVIGATION_SOURCE'
  | 'DUPLICATE_LEARNING_PATH_SOURCE'
  | 'DEAD_END_NAVIGATION_SOURCE'
  | 'INVALID_NAVIGATION_NEXT_SOURCE'
  | 'INVALID_NAVIGATION_PREREQUISITE'
  | 'INVALID_NAVIGATION_SECTION_ORDER'
  | 'INVALID_HELP_TRACK_ORDER'
  | 'INVALID_HELP_TRACK_SOURCE'
  | 'INVALID_HELP_TRACK_NEXT_SOURCE'
  | 'INVALID_HELP_TRACK_TERMINAL'
  | 'HELP_TRACK_COVERAGE_MISMATCH'
  | 'INVALID_NAVIGATION_SOURCE'
  | 'INVALID_NAVIGATION_TERMINAL'
  | 'INVALID_LEARNING_PATH_ORDER'
  | 'NAVIGATION_CYCLE'
  | 'MISSING_CLAIM'
  | 'MISSING_DEPENDENCY'
  | 'NAVIGATION_COVERAGE_MISMATCH'
  | 'REQUIRED_CONCEPT_AFTER_GUIDE'
  | 'ORPHAN_CLAIM'
  | 'PRIVATE_DEPENDENCY'
  | 'REMOTE_SOURCE_UNVERIFIED'
  | 'SOURCE_FILE_MISSING'
  | 'SOURCE_HASH_MISMATCH'
  | 'SOURCE_PATH_ESCAPE'
  | 'SOURCE_CYCLE'
  | 'SOURCE_MISMATCH'
  | 'UNKNOWN_ROOT'

export class KnowledgeValidationError extends Error {
  readonly code: KnowledgeValidationCode
  readonly sourceId: string | undefined

  constructor(code: KnowledgeValidationCode, message: string, sourceId?: string) {
    super(message)
    this.name = 'KnowledgeValidationError'
    this.code = code
    this.sourceId = sourceId
  }
}

export function validateKnowledgeCatalog(input: unknown): KnowledgeCatalog {
  const catalog = KnowledgeCatalogSchema.parse(input)
  const sourceIds = new Set<string>()
  const claimIds = new Set<string>()

  for (const source of catalog.sources) {
    if (sourceIds.has(source.id)) {
      throw new KnowledgeValidationError(
        'DUPLICATE_SOURCE_ID',
        `Knowledge source ID ${source.id} is duplicated`,
        source.id,
      )
    }
    sourceIds.add(source.id)

    for (const claimId of source.claimIds) {
      if (claimIds.has(claimId)) {
        throw new KnowledgeValidationError(
          'DUPLICATE_CLAIM_ID',
          `Claim ID ${claimId} is owned by more than one source`,
          source.id,
        )
      }
      claimIds.add(claimId)
    }
  }

  const byId = new Map(catalog.sources.map((source) => [source.id, source]))
  for (const source of catalog.sources) {
    for (const dependencyId of source.dependsOn) {
      if (!byId.has(dependencyId)) {
        throw new KnowledgeValidationError(
          'MISSING_DEPENDENCY',
          `Knowledge source ${source.id} depends on missing source ${dependencyId}`,
          source.id,
        )
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (sourceId: string, path: string[]): void => {
    if (visiting.has(sourceId)) {
      const cycleStart = path.indexOf(sourceId)
      const cycle = [...path.slice(Math.max(cycleStart, 0)), sourceId].join(' -> ')
      throw new KnowledgeValidationError(
        'SOURCE_CYCLE',
        `Knowledge dependency cycle: ${cycle}`,
        sourceId,
      )
    }
    if (visited.has(sourceId)) {
      return
    }

    visiting.add(sourceId)
    const source = byId.get(sourceId)
    if (!source) {
      throw new KnowledgeValidationError(
        'MISSING_DEPENDENCY',
        `Missing source ${sourceId}`,
        sourceId,
      )
    }
    for (const dependencyId of source.dependsOn) {
      visit(dependencyId, [...path, sourceId])
    }
    visiting.delete(sourceId)
    visited.add(sourceId)
  }

  for (const sourceId of [...sourceIds].sort()) {
    visit(sourceId, [])
  }

  return catalog
}

export function validateKnowledgeClaims(
  catalogInput: unknown,
  claimRegistryInput: unknown,
): { catalog: KnowledgeCatalog; claims: ClaimRegistry } {
  const catalog = validateKnowledgeCatalog(catalogInput)
  const claims = ClaimRegistrySchema.parse(claimRegistryInput)
  const claimById = new Map<string, ClaimRecord>()

  for (const claim of claims.claims) {
    if (claimById.has(claim.id)) {
      throw new KnowledgeValidationError('DUPLICATE_CLAIM_ID', `Claim ${claim.id} is duplicated`)
    }
    claimById.set(claim.id, claim)
  }

  const referencedClaims = new Set<string>()
  for (const source of catalog.sources) {
    for (const claimId of source.claimIds) {
      const claim = claimById.get(claimId)
      if (!claim) {
        throw new KnowledgeValidationError(
          'MISSING_CLAIM',
          `Knowledge source ${source.id} references missing claim ${claimId}`,
          source.id,
        )
      }
      if (claim.sourceId !== source.id) {
        throw new KnowledgeValidationError(
          'SOURCE_MISMATCH',
          `Claim ${claimId} belongs to ${claim.sourceId}, not ${source.id}`,
          source.id,
        )
      }
      referencedClaims.add(claimId)
    }
  }

  for (const claim of claims.claims) {
    if (!referencedClaims.has(claim.id)) {
      throw new KnowledgeValidationError(
        'ORPHAN_CLAIM',
        `Claim ${claim.id} is not owned by a knowledge source`,
        claim.sourceId,
      )
    }
  }

  return { catalog, claims }
}

function isHumanKnowledgeSource(source: KnowledgeSourceRecord): boolean {
  return source.canonicalUri.startsWith('knowledge/') && source.canonicalUri.endsWith('.md')
}

/**
 * Help can project selected public Markdown outside knowledge/ without teaching
 * packaged agent instructions or generated artifacts as reader documentation.
 */
export function isHelpKnowledgeSource(source: KnowledgeSourceRecord): boolean {
  return (
    isHumanKnowledgeSource(source) ||
    source.canonicalUri === 'examples/http-and-mcp.md' ||
    source.canonicalUri.startsWith('docs/evaluation/') ||
    source.canonicalUri === 'docs/operations/continuous-integration.md' ||
    source.canonicalUri === 'docs/decisions/0001-separate-runtime-truth-from-explanation.md'
  )
}

export function validateKnowledgeNavigation(
  catalogInput: unknown,
  navigationInput: unknown,
): { catalog: KnowledgeCatalog; navigation: KnowledgeNavigation } {
  const catalog = validateKnowledgeCatalog(catalogInput)
  const navigation = KnowledgeNavigationSchema.parse(navigationInput)

  navigation.sections.forEach((section, index) => {
    const expected = KNOWLEDGE_SECTIONS[index]
    if (!expected || section.id !== expected.id || section.title !== expected.title) {
      throw new KnowledgeValidationError(
        'INVALID_NAVIGATION_SECTION_ORDER',
        `Knowledge section ${index + 1} must be ${expected?.title ?? 'absent'}`,
      )
    }
  })

  const byId = new Map(catalog.sources.map((source) => [source.id, source]))
  const navigatedIds = new Set<string>()
  const items = navigation.sections.flatMap((section) => section.items)

  for (const item of items) {
    if (navigatedIds.has(item.sourceId)) {
      throw new KnowledgeValidationError(
        'DUPLICATE_NAVIGATION_SOURCE',
        `Knowledge source ${item.sourceId} appears more than once in navigation`,
        item.sourceId,
      )
    }

    const source = byId.get(item.sourceId)
    if (!source || !isHumanKnowledgeSource(source)) {
      throw new KnowledgeValidationError(
        'INVALID_NAVIGATION_SOURCE',
        `Navigation source ${item.sourceId} must be a cataloged human knowledge page`,
        item.sourceId,
      )
    }
    navigatedIds.add(item.sourceId)
  }

  const humanIds = new Set(
    catalog.sources.filter(isHumanKnowledgeSource).map((source) => source.id),
  )
  const missing = [...humanIds].filter((id) => !navigatedIds.has(id)).sort()
  const unexpected = [...navigatedIds].filter((id) => !humanIds.has(id)).sort()
  if (missing.length > 0 || unexpected.length > 0) {
    throw new KnowledgeValidationError(
      'NAVIGATION_COVERAGE_MISMATCH',
      `Knowledge navigation coverage differs from human sources (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`,
    )
  }

  navigation.learningPaths.forEach((path, pathIndex) => {
    const expected = KNOWLEDGE_LEARNING_PATHS[pathIndex]
    if (!expected || path.id !== expected.id || path.title !== expected.title) {
      throw new KnowledgeValidationError(
        'INVALID_LEARNING_PATH_ORDER',
        `Knowledge learning path ${pathIndex + 1} must be ${expected?.title ?? 'absent'}`,
      )
    }
  })

  const guideIds = new Set(
    navigation.sections
      .find((section) => section.id === 'guides')
      ?.items.map((item) => item.sourceId) ?? [],
  )
  const learningPathCoverage = new Set<string>()

  for (const path of navigation.learningPaths) {
    const byStepId = new Map<string, (typeof path.steps)[number]>()
    for (const step of path.steps) {
      if (byStepId.has(step.sourceId)) {
        throw new KnowledgeValidationError(
          'DUPLICATE_LEARNING_PATH_SOURCE',
          `Knowledge source ${step.sourceId} appears more than once in the ${path.id} path`,
          step.sourceId,
        )
      }
      if (!navigatedIds.has(step.sourceId)) {
        throw new KnowledgeValidationError(
          'INVALID_NAVIGATION_SOURCE',
          `Learning path ${path.id} references uncategorized source ${step.sourceId}`,
          step.sourceId,
        )
      }
      byStepId.set(step.sourceId, step)
      learningPathCoverage.add(step.sourceId)
    }

    for (const step of path.steps) {
      for (const prerequisiteId of step.prerequisiteSourceIds) {
        if (!byStepId.has(prerequisiteId)) {
          throw new KnowledgeValidationError(
            'INVALID_NAVIGATION_PREREQUISITE',
            `Learning path ${path.id} source ${step.sourceId} references missing prerequisite ${prerequisiteId}`,
            step.sourceId,
          )
        }
      }
      if (step.nextSourceId !== null && !byStepId.has(step.nextSourceId)) {
        throw new KnowledgeValidationError(
          'INVALID_NAVIGATION_NEXT_SOURCE',
          `Learning path ${path.id} source ${step.sourceId} points to unknown next source ${step.nextSourceId}`,
          step.sourceId,
        )
      }
      if (!step.terminal && step.nextSourceId === null) {
        throw new KnowledgeValidationError(
          'DEAD_END_NAVIGATION_SOURCE',
          `Nonterminal learning path source ${step.sourceId} must declare a next source`,
          step.sourceId,
        )
      }
      if (step.terminal && step.nextSourceId !== null) {
        throw new KnowledgeValidationError(
          'INVALID_NAVIGATION_TERMINAL',
          `Terminal learning path source ${step.sourceId} cannot declare a next source`,
          step.sourceId,
        )
      }
    }

    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (sourceId: string): void => {
      if (visiting.has(sourceId)) {
        throw new KnowledgeValidationError(
          'NAVIGATION_CYCLE',
          `Knowledge learning path ${path.id} contains a cycle at ${sourceId}`,
          sourceId,
        )
      }
      if (visited.has(sourceId)) return
      visiting.add(sourceId)
      const nextSourceId = byStepId.get(sourceId)?.nextSourceId
      if (nextSourceId) visit(nextSourceId)
      visiting.delete(sourceId)
      visited.add(sourceId)
    }
    for (const step of path.steps) visit(step.sourceId)

    const indexById = new Map(path.steps.map((step, index) => [step.sourceId, index]))
    path.steps.forEach((step, index) => {
      const expectedNextSourceId = path.steps[index + 1]?.sourceId ?? null
      if (step.nextSourceId !== expectedNextSourceId) {
        throw new KnowledgeValidationError(
          'INVALID_LEARNING_PATH_ORDER',
          `Learning path ${path.id} source ${step.sourceId} must point to ${expectedNextSourceId ?? 'the terminal state'}`,
          step.sourceId,
        )
      }

      for (const prerequisiteId of step.prerequisiteSourceIds) {
        const prerequisiteIndex = indexById.get(prerequisiteId)
        if (prerequisiteIndex === undefined || prerequisiteIndex >= index) {
          throw new KnowledgeValidationError(
            'INVALID_NAVIGATION_PREREQUISITE',
            `Learning path ${path.id} places prerequisite ${prerequisiteId} after ${step.sourceId}`,
            step.sourceId,
          )
        }
      }

      if (guideIds.has(step.sourceId)) {
        const requiredConceptIds =
          byId
            .get(step.sourceId)
            ?.dependsOn.filter((sourceId) => sourceId.startsWith('concept.')) ?? []
        for (const conceptId of requiredConceptIds) {
          const conceptIndex = indexById.get(conceptId)
          if (
            conceptIndex === undefined ||
            conceptIndex >= index ||
            !step.prerequisiteSourceIds.includes(conceptId)
          ) {
            throw new KnowledgeValidationError(
              'REQUIRED_CONCEPT_AFTER_GUIDE',
              `Learning path ${path.id} must place and declare required concept ${conceptId} before guide ${step.sourceId}`,
              step.sourceId,
            )
          }
        }
      }
    })

    if (path.steps.filter((step) => step.terminal).length !== 1) {
      throw new KnowledgeValidationError(
        'INVALID_NAVIGATION_TERMINAL',
        `Knowledge learning path ${path.id} must declare exactly one terminal source`,
      )
    }
  }

  const missingFromPaths = [...navigatedIds]
    .filter((sourceId) => !learningPathCoverage.has(sourceId))
    .sort()
  if (missingFromPaths.length > 0) {
    throw new KnowledgeValidationError(
      'NAVIGATION_COVERAGE_MISMATCH',
      `Knowledge learning paths do not cover categorized sources: ${missingFromPaths.join(', ')}`,
    )
  }

  navigation.helpTracks.forEach((track, index) => {
    const expected = KNOWLEDGE_HELP_TRACKS[index]
    if (
      !expected ||
      track.id !== expected.id ||
      track.title !== expected.title ||
      track.audience.join(',') !== expected.audience.join(',')
    ) {
      throw new KnowledgeValidationError(
        'INVALID_HELP_TRACK_ORDER',
        `Help track ${index + 1} must be ${expected?.title ?? 'absent'}`,
      )
    }
  })

  const helpItemIds = new Set<string>()
  const helpItems = navigation.helpTracks.flatMap((track) => track.items)
  for (const item of helpItems) {
    if (helpItemIds.has(item.sourceId)) {
      throw new KnowledgeValidationError(
        'DUPLICATE_NAVIGATION_SOURCE',
        `Help source ${item.sourceId} appears more than once`,
        item.sourceId,
      )
    }

    const source = byId.get(item.sourceId)
    if (!source || !isHelpKnowledgeSource(source)) {
      throw new KnowledgeValidationError(
        'INVALID_HELP_TRACK_SOURCE',
        `Help source ${item.sourceId} must be a cataloged public Markdown page`,
        item.sourceId,
      )
    }
    helpItemIds.add(item.sourceId)
  }

  const helpSourceIds = new Set(
    catalog.sources.filter(isHelpKnowledgeSource).map((source) => source.id),
  )
  const missingHelpSources = [...helpSourceIds].filter((id) => !helpItemIds.has(id)).sort()
  const unexpectedHelpSources = [...helpItemIds].filter((id) => !helpSourceIds.has(id)).sort()
  if (missingHelpSources.length > 0 || unexpectedHelpSources.length > 0) {
    throw new KnowledgeValidationError(
      'HELP_TRACK_COVERAGE_MISMATCH',
      `Help tracks differ from public Markdown sources (missing: ${missingHelpSources.join(', ') || 'none'}; unexpected: ${unexpectedHelpSources.join(', ') || 'none'})`,
    )
  }

  for (const track of navigation.helpTracks) {
    const byItemId = new Map(track.items.map((item) => [item.sourceId, item]))
    for (const [index, item] of track.items.entries()) {
      for (const prerequisiteId of item.prerequisiteSourceIds) {
        if (!helpItemIds.has(prerequisiteId)) {
          throw new KnowledgeValidationError(
            'INVALID_NAVIGATION_PREREQUISITE',
            `Help track ${track.id} source ${item.sourceId} references unknown prerequisite ${prerequisiteId}`,
            item.sourceId,
          )
        }
      }
      if (item.nextSourceId !== null && !byItemId.has(item.nextSourceId)) {
        throw new KnowledgeValidationError(
          'INVALID_HELP_TRACK_NEXT_SOURCE',
          `Help track ${track.id} source ${item.sourceId} points outside its track`,
          item.sourceId,
        )
      }
      const expectedNextSourceId = track.items[index + 1]?.sourceId ?? null
      if (item.nextSourceId !== expectedNextSourceId) {
        throw new KnowledgeValidationError(
          'INVALID_HELP_TRACK_NEXT_SOURCE',
          `Help track ${track.id} source ${item.sourceId} must point to ${expectedNextSourceId ?? 'the terminal state'}`,
          item.sourceId,
        )
      }
      if (item.terminal !== (expectedNextSourceId === null)) {
        throw new KnowledgeValidationError(
          'INVALID_HELP_TRACK_TERMINAL',
          `Help track ${track.id} source ${item.sourceId} has an invalid terminal marker`,
          item.sourceId,
        )
      }
    }
  }

  return { catalog, navigation }
}

export function resolveKnowledgeLearningPath(
  catalogInput: unknown,
  navigationInput: unknown,
  pathId: z.infer<typeof KnowledgeTrackSchema>,
): KnowledgeSourceRecord[] {
  const { catalog, navigation } = validateKnowledgeNavigation(catalogInput, navigationInput)
  const path = navigation.learningPaths.find((candidate) => candidate.id === pathId)
  if (!path) {
    throw new KnowledgeValidationError(
      'INVALID_LEARNING_PATH_ORDER',
      `Unknown knowledge learning path ${pathId}`,
    )
  }
  const byId = new Map(catalog.sources.map((source) => [source.id, source]))
  return path.steps.map((step) => {
    const source = byId.get(step.sourceId)
    if (!source) {
      throw new KnowledgeValidationError(
        'INVALID_NAVIGATION_SOURCE',
        `Learning path ${pathId} references missing source ${step.sourceId}`,
        step.sourceId,
      )
    }
    return source
  })
}

function isPublicSource(source: KnowledgeSourceRecord): boolean {
  return (
    source.visibility === 'public' &&
    source.sensitivity === 'public' &&
    !source.tenantScoped &&
    source.publishable
  )
}

export async function validateKnowledgeSourceFiles(
  input: unknown,
  repositoryRoot: string,
): Promise<KnowledgeCatalog> {
  const catalog = validateKnowledgeCatalog(input)
  const root = await realpath(resolve(repositoryRoot))
  const seenUris = new Set<string>()

  for (const source of catalog.sources) {
    if (seenUris.has(source.canonicalUri)) {
      throw new KnowledgeValidationError(
        'DUPLICATE_CANONICAL_URI',
        `Canonical URI ${source.canonicalUri} is assigned to more than one source`,
        source.id,
      )
    }
    seenUris.add(source.canonicalUri)

    if (source.canonicalUri.startsWith('https://')) {
      throw new KnowledgeValidationError(
        'REMOTE_SOURCE_UNVERIFIED',
        `Remote knowledge source ${source.id} requires a separately retained artifact`,
        source.id,
      )
    }

    const declaredPath = resolve(root, source.canonicalUri)
    let sourcePath: string
    let content: string
    try {
      sourcePath = await realpath(declaredPath)
      const pathFromRoot = relative(root, sourcePath)
      if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
        throw new KnowledgeValidationError(
          'SOURCE_PATH_ESCAPE',
          `Knowledge source ${source.id} resolves outside the repository`,
          source.id,
        )
      }
      content = await readFile(sourcePath, 'utf8')
    } catch (error) {
      if (error instanceof KnowledgeValidationError) {
        throw error
      }
      throw new KnowledgeValidationError(
        'SOURCE_FILE_MISSING',
        `Knowledge source file is missing for ${source.id}`,
        source.id,
      )
    }

    if (sha256Text(content) !== source.sha256) {
      throw new KnowledgeValidationError(
        'SOURCE_HASH_MISMATCH',
        `Knowledge source hash does not match ${source.id}`,
        source.id,
      )
    }
  }

  return catalog
}

export function resolvePublicMetadataClosure(
  input: unknown,
  rootSourceIds: readonly string[],
): KnowledgeSourceRecord[] {
  const catalog = validateKnowledgeCatalog(input)
  const byId = new Map(catalog.sources.map((source) => [source.id, source]))
  const ordered: KnowledgeSourceRecord[] = []
  const visited = new Set<string>()

  const visit = (sourceId: string): void => {
    if (visited.has(sourceId)) {
      return
    }
    const source = byId.get(sourceId)
    if (!source) {
      throw new KnowledgeValidationError(
        'UNKNOWN_ROOT',
        `Unknown public source ${sourceId}`,
        sourceId,
      )
    }
    if (!isPublicSource(source)) {
      throw new KnowledgeValidationError(
        'PRIVATE_DEPENDENCY',
        `Source ${sourceId} is not eligible for a public artifact`,
        sourceId,
      )
    }

    for (const dependencyId of [...source.dependsOn].sort()) {
      visit(dependencyId)
    }
    visited.add(sourceId)
    ordered.push(source)
  }

  for (const sourceId of [...new Set(rootSourceIds)].sort()) {
    visit(sourceId)
  }

  return ordered
}

export async function resolvePublicClosure(
  input: unknown,
  rootSourceIds: readonly string[],
  repositoryRoot: string,
): Promise<KnowledgeSourceRecord[]> {
  const catalog = await validateKnowledgeSourceFiles(input, repositoryRoot)
  return resolvePublicMetadataClosure(catalog, rootSourceIds)
}

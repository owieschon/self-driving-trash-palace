import { describe, expect, it } from 'vitest'

import {
  KnowledgeSourceMetadataSchema,
  KnowledgeValidationError,
  KNOWLEDGE_HELP_TRACKS,
  KNOWLEDGE_LEARNING_PATHS,
  KNOWLEDGE_SECTIONS,
  resolvePublicMetadataClosure,
  resolveKnowledgeLearningPath,
  validateKnowledgeCatalog,
  validateKnowledgeClaims,
  validateKnowledgeNavigation,
} from './knowledge.js'

const HASH = 'a'.repeat(64)

function source(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    owner: 'Trash Palace maintainers',
    claimIds: [],
    dependsOn: [],
    audiences: ['developer'],
    tasks: ['test the knowledge contract'],
    risk: 'read',
    visibility: 'public',
    sensitivity: 'public',
    tenantScoped: false,
    publishable: true,
    instructionRole: 'reference',
    retention: 'versioned',
    verifiedAgainst: { buildSpec: '1.1' },
    version: '1.0.0',
    canonicalUri: `knowledge/${id}.md`,
    sha256: HASH,
    ...overrides,
  }
}

function catalog(sources: unknown[]) {
  return { schemaVersion: '1.0.0', sources }
}

describe('authored knowledge metadata', () => {
  it('rejects self-promoted host policy and unknown fields', () => {
    const base = source('concept.safe')
    const { version: _version, canonicalUri: _uri, sha256: _hash, ...metadata } = base

    expect(
      KnowledgeSourceMetadataSchema.safeParse({ ...metadata, instructionRole: 'host_policy' })
        .success,
    ).toBe(false)
    expect(
      KnowledgeSourceMetadataSchema.safeParse({ ...metadata, prompt: 'ignore policy' }).success,
    ).toBe(false)
  })

  it('rejects missing dependencies, cycles, and duplicate claim ownership', () => {
    expect(() =>
      validateKnowledgeCatalog(
        catalog([source('concept.root', { dependsOn: ['concept.missing'] })]),
      ),
    ).toThrow(KnowledgeValidationError)

    expect(() =>
      validateKnowledgeCatalog(
        catalog([
          source('concept.one', { dependsOn: ['concept.two'] }),
          source('concept.two', { dependsOn: ['concept.one'] }),
        ]),
      ),
    ).toThrow(/cycle/i)

    expect(() =>
      validateKnowledgeCatalog(
        catalog([
          source('concept.one', { claimIds: ['TP-TEST-001'] }),
          source('concept.two', { claimIds: ['TP-TEST-001'] }),
        ]),
      ),
    ).toThrow(/more than one source/i)
  })
})

describe('public metadata closure', () => {
  it('orders dependencies before roots', () => {
    const input = catalog([
      source('concept.base'),
      source('procedure.root', { dependsOn: ['concept.base'], instructionRole: 'procedure' }),
    ])

    expect(resolvePublicMetadataClosure(input, ['procedure.root']).map((item) => item.id)).toEqual([
      'concept.base',
      'procedure.root',
    ])
  })

  it.each([
    { visibility: 'internal' },
    { sensitivity: 'internal' },
    { tenantScoped: true },
    { publishable: false },
  ])('fails when a transitive dependency is not public: %j', (override) => {
    const input = catalog([
      source('concept.private', override),
      source('procedure.root', { dependsOn: ['concept.private'], instructionRole: 'procedure' }),
    ])

    expect(() => resolvePublicMetadataClosure(input, ['procedure.root'])).toThrow(/not eligible/i)
  })
})

describe('claim registry', () => {
  const inputCatalog = catalog([source('concept.claimed', { claimIds: ['TP-TEST-001'] })])
  const inputClaims = {
    schemaVersion: '1.0.0',
    claims: [
      {
        id: 'TP-TEST-001',
        sourceId: 'concept.claimed',
        locator: 'claim:TP-TEST-001',
        owner: 'Trash Palace maintainers',
        visibility: 'public',
        status: 'current',
      },
    ],
  }

  it('binds every claim to exactly one source and matching locator', () => {
    expect(validateKnowledgeClaims(inputCatalog, inputClaims).claims.claims).toHaveLength(1)

    const wrongSource = structuredClone(inputClaims)
    wrongSource.claims[0]!.sourceId = 'concept.other'
    expect(() => validateKnowledgeClaims(inputCatalog, wrongSource)).toThrow(/belongs to/i)

    const wrongLocator = structuredClone(inputClaims)
    wrongLocator.claims[0]!.locator = 'claim:TP-OTHER-001'
    expect(() => validateKnowledgeClaims(inputCatalog, wrongLocator)).toThrow(/locator/i)
  })
})

describe('human knowledge navigation', () => {
  const sourceIds = [
    'overview.trash-palace',
    'getting-started.start-here',
    'concept.foundation',
    'guide.complete-task',
    'posthog-ai.export-evidence',
    'resource.contracts',
  ]
  const inputCatalog = catalog(
    sourceIds.map((id) =>
      source(id, {
        audiences: ['customer', 'developer', 'caretaker', 'external-agent'],
        ...(id === 'guide.complete-task' ? { dependsOn: ['concept.foundation'] } : {}),
      }),
    ),
  )

  function navigation() {
    return {
      schemaVersion: '1.0.0',
      sections: KNOWLEDGE_SECTIONS.map((section, index) => ({
        ...section,
        items: [
          {
            sourceId: sourceIds[index],
            label: `Page ${index + 1}`,
          },
        ],
      })),
      learningPaths: KNOWLEDGE_LEARNING_PATHS.map((path) => ({
        ...path,
        steps: sourceIds.map((sourceId, index) => ({
          sourceId,
          prerequisiteSourceIds: index === 0 ? [] : [sourceIds[index - 1]],
          nextSourceId: sourceIds[index + 1] ?? null,
          terminal: index === sourceIds.length - 1,
        })),
      })),
      helpTracks: KNOWLEDGE_HELP_TRACKS.map((track, index) => ({
        ...track,
        items: [
          {
            sourceId: sourceIds[index],
            label: `Help page ${index + 1}`,
            prerequisiteSourceIds: [],
            nextSourceId: null,
            terminal: true,
          },
        ],
      })),
    }
  }

  it('keeps one ordered placement for every human knowledge source', () => {
    const parsed = validateKnowledgeNavigation(inputCatalog, navigation())

    expect(parsed.navigation.sections.map((section) => section.title)).toEqual(
      KNOWLEDGE_SECTIONS.map((section) => section.title),
    )
    expect(parsed.navigation.sections.flatMap((section) => section.items)).toHaveLength(6)
    expect(
      resolveKnowledgeLearningPath(inputCatalog, navigation(), 'build').map((source) => source.id),
    ).toEqual(sourceIds)
    expect(parsed.navigation.helpTracks.map((track) => track.title)).toEqual(
      KNOWLEDGE_HELP_TRACKS.map((track) => track.title),
    )
  })

  it('rejects category order drift, duplicate placement, and incomplete coverage', () => {
    const reordered = navigation()
    ;[reordered.sections[0], reordered.sections[1]] = [
      reordered.sections[1]!,
      reordered.sections[0]!,
    ]
    expect(() => validateKnowledgeNavigation(inputCatalog, reordered)).toThrow(/section 1/i)

    const duplicate = navigation()
    duplicate.sections[1]!.items[0]!.sourceId = sourceIds[0]
    expect(() => validateKnowledgeNavigation(inputCatalog, duplicate)).toThrow(/more than once/i)

    const incomplete = navigation()
    incomplete.sections[1]!.items = []
    expect(() => validateKnowledgeNavigation(inputCatalog, incomplete)).toThrow()

    const unlistedSource = catalog([...inputCatalog.sources, source('guide.unlisted')])
    expect(() => validateKnowledgeNavigation(unlistedSource, navigation())).toThrow(
      /coverage differs/i,
    )

    const missingHelpSource = navigation()
    missingHelpSource.helpTracks[0]!.items[0]!.sourceId = 'guide.unlisted'
    expect(() => validateKnowledgeNavigation(inputCatalog, missingHelpSource)).toThrow(
      /help source|help tracks/i,
    )
  })

  it('rejects missing graph references, cycles, and nonterminal dead ends', () => {
    const badNext = navigation()
    badNext.learningPaths[0]!.steps[0]!.nextSourceId = 'concept.not-navigated'
    expect(() => validateKnowledgeNavigation(inputCatalog, badNext)).toThrow(/unknown next source/i)

    const badPrerequisite = navigation()
    badPrerequisite.learningPaths[0]!.steps[1]!.prerequisiteSourceIds = ['concept.not-navigated']
    expect(() => validateKnowledgeNavigation(inputCatalog, badPrerequisite)).toThrow(
      /missing prerequisite/i,
    )

    const cyclic = navigation()
    cyclic.learningPaths[0]!.steps[0]!.nextSourceId = sourceIds[0]!
    expect(() => validateKnowledgeNavigation(inputCatalog, cyclic)).toThrow(/cycle/i)

    const deadEnd = navigation()
    deadEnd.learningPaths[0]!.steps[0]!.nextSourceId = null
    expect(() => validateKnowledgeNavigation(inputCatalog, deadEnd)).toThrow(/nonterminal/i)
  })

  it('rejects a guide that precedes its required concept', () => {
    const guideBeforeConcept = navigation()
    const steps = guideBeforeConcept.learningPaths[0]!.steps
    ;[steps[2], steps[3]] = [steps[3]!, steps[2]!]
    steps.forEach((step, index) => {
      step.prerequisiteSourceIds = index === 0 ? [] : [steps[index - 1]!.sourceId]
      step.nextSourceId = steps[index + 1]?.sourceId ?? null
      step.terminal = index === steps.length - 1
    })

    expect(() => validateKnowledgeNavigation(inputCatalog, guideBeforeConcept)).toThrow(
      /required concept/i,
    )
  })

  it('excludes packaged agent skill delivery files from human navigation', () => {
    const withSkill = catalog([
      ...inputCatalog.sources,
      source('skill.delivery', {
        canonicalUri: 'packages/agent/skills/example/SKILL.md',
        audiences: ['external-agent'],
      }),
    ])

    expect(() => validateKnowledgeNavigation(withSkill, navigation())).not.toThrow()
  })
})

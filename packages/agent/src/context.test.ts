import { scrubForPublication } from '@trash-palace/observability'
import { TOOL_REGISTRY_HASH } from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import {
  assertManifestCompatible,
  calculateContextBudgetUsage,
  ContextBundleSchema,
  ContextRequestSchema,
  createContextBundle,
  InternalContextReceiptSchema,
  KnowledgeManifestSchema,
  PublicContextReceiptSchema,
  type ContextBundle,
} from './context.js'
import { projectExactToolContracts } from './context-contracts.js'
import { deriveContextBudget, deriveMandatoryContextSelection } from './context-routing.js'
import { DocsImpactSchema, validateDocsImpact } from './docs-impact.js'
import {
  getCaretakerHostPolicyContract,
  hashHostPolicyContract,
  projectHostPolicy,
} from './host-policy.js'
import { PublicCitationUriSchema, PublicSafeTextSchema } from './primitives.js'
import { sha256Text } from './primitives.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const NOW = '2026-07-15T00:00:00.000Z'

function versionPin(hash = HASH_A) {
  return { version: '1.0.0', sha256: hash }
}

function namedPin(id: string, hash = HASH_A) {
  return { id, version: '1.0.0', sha256: hash }
}

describe('compiler-owned host policy', () => {
  it('projects the current core contracts only when their hash is pinned', () => {
    const contract = getCaretakerHostPolicyContract()
    const hash = hashHostPolicyContract()
    const section = projectHostPolicy(hash)

    expect(section.source).toBe('compiler-generated')
    expect(section.instructionRole).toBe('host_policy')
    expect(section.contractHash).toBe(hash)
    expect(section.policy.corePolicy.invariants).toEqual(contract.corePolicy.invariants)
    expect(section.policy.tools.map((tool) => tool.toolId)).toContain('plans.activate')
    expect(section.policy.deniedCapabilities).toContain('shell')

    expect(() => projectHostPolicy(HASH_B)).toThrow(/hash mismatch/i)
  })
})

describe('context requests and bundles', () => {
  const contractPins = {
    app: versionPin(),
    api: versionPin(),
    toolRegistry: versionPin(TOOL_REGISTRY_HASH),
    policy: versionPin(hashHostPolicyContract()),
  }

  it('rejects unknown request fields and ambiguous source routing', () => {
    const required = deriveMandatoryContextSelection('plan', 'consequential-write')
    const request = {
      schemaVersion: '1.0.0',
      requestId: 'request_context_001',
      missionRef: 'mission_homecoming_001',
      runRef: 'run_homecoming_001',
      audience: 'caretaker',
      phase: 'plan',
      risk: 'consequential-write',
      publicOnly: false,
      mandatorySourceIds: required.sourceIds,
      requiredToolNames: required.toolNames,
      optionalSourceIds: [],
      contractPins,
      createdAt: NOW,
    }

    expect(ContextRequestSchema.parse(request).requestId).toBe(request.requestId)
    expect(ContextRequestSchema.safeParse({ ...request, rawPrompt: 'hidden' }).success).toBe(false)
    expect(
      ContextRequestSchema.safeParse({
        ...request,
        optionalSourceIds: [required.sourceIds[0]],
      }).success,
    ).toBe(false)
    expect(
      ContextRequestSchema.safeParse({
        ...request,
        mandatorySourceIds: ['procedure.operate-homecoming-mission'],
      }).success,
    ).toBe(false)
  })

  it('freezes a deterministic, hash-addressed bundle', () => {
    const bundleContractPins = contractPins
    const required = deriveMandatoryContextSelection('understand', 'read')
    const hostPolicy = projectHostPolicy(hashHostPolicyContract())
    const exactContracts = projectExactToolContracts(required.toolNames)
    const sections: ContextBundle['sections'] = required.sourceIds.map((sourceId) => {
      const content = `Validated content for ${sourceId}.`
      return {
        sourceId,
        sourceVersion: '1.0.0',
        sourceHash: sha256Text(content),
        canonicalUri: `knowledge/${sourceId}.md`,
        claimIds: [],
        instructionRole: sourceId.startsWith('skill.')
          ? ('procedure' as const)
          : ('reference' as const),
        selectionReason: sourceId.startsWith('skill.')
          ? ('program-skill' as const)
          : ('mandatory-policy-support' as const),
        content,
      }
    })
    const budget = deriveContextBudget('read')
    const usage = calculateContextBudgetUsage({
      hostPolicy,
      exactContracts,
      sections,
      runtimeSnapshots: [],
    })
    const payload = {
      schemaVersion: '1.0.0',
      bundleId: 'bundle_context_001',
      requestId: 'request_context_001',
      createdAt: NOW,
      frozenAt: NOW,
      phase: 'understand',
      risk: 'read',
      contractPins: bundleContractPins,
      hostPolicy,
      exactContracts,
      sections,
      runtimeSnapshots: [],
      budget,
      usage,
    }

    const first = createContextBundle(payload)
    const second = createContextBundle(payload)
    const lastSection = payload.sections[payload.sections.length - 1]
    if (lastSection === undefined) throw new Error('Test context requires a section')
    const changedSections: ContextBundle['sections'] = [
      ...payload.sections.slice(0, -1),
      {
        ...lastSection,
        content: 'Changed content.',
        sourceHash: sha256Text('Changed content.'),
      },
    ]
    const changed = createContextBundle({
      ...payload,
      sections: changedSections,
      usage: calculateContextBudgetUsage({
        hostPolicy,
        exactContracts,
        sections: changedSections,
        runtimeSnapshots: [],
      }),
    })

    expect(first.bundleHash).toBe(second.bundleHash)
    expect(changed.bundleHash).not.toBe(first.bundleHash)
    expect(ContextBundleSchema.safeParse({ ...first, bundleHash: HASH_A }).success).toBe(false)
    expect(() =>
      createContextBundle({
        ...payload,
        contractPins: { ...bundleContractPins, policy: versionPin(HASH_A) },
      }),
    ).toThrow(/current compiler-generated host policy/i)
  })
})

describe('strict knowledge manifests', () => {
  const manifest = {
    schemaVersion: '1.0.0',
    manifestId: 'manifest.context',
    schema: namedPin('schema.context'),
    bundle: namedPin('bundle.context'),
    compiler: namedPin('compiler.context'),
    app: namedPin('app.trash-palace'),
    api: namedPin('api.v1'),
    toolRegistry: namedPin('registry.tools'),
    policy: namedPin('policy.caretaker'),
    sources: [
      {
        ...namedPin('procedure.homecoming'),
        canonicalUri: 'knowledge/procedures/homecoming.md',
      },
    ],
    artifacts: [
      {
        ...namedPin('skill.homecoming'),
        canonicalUri: 'packages/agent/skills/homecoming/SKILL.md',
      },
    ],
    createdAt: NOW,
  }

  const requirements = {
    schema: manifest.schema,
    bundle: manifest.bundle,
    compiler: manifest.compiler,
    app: manifest.app,
    api: manifest.api,
    toolRegistry: manifest.toolRegistry,
    policy: manifest.policy,
  }

  it('requires exact compatible pins and never accepts latest', () => {
    expect(assertManifestCompatible(manifest, requirements).manifestId).toBe('manifest.context')
    expect(() =>
      assertManifestCompatible(manifest, {
        ...requirements,
        app: { ...requirements.app, sha256: HASH_B },
      }),
    ).toThrow(/incompatible/i)

    expect(
      KnowledgeManifestSchema.safeParse({
        ...manifest,
        app: { ...manifest.app, version: 'latest' },
      }).success,
    ).toBe(false)
    expect(KnowledgeManifestSchema.safeParse({ ...manifest, executable: true }).success).toBe(false)
  })
})

describe('receipt privacy boundary', () => {
  const internalReceipt = {
    schemaVersion: '1.0.0',
    receiptId: 'receipt_internal_001',
    requestId: 'request_context_001',
    bundleId: 'bundle_context_001',
    bundleHash: HASH_A,
    manifestHash: HASH_B,
    createdAt: NOW,
    selectedSources: [{ id: 'procedure.homecoming', sha256: HASH_A, reason: 'program-skill' }],
    excludedSources: [{ id: 'tenant.notes', reason: 'cross-tenant' }],
    runtimeVersions: {
      app: '1.0.0',
      api: '1.0.0',
      compiler: '1.0.0',
      toolRegistry: '1.0.0',
      policy: '1.0.0',
    },
    redactionCounts: { credential: 0 },
    privateTraceCorrelation: 'trace_private_001',
    internalEvidenceUri: 'artifacts/internal/context.json',
  }

  const publicReceipt = {
    schemaVersion: '1.0.0',
    receiptId: 'receipt_public_001',
    createdAt: NOW,
    safeVersions: [
      { component: 'app', version: '1.0.0' },
      { component: 'context', version: '1.0.0' },
    ],
    citations: [
      {
        title: 'Unknown outcomes are not failures',
        uri: 'knowledge/concepts/unknown-outcomes.md',
        claimIds: ['TP-RELIABILITY-001'],
      },
    ],
    selectionRationale: [
      'Selected the homecoming recovery reference for an unknown operation outcome.',
    ],
    evidenceUri: 'artifacts/public/context.json',
    redactionSummary: { fieldsRemoved: 3, valuesMasked: 1 },
  }

  it('retains private selection data only in the internal schema', () => {
    expect(InternalContextReceiptSchema.parse(internalReceipt).excludedSources).toHaveLength(1)
    expect(PublicContextReceiptSchema.parse(publicReceipt).citations).toHaveLength(1)
    expect(
      PublicContextReceiptSchema.safeParse({
        ...publicReceipt,
        excludedSources: internalReceipt.excludedSources,
      }).success,
    ).toBe(false)
    expect(
      PublicContextReceiptSchema.safeParse({
        ...publicReceipt,
        privateTraceCorrelation: internalReceipt.privateTraceCorrelation,
      }).success,
    ).toBe(false)
  })

  it.each([
    ['ph', 'c_', '1234567890abcdefghijkl'].join(''),
    ['github', '_pat_', '1234567890abcdefghijkl'].join(''),
    ['gh', 'p_', '1234567890abcdefghijkl'].join(''),
    ['sk', '-ant-', '1234567890abcdefghijkl'].join(''),
    ['sk', '-proj-', '1234567890abcdefghijkl'].join(''),
    ['AK', 'IA', '1234567890ABCDEF'].join(''),
    ['-----BEGIN PRIVATE', ' KEY----- secret -----END PRIVATE', ' KEY-----'].join(''),
    ['/', 'Users', '/example/private/receipt.json'].join(''),
  ])('rejects sensitive public text: %s', (value) => {
    expect(PublicSafeTextSchema.safeParse(value).success).toBe(false)
  })

  it('applies the shared publication scrub to public receipt text', () => {
    const rationale = 'Contact caretaker@example.com for the private trace.'
    expect(scrubForPublication(rationale).findings.map((finding) => finding.reason)).toContain(
      'email',
    )
    expect(
      PublicContextReceiptSchema.safeParse({
        ...publicReceipt,
        selectionRationale: [rationale],
      }).success,
    ).toBe(false)
  })

  it.each([
    'https://localhost./receipt',
    'https://127.0.0.2/receipt',
    'https://169.254.169.254/latest/meta-data',
    'https://0.0.0.0/receipt',
    'https://[::1]/receipt',
    'https://[fe80::1]/receipt',
    'https://[fd00::1]/receipt',
    ['https://app.', 'posthog.com', '/project/123'].join(''),
  ])('rejects private or reserved public citation URI: %s', (value) => {
    expect(PublicCitationUriSchema.safeParse(value).success).toBe(false)
  })

  it('accepts public HTTPS documentation and repository-relative citations', () => {
    expect(PublicCitationUriSchema.safeParse('https://posthog.com/docs/self-driving').success).toBe(
      true,
    )
    expect(
      PublicCitationUriSchema.safeParse('knowledge/concepts/context-authority.md').success,
    ).toBe(true)
  })
})

describe('documentation impact', () => {
  const claims = {
    schemaVersion: '1.0.0',
    claims: [
      {
        id: 'TP-TEST-001',
        sourceId: 'concept.test',
        locator: 'claim:TP-TEST-001',
        owner: 'Trash Palace maintainers',
        visibility: 'public',
        status: 'current',
      },
    ],
  }

  it('requires a resolved disposition and known claims', () => {
    const impact = {
      schemaVersion: '1.0.0',
      changeId: 'change.policy-v2',
      changedContracts: ['policy.caretaker'],
      affectedClaimIds: ['TP-TEST-001'],
      assessedAt: NOW,
      disposition: 'updated',
      updatedSourceIds: ['concept.test'],
    }
    expect(validateDocsImpact(impact, claims).disposition).toBe('updated')
    expect(() =>
      validateDocsImpact({ ...impact, affectedClaimIds: ['TP-OTHER-001'] }, claims),
    ).toThrow(/unknown claim/i)
    expect(() =>
      validateDocsImpact({ ...impact, updatedSourceIds: ['concept.other'] }, claims),
    ).toThrow(/source that owns/i)
    expect(DocsImpactSchema.safeParse({ ...impact, disposition: 'unresolved' }).success).toBe(false)
    const noUserImpact = {
      schemaVersion: '1.0.0',
      changeId: 'change.fixture-only',
      changedContracts: ['fixture.internal'],
      affectedClaimIds: [],
      assessedAt: NOW,
      disposition: 'no-user-impact',
      reason: 'Only an internal test fixture changed.',
    }
    expect(DocsImpactSchema.safeParse(noUserImpact).success).toBe(true)
    const { reason: _reason, ...missingReason } = noUserImpact
    expect(DocsImpactSchema.safeParse(missingReason).success).toBe(false)
  })
})

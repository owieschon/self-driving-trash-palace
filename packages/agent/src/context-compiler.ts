import {
  MissionProgramKindSchema,
  PermissionSchema,
  TOOL_REGISTRY_HASH,
  type Permission,
} from '@trash-palace/core'
import { scrubForPublication } from '@trash-palace/observability'
import { Buffer } from 'node:buffer'
import { z } from 'zod'

import {
  ContextRequestSchema,
  InternalContextReceiptSchema,
  KnowledgeManifestSchema,
  PublicContextReceiptSchema,
  calculateContextBudgetUsage,
  createContextBundle,
  type ContextBundle,
  type ContextRequest,
  type InternalContextReceipt,
  type KnowledgeManifest,
  type PublicContextReceipt,
} from './context.js'
import {
  RuntimeSnapshotCandidateSchema,
  projectExactToolContracts,
  projectRuntimeSnapshot,
  type RuntimeContextSnapshot,
} from './context-contracts.js'
import {
  deriveContextBudget,
  deriveProgramContextSelection,
  deriveProgramMissionContextSelection,
  type ContextBudget,
} from './context-routing.js'
import { hashHostPolicyContract, projectHostPolicy } from './host-policy.js'
import {
  KnowledgeCatalogSchema,
  type KnowledgeCatalog,
  type KnowledgeSourceRecord,
  validateKnowledgeCatalog,
} from './knowledge.js'
import {
  CanonicalUriSchema,
  IsoDateTimeSchema,
  OpaqueRefSchema,
  RepoRelativeUriSchema,
  SCHEMA_VERSION,
  Sha256Schema,
  StableIdSchema,
  canonicalJson,
  sha256,
  sha256Text,
  uniqueArray,
} from './primitives.js'

export const ContextCompileInputSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    requestId: OpaqueRefSchema,
    missionRef: OpaqueRefSchema,
    runRef: OpaqueRefSchema,
    audience: z.literal('caretaker'),
    phase: ContextRequestSchema.shape.phase,
    programKind: MissionProgramKindSchema.default('night_shift_homecoming'),
    risk: ContextRequestSchema.shape.risk,
    contextScope: z.enum(['phase', 'mission']).default('phase'),
    publicOnly: z.boolean(),
    optionalSourceIds: uniqueArray(StableIdSchema, 'Optional source IDs'),
    manifest: KnowledgeManifestSchema,
    catalog: KnowledgeCatalogSchema,
    sourceContents: z.record(StableIdSchema, z.string().min(1).max(50_000)),
    sourceTenantScopeHashes: z.record(StableIdSchema, Sha256Schema).default({}),
    grantedPermissions: uniqueArray(PermissionSchema, 'Granted permissions'),
    tenantScopeHash: Sha256Schema,
    runtimeSnapshots: z.array(RuntimeSnapshotCandidateSchema),
    privateTraceCorrelation: OpaqueRefSchema.optional(),
    internalEvidenceUri: CanonicalUriSchema,
    publicEvidenceUri: RepoRelativeUriSchema,
    sourceDateEpoch: z
      .string()
      .regex(/^(?:0|[1-9][0-9]{0,11})$/)
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const selection =
      input.contextScope === 'mission'
        ? deriveProgramMissionContextSelection(input.programKind, input.risk)
        : deriveProgramContextSelection(input.programKind, input.phase, input.risk)
    const mandatory = new Set(selection.sourceIds)
    input.optionalSourceIds.forEach((sourceId, index) => {
      if (mandatory.has(sourceId)) {
        context.addIssue({
          code: 'custom',
          message: 'Optional sources cannot replace or repeat a host-mandated source',
          path: ['optionalSourceIds', index],
        })
      }
    })

    const snapshots = new Set<string>()
    input.runtimeSnapshots.forEach((snapshot, index) => {
      if (snapshots.has(snapshot.snapshotId)) {
        context.addIssue({
          code: 'custom',
          message: 'Runtime snapshot IDs must be unique',
          path: ['runtimeSnapshots', index, 'snapshotId'],
        })
      }
      snapshots.add(snapshot.snapshotId)
    })
  })

export type ContextCompileInput = z.infer<typeof ContextCompileInputSchema>

export type CompiledFocusedContext = Readonly<{
  request: ContextRequest
  bundle: ContextBundle
  internalReceipt: InternalContextReceipt
  publicReceipt: PublicContextReceipt
}>

type ExclusionReason = InternalContextReceipt['excludedSources'][number]['reason']

type AuthoredSection = ContextBundle['sections'][number]

const POISON_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:(?:all|any)\s+)?(?:previous|prior)(?:\s+(?:host|system))?\s+instructions\b/i,
  /\bignore\s+(?:(?:all|any)\s+)?(?:host|system)\s+instructions\b/i,
  /\b(?:override|replace|disable|bypass)\s+(?:the\s+)?(?:host\s+)?(?:policy|permissions?|safety|guardrails?)\b/i,
  /(?:^|\n)\s*(?:system|assistant|developer)\s*:\s*/i,
  /<script(?:\s|>)/i,
  /[\u202A-\u202E\u2066-\u2069]/u,
]

type Environment = Readonly<Record<string, string | undefined>>

function sourceDateEpochIso(value: string | undefined, environment: Environment): string {
  const encoded = value ?? environment.SOURCE_DATE_EPOCH
  if (encoded === undefined || !/^(?:0|[1-9][0-9]{0,11})$/.test(encoded)) {
    throw new Error('SOURCE_DATE_EPOCH must be an integer number of Unix seconds')
  }
  const milliseconds = Number(encoded) * 1_000
  const date = new Date(milliseconds)
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(date.valueOf())) {
    throw new Error('SOURCE_DATE_EPOCH is outside the supported timestamp range')
  }
  return IsoDateTimeSchema.parse(date.toISOString())
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...stringsIn(nested)])
  }
  return []
}

export function containsContextPoison(value: unknown): boolean {
  return stringsIn(value).some(
    (text) => text.includes('\u0000') || POISON_PATTERNS.some((pattern) => pattern.test(text)),
  )
}

function isPublicSource(source: KnowledgeSourceRecord): boolean {
  return (
    source.visibility === 'public' &&
    source.sensitivity === 'public' &&
    !source.tenantScoped &&
    source.publishable
  )
}

function resolveClosure(catalog: KnowledgeCatalog, rootSourceIds: readonly string[]) {
  const byId = new Map(catalog.sources.map((source) => [source.id, source]))
  const ordered: KnowledgeSourceRecord[] = []
  const visited = new Set<string>()

  const visit = (sourceId: string): void => {
    if (visited.has(sourceId)) return
    const source = byId.get(sourceId)
    if (source === undefined) throw new Error(`Unknown context source ${sourceId}`)
    for (const dependencyId of [...source.dependsOn].sort((left, right) =>
      left.localeCompare(right),
    )) {
      visit(dependencyId)
    }
    visited.add(sourceId)
    ordered.push(source)
  }

  for (const sourceId of [...new Set(rootSourceIds)].sort((left, right) =>
    left.localeCompare(right),
  )) {
    visit(sourceId)
  }
  return ordered
}

function findManifestPin(manifest: KnowledgeManifest, sourceId: string) {
  return [...manifest.sources, ...manifest.artifacts].find((pin) => pin.id === sourceId)
}

function validateSelectedSource(input: ContextCompileInput, source: KnowledgeSourceRecord): string {
  const content = input.sourceContents[source.id]
  if (content === undefined || sha256Text(content) !== source.sha256) {
    throw new Error(`Context source ${source.id} does not match its catalog hash`)
  }
  const pin = findManifestPin(input.manifest, source.id)
  if (
    pin === undefined ||
    pin.version !== source.version ||
    pin.sha256 !== source.sha256 ||
    pin.canonicalUri !== source.canonicalUri
  ) {
    throw new Error(`Context source ${source.id} does not match its manifest pin`)
  }
  return content
}

function sourceExclusion(
  input: ContextCompileInput,
  source: KnowledgeSourceRecord,
  compiledAt: string,
): ExclusionReason | undefined {
  if (!source.audiences.includes('caretaker')) return 'not-authorized'
  if (input.publicOnly && !isPublicSource(source)) return 'not-public'
  if (source.tenantScoped) {
    const sourceScopeHash = input.sourceTenantScopeHashes[source.id]
    if (sourceScopeHash !== input.tenantScopeHash) return 'cross-tenant'
  }

  try {
    const content = validateSelectedSource(input, source)
    if (containsContextPoison(content)) return 'poisoned'
  } catch {
    return 'incompatible'
  }

  const verifiedUntil = source.verifiedAgainst.validUntil
  if (verifiedUntil !== undefined && Date.parse(verifiedUntil) < Date.parse(compiledAt))
    return 'stale'
  return undefined
}

function authoredSection(
  input: ContextCompileInput,
  source: KnowledgeSourceRecord,
  selectionReason: AuthoredSection['selectionReason'],
): AuthoredSection {
  return {
    sourceId: source.id,
    sourceVersion: source.version,
    sourceHash: source.sha256,
    canonicalUri: source.canonicalUri,
    claimIds: [...source.claimIds].sort((left, right) => left.localeCompare(right)),
    instructionRole: source.instructionRole,
    selectionReason,
    content: validateSelectedSource(input, source),
  }
}

function runtimeReceiptId(snapshotId: string): string {
  return StableIdSchema.parse(`runtime.${snapshotId}`)
}

function isWithinBudget(
  budget: ContextBudget,
  hostPolicy: ReturnType<typeof projectHostPolicy>,
  exactContracts: ReturnType<typeof projectExactToolContracts>,
  sections: readonly AuthoredSection[],
  runtimeSnapshots: readonly RuntimeContextSnapshot[],
): boolean {
  const usage = calculateContextBudgetUsage({
    hostPolicy,
    exactContracts,
    sections,
    runtimeSnapshots,
  })
  return (
    usage.totalBytes <= budget.maxTotalBytes &&
    usage.authoredBytes <= budget.maxAuthoredBytes &&
    usage.runtimeBytes <= budget.maxRuntimeBytes &&
    usage.contractBytes <= budget.maxContractBytes &&
    usage.optionalSources <= budget.maxOptionalSources &&
    usage.runtimeSnapshots <= budget.maxRuntimeSnapshots &&
    usage.toolContracts <= budget.maxToolContracts
  )
}

function humanTitle(sourceId: string): string {
  const [kind = 'Reference', ...parts] = sourceId.split('.')
  const title = parts.join(' ').replaceAll('-', ' ')
  return `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}: ${title}`
}

function sumCounts(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0)
}

export function compileFocusedContext(
  rawInput: unknown,
  environment: Environment = process.env,
): CompiledFocusedContext {
  const input = ContextCompileInputSchema.parse(rawInput)
  const catalog = validateKnowledgeCatalog(input.catalog)
  const compiledAt = sourceDateEpochIso(input.sourceDateEpoch, environment)
  const mandatory =
    input.contextScope === 'mission'
      ? deriveProgramMissionContextSelection(input.programKind, input.risk)
      : deriveProgramContextSelection(input.programKind, input.phase, input.risk)
  const budget = deriveContextBudget(input.risk)
  const mandatoryClosure = resolveClosure(catalog, mandatory.sourceIds)
  const mandatoryClosureIds = new Set(mandatoryClosure.map((source) => source.id))
  const optionalSourceIds = input.optionalSourceIds
    .filter((sourceId) => input.contextScope !== 'mission' || !mandatoryClosureIds.has(sourceId))
    .sort((left, right) => left.localeCompare(right))

  if (
    input.manifest.toolRegistry.sha256 !== TOOL_REGISTRY_HASH ||
    input.manifest.policy.sha256 !== hashHostPolicyContract()
  ) {
    throw new Error('Knowledge manifest does not pin the current host contracts')
  }

  const request = ContextRequestSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    requestId: input.requestId,
    missionRef: input.missionRef,
    runRef: input.runRef,
    audience: input.audience,
    phase: input.phase,
    programKind: input.programKind,
    risk: input.risk,
    contextScope: input.contextScope,
    publicOnly: input.publicOnly,
    mandatorySourceIds: mandatory.sourceIds,
    requiredToolNames: mandatory.toolNames,
    optionalSourceIds,
    contractPins: {
      app: { version: input.manifest.app.version, sha256: input.manifest.app.sha256 },
      api: { version: input.manifest.api.version, sha256: input.manifest.api.sha256 },
      toolRegistry: {
        version: input.manifest.toolRegistry.version,
        sha256: input.manifest.toolRegistry.sha256,
      },
      policy: { version: input.manifest.policy.version, sha256: input.manifest.policy.sha256 },
    },
    createdAt: compiledAt,
  })

  const hostPolicy = projectHostPolicy(input.manifest.policy.sha256)
  const exactContracts = projectExactToolContracts(request.requiredToolNames)
  const mandatoryDirect = new Set(request.mandatorySourceIds)
  const repeatedMandatory = request.optionalSourceIds.find((sourceId) =>
    mandatoryClosureIds.has(sourceId),
  )
  if (repeatedMandatory !== undefined) {
    throw new Error(`Optional source ${repeatedMandatory} repeats the mandatory source closure`)
  }
  const sections: AuthoredSection[] = mandatoryClosure.map((source) => {
    const exclusion = sourceExclusion(input, source, compiledAt)
    if (exclusion !== undefined) {
      throw new Error(`Mandatory context source ${source.id} is ${exclusion}`)
    }
    return authoredSection(
      input,
      source,
      mandatoryDirect.has(source.id)
        ? source.id.startsWith('skill.')
          ? 'program-skill'
          : 'mandatory-policy-support'
        : 'mandatory-dependency',
    )
  })

  const excluded: { id: string; reason: ExclusionReason }[] = []
  let optionalRootsSelected = 0
  const selectedIds = new Set(sections.map((section) => section.sourceId))

  for (const rootSourceId of request.optionalSourceIds) {
    let closure: KnowledgeSourceRecord[]
    try {
      closure = resolveClosure(catalog, [rootSourceId])
    } catch {
      excluded.push({ id: rootSourceId, reason: 'incompatible' })
      continue
    }

    const exclusion = closure
      .map((source) => sourceExclusion(input, source, compiledAt))
      .find((reason) => reason !== undefined)
    if (exclusion !== undefined) {
      excluded.push({ id: rootSourceId, reason: exclusion })
      continue
    }

    const additions = closure
      .filter((source) => !selectedIds.has(source.id))
      .map((source) =>
        authoredSection(
          input,
          source,
          source.id === rootSourceId ? 'optional-public-reference' : 'optional-dependency',
        ),
      )
    const prospective = [...sections, ...additions]
    if (
      optionalRootsSelected >= budget.maxOptionalSources ||
      !isWithinBudget(budget, hostPolicy, exactContracts, prospective, [])
    ) {
      excluded.push({ id: rootSourceId, reason: 'budget-exceeded' })
      continue
    }

    optionalRootsSelected += 1
    additions.forEach((section) => {
      sections.push(section)
      selectedIds.add(section.sourceId)
    })
  }

  sections.sort((left, right) => left.sourceId.localeCompare(right.sourceId))
  if (!isWithinBudget(budget, hostPolicy, exactContracts, sections, [])) {
    throw new Error('Mandatory context exceeds the host-derived context budget')
  }

  const grantedPermissions = new Set<Permission>(input.grantedPermissions)
  const runtimeSnapshots: RuntimeContextSnapshot[] = []
  for (const candidate of [...input.runtimeSnapshots].sort((left, right) =>
    left.snapshotId.localeCompare(right.snapshotId),
  )) {
    const id = runtimeReceiptId(candidate.snapshotId)
    if (!grantedPermissions.has(candidate.requiredPermission)) {
      excluded.push({ id, reason: 'not-authorized' })
      continue
    }
    if (candidate.tenantScopeHash !== input.tenantScopeHash) {
      excluded.push({ id, reason: 'cross-tenant' })
      continue
    }
    if (
      candidate.expiresAt !== undefined &&
      Date.parse(candidate.expiresAt) < Date.parse(compiledAt)
    ) {
      excluded.push({ id, reason: 'stale' })
      continue
    }
    if (containsContextPoison(candidate.state)) {
      excluded.push({ id, reason: 'poisoned' })
      continue
    }

    const projected = projectRuntimeSnapshot(candidate)
    const prospective = [...runtimeSnapshots, projected]
    if (!isWithinBudget(budget, hostPolicy, exactContracts, sections, prospective)) {
      excluded.push({ id, reason: 'budget-exceeded' })
      continue
    }
    runtimeSnapshots.push(projected)
  }

  const usage = calculateContextBudgetUsage({
    hostPolicy,
    exactContracts,
    sections,
    runtimeSnapshots,
  })
  const manifestHash = sha256(input.manifest)
  const bundleId = `bundle_${sha256({
    request,
    manifestHash,
    sections: sections.map((section) => ({ id: section.sourceId, hash: section.sourceHash })),
    runtimeSnapshots: runtimeSnapshots.map((snapshot) => ({
      id: snapshot.snapshotId,
      hash: snapshot.snapshotHash,
    })),
  }).slice(0, 32)}`
  const bundle = createContextBundle({
    schemaVersion: SCHEMA_VERSION,
    bundleId,
    requestId: request.requestId,
    createdAt: compiledAt,
    frozenAt: compiledAt,
    phase: request.phase,
    programKind: request.programKind,
    risk: request.risk,
    contextScope: request.contextScope,
    contractPins: request.contractPins,
    hostPolicy,
    exactContracts,
    sections,
    runtimeSnapshots,
    budget,
    usage,
  })

  const publicationScrub = scrubForPublication({
    request,
    runtimeSnapshots,
    privateTraceCorrelation: input.privateTraceCorrelation,
    internalEvidenceUri: input.internalEvidenceUri,
  })
  const selectedSources = [
    {
      id: 'policy.caretaker',
      sha256: hostPolicy.contractHash,
      reason: 'mandatory-policy-support' as const,
    },
    ...exactContracts.tools.map((tool) => ({
      id: `contract.tool.${tool.name}`,
      sha256: tool.contractHash,
      reason: 'exact-contract' as const,
    })),
    ...sections.map((section) => ({
      id: section.sourceId,
      sha256: section.sourceHash,
      reason: section.selectionReason,
    })),
    ...runtimeSnapshots.map((snapshot) => ({
      id: runtimeReceiptId(snapshot.snapshotId),
      sha256: snapshot.snapshotHash,
      reason: 'runtime-state' as const,
    })),
  ].sort((left, right) => left.id.localeCompare(right.id))

  excluded.sort((left, right) => left.id.localeCompare(right.id))
  const internalReceiptId = `receipt_internal_${sha256({
    bundleHash: bundle.bundleHash,
    manifestHash,
    selectedSources,
    excluded,
  }).slice(0, 24)}`
  const internalReceipt = InternalContextReceiptSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    receiptId: internalReceiptId,
    requestId: request.requestId,
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    manifestHash,
    createdAt: compiledAt,
    selectedSources,
    excludedSources: excluded,
    runtimeVersions: {
      app: input.manifest.app.version,
      api: input.manifest.api.version,
      compiler: input.manifest.compiler.version,
      toolRegistry: input.manifest.toolRegistry.version,
      policy: input.manifest.policy.version,
    },
    redactionCounts: publicationScrub.counts,
    ...(input.privateTraceCorrelation === undefined
      ? {}
      : { privateTraceCorrelation: input.privateTraceCorrelation }),
    internalEvidenceUri: input.internalEvidenceUri,
  })

  const sourceById = new Map(catalog.sources.map((source) => [source.id, source]))
  const citations = sections
    .map((section) => sourceById.get(section.sourceId))
    .filter(
      (source): source is KnowledgeSourceRecord =>
        source !== undefined && isPublicSource(source) && source.claimIds.length > 0,
    )
    .map((source) => ({
      title: humanTitle(source.id),
      uri: source.canonicalUri,
      claimIds: [...source.claimIds].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.uri.localeCompare(right.uri))

  const publicReceiptCore = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: compiledAt,
    safeVersions: [
      { component: 'api', version: input.manifest.api.version },
      { component: 'app', version: input.manifest.app.version },
      { component: 'compiler', version: input.manifest.compiler.version },
      { component: 'policy', version: input.manifest.policy.version },
      { component: 'tool-registry', version: input.manifest.toolRegistry.version },
    ],
    citations,
    selectionRationale: [
      `Host-selected context for the ${request.phase} phase at ${request.risk} risk.`,
      `Included ${citations.length} public citations and ${exactContracts.tools.length} exact tool contracts.`,
    ],
    evidenceUri: input.publicEvidenceUri,
    redactionSummary: {
      fieldsRemoved:
        9 + publicationScrub.counts.private_field + publicationScrub.counts.prompt_content,
      valuesMasked:
        sumCounts(publicationScrub.counts) -
        publicationScrub.counts.private_field -
        publicationScrub.counts.prompt_content,
    },
  }
  const publicReceipt = PublicContextReceiptSchema.parse({
    ...publicReceiptCore,
    receiptId: `receipt_public_${sha256({ bundleHash: bundle.bundleHash, publicReceiptCore }).slice(0, 24)}`,
  })

  return { request, bundle, internalReceipt, publicReceipt }
}

export function compileFocusedContextFromEnvironment(rawInput: unknown): CompiledFocusedContext {
  return compileFocusedContext(rawInput, process.env)
}

export function contextArtifactHash(artifact: CompiledFocusedContext): string {
  return sha256({
    request: artifact.request,
    bundle: artifact.bundle,
    internalReceipt: artifact.internalReceipt,
    publicReceipt: artifact.publicReceipt,
  })
}

export function contextArtifactBytes(artifact: CompiledFocusedContext): number {
  return Buffer.byteLength(canonicalJson(artifact), 'utf8')
}

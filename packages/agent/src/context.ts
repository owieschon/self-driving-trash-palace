import {
  MissionPhaseSchema,
  MissionProgramKindSchema,
  TOOL_REGISTRY_HASH,
  ToolNameSchema,
} from '@trash-palace/core'
import { Buffer } from 'node:buffer'
import { z } from 'zod'

import {
  BudgetedContextSchema,
  ContextBudgetUsageSchema,
  ExactToolContractSectionSchema,
  RuntimeContextSnapshotSchema,
  type ContextBudgetUsage,
  type ExactToolContractSection,
  type RuntimeContextSnapshot,
} from './context-contracts.js'
import {
  ContextBudgetSchema,
  deriveContextBudget,
  deriveProgramContextSelection,
  deriveProgramMissionContextSelection,
} from './context-routing.js'
import { hashHostPolicyContract, HostPolicySectionSchema } from './host-policy.js'
import { AuthoredInstructionRoleSchema, KnowledgeRiskSchema } from './knowledge.js'
import {
  CanonicalUriSchema,
  ClaimIdSchema,
  IsoDateTimeSchema,
  OpaqueRefSchema,
  PublicCitationUriSchema,
  PublicSafeTextSchema,
  RepoRelativeUriSchema,
  SCHEMA_VERSION,
  SemverSchema,
  Sha256Schema,
  StableIdSchema,
  canonicalJson,
  sha256,
  sha256Text,
  uniqueArray,
} from './primitives.js'

export const VersionHashPinSchema = z
  .object({
    version: SemverSchema,
    sha256: Sha256Schema,
  })
  .strict()

export const NamedVersionHashPinSchema = z
  .object({
    id: StableIdSchema,
    version: SemverSchema,
    sha256: Sha256Schema,
  })
  .strict()

const ContextContractPinsSchema = z
  .object({
    app: VersionHashPinSchema,
    api: VersionHashPinSchema,
    toolRegistry: VersionHashPinSchema,
    policy: VersionHashPinSchema,
  })
  .strict()

export const ContextRequestSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    requestId: OpaqueRefSchema,
    missionRef: OpaqueRefSchema,
    runRef: OpaqueRefSchema,
    audience: z.literal('caretaker'),
    phase: MissionPhaseSchema,
    programKind: MissionProgramKindSchema.default('night_shift_homecoming'),
    risk: KnowledgeRiskSchema,
    contextScope: z.enum(['phase', 'mission']).default('phase'),
    publicOnly: z.boolean(),
    mandatorySourceIds: uniqueArray(StableIdSchema, 'Mandatory source IDs'),
    requiredToolNames: uniqueArray(ToolNameSchema, 'Required tool names'),
    optionalSourceIds: uniqueArray(StableIdSchema, 'Optional source IDs'),
    contractPins: ContextContractPinsSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const required =
      request.contextScope === 'mission'
        ? deriveProgramMissionContextSelection(request.programKind, request.risk)
        : deriveProgramContextSelection(request.programKind, request.phase, request.risk)
    if (
      canonicalJson(request.mandatorySourceIds) !== canonicalJson(required.sourceIds) ||
      canonicalJson(request.requiredToolNames) !== canonicalJson(required.toolNames)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Mandatory sources and tool contracts must be derived by the host compiler',
        path: ['mandatorySourceIds'],
      })
    }
    if (
      request.contractPins.toolRegistry.sha256 !== TOOL_REGISTRY_HASH ||
      request.contractPins.policy.sha256 !== hashHostPolicyContract()
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Context request must pin the current host contracts',
        path: ['contractPins'],
      })
    }
    const mandatory = new Set(request.mandatorySourceIds)
    request.optionalSourceIds.forEach((sourceId, index) => {
      if (mandatory.has(sourceId)) {
        context.addIssue({
          code: 'custom',
          message: 'A source cannot be both mandatory and optional',
          path: ['optionalSourceIds', index],
        })
      }
    })
  })

const AuthoredContextSelectionReasonSchema = z.enum([
  'mandatory-policy-support',
  'mandatory-dependency',
  'program-skill',
  'homecoming-skill',
  'optional-public-reference',
  'optional-dependency',
])

const ContextSelectionReasonSchema = z.union([
  AuthoredContextSelectionReasonSchema,
  z.enum(['exact-contract', 'runtime-state']),
])

export const AuthoredContextSectionSchema = z
  .object({
    sourceId: StableIdSchema,
    sourceVersion: SemverSchema,
    sourceHash: Sha256Schema,
    canonicalUri: CanonicalUriSchema,
    claimIds: uniqueArray(ClaimIdSchema, 'Claim IDs'),
    instructionRole: AuthoredInstructionRoleSchema,
    selectionReason: AuthoredContextSelectionReasonSchema,
    content: z.string().min(1).max(50_000),
  })
  .strict()

export const ContextBundlePayloadSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    bundleId: OpaqueRefSchema,
    requestId: OpaqueRefSchema,
    createdAt: IsoDateTimeSchema,
    frozenAt: IsoDateTimeSchema,
    phase: MissionPhaseSchema,
    programKind: MissionProgramKindSchema.default('night_shift_homecoming'),
    risk: KnowledgeRiskSchema,
    contextScope: z.enum(['phase', 'mission']).default('phase'),
    contractPins: ContextContractPinsSchema,
    hostPolicy: HostPolicySectionSchema,
    exactContracts: ExactToolContractSectionSchema,
    sections: z.array(AuthoredContextSectionSchema).superRefine((sections, context) => {
      const seen = new Set<string>()
      sections.forEach((section, index) => {
        if (seen.has(section.sourceId)) {
          context.addIssue({
            code: 'custom',
            message: 'Context source IDs must be unique',
            path: [index],
          })
        }
        seen.add(section.sourceId)
      })
    }),
    runtimeSnapshots: z.array(RuntimeContextSnapshotSchema),
    budget: ContextBudgetSchema,
    usage: ContextBudgetUsageSchema,
  })
  .strict()
  .superRefine((bundle, context) => {
    const currentPolicyHash = hashHostPolicyContract()
    if (
      bundle.hostPolicy.contractHash !== currentPolicyHash ||
      bundle.contractPins.policy.sha256 !== currentPolicyHash
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Context bundle must pin the current compiler-generated host policy',
        path: ['contractPins', 'policy'],
      })
    }
    if (bundle.contractPins.policy.version !== bundle.hostPolicy.contractVersion) {
      context.addIssue({
        code: 'custom',
        message: 'Context policy version must match the projected host policy',
        path: ['contractPins', 'policy', 'version'],
      })
    }

    if (
      bundle.contractPins.toolRegistry.sha256 !== TOOL_REGISTRY_HASH ||
      bundle.exactContracts.toolRegistryHash !== TOOL_REGISTRY_HASH
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Context bundle must pin the current exact tool registry',
        path: ['contractPins', 'toolRegistry'],
      })
    }

    const required =
      bundle.contextScope === 'mission'
        ? deriveProgramMissionContextSelection(bundle.programKind, bundle.risk)
        : deriveProgramContextSelection(bundle.programKind, bundle.phase, bundle.risk)
    const actualTools = bundle.exactContracts.tools.map((tool) => tool.name)
    if (canonicalJson(actualTools) !== canonicalJson(required.toolNames)) {
      context.addIssue({
        code: 'custom',
        message: 'Context bundle does not contain the host-derived exact tool contracts',
        path: ['exactContracts', 'tools'],
      })
    }

    const sectionById = new Map(bundle.sections.map((section) => [section.sourceId, section]))
    required.sourceIds.forEach((sourceId) => {
      if (!sectionById.has(sourceId)) {
        context.addIssue({
          code: 'custom',
          message: `Context bundle is missing mandatory source ${sourceId}`,
          path: ['sections'],
        })
      }
    })
    bundle.sections.forEach((section, index) => {
      if (sha256Text(section.content) !== section.sourceHash) {
        context.addIssue({
          code: 'custom',
          message: 'Authored context section content does not match its source hash',
          path: ['sections', index, 'sourceHash'],
        })
      }
    })

    const snapshotIds = new Set<string>()
    bundle.runtimeSnapshots.forEach((snapshot, index) => {
      if (snapshotIds.has(snapshot.snapshotId)) {
        context.addIssue({
          code: 'custom',
          message: 'Runtime snapshot IDs must be unique',
          path: ['runtimeSnapshots', index, 'snapshotId'],
        })
      }
      snapshotIds.add(snapshot.snapshotId)
    })

    if (canonicalJson(bundle.budget) !== canonicalJson(deriveContextBudget(bundle.risk))) {
      context.addIssue({
        code: 'custom',
        message: 'Context budget must be derived by the host compiler',
        path: ['budget'],
      })
    }
    const actualUsage = calculateContextBudgetUsage(bundle)
    if (canonicalJson(bundle.usage) !== canonicalJson(actualUsage)) {
      context.addIssue({
        code: 'custom',
        message: 'Context budget usage does not match the selected context',
        path: ['usage'],
      })
    }
    const budgetResult = BudgetedContextSchema.safeParse({
      budget: bundle.budget,
      usage: bundle.usage,
    })
    if (!budgetResult.success) {
      context.addIssue({
        code: 'custom',
        message: 'Selected context exceeds the host-derived budget',
        path: ['usage'],
      })
    }
  })

export const ContextBundleSchema = ContextBundlePayloadSchema.extend({ bundleHash: Sha256Schema })
  .strict()
  .superRefine((bundle, context) => {
    const { bundleHash, ...payload } = bundle
    if (sha256(payload) !== bundleHash) {
      context.addIssue({
        code: 'custom',
        message: 'Context bundle hash does not match its payload',
        path: ['bundleHash'],
      })
    }
  })

const ArtifactPinSchema = NamedVersionHashPinSchema.extend({
  canonicalUri: CanonicalUriSchema,
}).strict()

export const KnowledgeManifestSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    manifestId: StableIdSchema,
    schema: NamedVersionHashPinSchema,
    bundle: NamedVersionHashPinSchema,
    compiler: NamedVersionHashPinSchema,
    app: NamedVersionHashPinSchema,
    api: NamedVersionHashPinSchema,
    toolRegistry: NamedVersionHashPinSchema,
    policy: NamedVersionHashPinSchema,
    sources: z.array(ArtifactPinSchema).min(1),
    artifacts: z.array(ArtifactPinSchema).min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const [field, values] of [
      ['sources', manifest.sources],
      ['artifacts', manifest.artifacts],
    ] as const) {
      const seen = new Set<string>()
      values.forEach((value, index) => {
        if (seen.has(value.id)) {
          context.addIssue({
            code: 'custom',
            message: `${field} IDs must be unique`,
            path: [field, index],
          })
        }
        seen.add(value.id)
      })
    }
  })

export const ManifestCompatibilityRequirementSchema = z
  .object({
    schema: NamedVersionHashPinSchema,
    bundle: NamedVersionHashPinSchema,
    compiler: NamedVersionHashPinSchema,
    app: NamedVersionHashPinSchema,
    api: NamedVersionHashPinSchema,
    toolRegistry: NamedVersionHashPinSchema,
    policy: NamedVersionHashPinSchema,
  })
  .strict()

const SelectedSourceReceiptSchema = z
  .object({
    id: StableIdSchema,
    sha256: Sha256Schema,
    reason: ContextSelectionReasonSchema,
  })
  .strict()

const ExcludedSourceReceiptSchema = z
  .object({
    id: StableIdSchema,
    reason: z.enum([
      'not-requested',
      'not-authorized',
      'not-public',
      'incompatible',
      'stale',
      'poisoned',
      'cross-tenant',
      'budget-exceeded',
    ]),
  })
  .strict()

export const InternalContextReceiptSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    receiptId: OpaqueRefSchema,
    requestId: OpaqueRefSchema,
    bundleId: OpaqueRefSchema,
    bundleHash: Sha256Schema,
    manifestHash: Sha256Schema,
    createdAt: IsoDateTimeSchema,
    selectedSources: z.array(SelectedSourceReceiptSchema),
    excludedSources: z.array(ExcludedSourceReceiptSchema),
    runtimeVersions: z
      .object({
        app: SemverSchema,
        api: SemverSchema,
        compiler: SemverSchema,
        toolRegistry: SemverSchema,
        policy: SemverSchema,
      })
      .strict(),
    redactionCounts: z.record(StableIdSchema, z.number().int().nonnegative()),
    privateTraceCorrelation: OpaqueRefSchema.optional(),
    internalEvidenceUri: CanonicalUriSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const selected = new Set<string>()
    receipt.selectedSources.forEach((source, index) => {
      if (selected.has(source.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Selected source IDs must be unique',
          path: ['selectedSources', index],
        })
      }
      selected.add(source.id)
    })

    const excluded = new Set<string>()
    receipt.excludedSources.forEach((source, index) => {
      if (excluded.has(source.id) || selected.has(source.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Excluded source IDs must be unique and cannot also be selected',
          path: ['excludedSources', index],
        })
      }
      excluded.add(source.id)
    })
  })

const PublicCitationSchema = z
  .object({
    title: PublicSafeTextSchema,
    uri: PublicCitationUriSchema,
    claimIds: uniqueArray(ClaimIdSchema, 'Claim IDs').min(1),
  })
  .strict()

export const PublicContextReceiptSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    receiptId: OpaqueRefSchema,
    createdAt: IsoDateTimeSchema,
    safeVersions: z
      .array(
        z
          .object({
            component: StableIdSchema,
            version: SemverSchema,
          })
          .strict(),
      )
      .min(1),
    citations: z.array(PublicCitationSchema),
    selectionRationale: z.array(PublicSafeTextSchema).min(1).max(12),
    evidenceUri: RepoRelativeUriSchema,
    redactionSummary: z
      .object({
        fieldsRemoved: z.number().int().nonnegative(),
        valuesMasked: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const components = new Set<string>()
    receipt.safeVersions.forEach((version, index) => {
      if (components.has(version.component)) {
        context.addIssue({
          code: 'custom',
          message: 'Public version components must be unique',
          path: ['safeVersions', index],
        })
      }
      components.add(version.component)
    })
  })

export type ContextRequest = z.infer<typeof ContextRequestSchema>
export type ContextBundle = z.infer<typeof ContextBundleSchema>
export type ContextBundlePayload = z.infer<typeof ContextBundlePayloadSchema>
export type KnowledgeManifest = z.infer<typeof KnowledgeManifestSchema>
export type InternalContextReceipt = z.infer<typeof InternalContextReceiptSchema>
export type PublicContextReceipt = z.infer<typeof PublicContextReceiptSchema>

type ContextUsageInput = Readonly<{
  hostPolicy: z.infer<typeof HostPolicySectionSchema>
  exactContracts: ExactToolContractSection
  sections: readonly z.infer<typeof AuthoredContextSectionSchema>[]
  runtimeSnapshots: readonly RuntimeContextSnapshot[]
}>

function byteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8')
}

export function calculateContextBudgetUsage(input: ContextUsageInput): ContextBudgetUsage {
  const authoredBytes = input.sections.reduce(
    (total, section) => total + Buffer.byteLength(section.content, 'utf8'),
    0,
  )
  const runtimeBytes = input.runtimeSnapshots.reduce(
    (total, snapshot) => total + byteLength(snapshot.state),
    0,
  )
  const contractBytes = byteLength(input.exactContracts)
  const totalBytes = byteLength({
    hostPolicy: input.hostPolicy,
    exactContracts: input.exactContracts,
    sections: input.sections,
    runtimeSnapshots: input.runtimeSnapshots,
  })

  return ContextBudgetUsageSchema.parse({
    totalBytes,
    authoredBytes,
    runtimeBytes,
    contractBytes,
    optionalSources: input.sections.filter(
      (section) => section.selectionReason === 'optional-public-reference',
    ).length,
    runtimeSnapshots: input.runtimeSnapshots.length,
    toolContracts: input.exactContracts.tools.length,
  })
}

export function createContextBundle(input: unknown): ContextBundle {
  const payload = ContextBundlePayloadSchema.parse(input)
  return ContextBundleSchema.parse({ ...payload, bundleHash: sha256(payload) })
}

export function assertManifestCompatible(
  manifestInput: unknown,
  requirementInput: unknown,
): KnowledgeManifest {
  const manifest = KnowledgeManifestSchema.parse(manifestInput)
  const requirement = ManifestCompatibilityRequirementSchema.parse(requirementInput)

  for (const field of [
    'schema',
    'bundle',
    'compiler',
    'app',
    'api',
    'toolRegistry',
    'policy',
  ] as const) {
    const actual = manifest[field]
    const expected = requirement[field]
    if (
      actual.id !== expected.id ||
      actual.version !== expected.version ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(`Incompatible knowledge manifest ${field}`)
    }
  }

  return manifest
}

import {
  ContextReceiptIdSchema,
  ContextReceiptSchema,
  MissionSchema,
  PermissionSchema,
  Sha256Schema,
  TOOL_REGISTRY_HASH,
  hashToolValue,
  permissionsFor,
  type ContextReceipt,
  type Mission,
  type MissionId,
  type OrganizationId,
  type RunId,
  type Sha256,
} from '@trash-palace/core'
import {
  assertMissionExecutionContext,
  type MissionExecutionContext,
  type MissionExecutionUnitOfWorkPort,
  type ToolInvocationScopeHasherPort,
} from '@trash-palace/application'
import {
  ContextBundleSchema,
  ContextRequestSchema,
  InternalContextReceiptSchema,
  KnowledgeCatalogSchema,
  KnowledgeManifestSchema,
  PublicContextReceiptSchema,
  compileFocusedContext,
  contextBundleHashForReceipt,
  hashHostPolicyContract,
  sha256,
  validateKnowledgeCatalog,
  type CaretakerContextPreparationPort,
  type CaretakerFrozenContextPort,
  type ContextBundle,
  type ContextCompileInput,
  type KnowledgeCatalog,
  type KnowledgeManifest,
  type RuntimeSnapshotCandidateSchema,
} from '@trash-palace/agent'
import { z } from 'zod'

import type { Database } from './client.js'
import { PgContextArtifactRepository, type StoredRichContextArtifact } from './repositories.js'

const SOURCE_POLICY_PIN_ID = 'context.source-policy'
const SOURCE_POLICY_PIN_VERSION = '1.0.0'
const SOURCE_POLICY_PIN_URI = 'artifacts/internal/context-source-policy.json'

const SourceTenantScopeHashesSchema = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))

export type CaretakerContextKnowledgeSnapshot = Readonly<{
  manifest: KnowledgeManifest
  catalog: KnowledgeCatalog
  sourceContents: Readonly<Record<string, string>>
  sourceTenantScopeHashes: Readonly<Record<string, Sha256>>
  optionalSourceIds: readonly string[]
  publicOnly: boolean
}>

export interface CaretakerContextKnowledgeProviderPort {
  load(input: {
    readonly context: MissionExecutionContext
    readonly missionId: MissionId
    readonly runId: RunId
    readonly phase: Mission['state']['phase']
    readonly signal: AbortSignal
  }): Promise<CaretakerContextKnowledgeSnapshot>
}

export interface CaretakerRuntimeContextSnapshotPort {
  capture(input: {
    readonly context: MissionExecutionContext
    readonly mission: Mission
    readonly runId: RunId
    readonly observedAt: string
    readonly tenantScopeHash: Sha256
    readonly signal: AbortSignal
  }): Promise<readonly z.input<typeof RuntimeSnapshotCandidateSchema>[]>
}

export interface PgCaretakerContextPreparationDependencies {
  readonly database: Database
  readonly unitOfWork: MissionExecutionUnitOfWorkPort
  readonly knowledge: CaretakerContextKnowledgeProviderPort
  readonly runtime: CaretakerRuntimeContextSnapshotPort
  readonly scopes: Pick<ToolInvocationScopeHasherPort, 'tenant'>
}

export interface PgCaretakerFrozenContextDependencies {
  readonly database: Database
  readonly knowledge: CaretakerContextKnowledgeProviderPort
}

export class CaretakerContextAdapterIntegrityError extends Error {
  public override readonly name = 'CaretakerContextAdapterIntegrityError'
}

/**
 * Compiles the exact host-selected context and binds its core receipt to the mission under the
 * active lease. Append-only rich artifacts may survive a crash before binding; they remain inert
 * until the final fenced transaction installs the matching core receipt and mission pointer.
 */
export class PgCaretakerContextPreparationPort implements CaretakerContextPreparationPort {
  public constructor(private readonly dependencies: PgCaretakerContextPreparationDependencies) {}

  public async ensureFrozen(input: {
    readonly context: MissionExecutionContext
    readonly mission: Mission
    readonly runId: RunId
    readonly referenceTime: string
    readonly signal: AbortSignal
  }): Promise<void> {
    input.signal.throwIfAborted()
    const suppliedMission = MissionSchema.parse(input.mission)
    assertMissionExecutionContext(input.context, {
      organizationId: suppliedMission.organizationId,
      missionId: suppliedMission.id,
    })

    const durableState = await this.dependencies.unitOfWork.runFenced(
      input.context.fence,
      async (repositories) => {
        const current = await repositories.missions.get(suppliedMission.id)
        if (current === null || hashToolValue(current) !== hashToolValue(suppliedMission)) {
          throw integrity('Context preparation received a stale or differently bound mission')
        }
        const receipt =
          current.contextReceiptId === null
            ? null
            : await repositories.contextReceipts.get(current.contextReceiptId)
        if (current.contextReceiptId !== null && receipt === null) {
          throw integrity('Mission points at an absent core context receipt')
        }
        return { mission: current, receipt }
      },
    )
    input.signal.throwIfAborted()

    const durableMission = durableState.mission
    if (durableState.receipt?.runId === input.runId) {
      const receipt = ContextReceiptSchema.parse(durableState.receipt)
      if (
        receipt.id !== durableMission.contextReceiptId ||
        receipt.organizationId !== durableMission.organizationId ||
        receipt.missionId !== durableMission.id ||
        receipt.policyHash !== hashHostPolicyContract() ||
        receipt.toolRegistryHash !== TOOL_REGISTRY_HASH
      ) {
        throw integrity('Existing frozen context does not bind the candidate run')
      }
      contextBundleHashForReceipt(receipt)
      await new PgCaretakerFrozenContextPort({
        database: this.dependencies.database,
        knowledge: this.dependencies.knowledge,
      }).load({
        context: input.context,
        missionId: durableMission.id,
        runId: input.runId,
        receiptId: receipt.id,
        signal: input.signal,
      })
      return
    }

    const tenantScopeHash = this.dependencies.scopes.tenant(durableMission.organizationId)
    const [knowledge, runtimeSnapshots] = await Promise.all([
      this.dependencies.knowledge.load({
        context: input.context,
        missionId: durableMission.id,
        runId: input.runId,
        phase: durableMission.state.phase,
        signal: input.signal,
      }),
      this.dependencies.runtime.capture({
        context: input.context,
        mission: durableMission,
        runId: input.runId,
        observedAt: input.referenceTime,
        tenantScopeHash,
        signal: input.signal,
      }),
    ])
    input.signal.throwIfAborted()

    const parsedKnowledge = parseKnowledgeSnapshot(knowledge)
    const compiledAt = compileTimestamp(input.referenceTime)
    if (Date.parse(compiledAt) < Date.parse(durableMission.updatedAt)) {
      throw integrity('Context cannot be frozen before the current mission state')
    }
    const manifest = bindManifestToRun({
      manifest: parsedKnowledge.manifest,
      knowledge: parsedKnowledge,
      organizationId: durableMission.organizationId,
      missionId: durableMission.id,
      runId: input.runId,
      createdAt: compiledAt,
    })
    const compiled = compileFocusedContext({
      schemaVersion: '1.0.0',
      requestId: contextRequestId(durableMission.organizationId, durableMission.id, input.runId),
      missionRef: missionReference(durableMission.id),
      runRef: input.runId,
      audience: 'caretaker',
      phase: durableMission.state.phase,
      programKind: durableMission.programKind ?? 'night_shift_homecoming',
      risk: 'consequential-write',
      contextScope: 'mission',
      publicOnly: parsedKnowledge.publicOnly,
      optionalSourceIds: [...parsedKnowledge.optionalSourceIds],
      manifest,
      catalog: parsedKnowledge.catalog,
      sourceContents: parsedKnowledge.sourceContents,
      sourceTenantScopeHashes: parsedKnowledge.sourceTenantScopeHashes,
      grantedPermissions: [...permissionsForPrincipal(input.context)],
      tenantScopeHash,
      runtimeSnapshots: [...runtimeSnapshots],
      internalEvidenceUri: `artifacts/internal/context/${durableMission.id}/${input.runId}.json`,
      publicEvidenceUri: `artifacts/public/context/${durableMission.id}/${input.runId}.json`,
      sourceDateEpoch: String(Math.ceil(Date.parse(compiledAt) / 1_000)),
    } satisfies ContextCompileInput)
    const coreReceipt = createCoreContextReceipt({
      organizationId: durableMission.organizationId,
      missionId: durableMission.id,
      runId: input.runId,
      bundle: compiled.bundle,
      catalog: parsedKnowledge.catalog,
    })

    const artifacts = new PgContextArtifactRepository(
      this.dependencies.database,
      durableMission.organizationId,
    )
    for (const value of [
      { kind: 'request', artifact: compiled.request },
      { kind: 'manifest', artifact: manifest },
      { kind: 'bundle', artifact: compiled.bundle },
      { kind: 'internal_receipt', artifact: compiled.internalReceipt },
      { kind: 'public_receipt', artifact: compiled.publicReceipt },
    ] as const) {
      input.signal.throwIfAborted()
      await artifacts.insert({ missionId: durableMission.id, runId: input.runId, value })
    }
    input.signal.throwIfAborted()

    await this.dependencies.unitOfWork.runFenced(input.context.fence, async (repositories) => {
      const current = await repositories.missions.get(durableMission.id)
      if (current === null || hashToolValue(current) !== hashToolValue(durableMission)) {
        throw integrity('Mission changed while its frozen context was being persisted')
      }

      const existingReceipt = await repositories.contextReceipts.get(coreReceipt.id)
      if (
        existingReceipt !== null &&
        hashToolValue(existingReceipt) !== hashToolValue(coreReceipt)
      ) {
        throw integrity('Core context receipt identity is already bound to different content')
      }
      if (current.contextReceiptId === coreReceipt.id) {
        if (existingReceipt === null) {
          throw integrity('Mission points at an absent core context receipt')
        }
        return
      }

      if (current.contextReceiptId !== null) {
        const priorReceipt = await repositories.contextReceipts.get(current.contextReceiptId)
        if (priorReceipt === null) throw integrity('Mission points at an absent prior context')
        if (priorReceipt.runId === input.runId || current.runId === input.runId) {
          throw integrity('An active run cannot replace its frozen context')
        }
        if (current.runId !== null) {
          const predecessor = await repositories.caretakerRuns.get(current.runId)
          if (predecessor === null || predecessor.run.status !== 'paused') {
            throw integrity('Only a paused predecessor may install successor-run context')
          }
        }
      }

      if (existingReceipt === null) await repositories.contextReceipts.insert(coreReceipt)
      const saved = await repositories.missions.save(
        MissionSchema.parse({
          ...current,
          contextReceiptId: coreReceipt.id,
          version: current.version + 1,
          updatedAt: coreReceipt.createdAt,
        }),
        current.version,
      )
      if (!saved) throw integrity('Mission changed while its core context was being bound')
    })
  }
}

/** Loads only a complete retained artifact set whose source-policy snapshot still matches. */
export class PgCaretakerFrozenContextPort implements CaretakerFrozenContextPort {
  public constructor(private readonly dependencies: PgCaretakerFrozenContextDependencies) {}

  public async load(input: {
    readonly context: MissionExecutionContext
    readonly missionId: MissionId
    readonly runId: RunId
    readonly receiptId: ContextReceipt['id']
    readonly signal: AbortSignal
  }): Promise<{ readonly bundle: unknown; readonly sourcePolicies: readonly unknown[] }> {
    input.signal.throwIfAborted()
    assertMissionExecutionContext(input.context, {
      organizationId: input.context.principal.organizationId,
      missionId: input.missionId,
    })
    const repository = new PgContextArtifactRepository(
      this.dependencies.database,
      input.context.principal.organizationId,
    )
    const retained = await repository.listForRun(input.missionId, input.runId)
    input.signal.throwIfAborted()
    const request = oneArtifact(retained, 'request', ContextRequestSchema)
    const manifest = oneArtifact(retained, 'manifest', KnowledgeManifestSchema)
    const bundle = oneArtifact(retained, 'bundle', ContextBundleSchema)
    const internalReceipt = oneArtifact(retained, 'internal_receipt', InternalContextReceiptSchema)
    oneArtifact(retained, 'public_receipt', PublicContextReceiptSchema)
    if (
      retained.length !== 5 ||
      bundle.requestId !== request.requestId ||
      internalReceipt.requestId !== request.requestId ||
      internalReceipt.bundleId !== bundle.bundleId ||
      internalReceipt.bundleHash !== bundle.bundleHash ||
      internalReceipt.manifestHash !== sha256(manifest)
    ) {
      throw integrity('Retained rich context artifact links are incomplete or inconsistent')
    }

    const knowledge = parseKnowledgeSnapshot(
      await this.dependencies.knowledge.load({
        context: input.context,
        missionId: input.missionId,
        runId: input.runId,
        phase: bundle.phase,
        signal: input.signal,
      }),
    )
    input.signal.throwIfAborted()
    assertRetainedSourcePolicyPin(manifest, knowledge)
    const expectedCoreReceipt = createCoreContextReceipt({
      organizationId: input.context.principal.organizationId,
      missionId: input.missionId,
      runId: input.runId,
      bundle,
      catalog: knowledge.catalog,
    })
    if (expectedCoreReceipt.id !== input.receiptId) {
      throw integrity('Retained context does not bind the requested core receipt')
    }

    const sourceById = new Map(knowledge.catalog.sources.map((source) => [source.id, source]))
    const sourcePolicies = bundle.sections.map((section) => {
      const source = sourceById.get(section.sourceId)
      if (
        source === undefined ||
        source.version !== section.sourceVersion ||
        source.sha256 !== section.sourceHash ||
        source.canonicalUri !== section.canonicalUri
      ) {
        throw integrity('Retained bundle source does not match its pinned policy catalog')
      }
      return {
        sourceId: source.id,
        version: source.version,
        contentHash: source.sha256,
        visibility: source.visibility,
        sensitivity: source.sensitivity,
        tenantScoped: source.tenantScoped,
        tenantScopeHash: source.tenantScoped
          ? (knowledge.sourceTenantScopeHashes[source.id] ?? null)
          : null,
      }
    })
    return { bundle, sourcePolicies }
  }
}

function parseKnowledgeSnapshot(
  input: CaretakerContextKnowledgeSnapshot,
): CaretakerContextKnowledgeSnapshot {
  const catalog = validateKnowledgeCatalog(KnowledgeCatalogSchema.parse(input.catalog))
  const manifest = KnowledgeManifestSchema.parse(input.manifest)
  const sourceTenantScopeHashes = SourceTenantScopeHashesSchema.parse(
    input.sourceTenantScopeHashes,
  ) as Record<string, Sha256>
  const sources = new Map(catalog.sources.map((source) => [source.id, source]))
  for (const [sourceId, scopeHash] of Object.entries(sourceTenantScopeHashes)) {
    const source = sources.get(sourceId)
    if (source === undefined || !source.tenantScoped || source.visibility !== 'tenant') {
      throw integrity(`Tenant scope metadata is not bound to tenant source ${sourceId}`)
    }
    if (!scopeHash) throw integrity(`Tenant source ${sourceId} lacks its exact scope hash`)
  }
  for (const source of catalog.sources) {
    if (source.tenantScoped !== (source.visibility === 'tenant')) {
      throw integrity(`Source ${source.id} has inconsistent tenant policy metadata`)
    }
    if (source.tenantScoped && sourceTenantScopeHashes[source.id] === undefined) {
      throw integrity(`Tenant source ${source.id} lacks its exact scope hash`)
    }
  }
  return {
    manifest,
    catalog,
    sourceContents: { ...input.sourceContents },
    sourceTenantScopeHashes,
    optionalSourceIds: [...input.optionalSourceIds],
    publicOnly: input.publicOnly,
  }
}

function bindManifestToRun(input: {
  readonly manifest: KnowledgeManifest
  readonly knowledge: CaretakerContextKnowledgeSnapshot
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly runId: RunId
  readonly createdAt: string
}): KnowledgeManifest {
  if (
    [...input.manifest.sources, ...input.manifest.artifacts].some(
      (pin) => pin.id === SOURCE_POLICY_PIN_ID,
    )
  ) {
    throw integrity('Knowledge provider may not author the host-owned source-policy pin')
  }
  const manifestIdentity = hashToolValue({
    schemaVersion: 'caretaker-context-manifest-binding@1',
    organizationId: input.organizationId,
    missionId: input.missionId,
    runId: input.runId,
    manifest: input.manifest,
    sourcePolicyHash: sourcePolicyHash(input.knowledge),
  })
  return KnowledgeManifestSchema.parse({
    ...input.manifest,
    manifestId: `manifest.context.${manifestIdentity.slice(0, 32)}`,
    artifacts: [
      ...input.manifest.artifacts,
      {
        id: SOURCE_POLICY_PIN_ID,
        version: SOURCE_POLICY_PIN_VERSION,
        sha256: sourcePolicyHash(input.knowledge),
        canonicalUri: SOURCE_POLICY_PIN_URI,
      },
    ],
    createdAt: input.createdAt,
  })
}

function assertRetainedSourcePolicyPin(
  manifest: KnowledgeManifest,
  knowledge: CaretakerContextKnowledgeSnapshot,
): void {
  const pins = [...manifest.sources, ...manifest.artifacts].filter(
    (pin) => pin.id === SOURCE_POLICY_PIN_ID,
  )
  const pin = pins.at(0)
  if (pins.length !== 1 || pin === undefined) {
    throw integrity('Retained context source-policy snapshot changed after compilation')
  }
  if (
    pin.version !== SOURCE_POLICY_PIN_VERSION ||
    pin.canonicalUri !== SOURCE_POLICY_PIN_URI ||
    pin.sha256 !== sourcePolicyHash(knowledge)
  ) {
    throw integrity('Retained context source-policy snapshot changed after compilation')
  }
}

function sourcePolicyHash(knowledge: CaretakerContextKnowledgeSnapshot): Sha256 {
  return hashToolValue({
    schemaVersion: 'caretaker-context-source-policy@1',
    sources: [...knowledge.catalog.sources]
      .map((source) => ({
        id: source.id,
        version: source.version,
        sha256: source.sha256,
        canonicalUri: source.canonicalUri,
        visibility: source.visibility,
        sensitivity: source.sensitivity,
        tenantScoped: source.tenantScoped,
        instructionRole: source.instructionRole,
        retention: source.retention,
        audiences: [...source.audiences].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    sourceTenantScopeHashes: Object.entries(knowledge.sourceTenantScopeHashes).sort(
      ([left], [right]) => left.localeCompare(right),
    ),
  })
}

function createCoreContextReceipt(input: {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly runId: RunId
  readonly bundle: ContextBundle
  readonly catalog: KnowledgeCatalog
}): ContextReceipt {
  const sourceById = new Map(input.catalog.sources.map((source) => [source.id, source]))
  const sources: ContextReceipt['sources'] = [
    {
      sourceId: 'policy.caretaker',
      version: input.bundle.hostPolicy.contractVersion,
      contentHash: Sha256Schema.parse(input.bundle.hostPolicy.contractHash),
      authority: 'host_policy',
    },
    ...input.bundle.exactContracts.tools.map((tool) => ({
      sourceId: `contract.tool.${tool.name}`,
      version: input.bundle.exactContracts.contractVersion,
      contentHash: Sha256Schema.parse(tool.contractHash),
      authority: 'tool_contract' as const,
    })),
    ...input.bundle.sections.map((section) => {
      const source = sourceById.get(section.sourceId)
      if (
        source === undefined ||
        source.version !== section.sourceVersion ||
        source.sha256 !== section.sourceHash ||
        source.canonicalUri !== section.canonicalUri
      ) {
        throw integrity('Compiled context source is absent from its exact policy catalog')
      }
      return {
        sourceId: section.sourceId,
        version: section.sourceVersion,
        contentHash: Sha256Schema.parse(section.sourceHash),
        authority: section.sourceId.startsWith('skill.')
          ? ('skill' as const)
          : source.instructionRole === 'untrusted_evidence'
            ? ('evidence' as const)
            : ('reference' as const),
      }
    }),
    ...input.bundle.runtimeSnapshots.map((snapshot) => ({
      sourceId: `runtime.${snapshot.snapshotId}`,
      version: snapshot.observedAt,
      contentHash: Sha256Schema.parse(snapshot.snapshotHash),
      authority: 'evidence' as const,
    })),
  ]
  const receiptCore = {
    organizationId: input.organizationId,
    missionId: input.missionId,
    runId: input.runId,
    policyHash: Sha256Schema.parse(hashHostPolicyContract()),
    toolRegistryHash: TOOL_REGISTRY_HASH,
    sources,
    createdAt: input.bundle.frozenAt,
  }
  return ContextReceiptSchema.parse({
    id: ContextReceiptIdSchema.parse(
      `ctx_${hashToolValue({ schemaVersion: 'caretaker-core-context-receipt@1', ...receiptCore }).slice(0, 32)}`,
    ),
    ...receiptCore,
  })
}

function permissionsForPrincipal(context: MissionExecutionContext) {
  const principal = context.principal
  const additive =
    principal.role === 'operator' ? principal.operatorGrants : principal.delegatedPermissions
  return [...permissionsFor(principal.role, additive)].map((permission) =>
    PermissionSchema.parse(permission),
  )
}

function contextRequestId(
  organizationId: OrganizationId,
  missionId: MissionId,
  runId: RunId,
): string {
  return `request_${hashToolValue({ schemaVersion: 'caretaker-context-request@1', organizationId, missionId, runId }).slice(0, 32)}`
}

function missionReference(missionId: MissionId): string {
  return `mission_${missionId.slice(4)}`
}

function compileTimestamp(referenceTime: string): string {
  const milliseconds = Date.parse(referenceTime)
  if (!Number.isFinite(milliseconds)) throw integrity('Context reference time is invalid')
  return new Date(Math.ceil(milliseconds / 1_000) * 1_000).toISOString()
}

function oneArtifact<Schema extends z.ZodType>(
  artifacts: readonly StoredRichContextArtifact[],
  kind: StoredRichContextArtifact['value']['kind'],
  schema: Schema,
): z.output<Schema> {
  const matches = artifacts.filter((entry) => entry.value.kind === kind)
  if (matches.length !== 1) throw integrity(`Retained context requires exactly one ${kind}`)
  return schema.parse(matches[0]?.value.artifact)
}

function integrity(message: string): CaretakerContextAdapterIntegrityError {
  return new CaretakerContextAdapterIntegrityError(message)
}

/** Verifies the receipt's canonical binding is evaluable without exposing its source content. */
export function verifyCaretakerContextReceiptBinding(receipt: ContextReceipt): Sha256 {
  return contextBundleHashForReceipt(ContextReceiptSchema.parse(receipt))
}

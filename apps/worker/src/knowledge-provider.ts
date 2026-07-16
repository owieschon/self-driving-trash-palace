import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  KnowledgeCatalogSchema,
  KnowledgeManifestSchema,
  assertGeneratedManifestHash,
  hashHostPolicyContract,
  sha256Text,
  validateKnowledgeCatalog,
} from '@trash-palace/agent'
import type {
  CaretakerContextKnowledgeProviderPort,
  CaretakerContextKnowledgeSnapshot,
} from '@trash-palace/db'
import { IsoDateTimeSchema, TOOL_REGISTRY_HASH } from '@trash-palace/core'

interface GeneratedReferenceManifest {
  readonly generatedAt: string
}

/** Retains one verified repository snapshot for every run started by this process. */
export class FilesystemCaretakerKnowledgeProvider implements CaretakerContextKnowledgeProviderPort {
  private constructor(private readonly snapshot: CaretakerContextKnowledgeSnapshot) {}

  public static async create(input: {
    readonly repositoryRoot: string
    readonly applicationVersion: string
  }): Promise<FilesystemCaretakerKnowledgeProvider> {
    const root = await canonicalRoot(input.repositoryRoot)
    await assertGeneratedManifestHash(await safePath(root, 'generated/reference'))

    const catalogText = await readUtf8(root, 'knowledge/catalog.json')
    const catalog = validateKnowledgeCatalog(
      KnowledgeCatalogSchema.parse(JSON.parse(catalogText) as unknown),
    )
    const sourceContents: Readonly<Record<string, string>> = Object.fromEntries(
      await Promise.all(
        catalog.sources.map(
          async (source) => [source.id, await readUtf8(root, source.canonicalUri)] as const,
        ),
      ),
    )
    for (const source of catalog.sources) {
      if (sha256Text(sourceContents[source.id] ?? '') !== source.sha256) {
        throw new Error(`Knowledge source ${source.id} does not match its catalog hash`)
      }
      if (
        source.tenantScoped ||
        source.visibility !== 'public' ||
        source.sensitivity !== 'public'
      ) {
        throw new Error('The repository knowledge provider accepts only public source artifacts')
      }
    }

    const [contextRequestSchema, contextBundleSchema, contextRegistry, openApi, packageManifest] =
      await Promise.all([
        readUtf8(root, 'generated/reference/contexts/context-request.schema.json'),
        readUtf8(root, 'generated/reference/contexts/context-bundle.schema.json'),
        readUtf8(root, 'generated/reference/context-registry.json'),
        readUtf8(root, 'generated/reference/openapi.json'),
        readUtf8(root, 'package.json'),
      ])
    const generatedManifest = generatedReferenceManifest(
      await readUtf8(root, 'generated/reference/manifest.json'),
    )
    const pins = catalog.sources.map((source) => ({
      id: source.id,
      version: source.version,
      sha256: source.sha256,
      canonicalUri: source.canonicalUri,
    }))
    const manifest = KnowledgeManifestSchema.parse({
      schemaVersion: '1.0.0',
      manifestId: 'manifest.worker.repository',
      schema: {
        id: 'schema.context',
        version: '1.0.0',
        sha256: sha256Text(contextRequestSchema),
      },
      bundle: {
        id: 'bundle.context',
        version: '1.0.0',
        sha256: sha256Text(contextBundleSchema),
      },
      compiler: {
        id: 'compiler.context',
        version: '1.0.0',
        sha256: sha256Text(contextRegistry),
      },
      app: {
        id: 'app.trash-palace',
        version: input.applicationVersion,
        sha256: sha256Text(packageManifest),
      },
      api: { id: 'api.v1', version: '1.0.0', sha256: sha256Text(openApi) },
      toolRegistry: {
        id: 'registry.tools',
        version: '1.0.0',
        sha256: TOOL_REGISTRY_HASH,
      },
      policy: {
        id: 'policy.caretaker',
        version: '1.0.0',
        sha256: hashHostPolicyContract(),
      },
      sources: pins.filter((pin) => !pin.id.startsWith('skill.')),
      artifacts: pins.filter((pin) => pin.id.startsWith('skill.')),
      createdAt: generatedManifest.generatedAt,
    })
    return new FilesystemCaretakerKnowledgeProvider(
      Object.freeze({
        manifest,
        catalog,
        sourceContents: Object.freeze(sourceContents),
        sourceTenantScopeHashes: Object.freeze({}),
        optionalSourceIds: Object.freeze([]),
        publicOnly: true,
      }),
    )
  }

  public async load(input: {
    readonly signal: AbortSignal
  }): Promise<CaretakerContextKnowledgeSnapshot> {
    input.signal.throwIfAborted()
    return this.snapshot
  }
}

async function canonicalRoot(input: string): Promise<string> {
  if (!isAbsolute(input) || resolve(input) !== input) {
    throw new Error('Knowledge repository root must be a normalized absolute path')
  }
  const root = await realpath(input)
  if (!isAbsolute(root)) throw new Error('Knowledge repository root did not resolve absolutely')
  return root
}

async function safePath(root: string, repositoryRelativePath: string): Promise<string> {
  if (
    repositoryRelativePath.length === 0 ||
    isAbsolute(repositoryRelativePath) ||
    repositoryRelativePath.includes('\\') ||
    repositoryRelativePath.split('/').some((component) => ['', '.', '..'].includes(component))
  ) {
    throw new Error('Knowledge artifact path is not repository-relative')
  }
  const candidate = await realpath(join(root, repositoryRelativePath))
  const fromRoot = relative(root, candidate)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error('Knowledge artifact resolves outside the repository root')
  }
  return candidate
}

async function readUtf8(root: string, repositoryRelativePath: string): Promise<string> {
  return readFile(await safePath(root, repositoryRelativePath), 'utf8')
}

function generatedReferenceManifest(value: string): GeneratedReferenceManifest {
  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Generated reference manifest is invalid')
  }
  const generatedAt = (parsed as Readonly<Record<string, unknown>>).generatedAt
  return { generatedAt: IsoDateTimeSchema.parse(generatedAt) }
}

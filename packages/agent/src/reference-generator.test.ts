import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MISSION_TRANSITIONS,
  TOOL_REGISTRY_HASH,
  TOOL_SCHEMA_PROJECTIONS,
  hashToolValue,
  projectToolResultSchema,
  resolveMissionTransition,
} from '@trash-palace/core'
import {
  EVIDENCE_EVENT_REGISTRY_HASH,
  EVIDENCE_EVENT_SCHEMA_PROJECTIONS,
} from '@trash-palace/observability'
import { afterEach, describe, expect, it } from 'vitest'

import {
  GENERATED_PUBLIC_REFERENCE_DIRECTORY,
  GENERATED_REFERENCE_DIRECTORY,
  PUBLIC_REFERENCE_PATHS,
  assertGeneratedManifestHash,
  assertPublicGeneratedManifest,
  buildGeneratedReferences,
  buildPublicGeneratedReferences,
  checkGeneratedReferences,
  readGeneratedSourceDateEpoch,
  writeGeneratedReferences,
  writePublicGeneratedReferences,
  type StaleGeneratedReferencesError,
} from './reference-generator.js'

const SOURCE_DATE_EPOCH = '1784073600'
const temporaryDirectories: string[] = []

const input = {
  sourceDateEpoch: SOURCE_DATE_EPOCH,
  applicationVersion: '0.0.0',
  httpBoundary: {
    sessionCookieName: '__Host-trash_palace_session',
    maxJsonBodyBytes: 65_536,
  },
  webApiOperations: [
    {
      operationId: 'getHealth',
      method: 'GET',
      path: '/api/v1/health',
      authentication: 'none',
      successStatus: 200,
      pathParameters: [],
      requestBodySchema: null,
      responseBodySchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
      },
    },
    {
      operationId: 'deleteWidget',
      method: 'DELETE',
      path: '/api/v1/widgets/{widgetId}',
      authentication: 'session_csrf_recent',
      successStatus: 200,
      pathParameters: [{ name: 'widgetId', schema: { type: 'string', minLength: 1 } }],
      requestBodySchema: null,
      responseBodySchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
      },
    },
  ],
  mcpTools: TOOL_SCHEMA_PROJECTIONS.map((tool) => ({
    name: tool.name,
    title: tool.mcp.title,
    description: tool.mcp.description,
    inputSchema: tool.inputSchema,
    outputSchema: {
      ...(projectToolResultSchema(tool.name) as Record<string, unknown>),
      type: 'object',
    },
    annotations: tool.mcp.annotations,
  })),
} as const

function parseFile(files: ReadonlyMap<string, string>, path: string): unknown {
  const content = files.get(path)
  if (content === undefined) throw new Error(`Missing generated file ${path}`)
  return JSON.parse(content) as unknown
}

async function temporaryOutput(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trash-palace-references-'))
  temporaryDirectories.push(root)
  return join(root, 'generated', 'reference')
}

async function temporaryPublicOutput(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trash-palace-public-references-'))
  temporaryDirectories.push(root)
  return join(root, 'generated', 'public-reference')
}

async function rewritePublicArtifactBytes(
  output: string,
  relativePath: string,
  content: Buffer,
): Promise<void> {
  await writeFile(join(output, relativePath), content)
  const manifestPath = join(output, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    artifacts: { path: string; sha256: string; bytes: number }[]
  }
  const artifactPath = `${GENERATED_PUBLIC_REFERENCE_DIRECTORY}/${relativePath}`
  const artifact = manifest.artifacts.find(({ path }) => path === artifactPath)
  if (artifact === undefined) throw new Error(`Missing fixture artifact ${artifactPath}`)
  artifact.sha256 = createHash('sha256').update(content).digest('hex')
  artifact.bytes = content.length
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(manifestPath, manifestContent, 'utf8')
  const manifestHash = createHash('sha256').update(manifestContent).digest('hex')
  await writeFile(join(output, 'manifest.sha256'), `${manifestHash}  manifest.json\n`, 'utf8')
}

async function rewritePublicArtifact(
  output: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await rewritePublicArtifactBytes(output, relativePath, Buffer.from(content, 'utf8'))
}

async function mutatePublicRegistry(
  output: string,
  mutate: (registry: {
    toolRegistryHash: string
    tools: {
      name: string
      contractHash: string
      inputSchemaPath: string
      inputSchemaHash: string
      outputSchemaPath: string
      outputSchemaHash: string
      resultSchemaPath: string
      resultSchemaHash: string
    }[]
  }) => void,
): Promise<void> {
  const path = join(output, 'tool-registry.json')
  const registry = JSON.parse(await readFile(path, 'utf8')) as Parameters<typeof mutate>[0]
  mutate(registry)
  await rewritePublicArtifact(
    output,
    'tool-registry.json',
    `${JSON.stringify(registry, null, 2)}\n`,
  )
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('generated executable references', () => {
  it('reproduces byte-for-byte from executable owners and SOURCE_DATE_EPOCH', async () => {
    const first = buildGeneratedReferences(input)
    const second = buildGeneratedReferences(input)
    const differentEpoch = buildGeneratedReferences({ ...input, sourceDateEpoch: '1784073660' })

    expect([...second.files]).toEqual([...first.files])
    expect(second.manifestHash).toBe(first.manifestHash)
    expect(second.generatedAt).toBe('2026-07-15T00:00:00.000Z')
    for (const [path, content] of first.files) {
      if (path === 'manifest.json' || path === 'manifest.sha256') continue
      expect(differentEpoch.files.get(path)).toBe(content)
    }
    expect(differentEpoch.manifestHash).not.toBe(first.manifestHash)

    const manifest = parseFile(first.files, 'manifest.json') as {
      artifacts: { path: string; sha256: string; bytes: number; owners: string[] }[]
    }
    expect(manifest.artifacts).toHaveLength(first.files.size - 2)
    expect(manifest.artifacts.every((artifact) => artifact.owners.length > 0)).toBe(true)
    for (const artifact of manifest.artifacts) {
      const relativePath = artifact.path.replace(`${GENERATED_REFERENCE_DIRECTORY}/`, '')
      const content = first.files.get(relativePath)
      expect(content, artifact.path).toBeDefined()
      expect(Buffer.byteLength(content ?? '', 'utf8'), artifact.path).toBe(artifact.bytes)
      expect(
        createHash('sha256')
          .update(content ?? '')
          .digest('hex'),
        artifact.path,
      ).toBe(artifact.sha256)
      for (const owner of artifact.owners) {
        const [ownerPath, symbol] = owner.split('#')
        const source = await readFile(join(process.cwd(), ownerPath ?? ''), 'utf8')
        if (symbol !== undefined) expect(source, owner).toContain(symbol)
      }
    }
    expect(first.files.get('manifest.sha256')).toBe(`${first.manifestHash}  manifest.json\n`)
  })

  it('projects HTTP, MCP, event, mission, tool, and context contracts without copies', () => {
    const generated = buildGeneratedReferences(input)
    const openapi = parseFile(generated.files, 'openapi.json') as {
      openapi: string
      paths: Record<
        string,
        Record<string, { operationId: string; parameters: { name: string }[]; security: unknown[] }>
      >
      components: { securitySchemes: Record<string, unknown> }
    }
    expect(openapi.openapi).toBe('3.1.0')
    expect(
      Object.values(openapi.paths)
        .flatMap((path) => Object.values(path).map((operation) => operation.operationId))
        .sort(),
    ).toEqual(
      [...TOOL_SCHEMA_PROJECTIONS.map((tool) => tool.name), 'deleteWidget', 'getHealth'].sort(),
    )
    expect(openapi.paths['/api/v1/health']?.get?.security).toEqual([])
    expect(
      openapi.paths['/api/v1/widgets/{widgetId}']?.delete?.parameters.map(
        (parameter) => parameter.name,
      ),
    ).toEqual(['widgetId', 'Origin', 'X-CSRF-Token'])
    expect(Object.keys(openapi.components.securitySchemes).sort()).toEqual([
      'bearerAuth',
      'sessionCookie',
    ])

    const toolRegistry = parseFile(generated.files, 'tool-registry.json') as {
      toolRegistryHash: string
      tools: {
        name: (typeof TOOL_SCHEMA_PROJECTIONS)[number]['name']
        inputSchemaPath: string
        outputSchemaPath: string
        resultSchemaPath: string
      }[]
    }
    expect(toolRegistry.toolRegistryHash).toBe(TOOL_REGISTRY_HASH)
    expect(toolRegistry.tools.map((tool) => tool.name)).toEqual(
      TOOL_SCHEMA_PROJECTIONS.map((tool) => tool.name),
    )
    for (const tool of toolRegistry.tools) {
      const projection = TOOL_SCHEMA_PROJECTIONS.find(({ name }) => name === tool.name)
      expect(projection, tool.name).toBeDefined()
      const schemas = [
        [tool.inputSchemaPath, projection?.inputSchema],
        [tool.outputSchemaPath, projection?.outputSchema],
        [tool.resultSchemaPath, projectToolResultSchema(tool.name)],
      ] as const
      for (const [schemaPath, ownerSchema] of schemas) {
        const relativePath = schemaPath.replace(`${GENERATED_REFERENCE_DIRECTORY}/`, '')
        expect(parseFile(generated.files, relativePath), schemaPath).toEqual(ownerSchema)
        expect(ownerSchema).toMatchObject({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
        })
      }
    }

    const mcp = parseFile(generated.files, 'mcp-catalog.json') as {
      tools: { name: string; annotations: unknown }[]
    }
    expect(mcp.tools.map((tool) => tool.name)).toEqual(
      TOOL_SCHEMA_PROJECTIONS.map((tool) => tool.name),
    )
    expect(mcp.tools.every((tool) => tool.annotations !== undefined)).toBe(true)
    expect(mcp.tools).toEqual(input.mcpTools)

    const events = parseFile(generated.files, 'event-registry.json') as {
      eventRegistryHash: string
      events: { event: string }[]
    }
    expect(events.eventRegistryHash).toBe(EVIDENCE_EVENT_REGISTRY_HASH)
    expect(events.events.map((event) => event.event)).toEqual(
      EVIDENCE_EVENT_SCHEMA_PROJECTIONS.map((event) => event.event),
    )

    const machine = parseFile(generated.files, 'mission-state-machine.json') as {
      transitions: {
        from: Parameters<typeof resolveMissionTransition>[0]
        event: Parameters<typeof resolveMissionTransition>[1]
        to: ReturnType<typeof resolveMissionTransition>
      }[]
    }
    expect(machine.transitions.length).toBeGreaterThan(MISSION_TRANSITIONS.length)
    for (const transition of machine.transitions) {
      expect(resolveMissionTransition(transition.from, transition.event)).toEqual(transition.to)
    }

    const contexts = parseFile(generated.files, 'context-registry.json') as {
      schemas: { name: string; path: string; sha256: string }[]
      routing: unknown[]
    }
    expect(contexts.schemas.map((schema) => schema.name)).toEqual(
      expect.arrayContaining(['internal-context-receipt', 'public-context-receipt']),
    )
    expect(contexts.routing).toHaveLength(24)
  })

  it('emits only the explicit public allowlist and verifies every retained hash', async () => {
    const first = buildPublicGeneratedReferences(input)
    const second = buildPublicGeneratedReferences(input)
    expect([...second.files]).toEqual([...first.files])
    expect([...first.files.keys()].sort()).toEqual(
      [...PUBLIC_REFERENCE_PATHS, 'manifest.json', 'manifest.sha256'].sort(),
    )
    expect([...first.files.keys()].join('\n')).not.toMatch(
      /internal|context-bundle|context-compile|host-policy|runtime-context/,
    )
    expect([...first.files.values()].join('\n')).not.toContain('generated/reference/')

    const manifest = parseFile(first.files, 'manifest.json') as {
      schemaVersion: string
      artifacts: { path: string; sha256: string }[]
    }
    expect(manifest.schemaVersion).toBe('public-reference-manifest@1')
    expect(manifest.artifacts).toHaveLength(PUBLIC_REFERENCE_PATHS.length)
    expect(
      manifest.artifacts.every((artifact) =>
        artifact.path.startsWith(`${GENERATED_PUBLIC_REFERENCE_DIRECTORY}/`),
      ),
    ).toBe(true)

    const registry = parseFile(first.files, 'tool-registry.json') as {
      tools: {
        inputSchemaPath: string
        inputSchemaHash: string
        outputSchemaPath: string
        outputSchemaHash: string
        resultSchemaPath: string
        resultSchemaHash: string
      }[]
    }
    for (const tool of registry.tools) {
      for (const [path, hash] of [
        [tool.inputSchemaPath, tool.inputSchemaHash],
        [tool.outputSchemaPath, tool.outputSchemaHash],
        [tool.resultSchemaPath, tool.resultSchemaHash],
      ] as const) {
        expect(path).toMatch(/^generated\/public-reference\/tools\//)
        const relativePath = path.replace(`${GENERATED_PUBLIC_REFERENCE_DIRECTORY}/`, '')
        const content = first.files.get(relativePath)
        expect(content, path).toBeDefined()
        expect(hashToolValue(JSON.parse(content ?? 'null')), path).toBe(hash)
        const artifact = manifest.artifacts.find((candidate) => candidate.path === path)
        expect(artifact, path).toBeDefined()
        expect(
          createHash('sha256')
            .update(content ?? '')
            .digest('hex'),
          path,
        ).toBe(artifact?.sha256)
      }
    }

    const output = await temporaryPublicOutput()
    const written = await writePublicGeneratedReferences(output, input)
    await expect(assertPublicGeneratedManifest(output)).resolves.toEqual({
      artifactCount: PUBLIC_REFERENCE_PATHS.length,
      manifestHash: written.manifestHash,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    })
    await writeFile(join(output, 'openapi.json'), '{}\n', 'utf8')
    await expect(assertPublicGeneratedManifest(output)).rejects.toThrow(/artifact hash/)
  }, 20_000)

  it('writes through staging, validates its manifest, and fails check mode on stale output', async () => {
    const output = await temporaryOutput()
    const written = await writeGeneratedReferences(output, input)

    await expect(checkGeneratedReferences(output, input)).resolves.toEqual({
      checkedFiles: written.files.size,
      manifestHash: written.manifestHash,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    })
    await expect(assertGeneratedManifestHash(output)).resolves.toBe(written.manifestHash)
    await expect(readGeneratedSourceDateEpoch(output)).resolves.toBe(SOURCE_DATE_EPOCH)

    await writeFile(join(output, 'mcp-catalog.json'), '{}\n', 'utf8')
    await expect(checkGeneratedReferences(output, input)).rejects.toMatchObject({
      changed: ['mcp-catalog.json'],
    } satisfies Partial<StaleGeneratedReferencesError>)

    await writeGeneratedReferences(output, input)
    await unlink(join(output, 'event-registry.json'))
    await expect(checkGeneratedReferences(output, input)).rejects.toMatchObject({
      missing: ['event-registry.json'],
    } satisfies Partial<StaleGeneratedReferencesError>)

    await writeGeneratedReferences(output, input)
    await writeFile(join(output, 'unexpected.json'), '{}\n', 'utf8')
    await expect(checkGeneratedReferences(output, input)).rejects.toMatchObject({
      unexpected: ['unexpected.json'],
    } satisfies Partial<StaleGeneratedReferencesError>)

    const manifest = await readFile(join(output, 'manifest.json'), 'utf8')
    expect(manifest).toContain(SOURCE_DATE_EPOCH)
  }, 20_000)

  it('rejects re-signed public registry closure mutations', async () => {
    const internalPathOutput = await temporaryPublicOutput()
    await writePublicGeneratedReferences(internalPathOutput, input)
    await mutatePublicRegistry(internalPathOutput, (registry) => {
      const first = registry.tools[0]
      if (first === undefined) throw new Error('Fixture registry is empty')
      first.inputSchemaPath = first.inputSchemaPath.replace(
        GENERATED_PUBLIC_REFERENCE_DIRECTORY,
        GENERATED_REFERENCE_DIRECTORY,
      )
    })
    await expect(assertPublicGeneratedManifest(internalPathOutput)).rejects.toThrow(
      /internal generated path/,
    )

    const orderOutput = await temporaryPublicOutput()
    await writePublicGeneratedReferences(orderOutput, input)
    await mutatePublicRegistry(orderOutput, (registry) => {
      const first = registry.tools[0]
      const second = registry.tools[1]
      if (first === undefined || second === undefined) throw new Error('Fixture needs two tools')
      registry.tools[0] = second
      registry.tools[1] = first
    })
    await expect(assertPublicGeneratedManifest(orderOutput)).rejects.toThrow(
      /every canonical tool exactly once in order/,
    )

    const semanticOutput = await temporaryPublicOutput()
    await writePublicGeneratedReferences(semanticOutput, input)
    const schemaPath = `tools/${TOOL_SCHEMA_PROJECTIONS[0]?.name}.input.schema.json`
    const schema = JSON.parse(await readFile(join(semanticOutput, schemaPath), 'utf8')) as Record<
      string,
      unknown
    >
    schema.$comment = 're-signed semantic mutation'
    await rewritePublicArtifact(semanticOutput, schemaPath, `${JSON.stringify(schema, null, 2)}\n`)
    await expect(assertPublicGeneratedManifest(semanticOutput)).rejects.toThrow(/semantic hash/)

    const registryHashOutput = await temporaryPublicOutput()
    await writePublicGeneratedReferences(registryHashOutput, input)
    await mutatePublicRegistry(registryHashOutput, (registry) => {
      registry.toolRegistryHash = '0'.repeat(64)
    })
    await expect(assertPublicGeneratedManifest(registryHashOutput)).rejects.toThrow(
      /canonical registry/,
    )

    const contractHashOutput = await temporaryPublicOutput()
    await writePublicGeneratedReferences(contractHashOutput, input)
    await mutatePublicRegistry(contractHashOutput, (registry) => {
      const first = registry.tools[0]
      if (first === undefined) throw new Error('Fixture registry is empty')
      first.contractHash = '0'.repeat(64)
    })
    await expect(assertPublicGeneratedManifest(contractHashOutput)).rejects.toThrow(
      /canonical contract/,
    )

    const canonicalSchemaOutput = await temporaryPublicOutput()
    await writePublicGeneratedReferences(canonicalSchemaOutput, input)
    const canonicalSchemaPath = `tools/${TOOL_SCHEMA_PROJECTIONS[0]?.name}.input.schema.json`
    const changedSchema = JSON.parse(
      await readFile(join(canonicalSchemaOutput, canonicalSchemaPath), 'utf8'),
    ) as Record<string, unknown>
    changedSchema.$comment = 'semantic hash updated but schema is no longer canonical'
    await rewritePublicArtifact(
      canonicalSchemaOutput,
      canonicalSchemaPath,
      `${JSON.stringify(changedSchema, null, 2)}\n`,
    )
    await mutatePublicRegistry(canonicalSchemaOutput, (registry) => {
      const first = registry.tools[0]
      if (first === undefined) throw new Error('Fixture registry is empty')
      first.inputSchemaHash = hashToolValue(changedSchema)
    })
    await expect(assertPublicGeneratedManifest(canonicalSchemaOutput)).rejects.toThrow(
      /canonical contract|canonical projection/,
    )
  }, 20_000)

  it('rejects decoded internal references and malformed re-signed JSON bytes', async () => {
    const escapedPathOutput = await temporaryPublicOutput()
    await writePublicGeneratedReferences(escapedPathOutput, input)
    const openApi = await readFile(join(escapedPathOutput, 'openapi.json'), 'utf8')
    const escapedPath = openApi.replace(
      '{',
      '{\n  "x-internal": "generated\\u002freference\\u002ftools\\u002fhidden.json",',
    )
    expect(escapedPath).not.toContain('generated/reference/')
    await rewritePublicArtifact(escapedPathOutput, 'openapi.json', escapedPath)
    await expect(assertPublicGeneratedManifest(escapedPathOutput)).rejects.toThrow(
      /internal generated path/,
    )

    const invalidUtf8Output = await temporaryPublicOutput()
    await writePublicGeneratedReferences(invalidUtf8Output, input)
    await rewritePublicArtifactBytes(invalidUtf8Output, 'openapi.json', Buffer.from([0xff, 0xfe]))
    await expect(assertPublicGeneratedManifest(invalidUtf8Output)).rejects.toThrow(/valid UTF-8/)

    const invalidJsonOutput = await temporaryPublicOutput()
    await writePublicGeneratedReferences(invalidJsonOutput, input)
    await rewritePublicArtifact(invalidJsonOutput, 'mission-state-machine.json', 'not JSON\n')
    await expect(assertPublicGeneratedManifest(invalidJsonOutput)).rejects.toThrow(/valid JSON/)
  }, 20_000)

  it('rejects missing reproducibility input and unsafe output targets', async () => {
    expect(() => buildGeneratedReferences({ ...input, sourceDateEpoch: 'latest' })).toThrow(
      /SOURCE_DATE_EPOCH/,
    )
    expect(() =>
      buildGeneratedReferences({
        ...input,
        webApiOperations: [
          {
            ...input.webApiOperations[1],
            pathParameters: [],
          },
        ],
      }),
    ).toThrow(/Path parameter projection/)
    await expect(writeGeneratedReferences(await temporaryOutput(), input)).resolves.toBeDefined()
    await expect(writeGeneratedReferences(tmpdir(), input)).rejects.toThrow(
      /end in \/generated\/reference/,
    )
    await expect(writePublicGeneratedReferences(tmpdir(), input)).rejects.toThrow(
      /end in \/generated\/public-reference/,
    )

    const root = await mkdtemp(join(tmpdir(), 'trash-palace-symlink-output-'))
    const outside = await mkdtemp(join(tmpdir(), 'trash-palace-outside-sentinel-'))
    temporaryDirectories.push(root, outside)
    const sentinel = join(outside, 'sentinel.txt')
    await writeFile(sentinel, 'must survive\n', 'utf8')
    await symlink(outside, join(root, 'generated'), 'dir')
    await expect(
      writePublicGeneratedReferences(join(root, 'generated', 'public-reference'), input),
    ).rejects.toThrow(/cannot use symlinks/)
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('must survive\n')
  })
})

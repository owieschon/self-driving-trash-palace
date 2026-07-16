import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'

import {
  InvalidMissionTransitionError,
  MISSION_TRANSITIONS,
  MissionIdSchema,
  MissionPhaseSchema,
  MissionStateSchema,
  MissionStatusSchema,
  MissionTransitionEventSchema,
  TOOL_REGISTRY_HASH,
  TOOL_SCHEMA_PROJECTIONS,
  ToolCallIdSchema,
  ToolNameSchema,
  hashToolResultSchema,
  hashToolValue,
  projectToolResultSchema,
  resolveMissionTransition,
  type MissionState,
} from '@trash-palace/core'
import {
  EVIDENCE_EVENT_REGISTRY_HASH,
  EVIDENCE_EVENT_SCHEMA_PROJECTIONS,
} from '@trash-palace/observability'
import { z } from 'zod'

import { ContextCompileInputSchema } from './context-compiler.js'
import {
  ExactToolContractSectionSchema,
  RuntimeContextSnapshotSchema,
} from './context-contracts.js'
import { deriveContextBudget, deriveMandatoryContextSelection } from './context-routing.js'
import {
  ContextBundleSchema,
  ContextRequestSchema,
  InternalContextReceiptSchema,
  KnowledgeManifestSchema,
  PublicContextReceiptSchema,
} from './context.js'
import { hashHostPolicyContract, HostPolicySectionSchema } from './host-policy.js'
import { KnowledgeRiskSchema } from './knowledge.js'
import { canonicalJson } from './primitives.js'

export const GENERATED_REFERENCE_DIRECTORY = 'generated/reference'
export const GENERATED_PUBLIC_REFERENCE_DIRECTORY = 'generated/public-reference'
export const REFERENCE_GENERATOR_VERSION = '1.0.0'

export interface ReferenceGeneratorInput {
  readonly sourceDateEpoch: string
  readonly applicationVersion: string
  readonly httpBoundary: Readonly<{
    sessionCookieName: string
    maxJsonBodyBytes: number
  }>
  readonly webApiOperations: readonly WebApiReferenceOperation[]
  readonly mcpTools: readonly Json[]
}

export interface WebApiReferenceOperation {
  readonly operationId: string
  readonly method: 'DELETE' | 'GET' | 'POST'
  readonly path: string
  readonly authentication: 'none' | 'session_csrf_recent'
  readonly successStatus: number
  readonly pathParameters: readonly Readonly<{ name: string; schema: Json }>[]
  readonly requestBodySchema: Json | null
  readonly responseBodySchema: Json
}

export interface GeneratedReferenceSet {
  readonly sourceDateEpoch: string
  readonly generatedAt: string
  readonly files: ReadonlyMap<string, string>
  readonly manifestHash: string
}

export interface GeneratedReferenceCheck {
  readonly checkedFiles: number
  readonly manifestHash: string
  readonly sourceDateEpoch: string
}

export interface GeneratedManifestIntegrity {
  readonly artifactCount: number
  readonly manifestHash: string
  readonly sourceDateEpoch: string
}

type Json = z.infer<ReturnType<typeof z.json>>

type ArtifactOwner = readonly string[]

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export const PUBLIC_REFERENCE_PATHS = Object.freeze(
  [
    'openapi.json',
    'tool-registry.json',
    'mcp-catalog.json',
    'event-registry.json',
    'mission-state-machine.json',
    'contexts/public-context-receipt.schema.json',
    ...TOOL_SCHEMA_PROJECTIONS.flatMap((tool) =>
      (['input', 'output', 'result'] as const).map(
        (kind) => `tools/${tool.name}.${kind}.schema.json`,
      ),
    ),
  ].sort(compareText),
)

const ARTIFACT_OWNERS = {
  openapi: [
    'packages/core/src/tools.ts#TOOL_REGISTRY',
    'apps/web/src/server/api-contracts.ts#WEB_API_SCHEMA_PROJECTIONS',
    'apps/web/src/server/http-boundary.ts',
  ],
  tools: ['packages/core/src/tools.ts#TOOL_REGISTRY'],
  mcp: ['packages/mcp/src/contract.ts#projectMcpToolCatalog'],
  events: ['packages/observability/src/contracts.ts#projectEvidenceEventRegistry'],
  mission: [
    'packages/core/src/missions.ts#MissionStateSchema',
    'packages/core/src/missions.ts#resolveMissionTransition',
  ],
  context: [
    'packages/agent/src/context.ts',
    'packages/agent/src/context-contracts.ts',
    'packages/agent/src/context-routing.ts',
  ],
} as const satisfies Record<string, ArtifactOwner>

export class StaleGeneratedReferencesError extends Error {
  public constructor(
    public readonly missing: readonly string[],
    public readonly changed: readonly string[],
    public readonly unexpected: readonly string[],
  ) {
    super(
      `Generated references are stale: ${missing.length} missing, ${changed.length} changed, ${unexpected.length} unexpected`,
    )
    this.name = 'StaleGeneratedReferencesError'
  }
}

function parseSourceDateEpoch(value: string): { seconds: string; timestamp: string } {
  if (!/^(?:0|[1-9][0-9]{0,11})$/.test(value)) {
    throw new Error('SOURCE_DATE_EPOCH must be an integer number of Unix seconds')
  }
  const milliseconds = Number(value) * 1_000
  const timestamp = new Date(milliseconds)
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(timestamp.valueOf())) {
    throw new Error('SOURCE_DATE_EPOCH is outside the supported timestamp range')
  }
  return { seconds: value, timestamp: timestamp.toISOString() }
}

function canonicalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }
  return value
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(canonicalize(z.json().parse(value)), null, 2)}\n`
}

function sha256Bytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, 'utf8'))
}

function parseJsonBytes(bytes: Buffer, path: string): Json {
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`Generated JSON artifact is not valid UTF-8: ${path}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content) as unknown
  } catch (error) {
    throw new Error(`Generated artifact is not valid JSON: ${path}`, { cause: error })
  }
  return z.json().parse(parsed)
}

function assertNoInternalGeneratedReference(value: Json, path: string): void {
  if (typeof value === 'string') {
    if (value.replaceAll('\\', '/').toLowerCase().includes('generated/reference/')) {
      throw new Error(`Public reference contains an internal generated path: ${path}`)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoInternalGeneratedReference(entry, path)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertNoInternalGeneratedReference(key, path)
      assertNoInternalGeneratedReference(entry, path)
    }
  }
}

function componentName(
  toolName: string,
  suffix: 'Input' | 'Output' | 'Request' | 'Response' | 'Result',
): string {
  const name = toolName
    .split(/[._-]/)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('')
  return `${name}${suffix}`
}

function operationComponentName(operationId: string, suffix: 'Request' | 'Response'): string {
  return componentName(operationId, suffix)
}

function jsonSchema(schema: z.ZodType): Json {
  return z.json().parse(z.toJSONSchema(schema))
}

function setPathOperation(
  paths: Record<string, Record<string, Json>>,
  path: string,
  method: string,
  operation: Json,
): void {
  const normalizedMethod = method.toLowerCase()
  const item = paths[path] ?? {}
  if (item[normalizedMethod] !== undefined) {
    throw new Error(`Duplicate HTTP operation ${method} ${path}`)
  }
  item[normalizedMethod] = operation
  paths[path] = item
}

function setComponentSchema(schemas: Record<string, Json>, name: string, schema: Json): void {
  if (schemas[name] !== undefined) throw new Error(`Duplicate OpenAPI component schema ${name}`)
  schemas[name] = schema
}

function validateWebApiOperations(operations: readonly WebApiReferenceOperation[]): void {
  const operationIds = new Set<string>()
  for (const operation of operations) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(operation.operationId)) {
      throw new Error(`Invalid web API operation ID ${operation.operationId}`)
    }
    if (operationIds.has(operation.operationId)) {
      throw new Error(`Duplicate web API operation ID ${operation.operationId}`)
    }
    operationIds.add(operation.operationId)
    if (!operation.path.startsWith('/api/v1/') || /[?#]/.test(operation.path)) {
      throw new Error(`Invalid web API path ${operation.path}`)
    }
    if (
      !Number.isInteger(operation.successStatus) ||
      operation.successStatus < 200 ||
      operation.successStatus > 299
    ) {
      throw new Error(`Invalid success status for ${operation.operationId}`)
    }

    const placeholders = [...operation.path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(
      (match) => match[1] ?? '',
    )
    const parameterNames = operation.pathParameters.map((parameter) => parameter.name)
    if (
      /[{}]/.test(operation.path.replaceAll(/\{[A-Za-z][A-Za-z0-9]*\}/g, '')) ||
      new Set(parameterNames).size !== parameterNames.length ||
      placeholders.join('\0') !== parameterNames.join('\0')
    ) {
      throw new Error(`Path parameter projection does not match ${operation.path}`)
    }
    for (const parameter of operation.pathParameters) z.json().parse(parameter.schema)
    if (operation.requestBodySchema !== null) z.json().parse(operation.requestBodySchema)
    z.json().parse(operation.responseBodySchema)
  }
}

function toolResponse(resultName: string, description: string): Json {
  return z.json().parse({
    description,
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${resultName}` } },
    },
  })
}

function validateMcpTools(input: readonly Json[]): Json[] {
  const tools = input.map((tool) =>
    z
      .object({
        name: ToolNameSchema,
        inputSchema: z.json(),
        outputSchema: z.json(),
      })
      .loose()
      .parse(tool),
  )
  const names = tools.map((tool) => tool.name)
  const expectedNames = TOOL_SCHEMA_PROJECTIONS.map((tool) => tool.name)
  if (names.join('\0') !== expectedNames.join('\0')) {
    throw new Error('MCP catalog must contain every executable tool in canonical order')
  }
  for (const tool of tools) {
    for (const schemaName of ['inputSchema', 'outputSchema'] as const) {
      const schema = z.record(z.string(), z.json()).parse(tool[schemaName])
      if (schema.type !== 'object') {
        throw new Error(`MCP ${tool.name} ${schemaName} must describe an object`)
      }
    }
  }
  return input.map((tool) => z.json().parse(tool))
}

function buildOpenApi(input: ReferenceGeneratorInput): Json {
  const schemas: Record<string, Json> = {}
  const paths: Record<string, Record<string, Json>> = {}
  const callIdSchema = jsonSchema(ToolCallIdSchema)
  const missionIdSchema = jsonSchema(MissionIdSchema)

  for (const tool of TOOL_SCHEMA_PROJECTIONS) {
    const inputName = componentName(tool.name, 'Input')
    const outputName = componentName(tool.name, 'Output')
    const resultName = componentName(tool.name, 'Result')
    setComponentSchema(schemas, inputName, tool.inputSchema)
    setComponentSchema(schemas, outputName, tool.outputSchema)
    setComponentSchema(schemas, resultName, projectToolResultSchema(tool.name))
    const parameters: Json[] = [
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: callIdSchema,
      },
      {
        name: 'X-Trash-Palace-Mission',
        in: 'header',
        required: true,
        schema: missionIdSchema,
      },
    ]
    if (!tool.readOnly) {
      parameters.push(
        {
          name: 'Origin',
          in: 'header',
          required: false,
          description: 'Required for a mutation authenticated by session cookie.',
          schema: { type: 'string', format: 'uri' },
        },
        {
          name: 'X-CSRF-Token',
          in: 'header',
          required: false,
          description: 'Required for a mutation authenticated by session cookie.',
          schema: { type: 'string', minLength: 1 },
        },
      )
    }
    setPathOperation(
      paths,
      tool.route.path,
      tool.route.method,
      z.json().parse({
        operationId: tool.name,
        summary: tool.mcp.title,
        description: tool.mcp.description,
        tags: [tool.risk],
        security: [{ sessionCookie: [] }, { bearerAuth: [] }],
        parameters,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${inputName}` } },
          },
        },
        responses: {
          '200': toolResponse(resultName, 'The tool completed.'),
          '202': toolResponse(resultName, 'The tool is pending or its outcome is unknown.'),
          '403': toolResponse(resultName, 'The tool call was denied.'),
          '409': toolResponse(resultName, 'The tool call conflicted with current state.'),
          '422': toolResponse(resultName, 'The tool input was invalid.'),
          '500': toolResponse(resultName, 'The tool failed.'),
          default: {
            description: 'Transport boundary rejection before tool dispatch.',
          },
        },
        'x-tool-contract-hash': tool.contractHash,
        'x-tool-registry-hash': TOOL_REGISTRY_HASH,
      }),
    )
  }

  validateWebApiOperations(input.webApiOperations)
  for (const operation of input.webApiOperations) {
    const requestName = operationComponentName(operation.operationId, 'Request')
    const responseName = operationComponentName(operation.operationId, 'Response')
    if (operation.requestBodySchema !== null) {
      setComponentSchema(schemas, requestName, operation.requestBodySchema)
    }
    setComponentSchema(schemas, responseName, operation.responseBodySchema)
    const parameters: Json[] = operation.pathParameters.map((parameter) => ({
      name: parameter.name,
      in: 'path',
      required: true,
      schema: parameter.schema,
    }))
    if (operation.authentication === 'session_csrf_recent') {
      parameters.push(
        {
          name: 'Origin',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'uri' },
        },
        {
          name: 'X-CSRF-Token',
          in: 'header',
          required: true,
          schema: { type: 'string', minLength: 1 },
        },
      )
    }
    setPathOperation(
      paths,
      operation.path,
      operation.method,
      z.json().parse({
        operationId: operation.operationId,
        security: operation.authentication === 'none' ? [] : [{ sessionCookie: [] }],
        parameters,
        ...(operation.requestBodySchema === null
          ? {}
          : {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: { $ref: `#/components/schemas/${requestName}` },
                  },
                },
              },
            }),
        responses: {
          [String(operation.successStatus)]: {
            description: 'Successful response.',
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${responseName}` },
              },
            },
          },
          default: { description: 'Transport boundary rejection.' },
        },
        'x-authentication': operation.authentication,
      }),
    )
  }

  return z.json().parse({
    openapi: '3.1.0',
    info: {
      title: 'TrashPal API',
      version: input.applicationVersion,
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: input.httpBoundary.sessionCookieName,
        },
      },
      schemas,
    },
    'x-max-json-body-bytes': input.httpBoundary.maxJsonBodyBytes,
    'x-generated-from': ARTIFACT_OWNERS.openapi,
  })
}

function buildToolArtifacts(
  mcpTools: readonly Json[],
  referenceDirectory: string,
): Map<string, string> {
  const files = new Map<string, string>()
  const registry = TOOL_SCHEMA_PROJECTIONS.map((tool) => {
    const resultSchema = projectToolResultSchema(tool.name)
    const resultSchemaHash = hashToolResultSchema(tool.name)
    const inputSchemaPath = `tools/${tool.name}.input.schema.json`
    const outputSchemaPath = `tools/${tool.name}.output.schema.json`
    const resultSchemaPath = `tools/${tool.name}.result.schema.json`
    files.set(inputSchemaPath, jsonFile(tool.inputSchema))
    files.set(outputSchemaPath, jsonFile(tool.outputSchema))
    files.set(resultSchemaPath, jsonFile(resultSchema))
    return {
      name: tool.name,
      permission: tool.permission,
      risk: tool.risk,
      allowedPhases: tool.allowedPhases,
      readOnly: tool.readOnly,
      route: tool.route,
      contractHash: tool.contractHash,
      inputSchemaHash: tool.inputSchemaHash,
      outputSchemaHash: tool.outputSchemaHash,
      resultSchemaHash,
      inputSchemaPath: `${referenceDirectory}/${inputSchemaPath}`,
      outputSchemaPath: `${referenceDirectory}/${outputSchemaPath}`,
      resultSchemaPath: `${referenceDirectory}/${resultSchemaPath}`,
    }
  })
  files.set(
    'tool-registry.json',
    jsonFile({
      schemaVersion: 'tool-registry-reference@1',
      toolRegistryHash: TOOL_REGISTRY_HASH,
      tools: registry,
      generatedFrom: ARTIFACT_OWNERS.tools,
    }),
  )
  files.set(
    'mcp-catalog.json',
    jsonFile({
      schemaVersion: 'mcp-tool-catalog@1',
      toolRegistryHash: TOOL_REGISTRY_HASH,
      tools: validateMcpTools(mcpTools),
      generatedFrom: ARTIFACT_OWNERS.mcp,
    }),
  )
  return files
}

function validMissionStates(): MissionState[] {
  const states: MissionState[] = []
  for (const status of MissionStatusSchema.options) {
    for (const phase of MissionPhaseSchema.options) {
      const state = MissionStateSchema.safeParse({ status, phase })
      if (state.success) states.push(state.data)
    }
  }
  return states.sort((left, right) =>
    compareText(`${left.status}/${left.phase}`, `${right.status}/${right.phase}`),
  )
}

function buildMissionStateMachine(): Json {
  const states = validMissionStates()
  const explicitActions = new Map(
    MISSION_TRANSITIONS.map((transition) => [
      `${transition.from.status}/${transition.from.phase}/${transition.event}`,
      transition.hostAction,
    ]),
  )
  const transitions: Json[] = []
  for (const from of states) {
    for (const event of MissionTransitionEventSchema.options) {
      try {
        const to = resolveMissionTransition(from, event)
        transitions.push({
          from,
          event,
          to,
          hostAction: explicitActions.get(`${from.status}/${from.phase}/${event}`) ?? null,
        })
      } catch (error) {
        if (!(error instanceof InvalidMissionTransitionError)) throw error
        // Invalid state/event pairs are intentionally absent from the generated machine.
      }
    }
  }
  transitions.sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)))
  const payload = {
    states,
    events: [...MissionTransitionEventSchema.options].sort(),
    transitions,
  }
  return z.json().parse({
    schemaVersion: 'mission-state-machine@1',
    ...payload,
    stateMachineHash: hashToolValue(payload),
    generatedFrom: ARTIFACT_OWNERS.mission,
  })
}

const CONTEXT_SCHEMAS = {
  'context-request': ContextRequestSchema,
  'context-bundle': ContextBundleSchema,
  'knowledge-manifest': KnowledgeManifestSchema,
  'internal-context-receipt': InternalContextReceiptSchema,
  'public-context-receipt': PublicContextReceiptSchema,
  'context-compile-input': ContextCompileInputSchema,
  'runtime-context-snapshot': RuntimeContextSnapshotSchema,
  'exact-tool-contract-section': ExactToolContractSectionSchema,
  'host-policy-section': HostPolicySectionSchema,
} as const satisfies Record<string, z.ZodType>

function buildContextArtifacts(): Map<string, string> {
  const files = new Map<string, string>()
  const schemas = Object.entries(CONTEXT_SCHEMAS)
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, schema]) => {
      const projected = jsonSchema(schema)
      const path = `contexts/${name}.schema.json`
      files.set(path, jsonFile(projected))
      return {
        name,
        path: `${GENERATED_REFERENCE_DIRECTORY}/${path}`,
        sha256: hashToolValue(projected),
      }
    })
  const routing = MissionPhaseSchema.options.flatMap((phase) =>
    KnowledgeRiskSchema.options.map((risk) => ({
      phase,
      risk,
      selection: deriveMandatoryContextSelection(phase, risk),
      budget: deriveContextBudget(risk),
    })),
  )
  files.set(
    'context-registry.json',
    jsonFile({
      schemaVersion: 'context-reference-registry@1',
      policyHash: hashHostPolicyContract(),
      toolRegistryHash: TOOL_REGISTRY_HASH,
      schemas,
      routing,
      generatedFrom: ARTIFACT_OWNERS.context,
    }),
  )
  return files
}

function ownersFor(path: string): ArtifactOwner {
  if (path === 'openapi.json') return ARTIFACT_OWNERS.openapi
  if (path === 'mcp-catalog.json') return ARTIFACT_OWNERS.mcp
  if (path === 'event-registry.json') return ARTIFACT_OWNERS.events
  if (path === 'mission-state-machine.json') return ARTIFACT_OWNERS.mission
  if (path === 'context-registry.json' || path.startsWith('contexts/')) {
    return ARTIFACT_OWNERS.context
  }
  return ARTIFACT_OWNERS.tools
}

function finalizeReferenceSet(
  filesInput: ReadonlyMap<string, string>,
  epoch: ReturnType<typeof parseSourceDateEpoch>,
  directory: string,
  schemaVersion: 'generated-reference-manifest@1' | 'public-reference-manifest@1',
): GeneratedReferenceSet {
  const files = new Map(filesInput)
  const artifacts = [...files.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([path, content]) => ({
      path: `${directory}/${path}`,
      sha256: sha256Text(content),
      bytes: Buffer.byteLength(content, 'utf8'),
      owners: ownersFor(path),
    }))
  const manifest = jsonFile({
    schemaVersion,
    generatorVersion: REFERENCE_GENERATOR_VERSION,
    sourceDateEpoch: epoch.seconds,
    generatedAt: epoch.timestamp,
    artifacts,
  })
  const manifestHash = sha256Text(manifest)
  files.set('manifest.json', manifest)
  files.set('manifest.sha256', `${manifestHash}  manifest.json\n`)
  return {
    sourceDateEpoch: epoch.seconds,
    generatedAt: epoch.timestamp,
    files,
    manifestHash,
  }
}

export function buildGeneratedReferences(input: ReferenceGeneratorInput): GeneratedReferenceSet {
  const epoch = parseSourceDateEpoch(input.sourceDateEpoch)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.applicationVersion)) {
    throw new Error('Application version must be semver')
  }
  if (
    input.httpBoundary.sessionCookieName.length === 0 ||
    !Number.isInteger(input.httpBoundary.maxJsonBodyBytes) ||
    input.httpBoundary.maxJsonBodyBytes <= 0
  ) {
    throw new Error('HTTP boundary projection is invalid')
  }

  const files = buildToolArtifacts(input.mcpTools, GENERATED_REFERENCE_DIRECTORY)
  files.set('openapi.json', jsonFile(buildOpenApi(input)))
  files.set(
    'event-registry.json',
    jsonFile({
      schemaVersion: 'evidence-event-registry@1',
      eventRegistryHash: EVIDENCE_EVENT_REGISTRY_HASH,
      events: EVIDENCE_EVENT_SCHEMA_PROJECTIONS,
      generatedFrom: ARTIFACT_OWNERS.events,
    }),
  )
  files.set('mission-state-machine.json', jsonFile(buildMissionStateMachine()))
  for (const [path, content] of buildContextArtifacts()) files.set(path, content)

  return finalizeReferenceSet(
    files,
    epoch,
    GENERATED_REFERENCE_DIRECTORY,
    'generated-reference-manifest@1',
  )
}

export function buildPublicGeneratedReferences(
  input: ReferenceGeneratorInput,
): GeneratedReferenceSet {
  const complete = buildGeneratedReferences(input)
  const publicToolArtifacts = buildToolArtifacts(
    input.mcpTools,
    GENERATED_PUBLIC_REFERENCE_DIRECTORY,
  )
  const publicFiles = new Map<string, string>()
  for (const path of PUBLIC_REFERENCE_PATHS) {
    const content = publicToolArtifacts.get(path) ?? complete.files.get(path)
    if (content === undefined) throw new Error(`Public reference owner did not generate ${path}`)
    publicFiles.set(path, content)
  }
  return finalizeReferenceSet(
    publicFiles,
    parseSourceDateEpoch(input.sourceDateEpoch),
    GENERATED_PUBLIC_REFERENCE_DIRECTORY,
    'public-reference-manifest@1',
  )
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink())
        throw new Error('Generated reference directory cannot use symlinks')
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) output.push(relative(root, path).split(sep).join('/'))
    }
  }
  try {
    await visit(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return output.sort(compareText)
}

async function assertNotSymbolicLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Generated reference path cannot use symlinks: ${path}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function assertSafeOutputDirectory(
  outputDirectory: string,
  expectedName: string,
): Promise<string> {
  const requestedOutput = resolve(outputDirectory)
  if (
    basename(requestedOutput) !== expectedName ||
    basename(dirname(requestedOutput)) !== 'generated'
  ) {
    throw new Error(`Generated reference output directory must end in /generated/${expectedName}`)
  }
  const requestedBase = dirname(dirname(requestedOutput))
  if ((await lstat(requestedBase)).isSymbolicLink()) {
    throw new Error(`Generated reference path cannot use symlinks: ${requestedBase}`)
  }
  const output = join(await realpath(requestedBase), 'generated', expectedName)
  const currentDirectory = resolve(process.cwd())
  if (currentDirectory === output || currentDirectory.startsWith(`${output}${sep}`)) {
    throw new Error('Cannot replace generated references while running inside the output directory')
  }
  await assertNotSymbolicLink(dirname(output))
  await assertNotSymbolicLink(output)
  return output
}

async function writeReferenceSet(
  output: string,
  generated: GeneratedReferenceSet,
): Promise<GeneratedReferenceSet> {
  const staging = `${output}.staging-${process.pid}`
  await assertNotSymbolicLink(dirname(output))
  await assertNotSymbolicLink(output)
  await assertNotSymbolicLink(staging)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    for (const [path, content] of generated.files) {
      const destination = join(staging, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, content, { encoding: 'utf8', flag: 'wx' })
    }
    await assertNotSymbolicLink(dirname(output))
    await assertNotSymbolicLink(output)
    await rm(output, { recursive: true, force: true })
    await assertNotSymbolicLink(dirname(output))
    await assertNotSymbolicLink(output)
    await assertNotSymbolicLink(staging)
    await rename(staging, output)
  } catch (error) {
    try {
      await assertNotSymbolicLink(dirname(output))
      await assertNotSymbolicLink(staging)
      await rm(staging, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Generated reference write and cleanup failed',
        { cause: cleanupError },
      )
    }
    throw error
  }
  return generated
}

export async function writeGeneratedReferences(
  outputDirectory: string,
  input: ReferenceGeneratorInput,
): Promise<GeneratedReferenceSet> {
  const output = await assertSafeOutputDirectory(outputDirectory, 'reference')
  return writeReferenceSet(output, buildGeneratedReferences(input))
}

export async function writePublicGeneratedReferences(
  outputDirectory: string,
  input: ReferenceGeneratorInput,
): Promise<GeneratedReferenceSet> {
  const output = await assertSafeOutputDirectory(outputDirectory, 'public-reference')
  return writeReferenceSet(output, buildPublicGeneratedReferences(input))
}

export async function checkGeneratedReferences(
  outputDirectory: string,
  input: ReferenceGeneratorInput,
): Promise<GeneratedReferenceCheck> {
  const output = await assertSafeOutputDirectory(outputDirectory, 'reference')
  const generated = buildGeneratedReferences(input)
  const actualPaths = await listFiles(output)
  const expectedPaths = [...generated.files.keys()].sort(compareText)
  const actualSet = new Set(actualPaths)
  const expectedSet = new Set(expectedPaths)
  const missing = expectedPaths.filter((path) => !actualSet.has(path))
  const unexpected = actualPaths.filter((path) => !expectedSet.has(path))
  const changed: string[] = []
  for (const path of expectedPaths.filter((candidate) => actualSet.has(candidate))) {
    const actual = await readFile(join(output, path), 'utf8')
    if (actual !== generated.files.get(path)) changed.push(path)
  }
  if (missing.length > 0 || changed.length > 0 || unexpected.length > 0) {
    throw new StaleGeneratedReferencesError(missing, changed, unexpected)
  }
  return {
    checkedFiles: expectedPaths.length,
    manifestHash: generated.manifestHash,
    sourceDateEpoch: generated.sourceDateEpoch,
  }
}

export async function readGeneratedSourceDateEpoch(outputDirectory: string): Promise<string> {
  const output = await assertSafeOutputDirectory(outputDirectory, 'reference')
  const manifest = z
    .object({ sourceDateEpoch: z.string().regex(/^(?:0|[1-9][0-9]{0,11})$/) })
    .loose()
    .parse(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')))
  return manifest.sourceDateEpoch
}

export async function assertGeneratedManifestHash(outputDirectory: string): Promise<string> {
  return (await assertReferenceSetIntegrity(outputDirectory, 'reference')).manifestHash
}

async function assertReferenceSetIntegrity(
  outputDirectory: string,
  expectedName: 'public-reference' | 'reference',
): Promise<GeneratedManifestIntegrity> {
  const output = await assertSafeOutputDirectory(outputDirectory, expectedName)
  const actualPaths = await listFiles(output)
  const manifestBytes = await readFile(join(output, 'manifest.json'))
  const checksumBytes = await readFile(join(output, 'manifest.sha256'))
  const manifest = parseJsonBytes(manifestBytes, 'manifest.json')
  let checksum: string
  try {
    checksum = new TextDecoder('utf-8', { fatal: true }).decode(checksumBytes)
  } catch (error) {
    throw new Error('Generated reference checksum is not valid UTF-8', { cause: error })
  }
  const manifestHash = sha256Bytes(manifestBytes)
  const expected = `${manifestHash}  manifest.json\n`
  if (checksum !== expected) throw new Error('Generated reference manifest hash is invalid')
  const parsed = z
    .object({
      schemaVersion: z.literal(
        expectedName === 'public-reference'
          ? 'public-reference-manifest@1'
          : 'generated-reference-manifest@1',
      ),
      generatorVersion: z.literal(REFERENCE_GENERATOR_VERSION),
      sourceDateEpoch: z.string().regex(/^(?:0|[1-9][0-9]{0,11})$/),
      artifacts: z.array(
        z
          .object({
            path: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            bytes: z.number().int().nonnegative(),
            owners: z.array(z.string().min(1)).min(1),
          })
          .loose(),
      ),
    })
    .loose()
    .parse(manifest)
  const prefix = `generated/${expectedName}/`
  const expectedPaths = new Set(['manifest.json', 'manifest.sha256'])
  const verifiedJson = new Map<string, Json>()
  const manifestArtifacts = new Map<string, (typeof parsed.artifacts)[number]>()
  for (const artifact of parsed.artifacts) {
    if (!artifact.path.startsWith(prefix)) {
      throw new Error(`Generated manifest path is outside ${prefix}`)
    }
    const path = artifact.path.slice(prefix.length)
    if (
      path.length === 0 ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path
        .split('/')
        .some((component) => component === '' || component === '.' || component === '..') ||
      expectedPaths.has(path)
    ) {
      throw new Error(`Generated manifest path is invalid: ${artifact.path}`)
    }
    expectedPaths.add(path)
    const bytes = await readFile(join(output, path))
    if (bytes.length !== artifact.bytes || sha256Bytes(bytes) !== artifact.sha256) {
      throw new Error(`Generated artifact hash is invalid: ${artifact.path}`)
    }
    verifiedJson.set(artifact.path, parseJsonBytes(bytes, artifact.path))
    manifestArtifacts.set(artifact.path, artifact)
  }
  const expectedList = [...expectedPaths].sort(compareText)
  if (actualPaths.join('\0') !== expectedList.join('\0')) {
    throw new Error('Generated reference directory does not match its manifest')
  }
  if (expectedName === 'public-reference') {
    const publicPaths = parsed.artifacts
      .map(({ path }) => path.slice(prefix.length))
      .sort(compareText)
    if (publicPaths.join('\0') !== PUBLIC_REFERENCE_PATHS.join('\0')) {
      throw new Error('Public reference manifest does not match its explicit allowlist')
    }
    for (const [path, value] of verifiedJson) assertNoInternalGeneratedReference(value, path)
    const registryPath = `${prefix}tool-registry.json`
    const registryValue = verifiedJson.get(registryPath)
    if (registryValue === undefined) throw new Error('Public tool registry is missing')
    const registry = z
      .object({
        schemaVersion: z.literal('tool-registry-reference@1'),
        toolRegistryHash: z.string().regex(/^[a-f0-9]{64}$/),
        tools: z.array(
          z
            .object({
              name: ToolNameSchema,
              permission: z.string(),
              risk: z.string(),
              allowedPhases: z.array(z.string()),
              readOnly: z.boolean(),
              route: z.json(),
              contractHash: z.string().regex(/^[a-f0-9]{64}$/),
              inputSchemaPath: z.string(),
              inputSchemaHash: z.string().regex(/^[a-f0-9]{64}$/),
              outputSchemaPath: z.string(),
              outputSchemaHash: z.string().regex(/^[a-f0-9]{64}$/),
              resultSchemaPath: z.string(),
              resultSchemaHash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .loose(),
        ),
      })
      .loose()
      .parse(registryValue)
    if (registry.toolRegistryHash !== TOOL_REGISTRY_HASH) {
      throw new Error('Public tool registry hash does not match the canonical registry')
    }
    const expectedToolNames = TOOL_SCHEMA_PROJECTIONS.map(({ name }) => name)
    const registryToolNames = registry.tools.map(({ name }) => name)
    if (registryToolNames.join('\0') !== expectedToolNames.join('\0')) {
      throw new Error(
        'Public tool registry must contain every canonical tool exactly once in order',
      )
    }
    for (const [toolIndex, tool] of registry.tools.entries()) {
      const projection = TOOL_SCHEMA_PROJECTIONS[toolIndex]
      if (projection === undefined) throw new Error('Public tool registry has an unknown tool')
      const references = [
        ['input', tool.inputSchemaPath, tool.inputSchemaHash, projection.inputSchema],
        ['output', tool.outputSchemaPath, tool.outputSchemaHash, projection.outputSchema],
        [
          'result',
          tool.resultSchemaPath,
          tool.resultSchemaHash,
          projectToolResultSchema(projection.name),
        ],
      ] as const
      const expectedRegistryEntry = {
        name: projection.name,
        permission: projection.permission,
        risk: projection.risk,
        allowedPhases: projection.allowedPhases,
        readOnly: projection.readOnly,
        route: projection.route,
        contractHash: projection.contractHash,
        inputSchemaHash: projection.inputSchemaHash,
        outputSchemaHash: projection.outputSchemaHash,
        resultSchemaHash: hashToolResultSchema(projection.name),
        inputSchemaPath: `${prefix}tools/${projection.name}.input.schema.json`,
        outputSchemaPath: `${prefix}tools/${projection.name}.output.schema.json`,
        resultSchemaPath: `${prefix}tools/${projection.name}.result.schema.json`,
      }
      if (canonicalJson(tool) !== canonicalJson(expectedRegistryEntry)) {
        throw new Error(
          `Public tool registry entry does not match its canonical contract: ${tool.name}`,
        )
      }
      for (const [kind, path, declaredHash, expectedSchema] of references) {
        const expectedPath = `${prefix}tools/${tool.name}.${kind}.schema.json`
        if (path !== expectedPath) {
          throw new Error(`Public tool schema path is outside its canonical location: ${path}`)
        }
        const artifact = manifestArtifacts.get(path)
        const schema = verifiedJson.get(path)
        if (artifact === undefined || schema === undefined) {
          throw new Error(`Public tool schema is not closed by the manifest: ${path}`)
        }
        const bytes = await readFile(join(output, path.slice(prefix.length)))
        if (sha256Bytes(bytes) !== artifact.sha256) {
          throw new Error(`Public tool schema byte hash does not match the manifest: ${path}`)
        }
        if (hashToolValue(schema) !== declaredHash) {
          throw new Error(`Public tool schema semantic hash does not match the registry: ${path}`)
        }
        if (canonicalJson(schema) !== canonicalJson(expectedSchema)) {
          throw new Error(`Public tool schema does not match its canonical projection: ${path}`)
        }
      }
    }
  }
  return {
    artifactCount: parsed.artifacts.length,
    manifestHash,
    sourceDateEpoch: parsed.sourceDateEpoch,
  }
}

export async function assertPublicGeneratedManifest(
  outputDirectory: string,
): Promise<GeneratedManifestIntegrity> {
  return assertReferenceSetIntegrity(outputDirectory, 'public-reference')
}

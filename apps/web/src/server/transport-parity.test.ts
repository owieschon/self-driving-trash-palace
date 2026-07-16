import {
  OpaqueMissionFenceToken,
  type DelegatedAuthContext,
  type MissionExecutionContext,
} from '@trash-palace/application'
import {
  MissionIdSchema,
  OperationSchema,
  OrganizationIdSchema,
  PalaceSchema,
  PlanActionSchema,
  PlanSchema,
  PrincipalSchema,
  RoutineSchema,
  RoutineVersionSchema,
  TOOL_REGISTRY,
  ToolNameSchema,
  computePlanHash,
  hashToolValue,
  parseToolInput,
  parseToolOutput,
  parseToolResult,
  type MissionId,
  type ToolInputPayload,
  type ToolName,
} from '@trash-palace/core'
import { InProcessToolAdapter, MCP_MISSION_HEADER, createMcpPostHandler } from '@trash-palace/mcp'
import { describe, expect, it } from 'vitest'

import { TrashPalaceApiClient } from './api-client.js'
import { createHttpToolRoute } from './tool-route.js'

const ORIGIN = 'http://127.0.0.1'
const ACCESS_TOKEN = 'delegated.parity.token_1234567890'
const NOW = '2026-08-14T05:40:00.000Z'
const organizationId = OrganizationIdSchema.parse('org_transport_parity')
const missionId = MissionIdSchema.parse('mis_transport_parity')
const palace = PalaceSchema.parse({
  id: 'pal_transport_parity',
  organizationId,
  name: 'Transport Parity Palace',
  timezone: 'America/New_York',
  batteryAvailablePercentage: 62,
  createdAt: NOW,
})
const routineDefinition = {
  name: 'Transport parity homecoming',
  trigger: {
    type: 'verified_arrival' as const,
    windowStart: '00:00',
    windowEnd: '03:00',
    timezone: 'America/New_York',
  },
  actions: [
    { type: 'preheat' as const, targetCelsius: 20, completeBy: '02:00' },
    {
      type: 'pathway_lighting' as const,
      intensityPercent: 40,
      durationSeconds: 900,
      beginsAfter: 'verified_arrival' as const,
    },
    { type: 'unlock' as const, durationSeconds: 90, requireVerifiedIdentity: true as const },
    { type: 'lock_desired_state' as const, afterUnlockSeconds: 90 },
  ],
  constraints: {
    projectedBatteryUseMaxPercentagePoints: 15,
    hardInvariantIds: ['verified_identity_required_for_unlock' as const],
  },
  projectedBatteryUsePercentagePoints: 13.2,
}
const routine = RoutineSchema.parse({
  id: 'rtn_transport_parity',
  organizationId,
  palaceId: palace.id,
  name: routineDefinition.name,
  activeVersionId: 'rtv_transport_parity',
  createdAt: NOW,
})
const routineVersion = RoutineVersionSchema.parse({
  id: 'rtv_transport_parity',
  routineId: routine.id,
  organizationId,
  version: 3,
  status: 'active',
  definition: routineDefinition,
  sourcePlanId: null,
  sourcePlanHash: null,
  createdAt: NOW,
})
const action = PlanActionSchema.parse({
  id: 'act_transport_parity',
  type: 'restore_routine_version',
  palaceId: palace.id,
  routineId: routine.id,
  restoreVersionId: routineVersion.id,
  expectedCurrentVersion: 3,
})
if (action.type !== 'restore_routine_version') {
  throw new TypeError('The transport fixture requires a restore action')
}
const constraints = {
  preheatBy: '02:00',
  requireVerifiedIdentityForUnlock: true as const,
  pathwayLightingBeginsAfter: 'verified_arrival' as const,
  projectedBatteryUseMaxPercentagePoints: 15,
}
const planHashPayload = {
  schemaVersion: 'plan-hash@1' as const,
  id: 'pln_transport_parity',
  organizationId,
  missionId,
  palaceId: palace.id,
  revision: 1,
  objective: 'Prove all canonical transports carry the same contract.',
  constraints,
  actions: [action],
  successCriteriaIds: ['transport_parity_complete'],
}
const approvedPlan = PlanSchema.parse({
  id: planHashPayload.id,
  organizationId,
  missionId,
  palaceId: palace.id,
  revision: planHashPayload.revision,
  hash: computePlanHash(planHashPayload),
  status: 'approved',
  objective: planHashPayload.objective,
  constraints,
  actions: [action],
  successCriteriaIds: planHashPayload.successCriteriaIds,
  createdAt: NOW,
})
const approvalId = 'apr_transport_parity'
const missionState = { status: 'running', phase: 'understand' } as const

const operation = OperationSchema.parse({
  id: 'op_transport_parity',
  organizationId,
  missionId,
  planId: approvedPlan.id,
  planActionId: action.id,
  approvalId,
  payloadHash: approvedPlan.hash,
  serverCreated: true,
  status: 'committed',
  outcome: {
    routineId: routine.id,
    routineVersionId: routineVersion.id,
    deactivatedRoutineId: null,
  },
  createdAt: NOW,
  committedAt: NOW,
})

const TOOL_INPUTS = {
  'palaces.get': { palaceId: palace.id },
  'crews.list': { palaceId: palace.id },
  'capabilities.list': { palaceId: palace.id },
  'routines.list': { palaceId: palace.id },
  'routines.get': { routineId: routine.id },
  'executions.list': { missionId },
  'knowledge.search': { query: 'safe homecoming operations', phase: 'understand' },
  'plans.propose': {
    missionId,
    revision: approvedPlan.revision,
    actions: approvedPlan.actions,
    successCriteriaIds: approvedPlan.successCriteriaIds,
  },
  'plans.validate': { planId: approvedPlan.id },
  'plans.simulate': {
    planId: approvedPlan.id,
    scenarios: ['timing', 'access', 'energy', 'transport_failure'],
  },
  'plans.request_approval': { planId: approvedPlan.id },
  'plans.activate': {
    planId: approvedPlan.id,
    actionId: action.id,
    expectedVersion: action.expectedCurrentVersion,
  },
  'operations.get': { operationId: operation.id },
  'verification.get_evidence': { missionId },
  'missions.cancel': { missionId, reason: 'Transport parity fixture completed' },
} as const satisfies Record<ToolName, unknown>

const TOOL_OUTPUTS = {
  'palaces.get': { palace },
  'crews.list': { crew: [], identityTags: [], schedules: [], preferences: [] },
  'capabilities.list': { devices: [], capabilities: [] },
  'routines.list': { routines: [routine], versions: [routineVersion] },
  'routines.get': {
    routine,
    version: routineVersion,
  },
  'executions.list': { executions: [] },
  'knowledge.search': {
    results: [
      {
        sourceId: 'knowledge/homecoming-operations.md',
        version: '2026-08-14',
        title: 'Operate a homecoming mission',
        excerpt: 'Reconcile an unknown activation before attempting the same operation again.',
      },
    ],
  },
  'plans.propose': { plan: approvedPlan },
  'plans.validate': {
    valid: true,
    checks: [
      { type: 'schema', passed: true, message: 'The plan matches the canonical schema.' },
      { type: 'hard_invariant', passed: true, message: 'Hard invariants hold.' },
    ],
  },
  'plans.simulate': {
    feasible: true,
    projectedBatteryUsePercentagePoints: 13.2,
    results: [
      { scenario: 'timing', passed: true, evidence: 'The timing window is feasible.' },
      { scenario: 'access', passed: true, evidence: 'Unlock requires verified identity.' },
      { scenario: 'energy', passed: true, evidence: 'Projected use remains below the bound.' },
      {
        scenario: 'transport_failure',
        passed: true,
        evidence: 'The operation can be reconciled by its stable identifier.',
      },
    ],
  },
  'plans.request_approval': { approvalRequestId: approvalId, paused: true },
  'plans.activate': { operation, durableRoutineId: routine.id },
  'operations.get': { operation, attempts: [] },
  'verification.get_evidence': { evidence: [] },
  'missions.cancel': { missionId, state: missionState },
} as const satisfies Record<ToolName, unknown>

const delegatedAuthentication: DelegatedAuthContext = {
  tokenId: 'tok_transport_parity',
  principal: PrincipalSchema.parse({
    organizationId,
    actorId: 'usr_transport_client',
    role: 'delegated',
    operatorGrants: [],
    delegatedPermissions: [
      ...new Set(ToolNameSchema.options.map((name) => TOOL_REGISTRY[name].permission)),
    ],
  }),
  expiresAt: '2026-08-14T08:00:00.000Z',
}

const missionAuthentication: MissionExecutionContext = {
  principal: PrincipalSchema.parse({
    organizationId,
    actorId: 'usr_caretaker_service',
    role: 'service',
    operatorGrants: [],
    delegatedPermissions: [],
  }),
  fence: {
    organizationId,
    missionId,
    ownerId: 'worker_transport_parity',
    epoch: 1,
    token: OpaqueMissionFenceToken.fromEntropy('transport-parity-fence-token'),
  },
  signal: new AbortController().signal,
}

describe('canonical tool transport parity', () => {
  it('returns equivalent envelopes and invocation state for all 15 tools', async () => {
    const inProcess = await runInProcessCopy()
    const http = await runHttpCopy()
    const mcp = await runMcpCopy()

    expect(ToolNameSchema.options).toHaveLength(15)
    expect(http.results).toEqual(inProcess.results)
    expect(mcp.results).toEqual(inProcess.results)
    expect(http.state).toEqual(inProcess.state)
    expect(mcp.state).toEqual(inProcess.state)
    expect(inProcess.channels).toEqual(['in_process'])
    expect(http.channels).toEqual(['http'])
    expect(mcp.channels).toEqual(['mcp'])
  })
})

class ParityDispatcher {
  readonly #invocations: Readonly<{ toolName: ToolName; inputHash: string }>[] = []
  readonly #channels = new Set<string>()

  public async invoke(
    request: Readonly<{ callId: string; toolName: ToolName; input: unknown }>,
    host: Readonly<{ missionId: MissionId; channel: 'in_process' | 'http' | 'mcp' }>,
  ): Promise<unknown> {
    expect(host.missionId).toBe(missionId)
    const input = parseToolInput(request.toolName, request.input)
    const data = parseToolOutput(request.toolName, TOOL_OUTPUTS[request.toolName])
    this.#invocations.push({ toolName: request.toolName, inputHash: hashToolValue(input) })
    this.#channels.add(host.channel)
    return parseToolResult(request.toolName, {
      schemaVersion: 'tool-result@1',
      toolName: request.toolName,
      callId: request.callId,
      status: 'succeeded',
      retryable: false,
      data,
      receiptId: receiptIdFor(request.toolName),
      resourceVersion: null,
      error: null,
    })
  }

  public state(): readonly Readonly<{ toolName: ToolName; inputHash: string }>[] {
    return structuredClone(this.#invocations)
  }

  public channels(): readonly string[] {
    return [...this.#channels].sort()
  }
}

async function runInProcessCopy() {
  const dispatcher = new ParityDispatcher()
  const adapter = new InProcessToolAdapter({
    dispatcher,
    authentication: missionAuthentication,
    missionId,
  })
  const results = []
  for (const toolName of ToolNameSchema.options) {
    results.push(
      normalizeResult(toolName, await invokeInProcess(adapter, toolName, TOOL_INPUTS[toolName])),
    )
  }
  return { results, state: dispatcher.state(), channels: dispatcher.channels() }
}

async function runHttpCopy() {
  const dispatcher = new ParityDispatcher()
  const route = createHttpToolRoute({
    allowedOrigin: ORIGIN,
    authentication: {
      authenticateSession: async () => {
        throw new Error('Session authentication is not part of this delegated parity copy')
      },
      authenticateBearer: async () => delegatedAuthentication,
      assertSensitiveMutation: () => undefined,
    },
    dispatcher,
  })
  const client = new TrashPalaceApiClient(ORIGIN, inProcessHttpFetch(route))
  const results = []
  for (const toolName of ToolNameSchema.options) {
    results.push(
      normalizeResult(toolName, await invokeHttp(client, toolName, TOOL_INPUTS[toolName])),
    )
  }
  return { results, state: dispatcher.state(), channels: dispatcher.channels() }
}

async function runMcpCopy() {
  const dispatcher = new ParityDispatcher()
  const handler = createMcpPostHandler({
    allowedHosts: [new URL(ORIGIN).host],
    authentication: { authenticateBearer: async () => delegatedAuthentication },
    dispatcher,
  })
  const results = []
  for (const [index, toolName] of ToolNameSchema.options.entries()) {
    const response = await handler(mcpToolRequest(index + 1, toolName, TOOL_INPUTS[toolName]))
    expect(response.status).toBe(200)
    results.push(normalizeResult(toolName, mcpStructuredContent(await response.json())))
  }
  return { results, state: dispatcher.state(), channels: dispatcher.channels() }
}

async function invokeInProcess<Name extends ToolName>(
  adapter: InProcessToolAdapter,
  toolName: Name,
  input: ToolInputPayload<Name>,
) {
  parseToolInput(toolName, input)
  return adapter.invoke({
    callId: callIdFor('in_process', toolName),
    toolName,
    input,
  })
}

async function invokeHttp<Name extends ToolName>(
  client: TrashPalaceApiClient,
  toolName: Name,
  input: unknown,
) {
  return client.invokeTool({
    toolName,
    callId: callIdFor('http', toolName),
    missionId,
    body: parseToolInput(toolName, input),
    bearerToken: ACCESS_TOKEN,
  })
}

function normalizeResult(toolName: ToolName, value: unknown) {
  const result = parseToolResult(toolName, value)
  return {
    schemaVersion: result.schemaVersion,
    toolName: result.toolName,
    status: result.status,
    retryable: result.retryable,
    data: result.data,
    resourceVersion: result.resourceVersion,
    error: result.error,
  }
}

function callIdFor(channel: 'http' | 'in_process', toolName: ToolName): string {
  return `call_${channel}_${toolName.replaceAll('.', '_')}`
}

function receiptIdFor(toolName: ToolName): string {
  return `rcp_parity_${toolName.replaceAll('.', '_')}`
}

function inProcessHttpFetch(
  route: ReturnType<typeof createHttpToolRoute>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const prefix = '/api/v1/tools/'
    const pathname = new URL(request.url).pathname
    if (!pathname.startsWith(prefix)) return new Response(null, { status: 404 })
    return route(request, decodeURIComponent(pathname.slice(prefix.length)))
  }
}

function mcpToolRequest(id: number, toolName: ToolName, toolInput: unknown): Request {
  return new Request(`${ORIGIN}/api/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${ACCESS_TOKEN}`,
      'content-type': 'application/json',
      host: new URL(ORIGIN).host,
      [MCP_MISSION_HEADER]: missionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: toolName, arguments: toolInput },
    }),
  })
}

function mcpStructuredContent(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || !('result' in value)) {
    throw new TypeError('MCP response is missing its result')
  }
  const result = value.result
  if (result === null || typeof result !== 'object' || !('structuredContent' in result)) {
    throw new TypeError('MCP response is missing structuredContent')
  }
  return result.structuredContent
}

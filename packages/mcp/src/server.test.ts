import type { DelegatedAuthContext } from '@trash-palace/application'
import { PrincipalSchema, ToolNameSchema, parseToolResult } from '@trash-palace/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MCP_MISSION_HEADER, projectMcpOutputSchema } from './contract.js'
import { createMcpPostHandler, mcpMethodNotAllowed, type McpDispatcherPort } from './server.js'

const TOKEN = 'delegated.token.value_1234567890'
const MISSION_ID = 'mis_mcp_route_01'
const HOST = 'trash-palace.local'

const authentication: DelegatedAuthContext = {
  tokenId: 'tok_mcp_route_01',
  principal: PrincipalSchema.parse({
    organizationId: 'org_mcp_route_01',
    actorId: 'usr_mcp_route_01',
    role: 'delegated',
    operatorGrants: [],
    delegatedPermissions: ['knowledge:read'],
  }),
  expiresAt: '2026-08-14T07:00:00.000Z',
}

describe('stateless Streamable HTTP MCP', () => {
  let invoke: ReturnType<typeof vi.fn<McpDispatcherPort['invoke']>>
  let revoked: boolean
  let handle: ReturnType<typeof createMcpPostHandler>

  beforeEach(() => {
    revoked = false
    invoke = vi.fn<McpDispatcherPort['invoke']>().mockImplementation(async (request) =>
      parseToolResult('knowledge.search', {
        schemaVersion: 'tool-result@1',
        toolName: 'knowledge.search',
        callId: request.callId,
        status: 'succeeded',
        retryable: false,
        data: { results: [] },
        receiptId: 'rcp_mcp_route_01',
        resourceVersion: null,
        error: null,
      }),
    )
    handle = createMcpPostHandler({
      allowedHosts: [HOST],
      authentication: {
        authenticateBearer: vi.fn(async () => {
          if (revoked) throw new Error('revoked')
          return authentication
        }),
      },
      dispatcher: { invoke },
    })
  })

  it('advertises exactly the canonical 15 tools with exact schemas and no other primitives', async () => {
    const response = await handle(mcpRequest(1, 'tools/list', {}))
    const payload = responsePayload(await response.json())
    const tools = payload.result.tools as Record<string, unknown>[]

    expect(response.status).toBe(200)
    expect(tools.map((tool) => tool.name)).toEqual([...ToolNameSchema.options].sort())
    expect(tools).toHaveLength(15)
    const knowledge = tools.find((tool) => tool.name === 'knowledge.search')
    expect(knowledge?.outputSchema).toEqual(projectMcpOutputSchema('knowledge.search'))
    expect(JSON.stringify(payload)).not.toContain('resources')
    expect(JSON.stringify(payload)).not.toContain('prompts')
  })

  it('dispatches a typed tool call with a stable opaque call ID', async () => {
    const request = () =>
      mcpRequest(41, 'tools/call', {
        name: 'knowledge.search',
        arguments: { query: 'unknown outcomes', phase: 'reconcile' },
      })

    const first = responsePayload(await (await handle(request())).json())
    const second = responsePayload(await (await handle(request())).json())

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls[0]?.[0].callId).toMatch(/^call_[a-f0-9]{64}$/)
    expect(invoke.mock.calls[1]?.[0].callId).toBe(invoke.mock.calls[0]?.[0].callId)
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      authentication,
      channel: 'mcp',
      missionId: MISSION_ID,
    })
    expect(first.result.structuredContent).toEqual(second.result.structuredContent)
  })

  it('rejects invalid arguments before dispatch without echoing hostile input', async () => {
    const hostile = '<script>wrong phase</script>'
    const response = await handle(
      mcpRequest('bad-input', 'tools/call', {
        name: 'knowledge.search',
        arguments: { query: hostile, phase: 'invent' },
      }),
    )
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(invoke).not.toHaveBeenCalled()
    expect(text).not.toContain(hostile)
    expect(text).toContain('Tool arguments do not match the exact schema.')
  })

  it('rejects cookies, browser origins, unknown hosts, and ambiguous bearer values', async () => {
    const cases = [
      mcpRequest(1, 'tools/list', {}, { cookie: 'session=value' }),
      mcpRequest(1, 'tools/list', {}, { origin: 'https://attacker.invalid' }),
      mcpRequest(1, 'tools/list', {}, { host: 'attacker.invalid' }),
      mcpRequest(1, 'tools/list', {}, { authorization: `Bearer ${TOKEN}, Bearer ${TOKEN}` }),
    ]

    for (const request of cases) {
      const response = await handle(request)
      expect([401, 403]).toContain(response.status)
      expect(response.headers.has('access-control-allow-origin')).toBe(false)
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('fails a revoked bearer before protocol handling', async () => {
    revoked = true
    const response = await handle(mcpRequest(1, 'tools/list', {}))

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('returns protocol-safe 405 responses for GET and DELETE', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await handle(new Request(`http://${HOST}/api/mcp`, { method }))
      const payload = responsePayload(await response.json())
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
      expect(payload.error.code).toBe(-32600)
    }
    expect(mcpMethodNotAllowed().status).toBe(405)
  })
})

function mcpRequest(
  id: number | string,
  method: string,
  params: Record<string, unknown>,
  overrides: Record<string, string> = {},
): Request {
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    host: HOST,
    [MCP_MISSION_HEADER]: MISSION_ID,
    ...overrides,
  })
  return new Request(`http://${HOST}/api/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
}

function responsePayload(value: unknown): {
  readonly result: Record<string, unknown>
  readonly error: Readonly<{ code: number }>
} {
  return value as {
    readonly result: Record<string, unknown>
    readonly error: Readonly<{ code: number }>
  }
}

import type { DelegatedAuthContext } from '@trash-palace/application'
import { PrincipalSchema, parseToolResult } from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

import { runMcpSmoke } from './client.js'
import { createMcpPostHandler, type McpDispatcherPort } from './server.js'

const TOKEN = 'delegated.token.value_1234567890'
const HOST = '127.0.0.1'
const MISSION_ID = 'mis_mcp_client_01'

const authentication: DelegatedAuthContext = {
  tokenId: 'tok_mcp_client_01',
  principal: PrincipalSchema.parse({
    organizationId: 'org_mcp_client_01',
    actorId: 'usr_mcp_client_01',
    role: 'delegated',
    operatorGrants: [],
    delegatedPermissions: ['knowledge:read'],
  }),
  expiresAt: '2026-08-14T07:00:00.000Z',
}

describe('bundled MCP smoke client', () => {
  it('negotiates, verifies the exact catalog, invokes one tool, and retains no sensitive output', async () => {
    const invoke = vi.fn<McpDispatcherPort['invoke']>().mockImplementation(async (request) =>
      parseToolResult('knowledge.search', {
        schemaVersion: 'tool-result@1',
        toolName: 'knowledge.search',
        callId: request.callId,
        status: 'succeeded',
        retryable: false,
        data: {
          results: [
            {
              sourceId: 'kb_reconciliation',
              version: '2026-08-14',
              title: 'Reconcile unknown outcomes',
              excerpt: 'Read durable state before retrying a consequential write.',
            },
          ],
        },
        receiptId: 'rcp_mcp_client_01',
        resourceVersion: null,
        error: null,
      }),
    )
    const handler = createMcpPostHandler({
      allowedHosts: [HOST],
      authentication: { authenticateBearer: vi.fn().mockResolvedValue(authentication) },
      dispatcher: { invoke },
    })

    const receipt = await runMcpSmoke({
      endpoint: `http://${HOST}/api/mcp`,
      accessToken: TOKEN,
      missionId: MISSION_ID,
      invoke: {
        toolName: 'knowledge.search',
        input: { query: 'unknown outcomes', phase: 'reconcile' },
      },
      fetch: inProcessFetch(handler),
    })

    expect(receipt).toMatchObject({
      schemaVersion: 'mcp-smoke-receipt@1',
      toolCount: 15,
      invokedTool: 'knowledge.search',
    })
    expect(receipt.resultHash).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.resultDataHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(receipt)).not.toContain(TOKEN)
    expect(JSON.stringify(receipt)).not.toContain('unknown outcomes')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it.each([
    'http://trash-palace.example/api/mcp',
    'http://192.0.2.10/api/mcp',
    'ftp://localhost/api/mcp',
    'https://operator:secret@trash-palace.example/api/mcp',
    'https://trash-palace.example/api/mcp?token=secret',
    'https://trash-palace.example/api/mcp#private',
  ])(
    'rejects an endpoint that could expose or misroute a delegated token: %s',
    async (endpoint) => {
      const request = vi.fn<typeof globalThis.fetch>()

      await expect(
        runMcpSmoke({
          endpoint,
          accessToken: TOKEN,
          missionId: MISSION_ID,
          fetch: request,
        }),
      ).rejects.toThrow()
      expect(request).not.toHaveBeenCalled()
    },
  )

  it.each([
    'http://localhost:3000/api/mcp',
    'http://127.42.0.2:3000/api/mcp',
    'http://[::1]:3000/api/mcp',
    'https://trash-palace.example/api/mcp',
  ])('allows a loopback or HTTPS MCP endpoint: %s', async (endpoint) => {
    const handler = createMcpPostHandler({
      allowedHosts: [new URL(endpoint).host],
      authentication: { authenticateBearer: vi.fn().mockResolvedValue(authentication) },
      dispatcher: { invoke: vi.fn() },
    })

    await expect(
      runMcpSmoke({
        endpoint,
        accessToken: TOKEN,
        missionId: MISSION_ID,
        fetch: inProcessFetch(handler),
      }),
    ).resolves.toMatchObject({ toolCount: 15, invokedTool: null })
  })
})

function inProcessFetch(handler: ReturnType<typeof createMcpPostHandler>): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const headers = new Headers(request.headers)
    headers.set('host', new URL(request.url).host)
    return handler(new Request(request, { headers }))
  }
}

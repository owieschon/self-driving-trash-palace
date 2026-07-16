import type { AuthContext, DelegatedAuthContext } from '@trash-palace/application'
import { PrincipalSchema, parseToolResult } from '@trash-palace/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SESSION_COOKIE_NAME } from './http-boundary.js'
import {
  createHttpToolRoute,
  type HttpToolDispatcherPort,
  type HttpToolRouteDependencies,
} from './tool-route.js'

const CALL_ID = 'call_http_tool_01'
const MISSION_ID = 'mis_http_route_01'
const SESSION = 'signed.session.value_1234567890'
const BEARER = 'delegated.token.value_1234567890'
const CSRF = 'csrf_http_route_value_1234567890'

const principal = PrincipalSchema.parse({
  organizationId: 'org_http_route_01',
  actorId: 'usr_http_owner_01',
  role: 'owner',
  operatorGrants: [],
  delegatedPermissions: [],
})

const sessionContext: AuthContext = {
  sessionId: 'session_http_route_1234567890',
  principal,
  csrfToken: CSRF,
  issuedAt: '2026-08-14T05:00:00.000Z',
  expiresAt: '2026-08-14T07:00:00.000Z',
  authenticatedAt: '2026-08-14T05:00:00.000Z',
}

const delegatedContext: DelegatedAuthContext = {
  tokenId: 'tok_http_route_01',
  principal: PrincipalSchema.parse({
    ...principal,
    role: 'delegated',
    delegatedPermissions: ['knowledge:read'],
  }),
  expiresAt: '2026-08-14T07:00:00.000Z',
}

describe('HTTP tool route', () => {
  let invoke: ReturnType<typeof vi.fn<HttpToolDispatcherPort['invoke']>>
  let assertSensitiveMutation: ReturnType<
    typeof vi.fn<HttpToolRouteDependencies['authentication']['assertSensitiveMutation']>
  >
  let route: ReturnType<typeof createHttpToolRoute>

  beforeEach(() => {
    invoke = vi.fn<HttpToolDispatcherPort['invoke']>().mockResolvedValue(successResult())
    assertSensitiveMutation = vi.fn()
    const dependencies: HttpToolRouteDependencies = {
      allowedOrigin: 'http://trash-palace.local',
      authentication: {
        authenticateSession: vi.fn().mockResolvedValue(sessionContext),
        authenticateBearer: vi.fn().mockResolvedValue(delegatedContext),
        assertSensitiveMutation,
      },
      dispatcher: { invoke },
    }
    route = createHttpToolRoute(dependencies)
  })

  it('authenticates one session and forwards host-derived invocation context', async () => {
    const response = await route(toolRequest({ credential: 'session' }), 'knowledge.search')

    expect(response.status).toBe(200)
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(invoke).toHaveBeenCalledWith(
      {
        callId: CALL_ID,
        toolName: 'knowledge.search',
        input: { query: 'reconcile an unknown outcome', phase: 'reconcile' },
      },
      expect.objectContaining({
        authentication: sessionContext,
        channel: 'http',
        missionId: MISSION_ID,
      }),
    )
    await expect(response.json()).resolves.toEqual(successResult())
  })

  it('supports bearer-only delegated authentication without browser mutation state', async () => {
    const response = await route(toolRequest({ credential: 'bearer' }), 'knowledge.search')

    expect(response.status).toBe(200)
    expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty('browserMutation')
  })

  it('requires same-origin CSRF state for browser mutations before dispatch', async () => {
    const response = await route(toolRequest({ credential: 'session' }), 'missions.cancel')

    expect(response.status).toBe(401)
    expect(invoke).not.toHaveBeenCalled()
    expect(await response.text()).not.toContain(CSRF)
  })

  it('enforces recent authentication through the session service before dispatch', async () => {
    assertSensitiveMutation.mockImplementationOnce(() => {
      throw new Error('stale authentication detail')
    })
    const request = toolRequest({ credential: 'session' })
    request.headers.set('origin', 'http://trash-palace.local')
    request.headers.set('x-csrf-token', CSRF)

    const response = await route(request, 'missions.cancel')

    expect(response.status).toBe(401)
    expect(invoke).not.toHaveBeenCalled()
    expect(await response.text()).not.toContain('stale authentication detail')
  })

  it('returns problem+json for unknown tools and authentication failures', async () => {
    const unknown = await route(toolRequest({ credential: 'session' }), 'palaces.delete')
    const confused = await route(toolRequest({ credential: 'both' }), 'knowledge.search')

    expect(unknown.status).toBe(404)
    expect(confused.status).toBe(401)
    expect(unknown.headers.get('content-type')).toContain('application/problem+json')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects query parameters before authentication or dispatch', async () => {
    const input = toolRequest({ credential: 'bearer' })
    const request = new Request(`${input.url}?debug=private`, input)

    const response = await route(request, 'knowledge.search')

    expect(response.status).toBe(400)
    expect(invoke).not.toHaveBeenCalled()
    expect(await response.text()).not.toContain('private')
  })

  it.each([
    ['pending', 202],
    ['unknown', 202],
    ['denied', 403],
    ['conflict', 409],
    ['failed', 500],
  ] as const)('maps canonical %s results to HTTP %i', async (status, expectedStatus) => {
    invoke.mockResolvedValueOnce(nonSuccessResult(status))

    const response = await route(toolRequest({ credential: 'bearer' }), 'knowledge.search')

    expect(response.status).toBe(expectedStatus)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('maps the dispatcher safe not-found code to HTTP 404', async () => {
    invoke.mockResolvedValueOnce(
      parseToolResult('knowledge.search', {
        ...nonSuccessResult('failed'),
        error: { code: 'RESOURCE_NOT_FOUND', message: 'Resource is unavailable', details: {} },
      }),
    )

    const response = await route(toolRequest({ credential: 'bearer' }), 'knowledge.search')

    expect(response.status).toBe(404)
  })

  it('fails closed when a dispatcher returns a malformed envelope', async () => {
    invoke.mockResolvedValueOnce({ status: 'succeeded', private: 'not a tool result' })

    const response = await route(toolRequest({ credential: 'bearer' }), 'knowledge.search')

    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('private')
  })
})

function toolRequest(input: { credential: 'bearer' | 'both' | 'session' }): Request {
  const headers = new Headers({
    'content-type': 'application/json',
    'idempotency-key': CALL_ID,
    'x-trash-palace-mission': MISSION_ID,
  })
  if (input.credential === 'session' || input.credential === 'both') {
    headers.set('cookie', `${SESSION_COOKIE_NAME}=${SESSION}`)
  }
  if (input.credential === 'bearer' || input.credential === 'both') {
    headers.set('authorization', `Bearer ${BEARER}`)
  }
  return new Request('http://trash-palace.local/api/v1/tools/knowledge.search', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'reconcile an unknown outcome', phase: 'reconcile' }),
  })
}

function successResult() {
  return parseToolResult('knowledge.search', {
    schemaVersion: 'tool-result@1',
    toolName: 'knowledge.search',
    callId: CALL_ID,
    status: 'succeeded',
    retryable: false,
    data: { results: [] },
    receiptId: 'rcp_http_route_01',
    resourceVersion: null,
    error: null,
  })
}

function nonSuccessResult(status: 'conflict' | 'denied' | 'failed' | 'pending' | 'unknown') {
  return parseToolResult('knowledge.search', {
    schemaVersion: 'tool-result@1',
    toolName: 'knowledge.search',
    callId: CALL_ID,
    status,
    retryable: status === 'pending' || status === 'unknown',
    data: null,
    receiptId: 'rcp_http_route_01',
    resourceVersion: null,
    error: { code: 'TEST_FAILURE', message: 'Safe failure', details: {} },
  })
}

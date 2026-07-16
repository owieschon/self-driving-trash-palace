import { createHash } from 'node:crypto'

import {
  DelegatedCredentialService,
  PersistentSessionService,
  SeededSessionService,
  type CredentialRepositoryPort,
  type CurrentAccessTokenRecord,
  type CurrentSessionRecord,
  type EntropyPort,
} from '@trash-palace/application'
import { MutableClock } from '@trash-palace/application/testing'
import {
  MembershipIdSchema,
  PrincipalSchema,
  parseToolResult,
  type MembershipId,
  type OrganizationId,
  type UserId,
} from '@trash-palace/core'
import { runMcpSmoke } from '@trash-palace/mcp/client'
import { createMcpPostHandler, type McpDispatcherPort } from '@trash-palace/mcp'
import { describe, expect, it, vi } from 'vitest'

import { DelegatedTokenResponseSchema } from './api-contracts.js'
import { SESSION_COOKIE_NAME } from './http-boundary.js'
import { createManagementRoutes } from './management-routes.js'

const NOW = '2026-08-14T05:00:00.000Z'
const ORIGIN = 'http://127.0.0.1'
const HOST = new URL(ORIGIN).host
const MISSION_ID = 'mis_lifecycle_01'
const MEMBERSHIP_ID = MembershipIdSchema.parse('mem_lifecycle_01')

const principal = PrincipalSchema.parse({
  organizationId: 'org_lifecycle_01',
  actorId: 'usr_lifecycle_01',
  role: 'owner',
  operatorGrants: [],
  delegatedPermissions: [],
})

describe('delegated MCP credential lifecycle', () => {
  it('issues through guarded HTTP, calls MCP, revokes through HTTP, and rejects replay', async () => {
    const clock = new MutableClock(new Date(NOW))
    const credentials = new MemoryCredentialRepository({
      organizationId: principal.organizationId,
      userId: principal.actorId,
      membershipId: MEMBERSHIP_ID,
    })
    const sessions = new PersistentSessionService(
      new SeededSessionService(
        'lifecycle-session-signing-key-at-least-32-bytes',
        clock,
        new SequenceEntropy([
          'lifecycle_session_entropy_1234567890',
          'lifecycle_csrf_entropy_123456789000',
        ]),
      ),
      credentials,
      clock,
    )
    const delegated = new DelegatedCredentialService(
      credentials,
      clock,
      new SequenceEntropy([
        'lifecycle_delegated_id_entropy_1234',
        'lifecycle_delegated_secret_entropy_1234567890',
      ]),
    )
    const browserSession = await sessions.issue({ principal, membershipId: MEMBERSHIP_ID })
    const management = createManagementRoutes({
      allowedOrigin: ORIGIN,
      sessions,
      delegatedCredentials: delegated,
      approvals: {
        decide: async () => {
          throw new Error('Approval is outside this credential lifecycle')
        },
      },
      humanTasks: {
        getMissionTasks: async () => {
          throw new Error('Mission tasks are outside this credential lifecycle')
        },
        getApproval: async () => {
          throw new Error('Approval task is outside this credential lifecycle')
        },
        getClarification: async () => {
          throw new Error('Clarification task is outside this credential lifecycle')
        },
      },
      clarifications: {
        answer: async () => {
          throw new Error('Clarification answer is outside this credential lifecycle')
        },
      },
      missions: {
        create: async () => {
          throw new Error('Mission bootstrap is outside this credential lifecycle')
        },
      },
      devBootstrap: { enabled: false },
    })

    const issueResponse = await management.issueDelegatedToken(
      browserJsonRequest(
        '/api/v1/auth/delegated-tokens',
        browserSession.signedCookie,
        browserSession.context.csrfToken,
        { scopes: ['knowledge:read'], expiresInSeconds: 900 },
      ),
    )
    const issuePayload: unknown = await issueResponse.json()
    if (!issueResponse.ok) {
      throw new Error(`Delegated token issue failed: ${JSON.stringify(issuePayload)}`)
    }
    const issued = DelegatedTokenResponseSchema.parse(issuePayload).token
    const invoke = vi.fn<McpDispatcherPort['invoke']>().mockImplementation(async (request) =>
      parseToolResult('knowledge.search', {
        schemaVersion: 'tool-result@1',
        toolName: 'knowledge.search',
        callId: request.callId,
        status: 'succeeded',
        retryable: false,
        data: { results: [] },
        receiptId: 'rcp_lifecycle_01',
        resourceVersion: null,
        error: null,
      }),
    )
    const mcp = createMcpPostHandler({
      allowedHosts: [HOST],
      authentication: { authenticateBearer: (value) => delegated.authenticate(value) },
      dispatcher: { invoke },
    })
    const mcpStatuses: number[] = []
    const smokeInput = {
      endpoint: `${ORIGIN}/api/mcp`,
      accessToken: issued.bearerToken,
      missionId: MISSION_ID,
      invoke: {
        toolName: 'knowledge.search' as const,
        input: { query: 'reconcile unknown outcomes', phase: 'reconcile' },
      },
      fetch: inProcessFetch(mcp, mcpStatuses),
    }

    const receipt = await runMcpSmoke(smokeInput)

    expect(issueResponse.status).toBe(201)
    expect(receipt).toMatchObject({
      schemaVersion: 'mcp-smoke-receipt@1',
      toolCount: 15,
      invokedTool: 'knowledge.search',
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(receipt)).not.toContain(issued.bearerToken)
    expect(JSON.stringify(receipt)).not.toContain('reconcile unknown outcomes')
    expect(credentials.serializedAccessTokenState()).not.toContain(issued.bearerToken)

    const revokeResponse = await management.revokeDelegatedToken(
      browserBodylessRequest(
        `/api/v1/auth/delegated-tokens/${issued.id}`,
        browserSession.signedCookie,
        browserSession.context.csrfToken,
      ),
      issued.id,
    )

    expect(revokeResponse.status).toBe(200)
    await expect(runMcpSmoke(smokeInput)).rejects.toThrow()
    expect(mcpStatuses.at(-1)).toBe(401)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

class SequenceEntropy implements EntropyPort {
  #index = 0

  public constructor(private readonly values: readonly string[]) {}

  public token(): string {
    const value = this.values[this.#index]
    if (value === undefined) throw new Error('Sequence entropy exhausted')
    this.#index += 1
    return value
  }
}

interface MembershipState {
  readonly organizationId: OrganizationId
  readonly userId: UserId
  readonly membershipId: MembershipId
}

interface StoredSession {
  readonly record: CurrentSessionRecord
  revoked: boolean
}

interface StoredAccessToken {
  readonly record: CurrentAccessTokenRecord
  revoked: boolean
}

class MemoryCredentialRepository implements CredentialRepositoryPort {
  readonly #sessions = new Map<string, StoredSession>()
  readonly #accessTokens = new Map<string, StoredAccessToken>()

  public constructor(private readonly membership: MembershipState) {}

  public issueSession(
    input: Parameters<CredentialRepositoryPort['issueSession']>[0],
  ): Promise<void> {
    this.#assertMembership(input.organizationId, input.userId, input.membershipId)
    this.#sessions.set(secretHash(input.signedToken), {
      revoked: false,
      record: {
        id: input.id,
        organizationId: input.organizationId,
        userId: input.userId,
        membershipId: input.membershipId,
        role: 'owner',
        grants: [],
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      },
    })
    return Promise.resolve()
  }

  public authenticateSession(
    signedToken: string,
    at: string,
  ): Promise<CurrentSessionRecord | null> {
    const stored = this.#sessions.get(secretHash(signedToken))
    return Promise.resolve(
      stored === undefined ||
        stored.revoked ||
        Date.parse(at) >= Date.parse(stored.record.expiresAt)
        ? null
        : structuredClone(stored.record),
    )
  }

  public rotateSession(): Promise<boolean> {
    return Promise.resolve(false)
  }

  public revokeSession(organizationId: OrganizationId, sessionId: string): Promise<boolean> {
    const stored = [...this.#sessions.values()].find(
      (candidate) =>
        candidate.record.organizationId === organizationId && candidate.record.id === sessionId,
    )
    if (stored === undefined || stored.revoked) return Promise.resolve(false)
    stored.revoked = true
    return Promise.resolve(true)
  }

  public issueAccessToken(
    input: Parameters<CredentialRepositoryPort['issueAccessToken']>[0],
  ): Promise<void> {
    this.#assertMembership(input.organizationId, input.issuedBy, this.membership.membershipId)
    this.#accessTokens.set(secretHash(input.bearerToken), {
      revoked: false,
      record: {
        id: input.id,
        organizationId: input.organizationId,
        issuedBy: input.issuedBy,
        scopes: [...input.scopes],
        expiresAt: input.expiresAt,
      },
    })
    return Promise.resolve()
  }

  public authenticateAccessToken(
    bearerToken: string,
    at: string,
  ): Promise<CurrentAccessTokenRecord | null> {
    const stored = this.#accessTokens.get(secretHash(bearerToken))
    return Promise.resolve(
      stored === undefined ||
        stored.revoked ||
        Date.parse(at) >= Date.parse(stored.record.expiresAt)
        ? null
        : structuredClone(stored.record),
    )
  }

  public revokeAccessToken(organizationId: OrganizationId, tokenId: string): Promise<boolean> {
    const stored = [...this.#accessTokens.values()].find(
      (candidate) =>
        candidate.record.organizationId === organizationId && candidate.record.id === tokenId,
    )
    if (stored === undefined || stored.revoked) return Promise.resolve(false)
    stored.revoked = true
    return Promise.resolve(true)
  }

  public serializedAccessTokenState(): string {
    return JSON.stringify([...this.#accessTokens.entries()])
  }

  #assertMembership(
    organizationId: OrganizationId,
    userId: UserId,
    membershipId: MembershipId,
  ): void {
    if (
      organizationId !== this.membership.organizationId ||
      userId !== this.membership.userId ||
      membershipId !== this.membership.membershipId
    ) {
      throw new Error('Credential fixture membership mismatch')
    }
  }
}

function secretHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function browserJsonRequest(
  path: string,
  signedCookie: string,
  csrfToken: string,
  body: unknown,
): Request {
  return new Request(new URL(path, ORIGIN), {
    method: 'POST',
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${signedCookie}`,
      host: HOST,
      origin: ORIGIN,
      'x-csrf-token': csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function browserBodylessRequest(path: string, signedCookie: string, csrfToken: string): Request {
  return new Request(new URL(path, ORIGIN), {
    method: 'DELETE',
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${signedCookie}`,
      host: HOST,
      origin: ORIGIN,
      'x-csrf-token': csrfToken,
    },
  })
}

function inProcessFetch(
  handler: ReturnType<typeof createMcpPostHandler>,
  statuses: number[],
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const headers = new Headers(request.headers)
    headers.set('host', new URL(request.url).host)
    const response = await handler(new Request(request, { headers }))
    statuses.push(response.status)
    return response
  }
}

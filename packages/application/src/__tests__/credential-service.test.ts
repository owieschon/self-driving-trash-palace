import { describe, expect, it } from 'vitest'

import {
  MembershipIdSchema,
  PrincipalSchema,
  type DelegatedPermission,
  type MembershipId,
  type OrganizationId,
  type UserId,
} from '@trash-palace/core'

import {
  DelegatedCredentialService,
  PersistentSessionService,
  type CredentialRepositoryPort,
  type CurrentAccessTokenRecord,
  type CurrentSessionRecord,
} from '../credential-service.js'
import { SeededSessionService } from '../session-service.js'
import type { EntropyPort } from '../ports.js'
import { MutableClock } from '../testing/fakes.js'
import { IDS, authContext, ownerPrincipal } from './fixtures.js'

const MEMBERSHIP_ID = MembershipIdSchema.parse('mem_owner000001')

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
  role: 'owner' | 'operator' | 'viewer'
  grants: 'routine:approve'[]
  revoked: boolean
}

interface StoredSession {
  record: CurrentSessionRecord
  signedToken: string
  revoked: boolean
}

interface StoredAccessToken {
  record: CurrentAccessTokenRecord
  bearerToken: string
  revoked: boolean
}

class MemoryCredentialRepository implements CredentialRepositoryPort {
  readonly sessions = new Map<string, StoredSession>()
  readonly accessTokens = new Map<string, StoredAccessToken>()
  readonly membership: MembershipState = {
    organizationId: IDS.organization,
    userId: IDS.owner,
    membershipId: MEMBERSHIP_ID,
    role: 'owner',
    grants: [],
    revoked: false,
  }
  sessionTouches = 0
  accessTokenTouches = 0
  failRotation = false

  public async issueSession(
    input: Parameters<CredentialRepositoryPort['issueSession']>[0],
  ): Promise<void> {
    if (!this.matchesMembership(input.organizationId, input.userId, input.membershipId)) {
      throw new Error('membership mismatch')
    }
    this.sessions.set(input.signedToken, {
      signedToken: input.signedToken,
      revoked: false,
      record: {
        id: input.id,
        organizationId: input.organizationId,
        userId: input.userId,
        membershipId: input.membershipId,
        role: this.membership.role,
        grants: this.membership.grants,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      },
    })
  }

  public authenticateSession(
    signedToken: string,
    at: string,
  ): Promise<CurrentSessionRecord | null> {
    const stored = this.sessions.get(signedToken)
    if (
      stored === undefined ||
      stored.revoked ||
      Date.parse(at) >= Date.parse(stored.record.expiresAt) ||
      !this.matchesMembership(
        stored.record.organizationId,
        stored.record.userId,
        stored.record.membershipId,
      )
    ) {
      return Promise.resolve(null)
    }
    this.sessionTouches += 1
    return Promise.resolve({
      ...stored.record,
      role: this.membership.role,
      grants: [...this.membership.grants],
    })
  }

  public async rotateSession(
    input: Parameters<CredentialRepositoryPort['rotateSession']>[0],
  ): Promise<boolean> {
    if (this.failRotation) return false
    const current = this.sessions.get(input.currentSignedToken)
    if (
      current === undefined ||
      current.revoked ||
      current.record.id !== input.currentSessionId ||
      current.record.organizationId !== input.organizationId ||
      current.record.userId !== input.userId ||
      current.record.membershipId !== input.membershipId ||
      Date.parse(input.rotatedAt) >= Date.parse(current.record.expiresAt) ||
      !this.matchesMembership(input.organizationId, input.userId, input.membershipId)
    ) {
      return false
    }
    current.revoked = true
    await this.issueSession({
      ...input.successor,
      organizationId: input.organizationId,
      userId: input.userId,
      membershipId: input.membershipId,
    })
    return true
  }

  public revokeSession(organizationId: OrganizationId, sessionId: string): Promise<boolean> {
    const stored = [...this.sessions.values()].find(
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
    if (
      this.membership.revoked ||
      input.organizationId !== this.membership.organizationId ||
      input.issuedBy !== this.membership.userId
    ) {
      throw new Error('issuer is not a current membership')
    }
    this.accessTokens.set(input.bearerToken, {
      bearerToken: input.bearerToken,
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
    const stored = this.accessTokens.get(bearerToken)
    if (
      stored === undefined ||
      stored.revoked ||
      this.membership.revoked ||
      stored.record.organizationId !== this.membership.organizationId ||
      stored.record.issuedBy !== this.membership.userId ||
      Date.parse(at) >= Date.parse(stored.record.expiresAt)
    ) {
      return Promise.resolve(null)
    }
    this.accessTokenTouches += 1
    return Promise.resolve(structuredClone(stored.record))
  }

  public revokeAccessToken(organizationId: OrganizationId, tokenId: string): Promise<boolean> {
    const stored = [...this.accessTokens.values()].find(
      (candidate) =>
        candidate.record.organizationId === organizationId && candidate.record.id === tokenId,
    )
    if (stored === undefined || stored.revoked) return Promise.resolve(false)
    stored.revoked = true
    return Promise.resolve(true)
  }

  private matchesMembership(
    organizationId: OrganizationId,
    userId: UserId,
    membershipId: MembershipId,
  ): boolean {
    return (
      !this.membership.revoked &&
      organizationId === this.membership.organizationId &&
      userId === this.membership.userId &&
      membershipId === this.membership.membershipId
    )
  }
}

function sessionHarness() {
  const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
  const repository = new MemoryCredentialRepository()
  const envelope = new SeededSessionService(
    'fixture-signing-key-with-at-least-thirty-two-bytes',
    clock,
    new SequenceEntropy([
      'first_session_entropy_1234567890',
      'first_csrf_entropy_123456789000',
      'second_session_entropy_123456789',
      'second_csrf_entropy_12345678900',
      'third_session_entropy_1234567890',
      'third_csrf_entropy_123456789000',
    ]),
  )
  return {
    clock,
    repository,
    service: new PersistentSessionService(envelope, repository, clock),
  }
}

describe('persistent browser sessions', () => {
  it('rebuilds authority from current membership and updates last-seen state', async () => {
    const harness = sessionHarness()
    const issued = await harness.service.issue({
      principal: ownerPrincipal,
      membershipId: MEMBERSHIP_ID,
      ttlMilliseconds: 10_000,
    })

    harness.repository.membership.role = 'viewer'
    const authenticated = await harness.service.authenticate(issued.signedCookie)

    expect(authenticated.principal).toMatchObject({ role: 'viewer', operatorGrants: [] })
    expect(harness.repository.sessionTouches).toBe(1)
    harness.repository.membership.revoked = true
    await expect(harness.service.authenticate(issued.signedCookie)).rejects.toThrow(
      /no longer current/,
    )
  })

  it('rotates atomically and rejects replay of the prior cookie', async () => {
    const harness = sessionHarness()
    const first = await harness.service.issue({
      principal: ownerPrincipal,
      membershipId: MEMBERSHIP_ID,
      ttlMilliseconds: 10_000,
    })
    harness.clock.advance(100)

    const second = await harness.service.rotate(first.signedCookie, 10_000)

    expect(second.signedCookie).not.toBe(first.signedCookie)
    await expect(harness.service.authenticate(first.signedCookie)).rejects.toThrow(
      /no longer current/,
    )
    await expect(harness.service.authenticate(second.signedCookie)).resolves.toMatchObject({
      principal: ownerPrincipal,
    })
  })

  it('leaves the current cookie valid when atomic rotation loses authority', async () => {
    const harness = sessionHarness()
    const first = await harness.service.issue({
      principal: ownerPrincipal,
      membershipId: MEMBERSHIP_ID,
      ttlMilliseconds: 10_000,
    })
    harness.repository.failRotation = true

    await expect(harness.service.rotate(first.signedCookie, 10_000)).rejects.toThrow(
      /lost current authority/,
    )
    await expect(harness.service.authenticate(first.signedCookie)).resolves.toMatchObject({
      principal: ownerPrincipal,
    })
    expect(harness.repository.sessions).toHaveLength(1)
  })

  it('revokes the current session and rejects cookie replay', async () => {
    const harness = sessionHarness()
    const issued = await harness.service.issue({
      principal: ownerPrincipal,
      membershipId: MEMBERSHIP_ID,
      ttlMilliseconds: 10_000,
    })

    await harness.service.revoke(issued.signedCookie)

    await expect(harness.service.authenticate(issued.signedCookie)).rejects.toThrow(
      /no longer current/,
    )
    await expect(harness.service.revoke(issued.signedCookie)).rejects.toThrow(/no longer current/)
  })

  it('rejects a database record that does not match the signed envelope', async () => {
    const harness = sessionHarness()
    const issued = await harness.service.issue({
      principal: ownerPrincipal,
      membershipId: MEMBERSHIP_ID,
      ttlMilliseconds: 10_000,
    })
    const stored = harness.repository.sessions.get(issued.signedCookie)
    if (stored === undefined) throw new Error('session fixture missing')
    stored.record = { ...stored.record, expiresAt: '2026-08-14T05:35:11.000Z' }

    await expect(harness.service.authenticate(issued.signedCookie)).rejects.toThrow(
      /does not match/,
    )
  })
})

describe('delegated MCP credentials', () => {
  it('issues a tenant-bound opaque secret once and rebuilds a scoped principal', async () => {
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const repository = new MemoryCredentialRepository()
    const service = new DelegatedCredentialService(
      repository,
      clock,
      new SequenceEntropy([
        'delegated_token_id_1234567890',
        'delegated_bearer_secret_12345678901234567890',
      ]),
    )

    const issued = await service.issue({
      issuer: authContext,
      scopes: ['routine:read', 'mission:cancel'],
      ttlMilliseconds: 10_000,
    })
    const delegated = await service.authenticate(issued.bearerToken)

    expect(issued.bearerToken).toMatch(/^tpc_/)
    expect(delegated).toMatchObject({
      tokenId: issued.tokenId,
      principal: {
        organizationId: IDS.organization,
        actorId: IDS.owner,
        role: 'delegated',
        delegatedPermissions: ['routine:read', 'mission:cancel'],
      },
    })
    expect(repository.accessTokenTouches).toBe(1)
  })

  it('rejects duplicate, approval, expired, malformed, and revoked-issuer authority', async () => {
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const repository = new MemoryCredentialRepository()
    const entropy = new SequenceEntropy([
      'delegated_token_id_1234567890',
      'delegated_bearer_secret_12345678901234567890',
      'second_token_id_1234567890000',
      'second_bearer_secret_123456789012345678900',
    ])
    const service = new DelegatedCredentialService(repository, clock, entropy)

    await expect(
      service.issue({ issuer: authContext, scopes: ['routine:read', 'routine:read'] }),
    ).rejects.toThrow(/unique/)
    await expect(
      service.issue({
        issuer: authContext,
        scopes: ['routine:approve'] as unknown as DelegatedPermission[],
      }),
    ).rejects.toThrow()

    const issued = await service.issue({
      issuer: authContext,
      scopes: ['routine:read'],
      ttlMilliseconds: 1_000,
    })
    const stored = repository.accessTokens.get(issued.bearerToken)
    if (stored === undefined) throw new Error('delegated token fixture missing')
    stored.record = {
      ...stored.record,
      scopes: ['routine:approve'] as unknown as DelegatedPermission[],
    }
    await expect(service.authenticate(issued.bearerToken)).rejects.toThrow()
    stored.record = { ...stored.record, scopes: ['routine:read'] }
    clock.advance(1_000)
    await expect(service.authenticate(issued.bearerToken)).rejects.toThrow(/not current/)
    clock.advance(-1_000)
    repository.membership.revoked = true
    await expect(service.authenticate(issued.bearerToken)).rejects.toThrow(/not current/)
  })

  it('does not let a non-owner mint delegated authority', async () => {
    const repository = new MemoryCredentialRepository()
    const service = new DelegatedCredentialService(repository)
    const viewerContext = {
      ...authContext,
      principal: PrincipalSchema.parse({
        ...authContext.principal,
        role: 'viewer',
      }),
    }

    await expect(
      service.issue({ issuer: viewerContext, scopes: ['routine:read'] }),
    ).rejects.toThrow(/Only an owner/)
    expect(repository.accessTokens).toHaveLength(0)
  })

  it('lets a current owner revoke one tenant token without revealing absent tokens', async () => {
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const repository = new MemoryCredentialRepository()
    const service = new DelegatedCredentialService(
      repository,
      clock,
      new SequenceEntropy([
        'delegated_token_id_1234567890',
        'delegated_bearer_secret_12345678901234567890',
      ]),
    )
    const issued = await service.issue({ issuer: authContext, scopes: ['routine:read'] })

    await expect(service.revoke({ issuer: authContext, tokenId: issued.tokenId })).resolves.toBe(
      true,
    )
    await expect(service.authenticate(issued.bearerToken)).rejects.toThrow(/not current/)
    await expect(service.revoke({ issuer: authContext, tokenId: issued.tokenId })).resolves.toBe(
      false,
    )
    await expect(service.revoke({ issuer: authContext, tokenId: 'tok_absent00001' })).resolves.toBe(
      false,
    )
  })
})

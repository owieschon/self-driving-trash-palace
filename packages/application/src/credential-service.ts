import {
  DelegatedPermissionSchema,
  IsoDateTimeSchema,
  MembershipIdSchema,
  OperatorGrantSchema,
  OrganizationIdSchema,
  PolicyViolationError,
  PrincipalSchema,
  UserIdSchema,
  type DelegatedPermission,
  type MembershipId,
  type OrganizationId,
  type UserId,
} from '@trash-palace/core'
import { z } from 'zod'

import { AuthenticationError } from './errors.js'
import type { AuthContext, DelegatedAuthContext } from './models.js'
import { CryptoEntropy, SYSTEM_CLOCK, iso } from './primitives.js'
import type { ClockPort, EntropyPort, SensitiveMutationGuardPort } from './ports.js'
import type { SeededSessionService } from './session-service.js'

const SessionRecordSchema = z
  .object({
    id: z.string().regex(/^session_[A-Za-z0-9_-]{20,}$/),
    organizationId: OrganizationIdSchema,
    userId: UserIdSchema,
    membershipId: MembershipIdSchema,
    role: z.enum(['owner', 'operator', 'viewer']),
    grants: z.array(OperatorGrantSchema),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .strict()

const AccessTokenRecordSchema = z
  .object({
    id: z.string().regex(/^tok_[a-z0-9][a-z0-9_-]{7,63}$/),
    organizationId: OrganizationIdSchema,
    issuedBy: UserIdSchema,
    scopes: z.array(DelegatedPermissionSchema).min(1),
    expiresAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (new Set(record.scopes).size !== record.scopes.length) {
      context.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'Delegated token scopes must be unique',
      })
    }
  })

export type CurrentSessionRecord = z.infer<typeof SessionRecordSchema>
export interface CurrentAccessTokenRecord {
  readonly id: string
  readonly organizationId: OrganizationId
  readonly issuedBy: UserId
  readonly scopes: readonly DelegatedPermission[]
  readonly expiresAt: string
}

export interface CredentialRepositoryPort {
  issueSession(input: {
    readonly id: string
    readonly organizationId: OrganizationId
    readonly userId: UserId
    readonly membershipId: MembershipId
    readonly signedToken: string
    readonly csrfSecret: string
    readonly createdAt: string
    readonly expiresAt: string
  }): Promise<void>
  authenticateSession(signedToken: string, at: string): Promise<CurrentSessionRecord | null>
  rotateSession(input: {
    readonly organizationId: OrganizationId
    readonly userId: UserId
    readonly membershipId: MembershipId
    readonly currentSessionId: string
    readonly currentSignedToken: string
    readonly successor: {
      readonly id: string
      readonly signedToken: string
      readonly csrfSecret: string
      readonly createdAt: string
      readonly expiresAt: string
    }
    readonly rotatedAt: string
  }): Promise<boolean>
  revokeSession(
    organizationId: OrganizationId,
    sessionId: string,
    revokedAt: string,
  ): Promise<boolean>
  issueAccessToken(input: {
    readonly id: string
    readonly organizationId: OrganizationId
    readonly issuedBy: UserId
    readonly bearerToken: string
    readonly scopes: readonly DelegatedPermission[]
    readonly createdAt: string
    readonly expiresAt: string
  }): Promise<void>
  authenticateAccessToken(bearerToken: string, at: string): Promise<CurrentAccessTokenRecord | null>
  revokeAccessToken(
    organizationId: OrganizationId,
    tokenId: string,
    revokedAt: string,
  ): Promise<boolean>
}

export interface IssuedSession {
  readonly signedCookie: string
  readonly context: AuthContext
}

export class PersistentSessionService implements SensitiveMutationGuardPort {
  public constructor(
    private readonly envelope: SeededSessionService,
    private readonly credentials: CredentialRepositoryPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
  ) {}

  public async issue(input: {
    readonly principal: AuthContext['principal']
    readonly membershipId: MembershipId
    readonly ttlMilliseconds?: number
  }): Promise<IssuedSession> {
    if (input.principal.role === 'service' || input.principal.role === 'delegated') {
      throw new PolicyViolationError('Browser sessions require a human membership')
    }
    const signedCookie = this.envelope.issue(input.principal, {
      ...(input.ttlMilliseconds === undefined ? {} : { ttlMilliseconds: input.ttlMilliseconds }),
    })
    const context = this.envelope.verify(signedCookie)
    await this.credentials.issueSession({
      id: context.sessionId,
      organizationId: context.principal.organizationId,
      userId: context.principal.actorId,
      membershipId: MembershipIdSchema.parse(input.membershipId),
      signedToken: signedCookie,
      csrfSecret: context.csrfToken,
      createdAt: context.issuedAt,
      expiresAt: context.expiresAt,
    })
    return { signedCookie, context }
  }

  public async authenticate(signedCookie: string): Promise<AuthContext> {
    return (await this.#authenticateCurrent(signedCookie)).context
  }

  public async rotate(signedCookie: string, ttlMilliseconds?: number): Promise<IssuedSession> {
    const current = await this.#authenticateCurrent(signedCookie)
    const successorCookie = this.envelope.issue(current.context.principal, {
      ...(ttlMilliseconds === undefined ? {} : { ttlMilliseconds }),
      authenticatedAt: this.clock.now(),
    })
    const successorContext = this.envelope.verify(successorCookie)
    const rotated = await this.credentials.rotateSession({
      organizationId: current.record.organizationId,
      userId: current.record.userId,
      membershipId: current.record.membershipId,
      currentSessionId: current.record.id,
      currentSignedToken: signedCookie,
      successor: {
        id: successorContext.sessionId,
        signedToken: successorCookie,
        csrfSecret: successorContext.csrfToken,
        createdAt: successorContext.issuedAt,
        expiresAt: successorContext.expiresAt,
      },
      rotatedAt: iso(this.clock.now()),
    })
    if (!rotated) throw new AuthenticationError('Session rotation lost current authority')
    return { signedCookie: successorCookie, context: successorContext }
  }

  public async revoke(signedCookie: string): Promise<void> {
    const current = await this.#authenticateCurrent(signedCookie)
    const revoked = await this.credentials.revokeSession(
      current.record.organizationId,
      current.record.id,
      iso(this.clock.now()),
    )
    if (!revoked) throw new AuthenticationError('Session revocation lost current authority')
  }

  public assert(input: {
    readonly context: AuthContext
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }): void {
    this.envelope.assert(input)
  }

  async #authenticateCurrent(
    signedCookie: string,
  ): Promise<{ readonly context: AuthContext; readonly record: CurrentSessionRecord }> {
    const envelopeContext = this.envelope.verify(signedCookie)
    const stored = await this.credentials.authenticateSession(signedCookie, iso(this.clock.now()))
    if (stored === null) throw new AuthenticationError('Session is no longer current')
    const record = SessionRecordSchema.parse({
      id: stored.id,
      organizationId: stored.organizationId,
      userId: stored.userId,
      membershipId: stored.membershipId,
      role: stored.role,
      grants: stored.grants,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    })
    if (
      record.id !== envelopeContext.sessionId ||
      record.organizationId !== envelopeContext.principal.organizationId ||
      record.userId !== envelopeContext.principal.actorId ||
      record.expiresAt !== envelopeContext.expiresAt
    ) {
      throw new AuthenticationError('Session state does not match its signed envelope')
    }
    const context: AuthContext = {
      ...envelopeContext,
      principal: PrincipalSchema.parse({
        organizationId: record.organizationId,
        actorId: record.userId,
        role: record.role,
        operatorGrants: record.role === 'operator' ? record.grants : [],
        delegatedPermissions: [],
      }),
    }
    return { context, record }
  }
}

export interface IssuedDelegatedCredential {
  readonly tokenId: string
  readonly bearerToken: string
  readonly scopes: readonly DelegatedPermission[]
  readonly expiresAt: string
}

export class DelegatedCredentialService {
  public constructor(
    private readonly credentials: CredentialRepositoryPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly entropy: EntropyPort = new CryptoEntropy(),
  ) {}

  public async issue(input: {
    readonly issuer: AuthContext
    readonly scopes: readonly DelegatedPermission[]
    readonly ttlMilliseconds?: number
  }): Promise<IssuedDelegatedCredential> {
    if (this.clock.now().getTime() >= Date.parse(input.issuer.expiresAt)) {
      throw new AuthenticationError('Credential issuer session has expired')
    }
    if (input.issuer.principal.role !== 'owner') {
      throw new PolicyViolationError('Only an owner may issue a delegated credential')
    }
    const scopes = AccessTokenRecordSchema.shape.scopes.parse(input.scopes)
    if (new Set(scopes).size !== scopes.length) {
      throw new PolicyViolationError('Delegated token scopes must be unique')
    }
    const ttlMilliseconds = input.ttlMilliseconds ?? 24 * 60 * 60 * 1_000
    if (
      !Number.isInteger(ttlMilliseconds) ||
      ttlMilliseconds <= 0 ||
      ttlMilliseconds > 30 * 24 * 60 * 60 * 1_000
    ) {
      throw new RangeError('Delegated credentials must expire within 30 days')
    }
    const createdAt = iso(this.clock.now())
    const expiresAt = iso(new Date(this.clock.now().getTime() + ttlMilliseconds))
    const tokenId = `tok_x${normalizeEntropy(this.entropy.token(18)).slice(0, 62)}`
    const bearerToken = `tpc_${this.entropy.token(32)}`
    await this.credentials.issueAccessToken({
      id: tokenId,
      organizationId: input.issuer.principal.organizationId,
      issuedBy: input.issuer.principal.actorId,
      bearerToken,
      scopes,
      createdAt,
      expiresAt,
    })
    return { tokenId, bearerToken, scopes, expiresAt }
  }

  public async authenticate(bearerToken: string): Promise<DelegatedAuthContext> {
    const stored = await this.credentials.authenticateAccessToken(
      bearerToken,
      iso(this.clock.now()),
    )
    if (stored === null) throw new AuthenticationError('Delegated credential is not current')
    const record = AccessTokenRecordSchema.parse({
      id: stored.id,
      organizationId: stored.organizationId,
      issuedBy: stored.issuedBy,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
    })
    if (this.clock.now().getTime() >= Date.parse(record.expiresAt)) {
      throw new AuthenticationError('Delegated credential has expired')
    }
    return {
      tokenId: record.id,
      expiresAt: record.expiresAt,
      principal: PrincipalSchema.parse({
        organizationId: record.organizationId,
        actorId: record.issuedBy,
        role: 'delegated',
        operatorGrants: [],
        delegatedPermissions: record.scopes,
      }),
    }
  }

  public revoke(input: {
    readonly issuer: AuthContext
    readonly tokenId: string
  }): Promise<boolean> {
    if (this.clock.now().getTime() >= Date.parse(input.issuer.expiresAt)) {
      throw new AuthenticationError('Credential issuer session has expired')
    }
    if (input.issuer.principal.role !== 'owner') {
      throw new PolicyViolationError('Only an owner may revoke a delegated credential')
    }
    const tokenId = AccessTokenRecordSchema.shape.id.parse(input.tokenId)
    return this.credentials.revokeAccessToken(
      input.issuer.principal.organizationId,
      tokenId,
      iso(this.clock.now()),
    )
  }
}

function normalizeEntropy(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, '_')
    .slice(0, 64)
  if (normalized.length < 8) throw new RangeError('Credential entropy did not produce an ID')
  return normalized
}

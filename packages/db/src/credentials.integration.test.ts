import { readFile, readdir } from 'node:fs/promises'

import { MembershipIdSchema, OrganizationIdSchema, UserIdSchema } from '@trash-palace/core'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabase, type Database } from './client.js'
import { hashSecret } from './crypto.js'
import { PgBootstrapRepository, PgCredentialRepository, createUnitOfWork } from './repositories.js'
import { accessTokens, memberships, sessions } from './schema.js'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip

const organizationId = OrganizationIdSchema.parse('org_credentialtenant')
const foreignOrganizationId = OrganizationIdSchema.parse('org_credentialmirror')
const userId = UserIdSchema.parse('usr_credentialowner')
const membershipId = MembershipIdSchema.parse('mem_credentialowner')
const revocableUserId = UserIdSchema.parse('usr_revocableuser')
const revocableMembershipId = MembershipIdSchema.parse('mem_revocablemember')

const createdAt = '2026-07-15T00:00:00.000Z'
const authenticatedAt = '2026-07-15T00:01:00.000Z'
const rotatedAt = '2026-07-15T00:02:00.000Z'
const afterRotation = '2026-07-15T00:03:00.000Z'
const revokedAt = '2026-07-15T00:04:00.000Z'
const afterRevocation = '2026-07-15T00:05:00.000Z'
const expiresAt = '2026-07-15T01:00:00.000Z'
const afterExpiry = '2026-07-15T01:00:00.000Z'

databaseDescribe('PostgreSQL credential repository', () => {
  let pool: pg.Pool
  let database: Database
  let credentials: PgCredentialRepository
  let schemaName: string

  beforeAll(async () => {
    schemaName = `trash_palace_credentials_${process.pid}_${Date.now()}`
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
      max: 1,
      options: `-c search_path=${schemaName},public`,
    })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await pool.query(`SET search_path TO "${schemaName}", public`)
    const migrationDirectory = new URL('../migrations/', import.meta.url)
    const filenames = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort()
    if (filenames.length === 0) throw new Error('Database migration is absent')
    for (const filename of filenames) {
      const migration = (await readFile(new URL(filename, migrationDirectory), 'utf8')).replaceAll(
        '"public".',
        `"${schemaName}".`,
      )
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await pool.query(statement)
      }
    }
    database = createDatabase(pool)
    credentials = new PgCredentialRepository(database)
    const bootstrap = new PgBootstrapRepository(database)
    await bootstrap.insertOrganization({
      id: organizationId,
      slug: 'credential-tenant',
      name: 'Credential Tenant',
      labTenant: true,
      createdAt,
    })
    await bootstrap.insertOrganization({
      id: foreignOrganizationId,
      slug: 'credential-mirror',
      name: 'Credential Mirror',
      labTenant: false,
      createdAt,
    })
    await bootstrap.insertUser({ id: userId, displayName: 'Credential Owner', createdAt })
    await bootstrap.insertUser({
      id: revocableUserId,
      displayName: 'Revocable User',
      createdAt,
    })
    const unitOfWork = createUnitOfWork(database)
    await unitOfWork.run(organizationId, async (repositories) => {
      await repositories.records.insertMembership({
        id: membershipId,
        organizationId,
        userId,
        role: 'owner',
        grants: [],
        createdAt,
        revokedAt: null,
      })
      await repositories.records.insertMembership({
        id: revocableMembershipId,
        organizationId,
        userId: revocableUserId,
        role: 'viewer',
        grants: [],
        createdAt,
        revokedAt: null,
      })
    })
  }, 30_000)

  afterAll(async () => {
    await pool.query('SET search_path TO public')
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  it('touches current membership sessions and rotates exactly once', async () => {
    const signedToken = 'signed-session-credential-value-0001'
    const csrfSecret = 'csrf-session-credential-value-000001'
    await credentials.issueSession({
      id: 'ses_credential_current',
      organizationId,
      userId,
      membershipId,
      signedToken,
      csrfSecret,
      createdAt,
      expiresAt,
    })
    await database
      .update(memberships)
      .set({ role: 'operator', grants: ['routine:approve'] })
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.id, membershipId)))

    expect(
      await credentials.authenticateSession('wrong-session-token-value', authenticatedAt),
    ).toBeNull()
    expect(
      await credentials.authenticateSession(signedToken, '2026-07-14T23:59:59.000Z'),
    ).toBeNull()
    expect(await credentials.authenticateSession(signedToken, afterExpiry)).toBeNull()
    expect(
      await credentials.findSessionById(
        foreignOrganizationId,
        'ses_credential_current',
        authenticatedAt,
      ),
    ).toBeNull()

    const authenticated = await credentials.authenticateSession(signedToken, authenticatedAt)
    expect(authenticated).toMatchObject({
      id: 'ses_credential_current',
      organizationId,
      userId,
      membershipId,
      role: 'operator',
      grants: ['routine:approve'],
      createdAt,
      expiresAt,
      lastSeenAt: authenticatedAt,
    })
    const [storedCurrent] = await database
      .select({
        tokenHash: sessions.tokenHash,
        csrfSecretHash: sessions.csrfSecretHash,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .where(eq(sessions.id, 'ses_credential_current'))
    expect(storedCurrent).toEqual({
      tokenHash: hashSecret(signedToken),
      csrfSecretHash: hashSecret(csrfSecret),
      lastSeenAt: new Date(authenticatedAt),
    })
    expect(storedCurrent?.tokenHash).not.toContain(signedToken)
    expect(storedCurrent?.csrfSecretHash).not.toContain(csrfSecret)

    const rotation = {
      organizationId,
      userId,
      membershipId,
      currentSessionId: 'ses_credential_current',
      currentSignedToken: signedToken,
      successor: {
        id: 'ses_credential_rotated',
        signedToken: 'signed-session-credential-value-0002',
        csrfSecret: 'csrf-session-credential-value-000002',
        createdAt: rotatedAt,
        expiresAt,
      },
      rotatedAt,
    } as const
    expect(
      await credentials.rotateSession({ ...rotation, organizationId: foreignOrganizationId }),
    ).toBe(false)
    expect(await credentials.rotateSession({ ...rotation, userId: revocableUserId })).toBe(false)
    expect(
      await credentials.rotateSession({ ...rotation, membershipId: revocableMembershipId }),
    ).toBe(false)
    expect(
      await credentials.rotateSession({ ...rotation, currentSignedToken: 'wrong-current-token' }),
    ).toBe(false)
    expect(await credentials.rotateSession(rotation)).toBe(true)
    expect(await credentials.rotateSession(rotation)).toBe(false)
    expect(await credentials.authenticateSession(signedToken, afterRotation)).toBeNull()
    expect(
      await credentials.authenticateSession(rotation.successor.signedToken, afterRotation),
    ).toMatchObject({
      id: rotation.successor.id,
      createdAt: rotatedAt,
      lastSeenAt: afterRotation,
    })

    await credentials.issueSession({
      id: 'ses_atomic_current',
      organizationId,
      userId,
      membershipId,
      signedToken: 'signed-session-atomic-current-0001',
      csrfSecret: 'csrf-session-atomic-current-000001',
      createdAt,
      expiresAt,
    })
    await expect(
      credentials.rotateSession({
        ...rotation,
        currentSessionId: 'ses_atomic_current',
        currentSignedToken: 'signed-session-atomic-current-0001',
      }),
    ).rejects.toThrow()
    expect(
      await credentials.authenticateSession('signed-session-atomic-current-0001', afterRotation),
    ).not.toBeNull()

    expect(await credentials.revokeSession(organizationId, rotation.successor.id, revokedAt)).toBe(
      true,
    )
    expect(
      await credentials.authenticateSession(rotation.successor.signedToken, afterRevocation),
    ).toBeNull()
    expect(
      await credentials.revokeSession(organizationId, rotation.successor.id, afterRevocation),
    ).toBe(false)
    await expect(
      credentials.issueSession({
        id: 'ses_foreign_membership',
        organizationId: foreignOrganizationId,
        userId,
        membershipId,
        signedToken: 'signed-session-foreign-value-0001',
        csrfSecret: 'csrf-session-foreign-value-000001',
        createdAt,
        expiresAt,
      }),
    ).rejects.toThrow(/not current in the tenant/)
  })

  it('allows only unique delegated scopes and records successful use', async () => {
    const bearerToken = 'delegated-bearer-credential-value-0001'
    await credentials.issueAccessToken({
      id: 'tok_credential_valid',
      organizationId,
      issuedBy: userId,
      bearerToken,
      scopes: ['routine:read', 'operation:reconcile'],
      createdAt,
      expiresAt,
    })
    expect(
      await credentials.authenticateAccessToken('wrong-bearer-token-value', authenticatedAt),
    ).toBeNull()
    expect(
      await credentials.authenticateAccessToken(bearerToken, '2026-07-14T23:59:59.000Z'),
    ).toBeNull()
    expect(await credentials.authenticateAccessToken(bearerToken, afterExpiry)).toBeNull()

    const authenticated = await credentials.authenticateAccessToken(bearerToken, authenticatedAt)
    expect(authenticated).toEqual({
      id: 'tok_credential_valid',
      organizationId,
      issuedBy: userId,
      scopes: ['routine:read', 'operation:reconcile'],
      createdAt,
      expiresAt,
      lastUsedAt: authenticatedAt,
    })
    const [stored] = await database
      .select({
        tokenHash: accessTokens.tokenHash,
        scopes: accessTokens.scopes,
        lastUsedAt: accessTokens.lastUsedAt,
      })
      .from(accessTokens)
      .where(eq(accessTokens.id, 'tok_credential_valid'))
    expect(stored).toEqual({
      tokenHash: hashSecret(bearerToken),
      scopes: ['routine:read', 'operation:reconcile'],
      lastUsedAt: new Date(authenticatedAt),
    })
    expect(stored?.tokenHash).not.toContain(bearerToken)

    for (const scopes of [
      [],
      ['routine:read', 'routine:read'],
      ['routine:approve'],
      ['not:a:permission'],
    ]) {
      await expect(
        credentials.issueAccessToken({
          id: `tok_invalid_${scopes.length}_${scopes.join('_')}`,
          organizationId,
          issuedBy: userId,
          bearerToken: `invalid-bearer-${scopes.join('-') || 'empty'}`,
          scopes: scopes as unknown as Parameters<
            PgCredentialRepository['issueAccessToken']
          >[0]['scopes'],
          createdAt,
          expiresAt,
        }),
      ).rejects.toThrow()
    }
    await expect(
      credentials.issueAccessToken({
        id: 'tok_foreign_issuer',
        organizationId: foreignOrganizationId,
        issuedBy: userId,
        bearerToken: 'foreign-bearer-credential-value-0001',
        scopes: ['routine:read'],
        createdAt,
        expiresAt,
      }),
    ).rejects.toThrow(/not a current tenant member/)

    await expect(
      pool.query(
        `INSERT INTO "${schemaName}"."access_tokens" (id, organization_id, issued_by, token_hash, scopes, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'tok_raw_approve',
          organizationId,
          userId,
          hashSecret('raw-approve-bearer-value'),
          ['routine:approve'],
          expiresAt,
          createdAt,
        ],
      ),
    ).rejects.toThrow(/access_tokens_scopes_delegated_only/)
    await expect(
      pool.query(
        `INSERT INTO "${schemaName}"."access_tokens" (id, organization_id, issued_by, token_hash, scopes, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'tok_raw_duplicate',
          organizationId,
          userId,
          hashSecret('raw-duplicate-bearer-value'),
          ['routine:read', 'routine:read'],
          expiresAt,
          createdAt,
        ],
      ),
    ).rejects.toThrow(/access_tokens_scopes_unique/)
    await expect(
      pool.query(
        `INSERT INTO "${schemaName}"."access_tokens" (id, organization_id, issued_by, token_hash, scopes, expires_at, created_at) VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
        [
          'tok_raw_null_issuer',
          organizationId,
          hashSecret('raw-null-issuer-bearer-value'),
          ['routine:read'],
          expiresAt,
          createdAt,
        ],
      ),
    ).rejects.toThrow(/not-null constraint/)

    await pool.query(
      `ALTER TABLE "${schemaName}"."access_tokens" DROP CONSTRAINT "access_tokens_scopes_delegated_only"`,
    )
    try {
      await pool.query(
        `UPDATE "${schemaName}"."access_tokens" SET scopes = ARRAY['routine:approve']::text[], last_used_at = NULL WHERE id = 'tok_credential_valid'`,
      )
      expect(await credentials.authenticateAccessToken(bearerToken, authenticatedAt)).toBeNull()
      const malformedUse = await pool.query<{ last_used_at: Date | null }>(
        `SELECT last_used_at FROM "${schemaName}"."access_tokens" WHERE id = 'tok_credential_valid'`,
      )
      expect(malformedUse.rows[0]?.last_used_at).toBeNull()
    } finally {
      await pool.query(
        `UPDATE "${schemaName}"."access_tokens" SET scopes = ARRAY['routine:read', 'operation:reconcile']::text[] WHERE id = 'tok_credential_valid'`,
      )
      await pool.query(
        `ALTER TABLE "${schemaName}"."access_tokens" ADD CONSTRAINT "access_tokens_scopes_delegated_only" CHECK (scopes <@ ARRAY['palace:read', 'crew:read', 'capability:read', 'routine:read', 'routine:draft', 'routine:validate', 'routine:simulate', 'routine:activate', 'recovery:propose', 'operation:reconcile', 'verification:read', 'knowledge:read', 'mission:cancel']::text[])`,
      )
    }

    expect(
      await credentials.revokeAccessToken(foreignOrganizationId, 'tok_credential_valid', revokedAt),
    ).toBe(false)
    expect(
      await credentials.revokeAccessToken(organizationId, 'tok_credential_valid', revokedAt),
    ).toBe(true)
    expect(await credentials.authenticateAccessToken(bearerToken, afterRevocation)).toBeNull()
  })

  it('invalidates sessions and delegated tokens when membership is revoked', async () => {
    const signedToken = 'signed-session-revocable-value-0001'
    const bearerToken = 'delegated-bearer-revocable-value-0001'
    await credentials.issueSession({
      id: 'ses_revocable_current',
      organizationId,
      userId: revocableUserId,
      membershipId: revocableMembershipId,
      signedToken,
      csrfSecret: 'csrf-session-revocable-value-000001',
      createdAt,
      expiresAt,
    })
    await credentials.issueAccessToken({
      id: 'tok_revocable_current',
      organizationId,
      issuedBy: revocableUserId,
      bearerToken,
      scopes: ['routine:read'],
      createdAt,
      expiresAt,
    })
    expect(await credentials.authenticateSession(signedToken, authenticatedAt)).not.toBeNull()
    expect(await credentials.authenticateAccessToken(bearerToken, authenticatedAt)).not.toBeNull()

    await database
      .update(memberships)
      .set({ revokedAt: new Date(revokedAt) })
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.id, revocableMembershipId),
        ),
      )
    expect(await credentials.authenticateSession(signedToken, afterRevocation)).toBeNull()
    expect(await credentials.authenticateAccessToken(bearerToken, afterRevocation)).toBeNull()
    expect(
      await credentials.rotateSession({
        organizationId,
        userId: revocableUserId,
        membershipId: revocableMembershipId,
        currentSessionId: 'ses_revocable_current',
        currentSignedToken: signedToken,
        successor: {
          id: 'ses_revocable_rotated',
          signedToken: 'signed-session-revocable-value-0002',
          csrfSecret: 'csrf-session-revocable-value-000002',
          createdAt: afterRevocation,
          expiresAt,
        },
        rotatedAt: afterRevocation,
      }),
    ).toBe(false)
    await expect(
      credentials.issueAccessToken({
        id: 'tok_revoked_issuer',
        organizationId,
        issuedBy: revocableUserId,
        bearerToken: 'delegated-bearer-revoked-issuer-0001',
        scopes: ['routine:read'],
        createdAt: afterRevocation,
        expiresAt,
      }),
    ).rejects.toThrow(/not a current tenant member/)
  })
})

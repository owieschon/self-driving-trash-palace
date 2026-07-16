import { readFile, readdir } from 'node:fs/promises'

import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  MembershipIdSchema,
  OrganizationIdSchema,
  PrincipalSchema,
  UserIdSchema,
} from '@trash-palace/core'
import {
  DelegatedCredentialService,
  PersistentSessionService,
  SeededSessionService,
  type ClockPort,
  type CredentialRepositoryPort,
  type EntropyPort,
} from '@trash-palace/application'
import {
  PgBootstrapRepository,
  PgCredentialRepository,
  createDatabase,
  createUnitOfWork,
  type Database,
} from '@trash-palace/db'
import { memberships } from '@trash-palace/db/schema'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip

const organizationId = OrganizationIdSchema.parse('org_appcredential')
const userId = UserIdSchema.parse('usr_appcredential')
const membershipId = MembershipIdSchema.parse('mem_appcredential')
const createdAt = '2026-07-15T02:00:00.000Z'

class MutableClock implements ClockPort {
  public constructor(private current: Date) {}

  public now(): Date {
    return new Date(this.current)
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds)
  }
}

class SequenceEntropy implements EntropyPort {
  #index = 0

  public constructor(private readonly values: readonly string[]) {}

  public token(): string {
    const value = this.values[this.#index]
    if (value === undefined) throw new Error('Credential integration entropy exhausted')
    this.#index += 1
    return value
  }
}

databaseDescribe('application credentials through the PostgreSQL adapter', () => {
  let pool: pg.Pool
  let database: Database
  let schemaName: string

  beforeAll(async () => {
    schemaName = `trash_palace_app_credentials_${process.pid}_${Date.now()}`
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1,
      options: `-c search_path=${schemaName},public`,
    })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await pool.query(`SET search_path TO "${schemaName}", public`)
    const migrationDirectory = new URL('../../db/migrations/', import.meta.url)
    const filenames = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort()
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
    const bootstrap = new PgBootstrapRepository(database)
    await bootstrap.insertOrganization({
      id: organizationId,
      slug: 'application-credential-tenant',
      name: 'Application Credential Tenant',
      labTenant: true,
      createdAt,
    })
    await bootstrap.insertUser({ id: userId, displayName: 'Rocky', createdAt })
    await createUnitOfWork(database).run(organizationId, (repositories) =>
      repositories.records.insertMembership({
        id: membershipId,
        organizationId,
        userId,
        role: 'owner',
        grants: [],
        createdAt,
        revokedAt: null,
      }),
    )
  }, 30_000)

  afterAll(async () => {
    await pool.query('SET search_path TO public')
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  it('authenticates, rotates, delegates, touches, and revokes through the real adapter', async () => {
    const clock = new MutableClock(new Date(createdAt))
    const postgresCredentials: CredentialRepositoryPort = new PgCredentialRepository(database)
    const envelope = new SeededSessionService(
      'credential-integration-signing-key-at-least-32-bytes',
      clock,
      new SequenceEntropy([
        'first_integration_session_1234567890',
        'first_integration_csrf_123456789000',
        'second_integration_session_123456789',
        'second_integration_csrf_12345678900',
      ]),
    )
    const sessions = new PersistentSessionService(envelope, postgresCredentials, clock)
    const principal = PrincipalSchema.parse({
      organizationId,
      actorId: userId,
      role: 'owner',
      operatorGrants: [],
      delegatedPermissions: [],
    })
    const first = await sessions.issue({
      principal,
      membershipId,
      ttlMilliseconds: 60_000,
    })

    await expect(sessions.authenticate(first.signedCookie)).resolves.toMatchObject({ principal })
    clock.advance(1_000)
    const second = await sessions.rotate(first.signedCookie, 60_000)
    await expect(sessions.authenticate(first.signedCookie)).rejects.toThrow(/no longer current/)
    const ownerContext = await sessions.authenticate(second.signedCookie)

    const delegatedCredentials = new DelegatedCredentialService(
      postgresCredentials,
      clock,
      new SequenceEntropy([
        'integration_delegated_id_123456789',
        'integration_delegated_secret_12345678901234567890',
      ]),
    )
    const delegated = await delegatedCredentials.issue({
      issuer: ownerContext,
      scopes: ['routine:read', 'mission:cancel'],
      ttlMilliseconds: 60_000,
    })
    await expect(delegatedCredentials.authenticate(delegated.bearerToken)).resolves.toMatchObject({
      tokenId: delegated.tokenId,
      principal: {
        organizationId,
        actorId: userId,
        role: 'delegated',
        delegatedPermissions: ['routine:read', 'mission:cancel'],
      },
    })

    await database
      .update(memberships)
      .set({ revokedAt: clock.now() })
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.id, membershipId)))
    await expect(sessions.authenticate(second.signedCookie)).rejects.toThrow(/no longer current/)
    await expect(delegatedCredentials.authenticate(delegated.bearerToken)).rejects.toThrow(
      /not current/,
    )
  })
})

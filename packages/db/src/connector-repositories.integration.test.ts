import { readFile, readdir } from 'node:fs/promises'

import { secret } from '@trash-palace/connectors'
import { OrganizationIdSchema } from '@trash-palace/core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabase, type Database } from './client.js'
import {
  PgConnectorCredentialVault,
  PgConnectorDeviceMappingRepository,
  PgConnectorOAuthStateStore,
} from './connector-repositories.js'
import { PgBootstrapRepository } from './repositories.js'
import { connectorCredentials, connectorDeviceCandidates } from './schema.js'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip
const tenantId = OrganizationIdSchema.parse('org_connectorprimary')
const otherTenantId = OrganizationIdSchema.parse('org_connectormirror')
const encryptionKey = Buffer.alloc(32, 7).toString('base64')

databaseDescribe('PostgreSQL connector repositories', () => {
  let pool: pg.Pool
  let database: Database
  let schemaName: string

  beforeAll(async () => {
    schemaName = `trash_palace_connector_${process.pid}_${Date.now()}`
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
      max: 1,
      options: `-c search_path=${schemaName},public`,
    })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await pool.query(`SET search_path TO "${schemaName}", public`)
    const migrationDirectory = new URL('../migrations/', import.meta.url)
    for (const filename of (await readdir(migrationDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort()) {
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
      id: tenantId,
      slug: 'connector-primary',
      name: 'Connector Primary',
      labTenant: true,
      createdAt: '2026-07-15T00:00:00.000Z',
    })
    await bootstrap.insertOrganization({
      id: otherTenantId,
      slug: 'connector-mirror',
      name: 'Connector Mirror',
      labTenant: true,
      createdAt: '2026-07-15T00:00:00.000Z',
    })
  }, 30_000)

  afterAll(async () => {
    await pool.query('SET search_path TO public')
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  it('consumes tenant-bound OAuth state exactly once', async () => {
    const store = new PgConnectorOAuthStateStore(database)
    const record = {
      tenantId,
      sessionBinding: 'a'.repeat(64),
      stateDigest: 'b'.repeat(64),
      redirectUri: 'https://example.test/connect/smartthings/callback',
      expiresAt: new Date('2026-07-15T00:10:00.000Z'),
    }
    await store.put(record)

    await expect(
      store.consume({
        ...record,
        tenantId: otherTenantId,
        now: new Date('2026-07-15T00:01:00.000Z'),
      }),
    ).resolves.toBeNull()
    await expect(
      store.consume({ ...record, now: new Date('2026-07-15T00:01:00.000Z') }),
    ).resolves.toEqual(record)
    await expect(
      store.consume({ ...record, now: new Date('2026-07-15T00:02:00.000Z') }),
    ).resolves.toBeNull()
  })

  it('encrypts, rotates under a row lock, scopes, and revokes SmartThings credentials', async () => {
    const vault = new PgConnectorCredentialVault(database, encryptionKey)
    const initial = {
      tenantId,
      provider: 'smartthings' as const,
      accessToken: secret('access-token-private-value-0001'),
      refreshToken: secret('refresh-token-private-value-0001'),
      installedAppId: secret('installed-app-private-value-0001'),
      accessTokenExpiresAt: new Date('2026-07-15T01:00:00.000Z'),
      scopes: ['r:devices:*', 'x:devices:*'],
    }
    await vault.create(initial)
    await expect(vault.load(otherTenantId)).resolves.toBeNull()
    await expect(vault.load(tenantId)).resolves.toMatchObject({ ...initial, revision: 1 })

    await expect(
      vault.withRefreshLock(tenantId, async () =>
        vault.replace(1, {
          ...initial,
          accessToken: secret('access-token-private-value-0002'),
          refreshToken: secret('refresh-token-private-value-0002'),
        }),
      ),
    ).resolves.toBe(true)
    await expect(vault.replace(1, initial)).resolves.toBe(false)
    await expect(vault.load(tenantId)).resolves.toMatchObject({ revision: 2 })

    const raw = await database.select().from(connectorCredentials)
    expect(JSON.stringify(raw)).not.toContain('private-value')
    await expect(
      vault.resolveInstallation(secret('installed-app-private-value-0001')),
    ).resolves.toEqual({ tenantId, status: 'active' })
    await expect(
      vault.revoke({ tenantId: otherTenantId, installedAppId: initial.installedAppId }),
    ).resolves.toBe(false)
    await expect(vault.revoke({ tenantId, installedAppId: initial.installedAppId })).resolves.toBe(
      true,
    )
    await expect(vault.load(tenantId)).resolves.toBeNull()
    await expect(
      vault.installationStatus({ tenantId, installedAppId: initial.installedAppId }),
    ).resolves.toBe('revoked')
  })

  it('projects opaque candidates into explicit tenant-scoped logical mappings', async () => {
    const mappings = new PgConnectorDeviceMappingRepository(database, encryptionKey)
    const providerDeviceId = secret('provider-device-private-value-001')
    const providerComponentId = secret('provider-component-private-value-001')
    const candidate = await mappings.recordCandidate({
      tenantId,
      provider: 'smartthings',
      providerDeviceId,
      providerComponentId,
      capabilities: ['lock.state'],
    })
    expect(candidate.candidateId).toMatch(/^stcand_[a-f0-9]{64}$/)
    await expect(
      mappings.getCandidate({
        tenantId: otherTenantId,
        provider: 'smartthings',
        candidateId: candidate.candidateId,
      }),
    ).resolves.toBeNull()

    const mapped = await mappings.mapCandidate({
      candidate,
      logicalDevice: {
        slotId: 'service-hatch',
        displayName: 'Exterior service hatch',
        kind: 'lock',
        capabilities: ['lock.state'],
      },
      confirmedBy: 'human',
    })
    expect(mapped).toMatchObject({ tenantId, slotId: 'service-hatch', kind: 'lock' })
    await expect(
      mappings.listByProviderDevice({
        tenantId: otherTenantId,
        provider: 'smartthings',
        providerDeviceId,
      }),
    ).resolves.toEqual([])
    await expect(
      mappings.listByProviderDevice({ tenantId, provider: 'smartthings', providerDeviceId }),
    ).resolves.toHaveLength(1)
    const raw = await database.select().from(connectorDeviceCandidates)
    expect(JSON.stringify(raw)).not.toContain('private-value')
  })
})

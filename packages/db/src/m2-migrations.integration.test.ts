import { readFile, readdir } from 'node:fs/promises'

import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip

const pools: pg.Pool[] = []

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()))
})

databaseDescribe('M2 migration compatibility', () => {
  it('builds the complete schema from an empty PostgreSQL database', async () => {
    const { pool, schemaName } = await migrationPool('fresh')
    await applyMigrations(pool, schemaName)

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schemaName],
    )
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'knowledge_sources',
        'tool_call_receipts',
        'tool_invocations',
        'tool_invocation_evidence',
        'context_runs',
        'context_artifacts',
      ]),
    )

    const triggers = await pool.query<{ trigger_name: string }>(
      `SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema = $1`,
      [schemaName],
    )
    expect(triggers.rows.map((row) => row.trigger_name)).toEqual(
      expect.arrayContaining([
        'context_runs_append_only',
        'context_artifacts_append_only',
        'tool_call_receipts_append_only',
        'tool_invocations_transition',
        'tool_invocation_evidence_guard',
      ]),
    )

    const bindingColumn = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tool_invocations' AND column_name = 'binding_hash'`,
      [schemaName],
    )
    expect(bindingColumn.rows).toEqual([{ is_nullable: 'NO' }])
    const reconciliationConstraint = await pool.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = $1 AND table_name = 'evidence' AND constraint_name = 'evidence_tool_invocation_reconciliation_shape'`,
      [schemaName],
    )
    expect(reconciliationConstraint.rows).toEqual([
      { constraint_name: 'evidence_tool_invocation_reconciliation_shape' },
    ])
    const evidenceTypes = await pool.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum item INNER JOIN pg_type kind ON kind.oid = item.enumtypid INNER JOIN pg_namespace namespace ON namespace.oid = kind.typnamespace WHERE namespace.nspname = $1 AND kind.typname = 'evidence_type'`,
      [schemaName],
    )
    expect(evidenceTypes.rows.map((row) => row.enumlabel)).toContain(
      'tool_invocation_reconciliation',
    )

    await dropSchema(pool, schemaName)
  }, 30_000)

  it('preserves an existing tenant while applying the M2 migrations', async () => {
    const { pool, schemaName } = await migrationPool('staged')
    await applyMigrations(
      pool,
      schemaName,
      (filename) => filename <= '0007_identity_telemetry_ingress.sql',
    )
    await pool.query(
      `INSERT INTO "${schemaName}"."organizations" (id, slug, name, lab_tenant, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [
        'org_m2migrationtenant',
        'm2-migration-tenant',
        'M2 Migration Tenant',
        true,
        '2026-07-15T00:00:00.000Z',
      ],
    )

    await applyMigrations(pool, schemaName, (filename) => filename >= '0008_redundant_zaran.sql')

    const retained = await pool.query<{
      id: string
      slug: string
      name: string
      lab_tenant: boolean
    }>(`SELECT id, slug, name, lab_tenant FROM "${schemaName}"."organizations" WHERE id = $1`, [
      'org_m2migrationtenant',
    ])
    expect(retained.rows).toEqual([
      {
        id: 'org_m2migrationtenant',
        slug: 'm2-migration-tenant',
        name: 'M2 Migration Tenant',
        lab_tenant: true,
      },
    ])
    await expect(
      pool.query(
        `INSERT INTO "${schemaName}"."knowledge_sources" (id, organization_id, version, title, content, canonical_uri, audiences, phases, risk, visibility, sensitivity, tenant_scoped, publishable, instruction_role, retention, source_hash, indexed_at) VALUES ($1, $2, '1.0.0', 'Retained tenant', 'Staged migration retained this tenant.', 'knowledge/staged.md', ARRAY['caretaker'], ARRAY['understand']::"${schemaName}".mission_phase[], 'read', 'tenant', 'internal', true, false, 'reference', 'versioned', $3, $4)`,
        [
          'tenant.staged-migration',
          'org_m2migrationtenant',
          'a'.repeat(64),
          '2026-07-15T00:01:00.000Z',
        ],
      ),
    ).resolves.toBeDefined()

    await dropSchema(pool, schemaName)
  }, 30_000)
})

async function migrationPool(label: string): Promise<{ pool: pg.Pool; schemaName: string }> {
  const schemaName = `trash_palace_m2_${label}_${process.pid}_${Date.now()}`
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL!,
    max: 1,
    options: `-c search_path=${schemaName},public`,
  })
  pools.push(pool)
  await pool.query(`CREATE SCHEMA "${schemaName}"`)
  return { pool, schemaName }
}

async function applyMigrations(
  pool: pg.Pool,
  schemaName: string,
  include: (filename: string) => boolean = () => true,
): Promise<void> {
  const migrationDirectory = new URL('../migrations/', import.meta.url)
  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => filename.endsWith('.sql') && include(filename))
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
}

async function dropSchema(pool: pg.Pool, schemaName: string): Promise<void> {
  await pool.query('SET search_path TO public')
  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
}

import { readFile, readdir } from 'node:fs/promises'

import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip
const pools: pg.Pool[] = []

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()))
})

databaseDescribe('M3 Caretaker migration compatibility', () => {
  it('creates the durable run ledger, guards, and exact budget constraints', async () => {
    const { pool, schemaName } = await migrationPool('fresh')
    await applyMigrations(pool, schemaName)

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'caretaker_%' ORDER BY table_name`,
      [schemaName],
    )
    expect(tables.rows).toEqual([
      { table_name: 'caretaker_run_checkpoints' },
      { table_name: 'caretaker_runs' },
      { table_name: 'caretaker_terminal_evidence_deliveries' },
    ])
    const triggers = await pool.query<{ trigger_name: string }>(
      `SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema = $1 AND (event_object_table IN ('caretaker_runs', 'caretaker_run_checkpoints', 'caretaker_terminal_evidence_deliveries') OR trigger_name LIKE 'missions_task_ledger%') ORDER BY trigger_name`,
      [schemaName],
    )
    expect(triggers.rows.map((row) => row.trigger_name)).toEqual(
      expect.arrayContaining([
        'caretaker_run_checkpoints_append_only',
        'caretaker_run_checkpoints_validate',
        'caretaker_evidence_profile_immutable_guard',
        'caretaker_checkpoints_run_consistency',
        'caretaker_runs_checkpoint_consistency',
        'caretaker_runs_guard',
        'caretaker_runs_validate_insert',
        'caretaker_terminal_evidence_guard_trigger',
        'missions_task_ledger_checkpoint',
        'missions_task_ledger_guard',
      ]),
    )
    const constraints = await pool.query<{ conname: string; definition: string }>(
      `SELECT constraints.constraint_name AS conname, pg_get_constraintdef(pg_constraint.oid) AS definition
       FROM information_schema.table_constraints AS constraints
       INNER JOIN pg_constraint ON pg_constraint.conname = constraints.constraint_name
       INNER JOIN pg_namespace ON pg_namespace.oid = pg_constraint.connamespace AND pg_namespace.nspname = constraints.constraint_schema
       WHERE constraints.table_schema = $1 AND constraints.table_name = 'caretaker_runs'
       ORDER BY constraints.constraint_name`,
      [schemaName],
    )
    const definitions = Object.fromEntries(
      constraints.rows.map(({ conname, definition }) => [conname, definition]),
    )
    expect(definitions.caretaker_runs_tool_call_budget).toContain('tool_call_count <= 24')
    expect(definitions.caretaker_runs_plan_revision_budget).toContain('plan_revision_count <= 3')
    expect(definitions.caretaker_runs_clarification_pause_budget).toContain(
      'clarification_pause_count <= 2',
    )
    expect(definitions.caretaker_runs_reconciliation_poll_budget).toContain(
      'reconciliation_poll_count <= 3',
    )
    expect(definitions.caretaker_runs_active_runtime_budget).toContain(
      'active_runtime_milliseconds <= 300000',
    )
    expect(definitions.caretaker_runs_pending_tool_call_valid).toContain(
      'caretaker_pending_tool_call_is_valid(pending_tool_call)',
    )
    const pendingColumns = await pool.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ('caretaker_runs', 'caretaker_run_checkpoints') AND column_name = 'pending_tool_call' ORDER BY table_name`,
      [schemaName],
    )
    expect(pendingColumns.rows).toEqual([
      { table_name: 'caretaker_run_checkpoints', is_nullable: 'YES' },
      { table_name: 'caretaker_runs', is_nullable: 'YES' },
    ])
    const profileColumn = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'caretaker_runs' AND column_name = 'evidence_profile'`,
      [schemaName],
    )
    expect(profileColumn.rows).toEqual([{ is_nullable: 'NO' }])

    await dropSchema(pool, schemaName)
  }, 30_000)

  it('retains an existing mission ledger while applying the Caretaker migration', async () => {
    const { pool, schemaName } = await migrationPool('staged')
    await applyMigrations(pool, schemaName, (filename) => filename < '0013_kind_miss_america.sql')
    const taskLedger = [
      {
        id: 'inspect_state',
        label: 'Inspect the current palace state',
        status: 'in_progress',
        evidenceRefs: [],
      },
    ]
    await seedMissionBeforeM3(pool, schemaName, taskLedger)

    await applyMigrations(pool, schemaName, (filename) => filename >= '0013_kind_miss_america.sql')

    const retained = await pool.query<{
      task_ledger: unknown
      task_ledger_version: number
      run_id: string | null
    }>(
      `SELECT task_ledger, task_ledger_version, run_id FROM "${schemaName}"."missions" WHERE id = $1`,
      ['mis_m3migrationstate'],
    )
    expect(retained.rows).toEqual([
      { task_ledger: taskLedger, task_ledger_version: 0, run_id: null },
    ])
    const rows = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM "${schemaName}"."caretaker_runs"`,
    )
    expect(rows.rows).toEqual([{ count: 0 }])

    await dropSchema(pool, schemaName)
  }, 30_000)
})

async function seedMissionBeforeM3(
  pool: pg.Pool,
  schemaName: string,
  taskLedger: readonly unknown[],
): Promise<void> {
  const createdAt = '2026-07-15T00:00:00.000Z'
  await pool.query(
    `INSERT INTO "${schemaName}"."organizations" (id, slug, name, lab_tenant, created_at) VALUES ($1, $2, $3, true, $4)`,
    ['org_m3migrationtenant', 'm3-migration-tenant', 'M3 Migration Tenant', createdAt],
  )
  await pool.query(
    `INSERT INTO "${schemaName}"."users" (id, display_name, created_at) VALUES ($1, $2, $3)`,
    ['usr_m3migrationowner', 'Rocky', createdAt],
  )
  await pool.query(
    `INSERT INTO "${schemaName}"."memberships" (id, organization_id, user_id, role, grants, revoked_at, created_at) VALUES ($1, $2, $3, 'owner', ARRAY[]::text[], NULL, $4)`,
    ['mem_m3migrationowner', 'org_m3migrationtenant', 'usr_m3migrationowner', createdAt],
  )
  await pool.query(
    `INSERT INTO "${schemaName}"."palaces" (id, organization_id, name, timezone, battery_available_percentage, record_version, created_at) VALUES ($1, $2, $3, $4, 80, 1, $5)`,
    [
      'pal_m3migrationhome',
      'org_m3migrationtenant',
      'Migration Palace',
      'America/New_York',
      createdAt,
    ],
  )
  await pool.query(
    `INSERT INTO "${schemaName}"."missions" (id, organization_id, palace_id, initiated_by, objective, constraints, success_criteria_ids, status, phase, version, run_id, context_receipt_id, task_ledger, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::text[], 'running', 'understand', 1, NULL, NULL, $8::jsonb, $9, $9)`,
    [
      'mis_m3migrationstate',
      'org_m3migrationtenant',
      'pal_m3migrationhome',
      'usr_m3migrationowner',
      'Retain structured Caretaker state',
      JSON.stringify({
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      }),
      ['single_durable_run'],
      JSON.stringify(taskLedger),
      createdAt,
    ],
  )
}

async function migrationPool(label: string): Promise<{ pool: pg.Pool; schemaName: string }> {
  const schemaName = `trash_palace_m3_${label}_${process.pid}_${Date.now()}`
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

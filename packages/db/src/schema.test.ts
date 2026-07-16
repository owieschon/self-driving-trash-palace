import { readFile, readdir } from 'node:fs/promises'

import { OrganizationIdSchema } from '@trash-palace/core'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { describe, expect, it } from 'vitest'

import * as schema from './schema.js'
import { createDatabaseId, hashCanonical, hashSecret } from './crypto.js'

async function migrationSql(): Promise<string> {
  const directory = new URL('../migrations/', import.meta.url)
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()
  expect(files.length).toBeGreaterThan(0)
  return (await Promise.all(files.map((file) => readFile(new URL(file, directory), 'utf8')))).join(
    '\n',
  )
}

describe('M1 database contract', () => {
  it('generates tenant predicates with bound parameters', () => {
    const database = drizzle.mock({ schema })
    const organizationId = OrganizationIdSchema.parse('org_primarytenant')
    const query = database
      .select()
      .from(schema.operations)
      .where(
        and(
          eq(schema.operations.organizationId, organizationId),
          eq(schema.operations.id, 'op_operation0001'),
        ),
      )
      .toSQL()

    expect(query.sql).toContain('"operations"."organization_id" = $1')
    expect(query.params).toEqual([organizationId, 'op_operation0001'])
  })

  it('migrates every durable M1 record and service-owned checkpoint record', async () => {
    const migration = await migrationSql()
    for (const table of [
      'organizations',
      'users',
      'memberships',
      'sessions',
      'access_tokens',
      'palaces',
      'crew_members',
      'crew_schedules',
      'crew_preferences',
      'identity_tags',
      'devices',
      'capabilities',
      'routines',
      'routine_versions',
      'missions',
      'mission_events',
      'mission_leases',
      'caretaker_runs',
      'caretaker_run_checkpoints',
      'plans',
      'plan_actions',
      'plan_validations',
      'plan_simulations',
      'approvals',
      'operations',
      'attempts',
      'reconciliation_polls',
      'cancellations',
      'compensating_plan_links',
      'outbox_messages',
      'gateway_commands',
      'gateway_callbacks',
      'executions',
      'evidence',
      'verifications',
      'context_receipts',
      'audit_events',
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`)
    }
  })

  it('encodes tenant, approval, operation, lifecycle, and append-only invariants', async () => {
    const migration = await migrationSql()
    for (const receipt of [
      'sessions_membership_tenant_fk',
      'sessions_lifecycle_timestamps_valid',
      'access_tokens_scopes_delegated_only',
      'access_tokens_scopes_unique',
      'operations_approved_action_tenant_fk',
      'operations_plan_action_unique',
      'operations_server_created',
      'routines_active_version_tenant_fk',
      'routine_versions_source_plan_tenant_fk',
      'crew_schedules_crew_palace_tenant_fk',
      'crew_preferences_crew_palace_tenant_fk',
      'crew_schedules_windows_valid',
      'crew_preferences_lighting_intensity_range',
      'gateway_callbacks_nonce_unique',
      'executions_operation_unique',
      'mission_leases_epoch_positive',
      'mission_leases_release_valid',
      'approvals_approved_fields',
      'operations_committed_fields',
      'attempts_error_required',
      'executions_completion_valid',
      'mission_events_append_only',
      'caretaker_run_checkpoints_append_only',
      'caretaker_run_checkpoints_validate',
      'caretaker_checkpoints_run_consistency',
      'caretaker_runs_checkpoint_consistency',
      'caretaker_runs_guard',
      'caretaker_runs_validate_insert',
      'missions_task_ledger_checkpoint',
      'missions_task_ledger_guard',
      'audit_events_append_only',
      'plans_guard',
      'operations_guard',
      'caretaker_runs_tool_call_budget',
      'caretaker_runs_plan_revision_budget',
      'caretaker_runs_clarification_pause_budget',
      'caretaker_runs_reconciliation_poll_budget',
      'caretaker_runs_active_runtime_budget',
      'caretaker_runs_pending_tool_call_valid',
      'caretaker_run_checkpoints_pending_tool_call_valid',
      'caretaker_pending_tool_call_is_valid',
      'caretaker_canonical_json',
    ]) {
      expect(migration).toContain(receipt)
    }
    expect(migration).toContain("'cancel_reconciliation_required'")
    expect(migration).toContain("'cancel_reconciliation_completed'")
    expect(migration).toContain("'gateway_delivery'")
    expect(migration).toContain('CREATE FUNCTION text_array_is_unique')
    expect(migration).toContain('ALTER COLUMN "issued_by" SET NOT NULL')
    const delegatedScopeConstraint =
      /ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_scopes_delegated_only"[^;]+;/.exec(
        migration,
      )?.[0]
    expect(delegatedScopeConstraint).toBeDefined()
    expect(delegatedScopeConstraint).not.toContain('routine:approve')
  })

  it('creates lowercase server identifiers and never exposes a raw secret digest input', () => {
    expect(createDatabaseId('op')).toMatch(/^op_[a-f0-9]{32}$/)
    expect(hashSecret('fixture-secret-that-is-long-enough')).toMatch(/^[a-f0-9]{64}$/)
    expect(hashCanonical({ b: 2, a: 1 })).toBe(hashCanonical({ a: 1, b: 2 }))
  })

  it('invalidates legacy leases while replacing raw tokens with retained fingerprints', async () => {
    const migration = await readFile(
      new URL('../migrations/0003_lease_fencing.sql', import.meta.url),
      'utf8',
    )
    expect(migration).toContain("encode(sha256(convert_to(\"token\", 'UTF8')), 'hex')")
    expect(migration).toContain('"released_at" = clock_timestamp()')
    expect(migration).toContain('DROP COLUMN "token"')
    expect(schema.missionLeases.tokenFingerprint).toBeDefined()
    expect('token' in schema.missionLeases).toBe(false)
  })
})

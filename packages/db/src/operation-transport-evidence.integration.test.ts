import { readFile, readdir } from 'node:fs/promises'

import {
  MissionSchema,
  MembershipIdSchema,
  PersistedEvidenceRecordSchema,
  ReceiptIdSchema,
  Sha256Schema,
  TOOL_REGISTRY_HASH,
  ToolCallIdSchema,
  ToolCallReceiptSchema,
  ToolTenantScopeHashSchema,
  UserIdSchema,
  hashToolResultSchema,
  hashToolValue,
  projectToolSchema,
  type AttemptId,
  type EvidenceId,
  type MissionId,
  type OperationId,
  type OrganizationId,
  type PalaceId,
} from '@trash-palace/core'
import { OpaqueToolInvocationClaimToken } from '@trash-palace/application'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabase, type Database } from './client.js'
import {
  PgBootstrapRepository,
  PgToolCallReceiptRepository,
  PgToolInvocationLedger,
  createUnitOfWork,
} from './repositories.js'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip

const NOW = '2026-07-15T00:00:00.000Z'
const COMMITTED_AT = '2026-07-15T00:00:01.000Z'
const CLAIMED_AT = '2026-07-15T00:00:02.000Z'
const CLAIM_EXPIRES_AT = '2026-07-15T00:01:02.000Z'
const LOST_AT = '2026-07-15T00:00:03.000Z'
const TENANT_SCOPE_HASH = ToolTenantScopeHashSchema.parse('7'.repeat(64))
const USER_ID = UserIdSchema.parse('usr_transport_owner')

interface TenantFixture {
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly palaceId: PalaceId
  readonly operationId: OperationId
}

interface ClaimedInvocation {
  readonly fixture: TenantFixture
  readonly callId: ReturnType<typeof ToolCallIdSchema.parse>
  readonly ownerToken: OpaqueToolInvocationClaimToken
  readonly claim: Extract<Awaited<ReturnType<PgToolInvocationLedger['claim']>>, { kind: 'claimed' }>
  readonly ledger: PgToolInvocationLedger
}

databaseDescribe('application response-loss PostgreSQL contract', () => {
  let pool: pg.Pool
  let database: Database
  let schemaName: string
  let primary: TenantFixture
  let mirror: TenantFixture
  let attemptSequence = 0

  beforeAll(async () => {
    schemaName = `trash_palace_operation_transport_${process.pid}_${Date.now()}`
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
      max: 5,
      options: `-c search_path=${schemaName},public`,
    })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await pool.query(`SET search_path TO "${schemaName}", public`)
    await applyMigrations(pool, schemaName)
    database = createDatabase(pool)
    const bootstrap = new PgBootstrapRepository(database)
    await bootstrap.insertUser({
      id: USER_ID,
      displayName: 'Rocky',
      createdAt: NOW,
    })
    primary = await seedTenant(database, pool, bootstrap, 'transport_primary')
    mirror = await seedTenant(database, pool, bootstrap, 'transport_mirror')
  }, 30_000)

  afterAll(async () => {
    await pool.query('SET search_path TO public')
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  async function insertUnknownAttempt(fixture: TenantFixture, suffix: string): Promise<AttemptId> {
    attemptSequence += 1
    const attemptId = `att_${suffix}` as AttemptId
    await pool.query(
      `INSERT INTO "${schemaName}"."attempts" (id, organization_id, operation_id, sequence, transport, status, retryable, error_code, error_message, started_at, completed_at)
       VALUES ($1, $2, $3, $4, 'worker', 'unknown', true, 'APPLICATION_RESPONSE_LOST', 'The committed response was lost', $5, $5)`,
      [attemptId, fixture.organizationId, fixture.operationId, attemptSequence, LOST_AT],
    )
    return attemptId
  }

  async function claimInvocation(
    fixture: TenantFixture,
    suffix: string,
  ): Promise<ClaimedInvocation> {
    const callId = ToolCallIdSchema.parse(`call_${suffix}`)
    const contract = projectToolSchema('plans.activate')
    const ownerToken = OpaqueToolInvocationClaimToken.fromEntropy(`owner-token-${suffix}`)
    const ledger = new PgToolInvocationLedger(database, fixture.organizationId)
    const claim = await ledger.claim({
      organizationId: fixture.organizationId,
      missionId: fixture.missionId,
      callId,
      toolName: 'plans.activate',
      channel: 'mcp',
      inputHash: hashToolValue({
        planId: `pln_${fixture.organizationId.slice(4)}`,
        actionId: `act_${fixture.organizationId.slice(4)}`,
        expectedVersion: 1,
      }),
      principalScopeHash: Sha256Schema.parse('8'.repeat(64)),
      toolContractHash: contract.contractHash,
      toolRegistryHash: TOOL_REGISTRY_HASH,
      resultSchemaHash: hashToolResultSchema('plans.activate'),
      executionClass: 'consequential',
      proposedReceiptId: ReceiptIdSchema.parse(`rcp_${suffix}`),
      ownerToken,
      startedAt: CLAIMED_AT,
      claimExpiresAt: CLAIM_EXPIRES_AT,
    })
    if (claim.kind !== 'claimed') throw new Error('Fixture invocation was not claimed')
    return { fixture, callId, ownerToken, claim, ledger }
  }

  async function persistTransportEvidence(input: {
    readonly invocation: ClaimedInvocation
    readonly attemptId: AttemptId
    readonly suffix: string
    readonly operationId?: OperationId
    readonly toolCallId?: ReturnType<typeof ToolCallIdSchema.parse>
  }): Promise<EvidenceId> {
    const evidenceId = `evd_${input.suffix}` as EvidenceId
    const operationId = input.operationId ?? input.invocation.fixture.operationId
    const toolCallId = input.toolCallId ?? input.invocation.callId
    const record = PersistedEvidenceRecordSchema.parse({
      schemaVersion: 'persisted-evidence@1',
      evidence: {
        id: evidenceId,
        organizationId: input.invocation.fixture.organizationId,
        missionId: input.invocation.fixture.missionId,
        palaceId: input.invocation.fixture.palaceId,
        observedAt: LOST_AT,
        type: 'operation_transport',
        operationId,
        attemptId: input.attemptId,
        toolCallId,
        transport: 'worker',
        status: 'unknown',
        operationCommitted: true,
        errorCode: 'APPLICATION_RESPONSE_LOST',
      },
      authorityReceipt: {
        schemaVersion: 'evidence-authority-receipt@1',
        id: `rcp_evidence_${input.suffix}`,
        evidenceId,
        organizationId: input.invocation.fixture.organizationId,
        missionId: input.invocation.fixture.missionId,
        palaceId: input.invocation.fixture.palaceId,
        verifiedAt: LOST_AT,
        authority: 'application',
        producer: 'application_code',
        ruleId: 'operation.application_response_lost',
        ruleVersion: 1,
        inputEvidenceIds: [],
        derivationVerified: true,
      },
      persistedAt: LOST_AT,
    })
    await createUnitOfWork(database).run(
      input.invocation.fixture.organizationId,
      async (repositories) => repositories.evidence.appendMany([record]),
    )
    return evidenceId
  }

  function unknownResult(invocation: ClaimedInvocation) {
    return {
      schemaVersion: 'tool-result@1' as const,
      toolName: 'plans.activate' as const,
      callId: invocation.callId,
      status: 'unknown' as const,
      data: null,
      error: {
        code: 'APPLICATION_RESPONSE_LOST',
        message: 'The operation committed, but the application response was lost',
        details: {},
      },
      retryable: false,
      receiptId: invocation.claim.invocation.receiptId,
      resourceVersion: null,
    }
  }

  async function completeInvocation(
    invocation: ClaimedInvocation,
    attemptId: AttemptId | null,
    evidenceIds: readonly EvidenceId[],
  ) {
    const result = unknownResult(invocation)
    return invocation.ledger.complete({
      organizationId: invocation.fixture.organizationId,
      callId: invocation.callId,
      generation: invocation.claim.invocation.generation,
      ownerToken: invocation.ownerToken,
      result,
      resultHash: hashToolValue(result),
      attemptId,
      evidenceIds,
      completedAt: LOST_AT,
    })
  }

  it('commits and receipts one exact response-loss binding', async () => {
    const invocation = await claimInvocation(primary, 'response_loss_happy')
    const attemptId = await insertUnknownAttempt(primary, 'response_loss_happy')
    const evidenceId = await persistTransportEvidence({
      invocation,
      attemptId,
      suffix: 'response_loss_happy',
    })
    const completion = await completeInvocation(invocation, attemptId, [evidenceId])
    expect(completion.kind).toBe('completed')
    if (completion.kind !== 'completed') throw new Error('Fixture invocation did not complete')

    const receipt = ToolCallReceiptSchema.parse({
      schemaVersion: 'tool-call-receipt@1',
      id: completion.invocation.receiptId,
      callId: completion.invocation.callId,
      toolName: completion.invocation.toolName,
      status: 'unknown',
      channel: completion.invocation.channel,
      tenantScopeHash: TENANT_SCOPE_HASH,
      inputHash: completion.invocation.inputHash,
      resultHash: completion.invocation.resultHash,
      toolContractHash: completion.invocation.toolContractHash,
      toolRegistryHash: completion.invocation.toolRegistryHash,
      attemptId,
      evidenceIds: [evidenceId],
      startedAt: completion.invocation.startedAt,
      completedAt: completion.invocation.completedAt,
    })
    const receipts = new PgToolCallReceiptRepository(
      database,
      primary.organizationId,
      TENANT_SCOPE_HASH,
    )
    await receipts.append(receipt)
    expect(await receipts.get(receipt.id)).toEqual(receipt)

    const stored = await pool.query<{
      invocation_links: string
      receipt_links: string
    }>(
      `SELECT
         (SELECT count(*) FROM "${schemaName}"."tool_invocation_evidence" WHERE organization_id = $1 AND call_id = $2)::text AS invocation_links,
         (SELECT count(*) FROM "${schemaName}"."tool_call_receipt_evidence" WHERE organization_id = $1 AND receipt_id = $3)::text AS receipt_links`,
      [primary.organizationId, invocation.callId, receipt.id],
    )
    expect(stored.rows[0]).toEqual({ invocation_links: '1', receipt_links: '1' })

    const forgedReceipt = ToolCallReceiptSchema.parse({
      ...receipt,
      id: 'rcp_response_loss_forged',
      callId: 'call_response_loss_forged',
    })
    await expect(receipts.append(forgedReceipt)).rejects.toThrow(/completed invocation/)
    expect(await receipts.get(forgedReceipt.id)).toBeNull()
  })

  it('rolls back missing, extra, wrong-call, wrong-attempt, and foreign evidence', async () => {
    const missing = await claimInvocation(primary, 'response_loss_missing')
    const missingAttempt = await insertUnknownAttempt(primary, 'response_loss_missing')
    await expect(completeInvocation(missing, missingAttempt, [])).rejects.toThrow(
      /one transport evidence/,
    )

    const wrongCall = await claimInvocation(primary, 'response_loss_wrong_call')
    const wrongCallAttempt = await insertUnknownAttempt(primary, 'response_loss_wrong_call')
    const wrongCallEvidence = await persistTransportEvidence({
      invocation: wrongCall,
      attemptId: wrongCallAttempt,
      suffix: 'response_loss_wrong_call',
      toolCallId: ToolCallIdSchema.parse('call_response_loss_other'),
    })
    await expect(
      completeInvocation(wrongCall, wrongCallAttempt, [wrongCallEvidence]),
    ).rejects.toThrow(/does not bind the tool invocation/)

    const wrongAttempt = await claimInvocation(primary, 'response_loss_wrong_attempt')
    const boundAttempt = await insertUnknownAttempt(primary, 'response_loss_bound_attempt')
    const otherAttempt = await insertUnknownAttempt(primary, 'response_loss_other_attempt')
    const wrongAttemptEvidence = await persistTransportEvidence({
      invocation: wrongAttempt,
      attemptId: boundAttempt,
      suffix: 'response_loss_wrong_attempt',
    })
    await expect(
      completeInvocation(wrongAttempt, otherAttempt, [wrongAttemptEvidence]),
    ).rejects.toThrow(/does not bind the tool invocation/)

    const extra = await claimInvocation(primary, 'response_loss_extra')
    const extraAttemptOne = await insertUnknownAttempt(primary, 'response_loss_extra_one')
    const extraAttemptTwo = await insertUnknownAttempt(primary, 'response_loss_extra_two')
    const extraEvidenceOne = await persistTransportEvidence({
      invocation: extra,
      attemptId: extraAttemptOne,
      suffix: 'response_loss_extra_one',
    })
    const extraEvidenceTwo = await persistTransportEvidence({
      invocation: extra,
      attemptId: extraAttemptTwo,
      suffix: 'response_loss_extra_two',
    })
    await expect(
      completeInvocation(extra, extraAttemptOne, [extraEvidenceOne, extraEvidenceTwo]),
    ).rejects.toThrow(/one transport evidence/)

    const mirrorInvocation = await claimInvocation(mirror, 'response_loss_mirror')
    const mirrorAttempt = await insertUnknownAttempt(mirror, 'response_loss_mirror')
    const mirrorEvidence = await persistTransportEvidence({
      invocation: mirrorInvocation,
      attemptId: mirrorAttempt,
      suffix: 'response_loss_mirror',
    })
    const foreign = await claimInvocation(primary, 'response_loss_foreign')
    const foreignAttempt = await insertUnknownAttempt(primary, 'response_loss_foreign')
    await expect(completeInvocation(foreign, foreignAttempt, [mirrorEvidence])).rejects.toThrow(
      /not bound to the invocation mission/,
    )

    const rolledBack = await pool.query<{ call_id: string; status: string }>(
      `SELECT call_id, status FROM "${schemaName}"."tool_invocations"
       WHERE organization_id = $1 AND call_id = ANY($2::text[])
       ORDER BY call_id`,
      [
        primary.organizationId,
        [missing.callId, wrongCall.callId, wrongAttempt.callId, extra.callId, foreign.callId],
      ],
    )
    expect(rolledBack.rows).toHaveLength(5)
    expect(rolledBack.rows.every((row) => row.status === 'claimed')).toBe(true)
  })

  it('rejects a forged operation binding and a mutated authority rule', async () => {
    const invocation = await claimInvocation(primary, 'response_loss_wrong_operation')
    const attemptId = await insertUnknownAttempt(primary, 'response_loss_wrong_operation')
    await expect(
      persistTransportEvidence({
        invocation,
        attemptId,
        suffix: 'response_loss_wrong_operation',
        operationId: 'op_forged_operation' as OperationId,
      }),
    ).rejects.toThrow(/committed operation attempt/)

    await expect(
      pool.query(
        `INSERT INTO "${schemaName}"."evidence" (
           id, organization_id, mission_id, palace_id, type, payload, authority_receipt_id,
           authority, authority_receipt, application_rule_id, application_rule_version,
           verified_at, observed_at, persisted_at
         )
         SELECT
           'evd_response_loss_bad_rule', organization_id, mission_id, palace_id, type,
           jsonb_set(payload, '{id}', '"evd_response_loss_bad_rule"'::jsonb),
           'rcp_response_loss_bad_rule', authority,
           jsonb_set(
             jsonb_set(
               jsonb_set(authority_receipt, '{id}', '"rcp_response_loss_bad_rule"'::jsonb),
               '{evidenceId}', '"evd_response_loss_bad_rule"'::jsonb
             ),
             '{ruleId}', '"operation.untrusted_rule"'::jsonb
           ),
           'operation.untrusted_rule', 1, verified_at, observed_at, persisted_at
         FROM "${schemaName}"."evidence"
         WHERE id = 'evd_response_loss_happy'`,
      ),
    ).rejects.toThrow(/evidence_operation_transport_shape/)
  })

  it('enforces the deferred database trigger when repository checks are bypassed', async () => {
    const invocation = await claimInvocation(primary, 'response_loss_direct_sql')
    const attemptId = await insertUnknownAttempt(primary, 'response_loss_direct_sql')
    const result = unknownResult(invocation)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE "${schemaName}"."tool_invocations"
         SET status = 'completed', result = $1, result_hash = $2, attempt_id = $3,
             completed_at = $4, updated_at = $4
         WHERE organization_id = $5 AND call_id = $6`,
        [
          result,
          hashToolValue(result),
          attemptId,
          LOST_AT,
          primary.organizationId,
          invocation.callId,
        ],
      )
      await expect(client.query('COMMIT')).rejects.toThrow(/one exact application response-loss/)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const retained = await pool.query<{ status: string }>(
      `SELECT status FROM "${schemaName}"."tool_invocations" WHERE organization_id = $1 AND call_id = $2`,
      [primary.organizationId, invocation.callId],
    )
    expect(retained.rows[0]?.status).toBe('claimed')
  })
})

async function applyMigrations(pool: pg.Pool, schemaName: string): Promise<void> {
  const migrationDirectory = new URL('../migrations/', import.meta.url)
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
}

async function seedTenant(
  database: Database,
  pool: pg.Pool,
  bootstrap: PgBootstrapRepository,
  suffix: string,
): Promise<TenantFixture> {
  const organizationId = `org_${suffix}` as OrganizationId
  const missionId = `mis_${suffix}` as MissionId
  const palaceId = `pal_${suffix}` as PalaceId
  const operationId = `op_${suffix}` as OperationId
  const planId = `pln_${suffix}`
  const actionId = `act_${suffix}`
  const approvalId = `apr_${suffix}`
  const membershipId = MembershipIdSchema.parse(`mem_${suffix}`)
  await bootstrap.insertOrganization({
    id: organizationId,
    slug: suffix.replaceAll('_', '-'),
    name: suffix,
    labTenant: true,
    createdAt: NOW,
  })
  await createUnitOfWork(database).run(organizationId, async (repositories) => {
    await repositories.records.insertMembership({
      id: membershipId,
      organizationId,
      userId: USER_ID,
      role: 'owner',
      grants: [],
      createdAt: NOW,
      revokedAt: null,
    })
    await repositories.records.insertPalace({
      id: palaceId,
      organizationId,
      name: suffix,
      timezone: 'America/New_York',
      batteryAvailablePercentage: 70,
      createdAt: NOW,
    })
    await repositories.missions.insert(
      MissionSchema.parse({
        id: missionId,
        organizationId,
        palaceId,
        initiatedBy: USER_ID,
        objective: 'Activate one approved routine exactly once',
        constraints: {
          preheatBy: '02:00',
          requireVerifiedIdentityForUnlock: true,
          pathwayLightingBeginsAfter: 'verified_arrival',
          projectedBatteryUseMaxPercentagePoints: 15,
        },
        successCriteriaIds: ['routine_matches_plan'],
        state: { status: 'running', phase: 'execute' },
        version: 1,
        runId: null,
        contextReceiptId: null,
        taskLedger: [],
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
  })
  await pool.query(
    `INSERT INTO plans (id, organization_id, mission_id, palace_id, revision, hash, status, objective, constraints, success_criteria_ids, created_at)
     VALUES ($1, $2, $3, $4, 1, $5, 'approved', 'Activate once', '{}'::jsonb, ARRAY['routine_matches_plan'], $6)`,
    [planId, organizationId, missionId, palaceId, 'a'.repeat(64), NOW],
  )
  await pool.query(
    `INSERT INTO plan_actions (id, organization_id, plan_id, position, type, payload, created_at)
     VALUES ($1, $2, $3, 0, 'restore_routine_version', $4, $5)`,
    [
      actionId,
      organizationId,
      planId,
      {
        id: actionId,
        type: 'restore_routine_version',
        palaceId,
        routineId: `rtn_${suffix}`,
        routineVersionId: `rtv_${suffix}`,
        expectedCurrentVersion: 1,
      },
      NOW,
    ],
  )
  await pool.query(
    `INSERT INTO approvals (id, organization_id, mission_id, plan_id, plan_hash, status, requested_by, approved_by, approver_role, nonce, approved_at, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 'approved', 'usr_transport_owner', 'usr_transport_owner', 'owner', $6, $7, $8, $9)`,
    [
      approvalId,
      organizationId,
      missionId,
      planId,
      'a'.repeat(64),
      `nonce_${suffix}`,
      COMMITTED_AT,
      '2026-07-15T00:10:00.000Z',
      NOW,
    ],
  )
  await pool.query(
    `INSERT INTO approval_actions (organization_id, approval_id, plan_id, action_id) VALUES ($1, $2, $3, $4)`,
    [organizationId, approvalId, planId, actionId],
  )
  await pool.query(
    `INSERT INTO operations (id, organization_id, mission_id, plan_id, plan_action_id, approval_id, payload_hash, server_created, status, outcome, committed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'committed', $8, $9, $10)`,
    [
      operationId,
      organizationId,
      missionId,
      planId,
      actionId,
      approvalId,
      'b'.repeat(64),
      {
        routineId: `rtn_${suffix}`,
        routineVersionId: `rtv_${suffix}`,
        deactivatedRoutineId: null,
      },
      COMMITTED_AT,
      NOW,
    ],
  )
  return { organizationId, missionId, palaceId, operationId }
}

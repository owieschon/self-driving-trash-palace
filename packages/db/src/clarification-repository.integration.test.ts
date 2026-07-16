import { readFile, readdir } from 'node:fs/promises'

import {
  ClarificationService,
  MissionLeaseService,
  hashCanonical,
  type AuthContext,
  type MissionExecutionContext,
  type SensitiveMutationGuardPort,
} from '@trash-palace/application'
import {
  FixedEntropy,
  MutableClock,
  SequentialIdGenerator,
  testCaretakerEvidenceProfile,
} from '@trash-palace/application/testing'
import {
  ClarificationChoiceIdSchema,
  EvidenceIdSchema,
  MembershipIdSchema,
  MissionIdSchema,
  MissionSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PersistedEvidenceRecordSchema,
  PrincipalSchema,
  ReceiptIdSchema,
  RunIdSchema,
  Sha256Schema,
  UserIdSchema,
  type Mission,
} from '@trash-palace/core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabase, type Database } from './client.js'
import {
  PgBootstrapRepository,
  createMissionExecutionUnitOfWork,
  createUnitOfWork,
} from './repositories.js'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip

const organizationId = OrganizationIdSchema.parse('org_clarification')
const foreignOrganizationId = OrganizationIdSchema.parse('org_clarifyforeign')
const ownerId = UserIdSchema.parse('usr_clarifyowner')
const serviceId = UserIdSchema.parse('usr_clarifyservice')
const viewerId = UserIdSchema.parse('usr_clarifyviewer')
const palaceId = PalaceIdSchema.parse('pal_clarifyhome')
const missionId = MissionIdSchema.parse('mis_clarifymission')
const rawMissionId = MissionIdSchema.parse('mis_clarifyrawone')
const unsafeMissionId = MissionIdSchema.parse('mis_clarifyunsafe')
const evidenceId = EvidenceIdSchema.parse('evd_clarification')
const energyFirst = ClarificationChoiceIdSchema.parse('energy_first')
const comfortFirst = ClarificationChoiceIdSchema.parse('comfort_first')
const requestKey = Sha256Schema.parse('a'.repeat(64))
const answerKey = Sha256Schema.parse('b'.repeat(64))
const changedKey = Sha256Schema.parse('c'.repeat(64))
const allowMutation: SensitiveMutationGuardPort = { assert: () => undefined }

databaseDescribe('PostgreSQL clarification seam', () => {
  let pool: pg.Pool
  let database: Database
  let schemaName: string
  let clock: MutableClock
  let unitOfWork: ReturnType<typeof createUnitOfWork>
  let fencedUnitOfWork: ReturnType<typeof createMissionExecutionUnitOfWork>
  let authContext: AuthContext
  let executionContext: MissionExecutionContext
  let service: ClarificationService
  let ids: SequentialIdGenerator
  let leaseService: MissionLeaseService

  beforeAll(async () => {
    schemaName = `trash_palace_clarification_${process.pid}_${Date.now()}`
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
      options: `-c search_path=${schemaName},public`,
    })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await applyMigrations(pool, schemaName)
    database = createDatabase(pool)
    unitOfWork = createUnitOfWork(database)
    fencedUnitOfWork = createMissionExecutionUnitOfWork(database)
    const now = new Date(Date.now() - 10_000)
    clock = new MutableClock(now)
    const at = now.toISOString()

    const bootstrap = new PgBootstrapRepository(database)
    await bootstrap.insertOrganization({
      id: organizationId,
      slug: 'clarification-tenant',
      name: 'Clarification Tenant',
      labTenant: true,
      createdAt: at,
    })
    await bootstrap.insertUser({ id: ownerId, displayName: 'Rocky', createdAt: at })
    await bootstrap.insertUser({ id: serviceId, displayName: 'Caretaker', createdAt: at })
    await bootstrap.insertUser({ id: viewerId, displayName: 'Viewer', createdAt: at })
    await unitOfWork.run(organizationId, async (repositories) => {
      await repositories.records.insertMembership({
        id: MembershipIdSchema.parse('mem_clarifyowner'),
        organizationId,
        userId: ownerId,
        role: 'owner',
        grants: [],
        createdAt: at,
        revokedAt: null,
      })
      await repositories.records.insertMembership({
        id: MembershipIdSchema.parse('mem_clarifyservice'),
        organizationId,
        userId: serviceId,
        role: 'operator',
        grants: [],
        createdAt: at,
        revokedAt: null,
      })
      await repositories.records.insertMembership({
        id: MembershipIdSchema.parse('mem_clarifyviewer'),
        organizationId,
        userId: viewerId,
        role: 'viewer',
        grants: [],
        createdAt: at,
        revokedAt: null,
      })
      await repositories.records.insertPalace({
        id: palaceId,
        organizationId,
        name: 'Clarification Palace',
        timezone: 'America/New_York',
        batteryAvailablePercentage: 80,
        createdAt: at,
      })
      await repositories.missions.insert(mission(missionId, ownerId, at))
      await repositories.missions.insert(mission(rawMissionId, ownerId, at))
      await repositories.missions.insert(mission(unsafeMissionId, ownerId, at))
      await repositories.evidence.appendMany([evidence(at)])
    })

    ids = new SequentialIdGenerator()
    const servicePrincipal = PrincipalSchema.parse({
      organizationId,
      actorId: serviceId,
      role: 'service',
      operatorGrants: [],
      delegatedPermissions: [],
    })
    leaseService = new MissionLeaseService(unitOfWork, clock, ids, new FixedEntropy())
    const acquired = await leaseService.acquire({
      organizationId,
      missionId,
      ownerId: 'clarification-worker',
      ttlMilliseconds: 30_000,
    })
    executionContext = {
      fence: acquired.fence,
      signal: new AbortController().signal,
      principal: servicePrincipal,
    }
    authContext = {
      sessionId: 'session_clarification_fixture_000001',
      principal: PrincipalSchema.parse({
        organizationId,
        actorId: ownerId,
        role: 'owner',
        operatorGrants: [],
        delegatedPermissions: [],
      }),
      csrfToken: 'csrf_clarification_fixture_000001',
      issuedAt: at,
      authenticatedAt: at,
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    }
    service = new ClarificationService(unitOfWork, fencedUnitOfWork, allowMutation, clock, ids)
  }, 30_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  it('persists fenced request and human answer with exact replay across PostgreSQL transactions', async () => {
    await expect(service.request(requestInput(3))).rejects.toThrow(/changed before this request/)
    await expect(
      service.request({
        ...requestInput(4),
        context: {
          ...executionContext,
          principal: PrincipalSchema.parse({
            ...executionContext.principal,
            organizationId: foreignOrganizationId,
          }),
        },
      }),
    ).rejects.toThrow(/does not authorize this mutation/)
    const created = await service.request(requestInput(4))
    expect(created).toMatchObject({
      kind: 'created',
      mission: { version: 5, state: { status: 'waiting_for_user', phase: 'plan' } },
      request: { status: 'pending', evidenceRefs: [evidenceId] },
    })
    await expect(
      fencedUnitOfWork.runFenced(executionContext.fence, (repositories) =>
        repositories.clarifications.findLatestForMission(missionId),
      ),
    ).resolves.toEqual(created.request)
    const replayed = await service.request(requestInput(1))
    expect(replayed.kind).toBe('replayed')
    expect(replayed.request.id).toBe(created.request.id)
    await expect(
      service.request({ ...requestInput(5), question: 'Should comfort take priority tonight?' }),
    ).rejects.toThrow(/reused with another payload/)

    clock.advance(1_000)
    const answered = await service.answer(answerInput(created.request.id, 5))
    expect(answered).toMatchObject({
      kind: 'answered',
      mission: { version: 6, state: { status: 'running', phase: 'plan' } },
      request: { status: 'answered', resolvedAt: clock.now().toISOString() },
      answer: { choiceId: energyFirst, answeredBy: ownerId, evidenceRefs: [evidenceId] },
    })
    await expect(
      fencedUnitOfWork.runFenced(executionContext.fence, (repositories) =>
        repositories.clarifications.findLatestForMission(missionId),
      ),
    ).resolves.toEqual(answered.request)
    const replayedAnswer = await service.answer(answerInput(created.request.id, 5))
    expect(replayedAnswer.kind).toBe('replayed')
    expect(replayedAnswer.answer).toEqual(answered.answer)
    await expect(
      service.answer({
        ...answerInput(created.request.id, 5),
        idempotencyKey: changedKey,
        choiceId: comfortFirst,
      }),
    ).rejects.toThrow(/another answer/)

    const runId = RunIdSchema.parse('run_clarification')
    await fencedUnitOfWork.runFenced(executionContext.fence, (repositories) =>
      repositories.caretakerRuns.start({
        runId,
        missionId,
        mutationKey: hashCanonical({ kind: 'start', attempt: 1 }),
        evidenceProfile: testCaretakerEvidenceProfile(runId),
        occurredAt: clock.now().toISOString(),
      }),
    )
    const firstDecision = {
      runId,
      expectedVersion: 0,
      expectedTaskLedgerVersion: 0,
      mutationKey: hashCanonical({ kind: 'decision_attempt', attempt: 1 }),
      kind: 'decision_attempt' as const,
      counters: {
        toolCallCount: 0,
        planRevisionCount: 0,
        clarificationPauseCount: 0,
        reconciliationPollCount: 0,
        activeRuntimeMilliseconds: 0,
      },
      pendingToolCall: null,
      taskLedger: [],
      evidenceRefs: [],
      occurredAt: clock.now().toISOString(),
    }
    await expect(
      fencedUnitOfWork.runFenced(executionContext.fence, (repositories) =>
        repositories.caretakerRuns.checkpoint(firstDecision),
      ),
    ).resolves.toMatchObject({
      kind: 'applied',
      snapshot: { run: { version: 1 }, checkpoint: { kind: 'decision_attempt' } },
    })
    await expect(
      fencedUnitOfWork.runFenced(executionContext.fence, (repositories) =>
        repositories.caretakerRuns.checkpoint(firstDecision),
      ),
    ).resolves.toMatchObject({ kind: 'replayed', snapshot: { run: { version: 1 } } })

    await unitOfWork.run(organizationId, (repositories) =>
      repositories.missionLeases.release(executionContext.fence),
    )
    const takeover = await leaseService.acquire({
      organizationId,
      missionId,
      ownerId: 'clarification-worker-takeover',
      ttlMilliseconds: 30_000,
    })
    const resumed = await fencedUnitOfWork.runFenced(takeover.fence, (repositories) =>
      repositories.caretakerRuns.start({
        runId,
        missionId,
        mutationKey: hashCanonical({ kind: 'resume', attempt: 2 }),
        evidenceProfile: testCaretakerEvidenceProfile(runId),
        occurredAt: clock.now().toISOString(),
      }),
    )
    expect(resumed).toMatchObject({
      kind: 'resumed',
      snapshot: { run: { version: 2 }, checkpoint: { kind: 'lease_replaced' } },
    })
    await expect(
      fencedUnitOfWork.runFenced(takeover.fence, (repositories) =>
        repositories.caretakerRuns.checkpoint({
          ...firstDecision,
          expectedVersion: 2,
          mutationKey: hashCanonical({ kind: 'decision_attempt', attempt: 2 }),
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'applied',
      snapshot: { run: { version: 3 }, checkpoint: { kind: 'decision_attempt' } },
    })
    const attempts = await pool.query<{ mutation_key: string; sequence: number }>(
      `SELECT mutation_key, sequence FROM caretaker_run_checkpoints WHERE run_id = $1 AND kind = 'decision_attempt' ORDER BY sequence`,
      [runId],
    )
    expect(attempts.rows).toHaveLength(2)
    expect(new Set(attempts.rows.map((row) => row.mutation_key)).size).toBe(2)
    await expect(
      pool.query(
        `INSERT INTO caretaker_run_checkpoints
          (organization_id, mission_id, run_id, sequence, mutation_key, mutation_hash, kind,
           run_status, phase, run_version, task_ledger_version, task_ledger_hash, task_ledger,
           tool_call_count, plan_revision_count, clarification_pause_count,
           reconciliation_poll_count, active_runtime_milliseconds, pending_tool_call,
           evidence_refs, occurred_at)
         SELECT organization_id, mission_id, run_id, sequence + 1, $2, $3, 'decision_attempt',
           run_status, phase, run_version + 1, task_ledger_version, task_ledger_hash, task_ledger,
           tool_call_count + 1, plan_revision_count, clarification_pause_count,
           reconciliation_poll_count, active_runtime_milliseconds, NULL, ARRAY[]::text[], $4
         FROM caretaker_run_checkpoints
         WHERE organization_id = $1 AND run_id = $5 AND sequence = 3`,
        [organizationId, '8'.repeat(64), '9'.repeat(64), clock.now().toISOString(), runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    const rows = await pool.query<{
      answer_count: number
      request_count: number
      event_count: number
    }>(
      `SELECT
        (SELECT count(*)::integer FROM clarification_requests WHERE mission_id = $1) AS request_count,
        (SELECT count(*)::integer FROM clarification_answers WHERE mission_id = $1) AS answer_count,
        (SELECT count(*)::integer FROM mission_events WHERE mission_id = $1 AND event IN ('material_ambiguity', 'clarification_answered')) AS event_count`,
      [missionId],
    )
    expect(rows.rows).toEqual([{ request_count: 1, answer_count: 1, event_count: 2 }])
  })

  it('enforces payload, actor, choice, singleton, evidence, and immutable-history guards on raw SQL', async () => {
    const choices = JSON.stringify([
      {
        id: energyFirst,
        label: 'Energy first',
        description: 'Stay inside the projected battery ceiling.',
      },
      {
        id: comfortFirst,
        label: 'Comfort first',
        description: 'Accept the projected battery tradeoff.',
      },
    ])
    const now = clock.now().toISOString()
    const requestValues = [
      'clr_rawrequest01',
      organizationId,
      rawMissionId,
      'd'.repeat(64),
      'e'.repeat(64),
      'Which constraint should take priority for this run?',
      choices,
      [],
      serviceId,
      now,
    ]
    await pool.query(
      `INSERT INTO clarification_requests
        (id, organization_id, mission_id, idempotency_key, payload_hash, question, choices, evidence_refs, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::text[], $9, $10)`,
      requestValues,
    )
    await expect(
      pool.query(
        `INSERT INTO clarification_requests
          (id, organization_id, mission_id, idempotency_key, payload_hash, question, choices, evidence_refs, requested_by, requested_at)
         VALUES ('clr_rawrequest02', $1, $2, $3, $4, $5, $6::jsonb, ARRAY[]::text[], $7, $8)`,
        [
          organizationId,
          rawMissionId,
          'f'.repeat(64),
          '0'.repeat(64),
          'Which other constraint should take priority tonight?',
          choices,
          serviceId,
          now,
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      pool.query(
        `INSERT INTO clarification_requests
          (id, organization_id, mission_id, idempotency_key, payload_hash, question, choices, evidence_refs, requested_by, requested_at)
         VALUES ('clr_unsaferequest', $1, $2, $3, $4, $5, $6::jsonb, ARRAY[]::text[], $7, $8)`,
        [
          organizationId,
          unsafeMissionId,
          '1'.repeat(64),
          '2'.repeat(64),
          'Use token=super-secret-value before choosing tonight',
          choices,
          serviceId,
          now,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query(`UPDATE clarification_requests SET question = 'Mutated question' WHERE id = $1`, [
        'clr_rawrequest01',
      ]),
    ).rejects.toMatchObject({ code: '23514' })

    await pool.query(
      `UPDATE missions SET status = 'waiting_for_user', phase = 'plan', version = version + 1 WHERE organization_id = $1 AND id = $2`,
      [organizationId, rawMissionId],
    )
    const rawAnswer = (
      id: string,
      key: string,
      choiceId: string,
      answeredBy: string,
      refs: readonly string[] = [],
    ) =>
      pool.query(
        `INSERT INTO clarification_answers
          (id, organization_id, mission_id, request_id, idempotency_key, payload_hash, choice_id, answered_by, evidence_refs, answered_at)
         VALUES ($1, $2, $3, 'clr_rawrequest01', $4, $5, $6, $7, $8::text[], $9)`,
        [id, organizationId, rawMissionId, key, '3'.repeat(64), choiceId, answeredBy, refs, now],
      )
    await expect(
      rawAnswer('cla_unoffered001', '4'.repeat(64), 'not_offered', ownerId),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      rawAnswer('cla_vieweranswer', '5'.repeat(64), energyFirst, viewerId),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      rawAnswer('cla_badevidence1', '6'.repeat(64), energyFirst, ownerId, ['evd_missing00001']),
    ).rejects.toMatchObject({ code: '23514' })

    await rawAnswer('cla_rawanswer001', '7'.repeat(64), energyFirst, ownerId)
    const resolved = await pool.query<{ status: string; resolved_at: Date | null }>(
      `SELECT status, resolved_at FROM clarification_requests WHERE id = $1`,
      ['clr_rawrequest01'],
    )
    expect(resolved.rows[0]).toMatchObject({ status: 'answered' })
    expect(resolved.rows[0]?.resolved_at?.toISOString()).toBe(now)
    await expect(
      pool.query(`DELETE FROM clarification_answers WHERE id = 'cla_rawanswer001'`),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query(
        `UPDATE clarification_requests SET status = 'pending', resolved_at = NULL WHERE id = 'clr_rawrequest01'`,
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  function requestInput(expectedMissionVersion: number) {
    return {
      context: executionContext,
      missionId,
      expectedMissionVersion,
      idempotencyKey: requestKey,
      question: 'Which comfort constraint should take priority for this homecoming?',
      choices: [
        {
          id: energyFirst,
          label: 'Energy first',
          description: 'Stay within the projected battery ceiling and preheat later.',
        },
        {
          id: comfortFirst,
          label: 'Comfort first',
          description: 'Preheat earlier and accept the projected battery tradeoff.',
        },
      ],
      evidenceRefs: [evidenceId],
    } as const
  }

  function answerInput(
    requestId: Parameters<ClarificationService['answer']>[0]['requestId'],
    expectedMissionVersion: number,
  ) {
    return {
      context: authContext,
      requestId,
      expectedMissionVersion,
      idempotencyKey: answerKey,
      choiceId: energyFirst,
      evidenceRefs: [evidenceId],
      csrfToken: authContext.csrfToken,
      origin: 'http://trash-palace.test',
      allowedOrigin: 'http://trash-palace.test',
    } as const
  }
})

function mission(id: Mission['id'], initiatedBy: Mission['initiatedBy'], at: string): Mission {
  return MissionSchema.parse({
    id,
    organizationId,
    palaceId,
    initiatedBy,
    objective: 'Resolve one material constraint before planning',
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    successCriteriaIds: ['bounded_clarification'],
    state: { status: 'running', phase: 'plan' },
    version: 4,
    runId: null,
    contextReceiptId: null,
    taskLedger: [],
    createdAt: at,
    updatedAt: at,
  })
}

function evidence(at: string) {
  return PersistedEvidenceRecordSchema.parse({
    schemaVersion: 'persisted-evidence@1',
    evidence: {
      id: evidenceId,
      organizationId,
      missionId,
      palaceId,
      observedAt: at,
      type: 'battery_projection',
      projectedUsePercentagePoints: 16.2,
    },
    authorityReceipt: {
      schemaVersion: 'evidence-authority-receipt@1',
      id: ReceiptIdSchema.parse('rcp_clarification'),
      evidenceId,
      organizationId,
      missionId,
      palaceId,
      verifiedAt: at,
      authority: 'application',
      producer: 'application_code',
      ruleId: 'clarification.material-ambiguity',
      ruleVersion: 1,
      inputEvidenceIds: [],
      derivationVerified: true,
    },
    persistedAt: at,
  })
}

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

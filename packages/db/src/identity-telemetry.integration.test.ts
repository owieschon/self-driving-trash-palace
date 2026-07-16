import { createHmac } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'

import {
  HmacIdentityTelemetryVerifier,
  HOMECOMING_LOGICAL_KEYS,
  IDENTITY_ARRIVAL_EXECUTION_TOPIC,
  IdentityTelemetryIngressService,
  IdentityArrivalExecutionReferenceSchema,
  identityArrivalExecutionOutboxIdentity,
  type ClockPort,
  type IdentityTelemetryKeyResolverPort,
} from '@trash-palace/application'
import {
  ApprovalSchema,
  EvidenceIdSchema,
  CrewMemberIdSchema,
  ExecutionIdSchema,
  ExecutionSchema,
  IdentityTelemetryEventSchema,
  IdentityTelemetryKeyIdSchema,
  IdentityTelemetryPrincipalSchema,
  IdentityTagIdSchema,
  HomecomingRoutineDefinitionSchema,
  MembershipIdSchema,
  MissionIdSchema,
  MissionSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PlanSchema,
  PersistedEvidenceRecordSchema,
  ReceiptIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  SignedIdentityTelemetrySchema,
  UserIdSchema,
  computePlanHash,
  deriveGatewayCommandId,
  deriveIdentityTelemetryEvidenceId,
  identityTelemetrySignaturePayload,
  type IdentityTelemetryEvent,
  type OperationId,
  type PersistedEvidenceRecord,
  type SignedIdentityTelemetry,
} from '@trash-palace/core'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabase, type Database } from './client.js'
import {
  PgBootstrapRepository,
  createIdentityTelemetryIngressUnitOfWork,
  createUnitOfWork,
} from './repositories.js'
import { evidence, gatewayCommands, identityTelemetryIngresses, outboxMessages } from './schema.js'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip
const ORGANIZATION_ID = OrganizationIdSchema.parse('org_identitytenant')
const USER_ID = UserIdSchema.parse('usr_identityowner')
const MEMBERSHIP_ID = MembershipIdSchema.parse('mem_identityowner')
const PALACE_ID = PalaceIdSchema.parse('pal_identityhome')
const CREW_MEMBER_ID = CrewMemberIdSchema.parse('crew_identityowner')
const ACTIVE_TAG_ID = IdentityTagIdSchema.parse('tag_identityactive')
const INACTIVE_TAG_ID = IdentityTagIdSchema.parse('tag_identityinactive')
const UNKNOWN_TAG_ID = IdentityTagIdSchema.parse('tag_identityunknown')
const MISSION_ID = MissionIdSchema.parse('mis_identitymission')
const PROTECTED_ROUTINE_ID = RoutineIdSchema.parse('rtn_identityprotected')
const PROTECTED_VERSION_ID = RoutineVersionIdSchema.parse('rtv_identityprotectedv1')
const REPLACEMENT_ROUTINE_ID = RoutineIdSchema.parse('rtn_identityreplacement')
const REPLACEMENT_VERSION_ID = RoutineVersionIdSchema.parse('rtv_identityreplacementv1')
const EXECUTION_ID = ExecutionIdSchema.parse('exe_identityexecution')
const AT = '2026-08-14T05:58:00.000Z'
const KEY_ID = IdentityTelemetryKeyIdSchema.parse('itk_database_gateway')
const KEY = 'database-identity-telemetry-key-with-32-bytes'

class MutableClock implements ClockPort {
  public constructor(public value = AT) {}

  public now(): Date {
    return new Date(this.value)
  }
}

class DatabaseKeyResolver implements IdentityTelemetryKeyResolverPort {
  public resolve(keyId: Parameters<IdentityTelemetryKeyResolverPort['resolve']>[0]) {
    if (keyId !== KEY_ID) return Promise.resolve(null)
    return Promise.resolve({
      principal: IdentityTelemetryPrincipalSchema.parse({
        principalId: 'itp_database_gateway',
        organizationId: ORGANIZATION_ID,
        palaceId: PALACE_ID,
        purpose: 'identity_telemetry_ingress' as const,
        keyId: KEY_ID,
        keyVersion: 2,
        validFrom: '2026-08-14T00:00:00.000Z',
        expiresAt: '2026-08-15T00:00:00.000Z',
        revokedAt: null,
      }),
      key: KEY,
    })
  }
}

function telemetryEvent(overrides: Readonly<Record<string, unknown>> = {}) {
  return IdentityTelemetryEventSchema.parse({
    schemaVersion: 'identity-telemetry-event@1',
    providerEventId: 'idt_database_arrival_01',
    organizationId: ORGANIZATION_ID,
    missionId: MISSION_ID,
    palaceId: PALACE_ID,
    identityTagId: ACTIVE_TAG_ID,
    observedAt: AT,
    nonce: 'itn_database_arrival_nonce_01',
    ...overrides,
  })
}

function sign(event: IdentityTelemetryEvent, timestamp = AT): SignedIdentityTelemetry {
  return SignedIdentityTelemetrySchema.parse({
    event,
    signature: {
      version: 'v1',
      algorithm: 'hmac-sha256',
      keyId: KEY_ID,
      timestamp,
      nonce: event.nonce,
      digest: createHmac('sha256', KEY)
        .update(identityTelemetrySignaturePayload({ event, keyId: KEY_ID, timestamp }))
        .digest('hex'),
    },
  })
}

function createIdentityIngress(
  database: Database,
  clock: ClockPort,
): IdentityTelemetryIngressService<SignedIdentityTelemetry> {
  return new IdentityTelemetryIngressService(
    createIdentityTelemetryIngressUnitOfWork(database),
    new HmacIdentityTelemetryVerifier(new DatabaseKeyResolver(), clock),
    clock,
  )
}

databaseDescribe('PostgreSQL identity telemetry ingress', () => {
  let pool: pg.Pool
  let database: Database
  let schemaName: string
  let clock: MutableClock
  let ingress: IdentityTelemetryIngressService<SignedIdentityTelemetry>
  let runningOperationId: OperationId

  beforeAll(async () => {
    schemaName = `trash_identity_${process.pid}_${Date.now()}`
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 1 })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await pool.query(`SET search_path TO "${schemaName}", public`)
    await applyMigrations(pool, schemaName)
    database = createDatabase(pool)
    await seedTenant(database)
    runningOperationId = await seedCommittedOperation(database)
    clock = new MutableClock()
    ingress = createIdentityIngress(database, clock)
    const trigger = await ingress.ingest(
      sign(
        telemetryEvent({
          providerEventId: 'idt_database_seed_arrival_00',
          nonce: 'itn_database_seed_arrival_nonce_00',
        }),
      ),
    )
    await insertRunningExecution(database, runningOperationId, trigger.record)
  }, 30_000)

  afterAll(async () => {
    await pool.query('SET search_path TO public')
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  it('replays the original record after a gateway restart re-signs the same provider event', async () => {
    const event = telemetryEvent()
    const first = await ingress.ingest(sign(event))
    clock.value = '2026-08-14T05:58:01.000Z'
    const restartedIngress = createIdentityIngress(database, clock)
    const replay = await restartedIngress.ingest(sign(event, clock.value))

    expect(first.status).toBe('stored')
    expect(replay.status).toBe('duplicate')
    expect(replay.record).toEqual(first.record)
    expect(first.provenance.signatureTimestamp).toBe(AT)
    expect(replay.provenance.signatureTimestamp).toBe(AT)
    expect(replay.provenance.verifiedAt).toBe(first.provenance.verifiedAt)
    expect(first.record.evidence).toMatchObject({ type: 'identity_arrival', verified: true })
    expect(first.executionJobs).toHaveLength(1)
    expect(replay.executionJobs).toEqual([{ ...first.executionJobs[0], status: 'duplicate' }])
    expect(first.executionJobs[0]?.reference).toEqual({
      organizationId: ORGANIZATION_ID,
      missionId: MISSION_ID,
      operationId: runningOperationId,
      executionId: EXECUTION_ID,
      evidenceId: first.record.evidence.id,
    })
    expect(
      await database.$count(
        identityTelemetryIngresses,
        eq(identityTelemetryIngresses.providerEventId, first.event.providerEventId),
      ),
    ).toBe(1)
    expect(await database.$count(evidence, eq(evidence.id, first.record.evidence.id))).toBe(1)
    expect(
      await database.$count(
        outboxMessages,
        eq(outboxMessages.topic, IDENTITY_ARRIVAL_EXECUTION_TOPIC),
      ),
    ).toBe(1)

    const stableJob = first.executionJobs[0]
    if (stableJob === undefined) throw new Error('Identity execution job was not scheduled')
    await database.delete(outboxMessages).where(eq(outboxMessages.id, stableJob.outboxId))
    const repaired = await restartedIngress.ingest(sign(event, clock.value))
    expect(repaired.executionJobs).toEqual([stableJob])
    expect(await database.$count(outboxMessages, eq(outboxMessages.id, stableJob.outboxId))).toBe(1)
  })

  it('rolls the evidence ingress back when its stable outbox identity is rebound', async () => {
    clock.value = AT
    const rejectedEvent = telemetryEvent({
      providerEventId: 'idt_database_arrival_atomic_06',
      nonce: 'itn_database_arrival_atomic_nonce_06',
    })
    const reference = IdentityArrivalExecutionReferenceSchema.parse({
      organizationId: ORGANIZATION_ID,
      missionId: MISSION_ID,
      operationId: runningOperationId,
      executionId: EXECUTION_ID,
      evidenceId: deriveIdentityTelemetryEvidenceId(rejectedEvent),
    })
    const identity = identityArrivalExecutionOutboxIdentity(reference)
    await createUnitOfWork(database).run(ORGANIZATION_ID, (repositories) =>
      repositories.outbox.insert({
        id: identity.outboxId,
        organizationId: ORGANIZATION_ID,
        topic: 'mission.resume',
        deduplicationKey: 'mission.resume:identity-arrival-atomic-collision',
        payload: { organizationId: ORGANIZATION_ID, missionId: MISSION_ID },
        status: 'pending',
        availableAt: AT,
        createdAt: AT,
        claimedBy: null,
        claimExpiresAt: null,
        dispatchedAt: null,
        deliveryAttempts: 0,
        lastErrorCode: null,
      }),
    )

    await expect(ingress.ingest(sign(rejectedEvent))).rejects.toThrow(/rebound/)
    expect(
      await database.$count(
        evidence,
        eq(evidence.id, deriveIdentityTelemetryEvidenceId(rejectedEvent)),
      ),
    ).toBe(0)
    expect(
      await database.$count(
        identityTelemetryIngresses,
        eq(identityTelemetryIngresses.providerEventId, rejectedEvent.providerEventId),
      ),
    ).toBe(0)
  })

  it('rejects cross-tenant and cross-mission execution references before insertion', async () => {
    const base = {
      organizationId: ORGANIZATION_ID,
      missionId: MISSION_ID,
      operationId: runningOperationId,
      executionId: EXECUTION_ID,
      evidenceId: deriveIdentityTelemetryEvidenceId(telemetryEvent()),
    }
    for (const reference of [
      { ...base, organizationId: OrganizationIdSchema.parse('org_foreignidentity') },
      { ...base, missionId: MissionIdSchema.parse('mis_foreignidentity') },
    ]) {
      const parsed = IdentityArrivalExecutionReferenceSchema.parse(reference)
      const identity = identityArrivalExecutionOutboxIdentity(parsed)
      await expect(
        createUnitOfWork(database).run(ORGANIZATION_ID, (repositories) =>
          repositories.outbox.insert({
            id: identity.outboxId,
            organizationId: ORGANIZATION_ID,
            topic: IDENTITY_ARRIVAL_EXECUTION_TOPIC,
            deduplicationKey: identity.deduplicationKey,
            payload: parsed,
            status: 'pending',
            availableAt: AT,
            createdAt: AT,
            claimedBy: null,
            claimExpiresAt: null,
            dispatchedAt: null,
            deliveryAttempts: 0,
            lastErrorCode: null,
          }),
        ),
      ).rejects.toThrow()
      expect(await database.$count(outboxMessages, eq(outboxMessages.id, identity.outboxId))).toBe(
        0,
      )
    }
  })

  it('derives inactive and unassigned identities as unverified at both service and DB boundaries', async () => {
    clock.value = AT
    const inactive = await ingress.ingest(
      sign(
        telemetryEvent({
          providerEventId: 'idt_database_arrival_02',
          nonce: 'itn_database_arrival_nonce_02',
          identityTagId: INACTIVE_TAG_ID,
        }),
      ),
    )
    const unassigned = await ingress.ingest(
      sign(
        telemetryEvent({
          providerEventId: 'idt_database_arrival_03',
          nonce: 'itn_database_arrival_nonce_03',
          identityTagId: UNKNOWN_TAG_ID,
        }),
      ),
    )

    expect(inactive.record.evidence).toMatchObject({ verified: false })
    expect(unassigned.record.evidence).toMatchObject({ verified: false })
    expect(inactive.executionJobs).toEqual([])
    expect(unassigned.executionJobs).toEqual([])
    expect(await database.$count(gatewayCommands)).toBe(0)
  })

  it('rejects provider-event mutation, nonce reuse, and cross-tenant signed input without writes', async () => {
    clock.value = AT
    const baselineEvidence = await database.$count(evidence)
    const changed = telemetryEvent({
      providerEventId: 'idt_database_arrival_01',
      nonce: 'itn_database_changed_payload_01',
    })
    await expect(ingress.ingest(sign(changed))).rejects.toThrow(/changed content/)

    const nonceReuse = telemetryEvent({ providerEventId: 'idt_database_arrival_04' })
    await expect(ingress.ingest(sign(nonceReuse))).rejects.toThrow(/nonce was reused/)

    const foreign = telemetryEvent({
      providerEventId: 'idt_database_arrival_05',
      nonce: 'itn_database_foreign_nonce_01',
      organizationId: OrganizationIdSchema.parse('org_foreignidentity'),
      palaceId: PalaceIdSchema.parse('pal_foreignidentity'),
    })
    await expect(ingress.ingest(sign(foreign))).rejects.toMatchObject({
      code: 'IDENTITY_TELEMETRY_TENANT_MISMATCH',
    })
    expect(await database.$count(evidence)).toBe(baselineEvidence)
    expect(await database.$count(gatewayCommands)).toBe(0)
  })

  it('rejects caller-minted identity evidence through the generic repository', async () => {
    const forged = retainedV1Record('evd_direct_forgery', 'rcp_direct_forgery')
    await expect(
      createUnitOfWork(database).run(ORGANIZATION_ID, (repositories) =>
        repositories.evidence.appendMany([forged]),
      ),
    ).rejects.toThrow(/signed ingress repository/)
    expect(await database.$count(evidence, eq(evidence.id, forged.evidence.id))).toBe(0)
  })

  it('rejects evidence without provenance and a caller-forged verified verdict in SQL', async () => {
    const forged = retainedV1Record('evd_sql_forgery01', 'rcp_sql_forgery01')
    const forgedReceipt = identityReceipt(forged)
    const v2Receipt = {
      ...forgedReceipt,
      schemaVersion: 'evidence-authority-receipt@2',
      principalId: 'itp_database_gateway',
      keyId: KEY_ID,
      keyVersion: 2,
      verifiedPayloadHash: 'a'.repeat(64),
      verifierVersion: 1,
      purposeVerified: true,
    }
    await expect(
      pool.query(
        `INSERT INTO "${schemaName}".evidence
         (id, organization_id, mission_id, palace_id, type, payload, authority_receipt_id,
          authority, authority_receipt, authority_provider_event_id, verified_at, observed_at, persisted_at)
         VALUES ($1, $2, $3, $4, 'identity_arrival', $5, $6, 'identity_telemetry', $7, $8, $9, $9, $9)`,
        [
          forged.evidence.id,
          forged.evidence.organizationId,
          forged.evidence.missionId,
          forged.evidence.palaceId,
          forged.evidence,
          forgedReceipt.id,
          v2Receipt,
          forgedReceipt.providerEventId,
          AT,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' })

    await expect(
      pool.query(
        `INSERT INTO "${schemaName}".identity_telemetry_ingresses
         (schema_version, provider_event_id, organization_id, mission_id, palace_id,
          identity_tag_id, nonce, principal_id, key_id, key_version, verified_payload_hash,
          signature_timestamp, verified_at, evidence_id, authority_receipt_id, identity_verified)
         VALUES ('identity-telemetry-ingress@1', 'idt_database_forged_99', $1, $2, $3,
          'tag_identityinactive', 'itn_database_forged_nonce_99', 'itp_database_gateway', $4, 2,
          $5, $6, $6, 'evd_database_forged99', 'rcp_database_forged99', true)`,
        [ORGANIZATION_ID, MISSION_ID, PALACE_ID, KEY_ID, 'b'.repeat(64), AT],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

databaseDescribe('identity-arrival execution outbox migration compatibility', () => {
  let pool: pg.Pool
  let schemaName: string

  beforeAll(async () => {
    schemaName = `trash_identity_outbox_${process.pid}_${Date.now()}`
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 1 })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await pool.query(`SET search_path TO "${schemaName}", public`)
    await applyMigrations(pool, schemaName, 16)
    await applyMigration(pool, schemaName, '0017_icy_hiroim.sql')
  }, 30_000)

  afterAll(async () => {
    await pool.query('SET search_path TO public')
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  it('adds the enum before replacing the exact-reference constraints', async () => {
    const enumRows = await pool.query<{ enumlabel: string }>(
      `SELECT enum_value.enumlabel
         FROM pg_enum AS enum_value
         JOIN pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
         JOIN pg_namespace AS namespace ON namespace.oid = enum_type.typnamespace
        WHERE namespace.nspname = $1 AND enum_type.typname = 'outbox_topic'`,
      [schemaName],
    )
    expect(enumRows.rows.map((row) => row.enumlabel)).toContain(IDENTITY_ARRIVAL_EXECUTION_TOPIC)
    expect(
      await outboxConstraintDefinition(pool, schemaName, 'outbox_messages_reference_shape'),
    ).not.toContain(IDENTITY_ARRIVAL_EXECUTION_TOPIC)

    await applyMigration(pool, schemaName, '0018_late_daimon_hellstrom.sql')

    expect(
      await outboxConstraintDefinition(pool, schemaName, 'outbox_messages_reference_shape'),
    ).toContain(IDENTITY_ARRIVAL_EXECUTION_TOPIC)
    expect(
      await outboxConstraintDefinition(pool, schemaName, 'outbox_messages_reference_payload_only'),
    ).toContain('evidenceId')
  })
})

databaseDescribe('identity telemetry V1 migration compatibility', () => {
  let pool: pg.Pool
  let database: Database
  let schemaName: string

  beforeAll(async () => {
    schemaName = `trash_identity_v1_${process.pid}_${Date.now()}`
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 1 })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await pool.query(`SET search_path TO "${schemaName}", public`)
    await applyMigrations(pool, schemaName, 6)
    database = createDatabase(pool)
    await seedTenant(database, { pool, schemaName })
    const retained = retainedV1Record('evd_retained_v1_01', 'rcp_retained_v1_01')
    await insertV1Evidence(pool, retained)
    await applyMigration(pool, schemaName, '0007_identity_telemetry_ingress.sql')
  }, 30_000)

  afterAll(async () => {
    await pool.query('SET search_path TO public')
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  it('reads retained V1 evidence while new V1 inserts fail closed', async () => {
    const retainedId = EvidenceIdSchema.parse('evd_retained_v1_01')
    const retained = await createUnitOfWork(database).run(ORGANIZATION_ID, (repositories) =>
      repositories.evidence.get(retainedId),
    )
    expect(retained?.authorityReceipt.schemaVersion).toBe('evidence-authority-receipt@1')

    await expect(
      insertV1Evidence(pool, retainedV1Record('evd_new_v1_after', 'rcp_new_v1_after')),
    ).rejects.toMatchObject({ code: '23503' })
  })
})

async function seedTenant(
  database: Database,
  legacySchema?: Readonly<{ pool: pg.Pool; schemaName: string }>,
): Promise<void> {
  const bootstrap = new PgBootstrapRepository(database)
  await bootstrap.insertOrganization({
    id: ORGANIZATION_ID,
    slug: 'identity-tenant',
    name: 'Identity Tenant',
    labTenant: true,
    createdAt: AT,
  })
  await bootstrap.insertUser({
    id: USER_ID,
    displayName: 'Rocky',
    createdAt: AT,
  })
  await createUnitOfWork(database).run(ORGANIZATION_ID, async (repositories) => {
    await repositories.records.insertMembership({
      id: MEMBERSHIP_ID,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      role: 'owner',
      grants: [],
      createdAt: AT,
      revokedAt: null,
    })
    await repositories.records.insertPalace({
      id: PALACE_ID,
      organizationId: ORGANIZATION_ID,
      name: 'Identity Home',
      timezone: 'America/New_York',
      batteryAvailablePercentage: 80,
      createdAt: AT,
    })
    await repositories.records.insertCrewMember({
      id: CREW_MEMBER_ID,
      organizationId: ORGANIZATION_ID,
      palaceId: PALACE_ID,
      userId: USER_ID,
      displayName: 'Rocky',
      active: true,
    })
    await repositories.records.insertIdentityTag({
      id: ACTIVE_TAG_ID,
      organizationId: ORGANIZATION_ID,
      crewMemberId: CREW_MEMBER_ID,
      label: 'Active tag',
      verified: true,
      active: true,
      version: 1,
    })
    await repositories.records.insertIdentityTag({
      id: INACTIVE_TAG_ID,
      organizationId: ORGANIZATION_ID,
      crewMemberId: CREW_MEMBER_ID,
      label: 'Inactive tag',
      verified: true,
      active: false,
      version: 1,
    })
    await repositories.records.insertIdentityTag({
      id: UNKNOWN_TAG_ID,
      organizationId: ORGANIZATION_ID,
      crewMemberId: null,
      label: 'Unknown tag',
      verified: false,
      active: true,
      version: 1,
    })
    if (legacySchema === undefined) {
      await repositories.missions.insert(
        MissionSchema.parse({
          id: MISSION_ID,
          organizationId: ORGANIZATION_ID,
          palaceId: PALACE_ID,
          initiatedBy: USER_ID,
          objective: 'Ingest identity telemetry safely',
          constraints: {
            preheatBy: '02:00',
            requireVerifiedIdentityForUnlock: true,
            pathwayLightingBeginsAfter: 'verified_arrival',
            projectedBatteryUseMaxPercentagePoints: 15,
          },
          successCriteriaIds: ['verified_identity_required_for_unlock'],
          state: { status: 'waiting_for_system', phase: 'observe' },
          version: 1,
          runId: null,
          contextReceiptId: null,
          taskLedger: [],
          createdAt: AT,
          updatedAt: AT,
        }),
      )
    }
  })
  if (legacySchema !== undefined) {
    await legacySchema.pool.query(
      `INSERT INTO "${legacySchema.schemaName}"."missions"
       (id, organization_id, palace_id, initiated_by, objective, constraints,
        success_criteria_ids, status, phase, version, run_id, context_receipt_id,
        task_ledger, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::text[], 'waiting_for_system',
        'observe', 1, NULL, NULL, '[]'::jsonb, $8, $8)`,
      [
        MISSION_ID,
        ORGANIZATION_ID,
        PALACE_ID,
        USER_ID,
        'Ingest identity telemetry safely',
        JSON.stringify({
          preheatBy: '02:00',
          requireVerifiedIdentityForUnlock: true,
          pathwayLightingBeginsAfter: 'verified_arrival',
          projectedBatteryUseMaxPercentagePoints: 15,
        }),
        ['verified_identity_required_for_unlock'],
        AT,
      ],
    )
  }
}

const homecomingDefinition = HomecomingRoutineDefinitionSchema.parse({
  name: 'Identity-triggered homecoming',
  trigger: {
    type: 'verified_arrival' as const,
    windowStart: '01:00',
    windowEnd: '03:00',
    timezone: 'America/New_York',
  },
  actions: [
    { type: 'preheat', targetCelsius: 20, completeBy: '02:00' },
    {
      type: 'pathway_lighting',
      intensityPercent: 40,
      durationSeconds: 900,
      beginsAfter: 'verified_arrival',
    },
    {
      type: 'unlock',
      durationSeconds: 90,
      requireVerifiedIdentity: true,
    },
    { type: 'lock_desired_state', afterUnlockSeconds: 90 },
  ],
  constraints: {
    projectedBatteryUseMaxPercentagePoints: 15,
    hardInvariantIds: [
      'tenant_context_host_derived',
      'verified_identity_required_for_unlock',
      'routine_activation_validated',
      'exact_plan_approval_required',
      'retry_preserves_logical_operation',
      'verifier_owns_mission_success',
      'secrets_excluded_from_model_context',
    ],
  },
  projectedBatteryUsePercentagePoints: 12,
})

async function seedCommittedOperation(database: Database): Promise<OperationId> {
  return createUnitOfWork(database).run(ORGANIZATION_ID, async (repositories) => {
    const mission = await repositories.missions.get(MISSION_ID)
    if (mission === null) throw new Error('Identity bridge mission is absent')
    await repositories.records.insertRoutine(
      {
        id: PROTECTED_ROUTINE_ID,
        organizationId: ORGANIZATION_ID,
        palaceId: PALACE_ID,
        name: 'Protected homecoming',
        activeVersionId: PROTECTED_VERSION_ID,
        createdAt: AT,
      },
      {
        id: PROTECTED_VERSION_ID,
        routineId: PROTECTED_ROUTINE_ID,
        organizationId: ORGANIZATION_ID,
        version: 1,
        status: 'active',
        definition: { ...homecomingDefinition, name: 'Protected homecoming' },
        sourcePlanId: null,
        sourcePlanHash: null,
        createdAt: AT,
      },
    )
    const action = {
      id: 'act_identityreplacement',
      type: 'replace_homecoming_routine' as const,
      palaceId: PALACE_ID,
      protectedRoutineId: PROTECTED_ROUTINE_ID,
      protectedRoutineVersionId: PROTECTED_VERSION_ID,
      expectedProtectedVersion: 1,
      replacementRoutineId: REPLACEMENT_ROUTINE_ID,
      replacementRoutineVersionId: REPLACEMENT_VERSION_ID,
      replacement: homecomingDefinition,
    }
    const planContent = {
      schemaVersion: 'plan-hash@1' as const,
      id: 'pln_identityexecution',
      organizationId: ORGANIZATION_ID,
      missionId: MISSION_ID,
      palaceId: PALACE_ID,
      revision: 1,
      objective: mission.objective,
      constraints: mission.constraints,
      actions: [action],
      successCriteriaIds: mission.successCriteriaIds,
    }
    const { schemaVersion: _schemaVersion, ...planFields } = planContent
    const plan = PlanSchema.parse({
      ...planFields,
      hash: computePlanHash(planContent),
      status: 'approved',
      createdAt: AT,
    })
    const approval = ApprovalSchema.parse({
      id: 'apr_identityexecution',
      organizationId: ORGANIZATION_ID,
      missionId: MISSION_ID,
      planId: plan.id,
      planHash: plan.hash,
      status: 'approved',
      actionIds: [action.id],
      protectedResources: [
        {
          routineId: PROTECTED_ROUTINE_ID,
          routineVersionId: PROTECTED_VERSION_ID,
          version: 1,
        },
      ],
      requestedBy: USER_ID,
      approvedBy: USER_ID,
      approverRole: 'owner',
      nonce: 'identity_execution_approval_nonce',
      createdAt: AT,
      approvedAt: AT,
      expiresAt: '2026-08-14T06:10:00.000Z',
    })
    await repositories.plans.insert(plan)
    await repositories.approvals.insert(approval)
    const [created] = await repositories.operations.createForApprovedPlan(approval.id, AT)
    if (created === undefined) throw new Error('Identity bridge operation was not created')
    const committed = await repositories.activateApprovedOperation({
      operationId: created.id,
      expectedVersion: 1,
      at: AT,
    })
    return committed.id
  })
}

async function insertRunningExecution(
  database: Database,
  operationId: OperationId,
  trigger: PersistedEvidenceRecord,
): Promise<void> {
  await createUnitOfWork(database).run(ORGANIZATION_ID, async (repositories) => {
    const operation = await repositories.operations.get(operationId)
    if (operation?.outcome === null || operation?.outcome === undefined) {
      throw new Error('Identity bridge operation is not committed')
    }
    const pending = (
      name: 'pathway_lighting' | 'preheat' | 'relock' | 'unlock',
      logicalKey: (typeof HOMECOMING_LOGICAL_KEYS)[keyof typeof HOMECOMING_LOGICAL_KEYS],
    ) => ({
      name,
      commandId: deriveGatewayCommandId(operation.id, logicalKey),
      status: 'pending' as const,
      evidenceId: null,
      resolvedAt: null,
      failure: null,
    })
    const execution = ExecutionSchema.parse({
      id: EXECUTION_ID,
      organizationId: ORGANIZATION_ID,
      missionId: MISSION_ID,
      operationId: operation.id,
      routineId: operation.outcome.routineId,
      routineVersionId: operation.outcome.routineVersionId,
      status: 'running',
      triggeredByEvidenceId: trigger.evidence.id,
      evidenceIds: [trigger.evidence.id],
      startedAt: AT,
      deadline: '2026-08-14T06:58:00.000Z',
      milestones: [
        pending('preheat', HOMECOMING_LOGICAL_KEYS.preheat),
        {
          name: 'verified_arrival',
          commandId: null,
          status: 'pending',
          evidenceId: null,
          resolvedAt: null,
          failure: null,
        },
        pending('pathway_lighting', HOMECOMING_LOGICAL_KEYS.pathwayLighting),
        pending('unlock', HOMECOMING_LOGICAL_KEYS.unlock),
        pending('relock', HOMECOMING_LOGICAL_KEYS.relock),
      ],
      updatedAt: AT,
      completedAt: null,
    })
    await repositories.executions.insert({
      operationId: operation.id,
      execution,
      authorization: { kind: 'manual' },
    })
  })
}

function retainedV1Record(evidenceId: string, receiptId: string) {
  return PersistedEvidenceRecordSchema.parse({
    evidence: {
      id: EvidenceIdSchema.parse(evidenceId),
      organizationId: ORGANIZATION_ID,
      missionId: MISSION_ID,
      palaceId: PALACE_ID,
      observedAt: AT,
      type: 'identity_arrival',
      identityTagId: ACTIVE_TAG_ID,
      verified: true,
    },
    authorityReceipt: {
      id: ReceiptIdSchema.parse(receiptId),
      evidenceId,
      organizationId: ORGANIZATION_ID,
      missionId: MISSION_ID,
      palaceId: PALACE_ID,
      verifiedAt: AT,
      authority: 'identity_telemetry',
      providerEventId: `idt_${evidenceId.slice(4)}`,
      identityTagId: ACTIVE_TAG_ID,
      authenticityVerified: true,
      tenantBindingVerified: true,
    },
    persistedAt: AT,
  })
}

function identityReceipt(record: PersistedEvidenceRecord) {
  if (record.authorityReceipt.authority !== 'identity_telemetry') {
    throw new TypeError('Expected identity telemetry receipt')
  }
  return record.authorityReceipt
}

async function insertV1Evidence(
  pool: pg.Pool,
  record: ReturnType<typeof retainedV1Record>,
): Promise<void> {
  await pool.query(
    `INSERT INTO evidence
     (id, organization_id, mission_id, palace_id, type, payload, authority_receipt_id,
      authority, authority_receipt, authority_provider_event_id, verified_at, observed_at, persisted_at)
     VALUES ($1, $2, $3, $4, 'identity_arrival', $5, $6, 'identity_telemetry', $7, $8, $9, $9, $9)`,
    [
      record.evidence.id,
      record.evidence.organizationId,
      record.evidence.missionId,
      record.evidence.palaceId,
      record.evidence,
      identityReceipt(record).id,
      identityReceipt(record),
      identityReceipt(record).providerEventId,
      AT,
    ],
  )
}

async function applyMigrations(
  pool: pg.Pool,
  schemaName: string,
  maximumIndex = Number.POSITIVE_INFINITY,
): Promise<void> {
  const migrationDirectory = new URL('../migrations/', import.meta.url)
  const filenames = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith('.sql') && Number(file.slice(0, 4)) <= maximumIndex)
    .sort()
  for (const filename of filenames) await applyMigration(pool, schemaName, filename)
}

async function applyMigration(pool: pg.Pool, schemaName: string, filename: string): Promise<void> {
  const migrationDirectory = new URL('../migrations/', import.meta.url)
  const migration = (await readFile(new URL(filename, migrationDirectory), 'utf8')).replaceAll(
    '"public".',
    `"${schemaName}".`,
  )
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) await pool.query(statement)
  }
}

async function outboxConstraintDefinition(
  pool: pg.Pool,
  schemaName: string,
  constraintName: string,
): Promise<string> {
  const result = await pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(constraint_record.oid) AS definition
       FROM pg_constraint AS constraint_record
       JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = 'outbox_messages'
        AND constraint_record.conname = $2`,
    [schemaName, constraintName],
  )
  const definition = result.rows[0]?.definition
  if (definition === undefined) throw new Error(`Missing outbox constraint ${constraintName}`)
  return definition
}

import { readFile, readdir } from 'node:fs/promises'

import {
  ApprovalSchema,
  CapabilityIdSchema,
  ContextReceiptIdSchema,
  ContextReceiptSchema,
  CrewMemberIdSchema,
  CrewPreferenceIdSchema,
  CrewScheduleIdSchema,
  DeviceIdSchema,
  IdentityTagIdSchema,
  MembershipIdSchema,
  MissionIdSchema,
  MissionSchema,
  PalaceIdSchema,
  PlanSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  UserIdSchema,
  computePlanHash,
  type ContextReceipt,
  type OrganizationId,
  type RoutineDefinition,
} from '@trash-palace/core'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabase, type Database } from './client.js'
import { PgBootstrapRepository, PgCredentialRepository, createUnitOfWork } from './repositories.js'
import { outboxMessages, routineVersions, routines } from './schema.js'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip

const organizationId = 'org_primarytenant' as OrganizationId
const mirrorOrganizationId = 'org_mirrortenant' as OrganizationId
const userId = UserIdSchema.parse('usr_owneruser')
const membershipId = MembershipIdSchema.parse('mem_ownermember')
const palaceId = PalaceIdSchema.parse('pal_mainpalace')
const secondaryPalaceId = PalaceIdSchema.parse('pal_secondarypalace')
const missingPalaceId = PalaceIdSchema.parse('pal_missingpalace')
const crewMemberId = CrewMemberIdSchema.parse('crew_rockyresident')
const crewScheduleId = CrewScheduleIdSchema.parse('sch_rockyschedule')
const inactiveCrewScheduleId = CrewScheduleIdSchema.parse('sch_rockyinactive')
const crewPreferenceId = CrewPreferenceIdSchema.parse('pref_rockycomfort')
const inactiveCrewPreferenceId = CrewPreferenceIdSchema.parse('pref_rockyinactive')
const identityTagId = IdentityTagIdSchema.parse('tag_rockyverified')
const inactiveIdentityTagId = IdentityTagIdSchema.parse('tag_rockyinactive')
const protectedRoutineId = RoutineIdSchema.parse('rtn_oldroutine')
const protectedVersionId = RoutineVersionIdSchema.parse('rtv_oldversion')
const replacementRoutineId = RoutineIdSchema.parse('rtn_newroutine')
const replacementVersionId = RoutineVersionIdSchema.parse('rtv_newversion')
const missionId = 'mis_mainmission'
const missingMissionId = MissionIdSchema.parse('mis_missingmission')
const missingContextReceiptId = ContextReceiptIdSchema.parse('ctx_missingreceipt')
const planId = 'pln_mainplan01'
const actionId = 'act_replace001'
const approvalId = 'apr_approval01'
const thermostatId = DeviceIdSchema.parse('dev_thermostat1')
const temperatureCapabilityId = CapabilityIdSchema.parse('cap_temperature1')

const definition: RoutineDefinition = {
  name: 'Night Shift Homecoming',
  trigger: {
    type: 'verified_arrival',
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
    { type: 'unlock', durationSeconds: 90, requireVerifiedIdentity: true },
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
  projectedBatteryUsePercentagePoints: 13.2,
}

databaseDescribe('PostgreSQL repository contract', () => {
  let pool: pg.Pool
  let database: Database
  let schemaName: string

  beforeAll(async () => {
    schemaName = `trash_palace_test_${process.pid}_${Date.now()}`
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 1 })
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
  }, 30_000)

  afterAll(async () => {
    await pool.query('SET search_path TO public')
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  it('binds approval to current state, creates one server operation, and replaces atomically', async () => {
    const now = new Date()
    const createdAt = new Date(now.valueOf() - 60_000).toISOString()
    const approvedAt = new Date(now.valueOf() + 1_000).toISOString()
    const expiresAt = new Date(now.valueOf() + 10 * 60_000).toISOString()
    const bootstrap = new PgBootstrapRepository(database)
    await bootstrap.insertOrganization({
      id: organizationId,
      slug: 'primary-tenant',
      name: 'Primary Tenant',
      labTenant: true,
      createdAt,
    })
    await bootstrap.insertOrganization({
      id: mirrorOrganizationId,
      slug: 'mirror-tenant',
      name: 'Mirror Tenant',
      labTenant: false,
      createdAt,
    })
    await bootstrap.insertUser({ id: userId, displayName: 'Rocky', createdAt })

    const mission = MissionSchema.parse({
      id: missionId,
      organizationId,
      palaceId,
      initiatedBy: userId,
      objective: 'Replace the homecoming routine safely',
      constraints: {
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
      successCriteriaIds: ['routine_matches_plan'],
      state: { status: 'waiting_for_user', phase: 'approve' },
      version: 1,
      runId: null,
      contextReceiptId: null,
      taskLedger: [],
      createdAt,
      updatedAt: createdAt,
    })
    const contextReceipt = ContextReceiptSchema.parse({
      id: 'ctx_context0001',
      organizationId,
      missionId: mission.id,
      runId: 'run_context0001',
      policyHash: '1'.repeat(64),
      toolRegistryHash: '2'.repeat(64),
      sources: [
        {
          sourceId: 'host.policy',
          version: '1',
          contentHash: '3'.repeat(64),
          authority: 'host_policy',
        },
      ],
      createdAt,
    })
    const action = {
      id: actionId,
      type: 'replace_homecoming_routine' as const,
      palaceId,
      protectedRoutineId,
      protectedRoutineVersionId: protectedVersionId,
      expectedProtectedVersion: 3,
      replacementRoutineId,
      replacementRoutineVersionId: replacementVersionId,
      replacement: definition,
    }
    const planContent = {
      schemaVersion: 'plan-hash@1' as const,
      id: planId,
      organizationId,
      missionId,
      palaceId,
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
      status: 'awaiting_approval',
      createdAt,
    })
    const pendingApproval = ApprovalSchema.parse({
      id: approvalId,
      organizationId,
      missionId,
      planId,
      planHash: plan.hash,
      status: 'pending',
      actionIds: [actionId],
      protectedResources: [
        { routineId: protectedRoutineId, routineVersionId: protectedVersionId, version: 3 },
      ],
      requestedBy: userId,
      approvedBy: null,
      approverRole: null,
      nonce: 'approval_nonce_value_000001',
      createdAt,
      approvedAt: null,
      expiresAt,
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
      await repositories.records.insertPalace({
        id: palaceId,
        organizationId,
        name: 'Trash Palace',
        timezone: 'America/New_York',
        batteryAvailablePercentage: 62,
        createdAt,
      })
      await repositories.records.insertPalace({
        id: secondaryPalaceId,
        organizationId,
        name: 'Secondary Trash Palace',
        timezone: 'America/New_York',
        batteryAvailablePercentage: 80,
        createdAt,
      })
      await repositories.records.insertCrewMember({
        id: crewMemberId,
        organizationId,
        palaceId,
        userId,
        displayName: 'Rocky',
        active: true,
      })
      await repositories.records.insertIdentityTag({
        id: identityTagId,
        organizationId,
        crewMemberId,
        label: 'Rocky verified tag',
        verified: true,
        active: true,
        version: 1,
      })
      await repositories.records.insertIdentityTag({
        id: inactiveIdentityTagId,
        organizationId,
        crewMemberId,
        label: 'Rocky retired tag',
        verified: true,
        active: false,
        version: 2,
      })
      await repositories.records.insertCrewSchedule({
        id: crewScheduleId,
        organizationId,
        palaceId,
        crewMemberId,
        active: true,
        version: 1,
        timezone: 'America/New_York',
        windowStart: '00:00',
        windowEnd: '03:00',
      })
      await repositories.records.insertCrewSchedule({
        id: inactiveCrewScheduleId,
        organizationId,
        palaceId,
        crewMemberId,
        active: false,
        version: 2,
        timezone: 'America/New_York',
        windowStart: '21:00',
        windowEnd: '23:00',
      })
      await repositories.records.insertCrewPreference({
        id: crewPreferenceId,
        organizationId,
        palaceId,
        crewMemberId,
        kind: 'homecoming_comfort',
        active: true,
        version: 1,
        targetCelsius: 22,
        pathwayLightingIntensityPercent: 60,
        pathwayLightingDurationSeconds: 1_800,
      })
      await repositories.records.insertCrewPreference({
        id: inactiveCrewPreferenceId,
        organizationId,
        palaceId,
        crewMemberId,
        kind: 'homecoming_comfort',
        active: false,
        version: 2,
        targetCelsius: 19,
        pathwayLightingIntensityPercent: 30,
        pathwayLightingDurationSeconds: 600,
      })
      await repositories.records.insertDevice({
        id: thermostatId,
        organizationId,
        palaceId,
        kind: 'thermostat',
        name: 'Main thermostat',
        health: 'online',
        version: 1,
      })
      await repositories.records.insertCapability({
        id: temperatureCapabilityId,
        organizationId,
        deviceId: thermostatId,
        kind: 'temperature_target',
        enabled: true,
        constraints: { minimumCelsius: 5, maximumCelsius: 35 },
      })
      await repositories.records.insertRoutine(
        {
          id: protectedRoutineId,
          organizationId,
          palaceId,
          name: 'Midnight Entry',
          activeVersionId: protectedVersionId,
          createdAt,
        },
        {
          id: protectedVersionId,
          routineId: protectedRoutineId,
          organizationId,
          version: 3,
          status: 'active',
          definition: { ...definition, name: 'Midnight Entry' },
          sourcePlanId: null,
          sourcePlanHash: null,
          createdAt,
        },
      )
      await repositories.missions.insert(mission)
      await repositories.contextReceipts.insert(contextReceipt)
      await repositories.plans.insert(plan)
      await repositories.approvals.insert(pendingApproval)
    })

    const readProjection = await unitOfWork.run(organizationId, async (repositories) => ({
      palace: await repositories.palaces.get(palaceId),
      crew: await repositories.crews.list(palaceId),
      allCrew: await repositories.crews.list(palaceId, false),
      capabilities: await repositories.capabilities.list(palaceId),
      routines: await repositories.routines.list(palaceId, ['active']),
      routine: await repositories.routines.get(protectedRoutineId),
      contextReceipt: await repositories.contextReceipts.get(contextReceipt.id),
    }))
    expect(readProjection.palace).toMatchObject({ id: palaceId, organizationId })
    expect(readProjection.crew).toMatchObject({
      crew: [{ id: crewMemberId, organizationId, palaceId }],
      identityTags: [{ id: identityTagId, crewMemberId, active: true }],
      schedules: [{ id: crewScheduleId, crewMemberId, active: true }],
      preferences: [
        {
          id: crewPreferenceId,
          crewMemberId,
          active: true,
          pathwayLightingIntensityPercent: 60,
        },
      ],
    })
    expect(readProjection.allCrew.identityTags).toHaveLength(2)
    expect(readProjection.allCrew.schedules).toHaveLength(2)
    expect(readProjection.allCrew.preferences).toHaveLength(2)
    expect(readProjection.capabilities).toMatchObject({
      devices: [{ id: thermostatId, health: 'online' }],
      capabilities: [{ id: temperatureCapabilityId, deviceId: thermostatId }],
    })
    expect(readProjection.routines.routines.map((routine) => routine.id)).toEqual([
      protectedRoutineId,
    ])
    expect(readProjection.routine).toMatchObject({
      routine: { id: protectedRoutineId },
      version: { id: protectedVersionId, status: 'active' },
    })
    expect(readProjection.contextReceipt).toEqual(contextReceipt)

    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.records.insertCrewSchedule({
          id: CrewScheduleIdSchema.parse('sch_wrongpalace'),
          organizationId,
          palaceId: secondaryPalaceId,
          crewMemberId,
          active: true,
          version: 1,
          timezone: 'America/New_York',
          windowStart: '00:00',
          windowEnd: '03:00',
        }),
      ),
    ).rejects.toThrow(/crew_schedules_crew_palace_tenant_fk/)
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.contextReceipts.insert(contextReceipt),
      ),
    ).rejects.toThrow(/context_receipts_pkey/)
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.contextReceipts.insert(
          ContextReceiptSchema.parse({
            ...contextReceipt,
            id: 'ctx_foreign0001',
            organizationId: mirrorOrganizationId,
          }),
        ),
      ),
    ).rejects.toThrow(/authenticated organization/)
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.contextReceipts.insert({
          ...contextReceipt,
          id: 'ctx_malformed001',
          sources: [],
        } as unknown as ContextReceipt),
      ),
    ).rejects.toThrow()

    const credentials = new PgCredentialRepository(database)
    await credentials.issueSession({
      id: 'ses_fixture_session',
      organizationId,
      userId,
      membershipId,
      signedToken: 'signed-session-token-value-000001',
      csrfSecret: 'csrf-secret-value-that-is-long-0001',
      createdAt,
      expiresAt,
    })
    const authenticatedSession = await credentials.authenticateSession(
      'signed-session-token-value-000001',
      approvedAt,
    )
    expect(authenticatedSession).toMatchObject({
      organizationId,
      userId,
      membershipId,
      organizationSlug: 'primary-tenant',
      userDisplayName: 'Rocky',
    })
    await credentials.issueAccessToken({
      id: 'tok_fixture_token',
      organizationId,
      issuedBy: userId,
      bearerToken: 'mcp-bearer-token-value-0000001',
      scopes: ['routine:read', 'operation:reconcile'],
      createdAt,
      expiresAt,
    })
    const authenticatedToken = await credentials.authenticateAccessToken(
      'mcp-bearer-token-value-0000001',
      approvedAt,
    )
    expect(authenticatedToken).toMatchObject({
      organizationId,
      issuedBy: userId,
      scopes: ['routine:read', 'operation:reconcile'],
    })
    const wrongHashApproval = ApprovalSchema.parse({
      ...pendingApproval,
      id: 'apr_wronghash1',
      planHash: '0'.repeat(64),
      nonce: 'approval_nonce_wrong_hash_001',
    })
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.approvals.insert(wrongHashApproval),
      ),
    ).rejects.toThrow(/exact plan/)

    const operations = await unitOfWork.run(organizationId, async (repositories) => {
      const approved = ApprovalSchema.parse({
        ...pendingApproval,
        status: 'approved',
        approvedBy: userId,
        approverRole: 'owner',
        approvedAt,
      })
      await repositories.plans.save(PlanSchema.parse({ ...plan, status: 'approved' }))
      await repositories.approvals.save(approved)
      return repositories.operations.createForApprovedPlan(approvalId, approvedAt)
    })
    expect(operations).toHaveLength(1)
    expect(operations[0]!.id).toMatch(/^op_[a-f0-9]{32}$/)

    const replayedOperations = await unitOfWork.run(organizationId, (repositories) =>
      repositories.operations.createForApprovedPlan(approvalId, approvedAt),
    )
    expect(replayedOperations.map((operation) => operation.id)).toEqual(
      operations.map((operation) => operation.id),
    )

    const committed = await unitOfWork.run(organizationId, (repositories) =>
      repositories.activateApprovedOperation({
        operationId: operations[0]!.id,
        expectedVersion: 3,
        at: new Date(now.valueOf() + 2_000).toISOString(),
      }),
    )
    expect(committed.status).toBe('committed')
    expect(committed.outcome?.routineId).toBe(replacementRoutineId)

    const replay = await unitOfWork.run(organizationId, (repositories) =>
      repositories.activateApprovedOperation({
        operationId: operations[0]!.id,
        expectedVersion: 3,
        at: new Date(now.valueOf() + 3_000).toISOString(),
      }),
    )
    expect(replay).toEqual(committed)

    const versionRows = await database
      .select({ id: routineVersions.id, status: routineVersions.status })
      .from(routineVersions)
      .where(eq(routineVersions.organizationId, organizationId))
    expect(versionRows).toEqual(
      expect.arrayContaining([
        { id: protectedVersionId, status: 'inactive' },
        { id: replacementVersionId, status: 'active' },
      ]),
    )
    const replacementRows = await database
      .select()
      .from(routines)
      .where(
        and(eq(routines.organizationId, organizationId), eq(routines.id, replacementRoutineId)),
      )
    expect(replacementRows).toHaveLength(1)
    const outboxRows = await database
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.organizationId, organizationId))
    expect(outboxRows).toHaveLength(0)

    const crossTenant = await unitOfWork.run(mirrorOrganizationId, (repositories) =>
      repositories.operations.get(operations[0]!.id),
    )
    expect(crossTenant).toBeNull()

    const isolatedReads = await unitOfWork.run(mirrorOrganizationId, async (repositories) => ({
      foreign: {
        palace: await repositories.palaces.get(palaceId),
        crew: await repositories.crews.list(palaceId),
        capabilities: await repositories.capabilities.list(palaceId),
        routines: await repositories.routines.list(palaceId),
        routine: await repositories.routines.get(protectedRoutineId),
        executions: await repositories.executions.list({ missionId: mission.id, limit: 20 }),
        contextReceipt: await repositories.contextReceipts.get(contextReceipt.id),
      },
      absent: {
        palace: await repositories.palaces.get(missingPalaceId),
        crew: await repositories.crews.list(missingPalaceId),
        capabilities: await repositories.capabilities.list(missingPalaceId),
        routines: await repositories.routines.list(missingPalaceId),
        routine: await repositories.routines.get(RoutineIdSchema.parse('rtn_missingroutine')),
        executions: await repositories.executions.list({
          missionId: missingMissionId,
          limit: 20,
        }),
        contextReceipt: await repositories.contextReceipts.get(missingContextReceiptId),
      },
    }))
    expect(isolatedReads.foreign).toEqual(isolatedReads.absent)
    expect(isolatedReads.absent).toEqual({
      palace: null,
      crew: { crew: [], identityTags: [], schedules: [], preferences: [] },
      capabilities: { devices: [], capabilities: [] },
      routines: { routines: [], versions: [] },
      routine: null,
      executions: [],
      contextReceipt: null,
    })

    await expect(
      pool.query(`DELETE FROM "${schemaName}"."audit_events" WHERE organization_id = $1`, [
        organizationId,
      ]),
    ).rejects.toThrow(/append-only/)
    const retainedAudit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${schemaName}"."audit_events" WHERE organization_id = $1`,
      [organizationId],
    )
    expect(retainedAudit.rows[0]?.count).toBe('1')
    await expect(
      pool.query(`DELETE FROM "${schemaName}"."context_receipts" WHERE id = $1`, [
        contextReceipt.id,
      ]),
    ).rejects.toThrow(/append-only/)
  }, 30_000)
})

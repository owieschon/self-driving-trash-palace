import { readFile, readdir } from 'node:fs/promises'

import {
  ApprovalSchema,
  AttemptIdSchema,
  CapabilityIdSchema,
  CrewMemberIdSchema,
  DeviceIdSchema,
  EvidenceIdSchema,
  ExecutionIdSchema,
  ExecutionSchema,
  GatewayCallbackSchema,
  IdentityTelemetryEventSchema,
  IdentityTagIdSchema,
  MembershipIdSchema,
  MissionIdSchema,
  MissionSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PersistedEvidenceRecordSchema,
  PlanSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  UserIdSchema,
  computeGatewayCallbackPayloadHash,
  computePlanHash,
  createGatewayCommand,
  deriveGatewayCommandId,
  type GatewayCallback,
  type GatewayCommand,
  type OperationId,
  type PersistedEvidenceRecord,
  type RoutineDefinition,
} from '@trash-palace/core'
import {
  HmacIdentityTelemetryVerifier,
  IdentityTelemetryIngressService,
  type GatewayEffectMaterialization,
  type StoredExecution,
  type StoredGatewayCallback,
} from '@trash-palace/application'
import {
  OptimisticConcurrencyError,
  PgBootstrapRepository,
  createDatabase,
  createIdentityTelemetryIngressUnitOfWork,
  createUnitOfWork,
  type Database,
  type PgUnitOfWork,
} from '@trash-palace/db'
import {
  attempts,
  capabilities,
  gatewayCallbacks,
  gatewayCommands,
  gatewayDispatches,
  gatewayEffectReconciliationPolls,
  gatewayEffects,
  identityTags,
  outboxMessages,
} from '@trash-palace/db/schema'
import { signIdentityTelemetry } from '@trash-palace/gateway-simulator'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip

const organizationId = OrganizationIdSchema.parse('org_gatewayeffects')
const mirrorOrganizationId = OrganizationIdSchema.parse('org_gatewaymirror')
const userId = UserIdSchema.parse('usr_gatewayowner')
const palaceId = PalaceIdSchema.parse('pal_gatewaypalace')
const crewMemberId = CrewMemberIdSchema.parse('crew_gatewayrocky')
const identityTagId = IdentityTagIdSchema.parse('tag_gatewayrocky')
const thermostatId = DeviceIdSchema.parse('dev_gatewaythermostat')
const pathwayLightId = DeviceIdSchema.parse('dev_gatewaypathlight')
const lockId = DeviceIdSchema.parse('dev_gatewaylock')

const definition: RoutineDefinition = {
  name: 'Gateway effect homecoming',
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
  projectedBatteryUsePercentagePoints: 12,
}

interface Scenario {
  readonly suffix: string
  readonly missionId: ReturnType<typeof MissionIdSchema.parse>
  readonly operationId: OperationId
  readonly executionId: ReturnType<typeof ExecutionIdSchema.parse>
  readonly triggerEvidenceId: ReturnType<typeof EvidenceIdSchema.parse>
  readonly startedAt: string
  readonly deadline: string
  readonly commands: Readonly<{
    preheat: GatewayCommand
    pathwayLighting: GatewayCommand
    unlock: GatewayCommand
    relock: GatewayCommand
  }>
}

function at(base: Date, offsetMilliseconds: number): string {
  return new Date(base.valueOf() + offsetMilliseconds).toISOString()
}

function outboxId(suffix: string, purpose: string): string {
  return `out_gateway_${suffix}_${purpose}`
}

databaseDescribe('PostgreSQL durable gateway-effect pipeline', () => {
  let pool: pg.Pool
  let database: Database
  let unitOfWork: PgUnitOfWork
  let schemaName: string

  beforeAll(async () => {
    schemaName = `trash_palace_gateway_effects_${process.pid}_${Date.now()}`
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 12,
      options: `-c search_path=${schemaName},public`,
    })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
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
    unitOfWork = createUnitOfWork(database)
    const bootstrap = new PgBootstrapRepository(database)
    const createdAt = new Date(Date.now() - 120_000).toISOString()
    await bootstrap.insertOrganization({
      id: organizationId,
      slug: 'gateway-effects',
      name: 'Gateway Effects',
      labTenant: true,
      createdAt,
    })
    await bootstrap.insertOrganization({
      id: mirrorOrganizationId,
      slug: 'gateway-mirror',
      name: 'Gateway Mirror',
      labTenant: true,
      createdAt,
    })
    await bootstrap.insertUser({ id: userId, displayName: 'Rocky', createdAt })
    await unitOfWork.run(organizationId, async (repositories) => {
      await repositories.records.insertMembership({
        id: MembershipIdSchema.parse('mem_gatewayowner'),
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
        name: 'Gateway Test Palace',
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
      await repositories.records.insertDevice({
        id: thermostatId,
        organizationId,
        palaceId,
        kind: 'thermostat',
        name: 'Thermostat',
        health: 'online',
        version: 1,
      })
      await repositories.records.insertCapability({
        id: CapabilityIdSchema.parse('cap_gatewaytemp'),
        organizationId,
        deviceId: thermostatId,
        kind: 'temperature_target',
        enabled: true,
        constraints: { minimumCelsius: 5, maximumCelsius: 35 },
      })
      await repositories.records.insertDevice({
        id: pathwayLightId,
        organizationId,
        palaceId,
        kind: 'pathway_light',
        name: 'Pathway light',
        health: 'online',
        version: 1,
      })
      await repositories.records.insertCapability({
        id: CapabilityIdSchema.parse('cap_gatewaylight'),
        organizationId,
        deviceId: pathwayLightId,
        kind: 'pathway_lighting',
        enabled: true,
        constraints: { maximumDurationSeconds: 3_600 },
      })
      await repositories.records.insertDevice({
        id: lockId,
        organizationId,
        palaceId,
        kind: 'lock',
        name: 'Main lock',
        health: 'online',
        version: 1,
      })
      await repositories.records.insertCapability({
        id: CapabilityIdSchema.parse('cap_gatewaylock'),
        organizationId,
        deviceId: lockId,
        kind: 'lock_desired_state',
        enabled: true,
        constraints: { maximumUnlockSeconds: 300 },
      })
    })
  }, 30_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  async function seedScenario(suffix: string): Promise<Scenario> {
    const base = new Date(Date.now() - 60_000)
    const createdAt = at(base, 0)
    const approvedAt = at(base, 1_000)
    const committedAt = at(base, 2_000)
    const startedAt = at(base, 3_000)
    const deadline = at(base, 10 * 60_000)
    const missionId = MissionIdSchema.parse(`mis_${suffix}`)
    const protectedRoutineId = RoutineIdSchema.parse(`rtn_old_${suffix}`)
    const protectedVersionId = RoutineVersionIdSchema.parse(`rtv_old_${suffix}`)
    const replacementRoutineId = RoutineIdSchema.parse(`rtn_new_${suffix}`)
    const replacementVersionId = RoutineVersionIdSchema.parse(`rtv_new_${suffix}`)
    const planId = `pln_${suffix}`
    const actionId = `act_${suffix}`
    const approvalId = `apr_${suffix}`

    const mission = MissionSchema.parse({
      id: missionId,
      organizationId,
      palaceId,
      initiatedBy: userId,
      objective: `Exercise durable gateway effects for ${suffix}`,
      constraints: {
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
      successCriteriaIds: ['durable_effect'],
      state: { status: 'waiting_for_user', phase: 'approve' },
      version: 1,
      runId: null,
      contextReceiptId: null,
      taskLedger: [],
      createdAt,
      updatedAt: createdAt,
    })
    const action = {
      id: actionId,
      type: 'replace_homecoming_routine' as const,
      palaceId,
      protectedRoutineId,
      protectedRoutineVersionId: protectedVersionId,
      expectedProtectedVersion: 1,
      replacementRoutineId,
      replacementRoutineVersionId: replacementVersionId,
      replacement: { ...definition, name: `Routine ${suffix}` },
    }
    const planHashInput = {
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
    const { schemaVersion: _schemaVersion, ...planContent } = planHashInput
    const plan = PlanSchema.parse({
      ...planContent,
      hash: computePlanHash(planHashInput),
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
        { routineId: protectedRoutineId, routineVersionId: protectedVersionId, version: 1 },
      ],
      requestedBy: userId,
      approvedBy: null,
      approverRole: null,
      nonce: `approval_${suffix}_000000000000`,
      createdAt,
      approvedAt: null,
      expiresAt: at(base, 9 * 60_000),
    })

    const committed = await unitOfWork.run(organizationId, async (repositories) => {
      await repositories.records.insertRoutine(
        {
          id: protectedRoutineId,
          organizationId,
          palaceId,
          name: `Protected ${suffix}`,
          activeVersionId: protectedVersionId,
          createdAt,
        },
        {
          id: protectedVersionId,
          routineId: protectedRoutineId,
          organizationId,
          version: 1,
          status: 'active',
          definition: { ...definition, name: `Protected ${suffix}` },
          sourcePlanId: null,
          sourcePlanHash: null,
          createdAt,
        },
      )
      await repositories.missions.insert(mission)
      await repositories.plans.insert(plan)
      await repositories.approvals.insert(pendingApproval)
      await repositories.plans.save(PlanSchema.parse({ ...plan, status: 'approved' }))
      const approved = ApprovalSchema.parse({
        ...pendingApproval,
        status: 'approved',
        approvedBy: userId,
        approverRole: 'owner',
        approvedAt,
      })
      await repositories.approvals.save(approved)
      const [operation] = await repositories.operations.createForApprovedPlan(
        approvalId,
        approvedAt,
      )
      if (!operation) throw new Error('Scenario operation was not created')
      return repositories.activateApprovedOperation({
        operationId: operation.id,
        expectedVersion: 1,
        at: committedAt,
      })
    })
    if (committed.status !== 'committed' || !committed.outcome) {
      throw new Error('Scenario operation was not committed')
    }

    const triggerEvidenceId = EvidenceIdSchema.parse(`evd_activation_${suffix}`)
    const trigger = PersistedEvidenceRecordSchema.parse({
      evidence: {
        id: triggerEvidenceId,
        organizationId,
        missionId,
        palaceId,
        observedAt: committedAt,
        type: 'routine_state',
        routineId: replacementRoutineId,
        routineVersionId: replacementVersionId,
        active: true,
        planId,
        planHash: plan.hash,
      },
      authorityReceipt: {
        id: `rcp_activation_${suffix}`,
        evidenceId: triggerEvidenceId,
        organizationId,
        missionId,
        palaceId,
        verifiedAt: committedAt,
        authority: 'application',
        producer: 'application_code',
        ruleId: 'routine.activation.commit',
        ruleVersion: 1,
        inputEvidenceIds: [],
        derivationVerified: true,
      },
      persistedAt: committedAt,
    })
    const operationId = committed.id
    const commandIds = {
      preheat: deriveGatewayCommandId(operationId, 'homecoming.preheat'),
      pathwayLighting: deriveGatewayCommandId(operationId, 'homecoming.pathway-lighting'),
      unlock: deriveGatewayCommandId(operationId, 'homecoming.unlock'),
      relock: deriveGatewayCommandId(operationId, 'homecoming.relock'),
    }
    const executionId = ExecutionIdSchema.parse(`exe_${suffix}`)
    const storedExecution: StoredExecution = {
      operationId,
      authorization: { kind: 'manual' },
      execution: ExecutionSchema.parse({
        id: executionId,
        organizationId,
        missionId,
        operationId,
        routineId: replacementRoutineId,
        routineVersionId: replacementVersionId,
        status: 'scheduled',
        triggeredByEvidenceId: triggerEvidenceId,
        evidenceIds: [triggerEvidenceId],
        startedAt,
        deadline,
        milestones: [
          pendingMilestone('preheat', commandIds.preheat),
          pendingMilestone('verified_arrival', null),
          pendingMilestone('pathway_lighting', commandIds.pathwayLighting),
          pendingMilestone('unlock', commandIds.unlock),
          pendingMilestone('relock', commandIds.relock),
        ],
        updatedAt: startedAt,
        completedAt: null,
      }),
    }
    await unitOfWork.run(organizationId, async (repositories) => {
      await repositories.evidence.appendMany([trigger])
      await repositories.executions.insert(storedExecution)
    })

    return {
      suffix,
      missionId,
      operationId,
      executionId,
      triggerEvidenceId,
      startedAt,
      deadline,
      commands: {
        preheat: createGatewayCommand({
          organizationId,
          missionId,
          palaceId,
          operationId,
          logicalKey: 'homecoming.preheat',
          kind: 'set_temperature',
          payload: {
            deviceId: thermostatId,
            targetCelsius: 20,
            completeAt: deadline,
            causedByEvidenceId: null,
          },
          createdAt: startedAt,
        }),
        pathwayLighting: createGatewayCommand({
          organizationId,
          missionId,
          palaceId,
          operationId,
          logicalKey: 'homecoming.pathway-lighting',
          kind: 'set_lighting',
          payload: {
            deviceId: pathwayLightId,
            intensityPercent: 40,
            durationSeconds: 900,
            causedByEvidenceId: triggerEvidenceId,
          },
          createdAt: startedAt,
        }),
        unlock: createGatewayCommand({
          organizationId,
          missionId,
          palaceId,
          operationId,
          logicalKey: 'homecoming.unlock',
          kind: 'unlock',
          payload: {
            deviceId: lockId,
            identityTagId,
            durationSeconds: 90,
            causedByEvidenceId: triggerEvidenceId,
          },
          createdAt: startedAt,
        }),
        relock: createGatewayCommand({
          organizationId,
          missionId,
          palaceId,
          operationId,
          logicalKey: 'homecoming.relock',
          kind: 'locked_desired_state',
          payload: { deviceId: lockId, causedByEvidenceId: triggerEvidenceId },
          createdAt: startedAt,
        }),
      },
    }
  }

  function pendingMilestone(name: string, commandId: string | null) {
    return {
      name,
      commandId,
      status: 'pending' as const,
      evidenceId: null,
      resolvedAt: null,
      failure: null,
    }
  }

  function materialization(
    scenario: Scenario,
    key: keyof Scenario['commands'],
    options: Readonly<{ command?: GatewayCommand; outboxPurpose?: string }> = {},
  ): GatewayEffectMaterialization {
    const command = options.command ?? scenario.commands[key]
    const milestone =
      key === 'pathwayLighting' ? 'pathway_lighting' : key === 'preheat' ? 'preheat' : key
    return {
      intent: {
        command,
        dispatchAt: scenario.startedAt,
        milestone,
        cancellationPolicy: key === 'relock' ? 'mandatory_relock' : 'cancel_if_pending',
        authorization: { kind: 'manual' },
        createdAt: scenario.startedAt,
      },
      dispatchOutboxId: outboxId(scenario.suffix, options.outboxPurpose ?? `${key}_generation_1`),
    }
  }

  async function withSerializationRetry<Result>(work: () => Promise<Result>): Promise<Result> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await work()
      } catch (error) {
        if (!(error instanceof OptimisticConcurrencyError) || attempt === 4) throw error
      }
    }
    throw new Error('unreachable')
  }

  async function claim(scenario: Scenario, key: keyof Scenario['commands'], generation = 1) {
    return unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.claimDispatch({
        operationId: scenario.operationId,
        commandId: scenario.commands[key].id,
        generation,
        attemptId: AttemptIdSchema.parse(`att_${scenario.suffix}_${key}_${generation}`),
        claimedAt: new Date().toISOString(),
      }),
    )
  }

  async function acceptClaim(scenario: Scenario, key: keyof Scenario['commands'], generation = 1) {
    const claimed = await claim(scenario, key, generation)
    if (claimed?.status !== 'claimed')
      throw new Error(`Dispatch was not claimed: ${claimed?.status}`)
    const completedAt = new Date().toISOString()
    const finalized = await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.finalizeDispatch({
        operationId: scenario.operationId,
        commandId: scenario.commands[key].id,
        generation,
        attemptId: claimed.attempt.id,
        result: { status: 'accepted', acknowledgementId: `gack_${scenario.suffix}_${generation}` },
        completedAt,
        reconciliationOutboxId: outboxId(scenario.suffix, `${key}_${generation}_unused_reconcile`),
      }),
    )
    expect(finalized?.status).toBe('applied')
    return claimed
  }

  function callbackFixture(
    scenario: Scenario,
    command: GatewayCommand,
    status: GatewayCallback['status'],
    sequence: number,
  ): { callback: StoredGatewayCallback; evidence: readonly PersistedEvidenceRecord[] } {
    const occurredAt = new Date(Date.now() + sequence).toISOString()
    const callbackId = `gcb_${scenario.suffix}_${status}`
    const callbackEvidence =
      status === 'completed'
        ? [
            {
              id: `evd_${scenario.suffix}_command`,
              organizationId,
              missionId: scenario.missionId,
              palaceId,
              observedAt: occurredAt,
              type: 'device_command',
              deviceId: thermostatId,
              command: 'set_temperature',
              causedByEvidenceId: null,
            },
            {
              id: `evd_${scenario.suffix}_observation`,
              organizationId,
              missionId: scenario.missionId,
              palaceId,
              observedAt: occurredAt,
              type: 'temperature_observation',
              deviceId: thermostatId,
              celsius: 20,
            },
            {
              id: `evd_${scenario.suffix}_delivery`,
              organizationId,
              missionId: scenario.missionId,
              palaceId,
              observedAt: occurredAt,
              type: 'gateway_delivery',
              gatewayCommandId: command.id,
              operationId: scenario.operationId,
              status: 'completed',
              code: null,
            },
          ]
        : status === 'failed'
          ? [
              {
                id: `evd_${scenario.suffix}_failure`,
                organizationId,
                missionId: scenario.missionId,
                palaceId,
                observedAt: occurredAt,
                type: 'gateway_delivery',
                gatewayCommandId: command.id,
                operationId: scenario.operationId,
                status: 'failed',
                code: 'GATEWAY_REJECTED',
              },
            ]
          : []
    const wireCallback = GatewayCallbackSchema.parse({
      id: callbackId,
      organizationId,
      missionId: scenario.missionId,
      palaceId,
      commandId: command.id,
      operationId: scenario.operationId,
      status,
      occurredAt,
      nonce: `gwn_${`${scenario.suffix}_${status}_${sequence}`.padEnd(24, 'x')}`,
      evidence: callbackEvidence,
    })
    const digest = computeGatewayCallbackPayloadHash(wireCallback)
    const stored: StoredGatewayCallback = {
      ...wireCallback,
      verifierKeyId: 'gwk_gateway_effect_tests',
      verifierVersion: 1,
      verifiedPayloadDigest: digest,
      receivedAt: occurredAt,
    }
    const evidenceRecords = wireCallback.evidence.map((item, position) =>
      PersistedEvidenceRecordSchema.parse({
        evidence: item,
        authorityReceipt: {
          id: `rcp_${scenario.suffix}_${status}_${position}`,
          evidenceId: item.id,
          organizationId,
          missionId: scenario.missionId,
          palaceId,
          verifiedAt: occurredAt,
          authority: 'gateway_callback',
          callbackId: wireCallback.id,
          commandId: command.id,
          verifiedPayloadHash: digest,
          signatureVerified: true,
          commandBindingVerified: true,
        },
        persistedAt: occurredAt,
      }),
    )
    return { callback: stored, evidence: evidenceRecords }
  }

  it('materializes one immutable intent under a concurrent replay and rejects changed content', async () => {
    const scenario = await seedScenario('materialize01')
    const input = materialization(scenario, 'preheat')
    const [left, right] = await Promise.all([
      withSerializationRetry(() =>
        unitOfWork.run(organizationId, (repositories) =>
          repositories.gatewayEffects.materialize(input),
        ),
      ),
      withSerializationRetry(() =>
        unitOfWork.run(organizationId, (repositories) =>
          repositories.gatewayEffects.materialize(input),
        ),
      ),
    ])
    expect([left.status, right.status].sort()).toEqual(['created', 'existing'])

    const preheat = scenario.commands.preheat
    if (preheat.kind !== 'set_temperature') throw new Error('Preheat fixture has the wrong kind')
    const changed = createGatewayCommand({
      organizationId,
      missionId: scenario.missionId,
      palaceId,
      operationId: scenario.operationId,
      logicalKey: preheat.logicalKey,
      kind: 'set_temperature',
      payload: { ...preheat.payload, targetCelsius: 21 },
      createdAt: preheat.createdAt,
    })
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.gatewayEffects.materialize(
          materialization(scenario, 'preheat', {
            command: changed,
            outboxPurpose: 'conflicting_content',
          }),
        ),
      ),
    ).rejects.toThrow(/different immutable intent/)

    const [counts] = await database
      .select({
        commands: database.$count(gatewayCommands, eq(gatewayCommands.id, input.intent.command.id)),
        effects: database.$count(
          gatewayEffects,
          eq(gatewayEffects.commandId, input.intent.command.id),
        ),
        dispatches: database.$count(
          gatewayDispatches,
          eq(gatewayDispatches.commandId, input.intent.command.id),
        ),
        outbox: database.$count(
          outboxMessages,
          eq(outboxMessages.commandId, input.intent.command.id),
        ),
      })
      .from(gatewayCommands)
      .limit(1)
    expect(counts).toEqual({ commands: 1, effects: 1, dispatches: 1, outbox: 1 })
  })

  it('claims scheduled effects against the trusted virtual clock instead of database wall time', async () => {
    const scenario = await seedScenario('virtualclock1')
    const virtualDispatchAt = new Date(Date.now() + 24 * 60 * 60 * 1_000)
    const input = materialization(scenario, 'preheat')
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.materialize({
        ...input,
        intent: { ...input.intent, dispatchAt: virtualDispatchAt.toISOString() },
      }),
    )

    const beforeDue = await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.claimDispatch({
        operationId: scenario.operationId,
        commandId: scenario.commands.preheat.id,
        generation: 1,
        attemptId: AttemptIdSchema.parse('att_virtualclock1_before'),
        claimedAt: new Date(virtualDispatchAt.valueOf() - 1).toISOString(),
      }),
    )
    expect(beforeDue).toMatchObject({ status: 'not_claimed', reason: 'not_due' })
    expect(
      await database.$count(attempts, eq(attempts.gatewayCommandId, scenario.commands.preheat.id)),
    ).toBe(0)

    const atDue = await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.claimDispatch({
        operationId: scenario.operationId,
        commandId: scenario.commands.preheat.id,
        generation: 1,
        attemptId: AttemptIdSchema.parse('att_virtualclock1_due'),
        claimedAt: virtualDispatchAt.toISOString(),
      }),
    )
    expect(atDue?.status).toBe('claimed')
  })

  it('makes cancellation-before-claim terminal for dispatch without allocating an attempt', async () => {
    const scenario = await seedScenario('cancelwins01')
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.materialize(materialization(scenario, 'preheat')),
    )
    const cancellation = await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.cancelPendingForMission({
        missionId: scenario.missionId,
        requestedAt: new Date().toISOString(),
      }),
    )
    expect(cancellation.cancelledCommandIds).toEqual([scenario.commands.preheat.id])
    const result = await claim(scenario, 'preheat')
    expect(result).toMatchObject({ status: 'not_claimed', reason: 'cancelled' })
    expect(
      await database.$count(attempts, eq(attempts.gatewayCommandId, scenario.commands.preheat.id)),
    ).toBe(0)
  })

  it('preserves an in-flight dispatch when claim wins and marks reconciliation required', async () => {
    const scenario = await seedScenario('claimwins001')
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.materialize(materialization(scenario, 'preheat')),
    )
    const claimed = await claim(scenario, 'preheat')
    expect(claimed?.status).toBe('claimed')
    const cancellation = await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.cancelPendingForMission({
        missionId: scenario.missionId,
        requestedAt: new Date().toISOString(),
      }),
    )
    expect(cancellation.reconciliationCommandIds).toEqual([scenario.commands.preheat.id])
    expect(cancellation.cancelledCommandIds).toEqual([])
    expect(
      (
        await unitOfWork.run(organizationId, (repositories) =>
          repositories.gatewayEffects.get(scenario.commands.preheat.id),
        )
      )?.effectState.status,
    ).toBe('cancellation_requested')
  })

  it('revalidates identity telemetry and the current tag at claim time', async () => {
    const scenario = await seedScenario('revocation01')
    const identityKeyId = 'itk_gateway_effects'
    const identityKey = 'gateway-effects-identity-key-with-more-than-32-bytes'
    const identityEvent = IdentityTelemetryEventSchema.parse({
      schemaVersion: 'identity-telemetry-event@1',
      providerEventId: `idt_${scenario.suffix}_arrival`,
      organizationId,
      missionId: scenario.missionId,
      palaceId,
      identityTagId,
      observedAt: scenario.startedAt,
      nonce: `itn_${scenario.suffix}_arrival_00000000`,
    })
    const signedArrival = signIdentityTelemetry(identityEvent, {
      keyId: identityKeyId,
      key: identityKey,
      timestamp: scenario.startedAt,
    })
    const identityIngress = new IdentityTelemetryIngressService(
      createIdentityTelemetryIngressUnitOfWork(database),
      new HmacIdentityTelemetryVerifier({
        resolve: async (keyId) =>
          keyId === identityKeyId
            ? {
                key: identityKey,
                principal: {
                  principalId: 'itp_gateway_effects',
                  organizationId,
                  palaceId,
                  purpose: 'identity_telemetry_ingress',
                  keyId: identityKeyId,
                  keyVersion: 1,
                  validFrom: new Date(Date.parse(scenario.startedAt) - 60_000).toISOString(),
                  expiresAt: new Date(Date.parse(scenario.startedAt) + 60 * 60_000).toISOString(),
                  revokedAt: null,
                },
              }
            : null,
      }),
    )
    const arrival = await identityIngress.ingest(signedArrival)
    const arrivalEvidenceId = arrival.record.evidence.id
    const plannedUnlock = scenario.commands.unlock
    if (plannedUnlock.kind !== 'unlock') throw new Error('Unlock fixture has the wrong kind')
    const unlock = createGatewayCommand({
      organizationId,
      missionId: scenario.missionId,
      palaceId,
      operationId: scenario.operationId,
      logicalKey: plannedUnlock.logicalKey,
      kind: 'unlock',
      payload: { ...plannedUnlock.payload, causedByEvidenceId: arrivalEvidenceId },
      createdAt: plannedUnlock.createdAt,
    })
    await unitOfWork.run(organizationId, async (repositories) => {
      await repositories.gatewayEffects.materialize(
        materialization(scenario, 'unlock', { command: unlock }),
      )
    })
    await database
      .update(identityTags)
      .set({ active: false })
      .where(
        and(eq(identityTags.organizationId, organizationId), eq(identityTags.id, identityTagId)),
      )
    const result = await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.claimDispatch({
        operationId: scenario.operationId,
        commandId: unlock.id,
        generation: 1,
        attemptId: AttemptIdSchema.parse('att_revocation01_unlock'),
        claimedAt: new Date().toISOString(),
      }),
    )
    expect(result).toMatchObject({ status: 'not_claimed', reason: 'authorization_invalid' })
    await database
      .update(identityTags)
      .set({ active: true })
      .where(
        and(eq(identityTags.organizationId, organizationId), eq(identityTags.id, identityTagId)),
      )
  })

  it('accepts a late terminal callback after cancellation and preserves the cancellation audit', async () => {
    const scenario = await seedScenario('latecallback1')
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.materialize(materialization(scenario, 'preheat')),
    )
    await acceptClaim(scenario, 'preheat')
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.cancelPendingForMission({
        missionId: scenario.missionId,
        requestedAt: new Date().toISOString(),
      }),
    )

    for (const [index, status] of ['acknowledged', 'executing', 'completed'].entries()) {
      const callback = callbackFixture(
        scenario,
        scenario.commands.preheat,
        status as GatewayCallback['status'],
        index,
      )
      const applied = await unitOfWork.run(organizationId, (repositories) =>
        repositories.gatewayEffects.applyCallback(callback),
      )
      expect(applied?.status).toBe('advanced')
    }
    const [row] = await database
      .select()
      .from(gatewayEffects)
      .where(eq(gatewayEffects.commandId, scenario.commands.preheat.id))
    expect(row?.status).toBe('completed')
    expect(row?.cancellationRequestedAt).not.toBeNull()
  })

  it('deduplicates an exact callback and rejects a contradictory terminal callback atomically', async () => {
    const scenario = await seedScenario('callbackterm1')
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.materialize(materialization(scenario, 'preheat')),
    )
    const completed = callbackFixture(scenario, scenario.commands.preheat, 'completed', 1)
    const first = await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.applyCallback(completed),
    )
    const duplicate = await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.applyCallback(completed),
    )
    expect(first?.status).toBe('advanced')
    expect(duplicate?.status).toBe('duplicate')

    const failed = callbackFixture(scenario, scenario.commands.preheat, 'failed', 2)
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.gatewayEffects.applyCallback(failed),
      ),
    ).rejects.toThrow(/regress or contradict/)
    expect(
      await database.$count(
        gatewayCallbacks,
        and(
          eq(gatewayCallbacks.commandId, scenario.commands.preheat.id),
          eq(gatewayCallbacks.status, 'completed'),
        ),
      ),
    ).toBe(1)
    expect(await database.$count(gatewayCallbacks, eq(gatewayCallbacks.status, 'failed'))).toBe(0)
  })

  it('persists reconciliation polls and a new dispatch generation across repository restart', async () => {
    const scenario = await seedScenario('reconcile001')
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.materialize(materialization(scenario, 'preheat')),
    )
    const claimed = await claim(scenario, 'preheat')
    if (claimed?.status !== 'claimed') throw new Error('Dispatch was not claimed')
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.finalizeDispatch({
        operationId: scenario.operationId,
        commandId: scenario.commands.preheat.id,
        generation: 1,
        attemptId: claimed.attempt.id,
        result: { status: 'unknown', retryable: true, reason: 'timeout' },
        completedAt: new Date().toISOString(),
        reconciliationOutboxId: outboxId(scenario.suffix, 'unknown_reconcile'),
      }),
    )
    const reconciled = await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.reconcile({
        operationId: scenario.operationId,
        commandId: scenario.commands.preheat.id,
        generation: 1,
        reconciledAt: new Date().toISOString(),
        nextPollAt: new Date(Date.now() + 1_000).toISOString(),
        maximumAttempts: 3,
        dispatchOutboxId: outboxId(scenario.suffix, 'generation_2'),
        reconciliationOutboxId: outboxId(scenario.suffix, 'next_poll'),
      }),
    )
    expect(reconciled?.status).toBe('retry_authorized')

    const restartedUnitOfWork = createUnitOfWork(createDatabase(pool))
    const restored = await restartedUnitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.get(scenario.commands.preheat.id),
    )
    expect(restored?.dispatchState).toMatchObject({ generation: 2, status: 'pending' })
    expect(
      await database.$count(
        gatewayEffectReconciliationPolls,
        eq(gatewayEffectReconciliationPolls.commandId, scenario.commands.preheat.id),
      ),
    ).toBe(1)
    expect(
      await database.$count(
        gatewayDispatches,
        eq(gatewayDispatches.commandId, scenario.commands.preheat.id),
      ),
    ).toBe(2)
  })

  it('finalizes readiness only after the durable deadline when milestones remain pending', async () => {
    const scenario = await seedScenario('readiness001')
    const before = await unitOfWork.run(organizationId, (repositories) =>
      repositories.executions.evaluateReadiness({
        missionId: scenario.missionId,
        operationId: scenario.operationId,
        executionId: scenario.executionId,
        evaluatedAt: new Date(Date.parse(scenario.deadline) - 1).toISOString(),
      }),
    )
    expect(before?.status).toBe('not_ready')
    const deadline = await unitOfWork.run(organizationId, (repositories) =>
      repositories.executions.evaluateReadiness({
        missionId: scenario.missionId,
        operationId: scenario.operationId,
        executionId: scenario.executionId,
        evaluatedAt: scenario.deadline,
      }),
    )
    expect(deadline).toMatchObject({ status: 'finalized', reason: 'deadline_elapsed' })
    expect(deadline?.execution).toMatchObject({ status: 'failed', completedAt: scenario.deadline })
  })

  it('preserves mandatory relock and permits it after cancellation while rejecting new optional work', async () => {
    const scenario = await seedScenario('relockkeep01')
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.materialize(materialization(scenario, 'preheat')),
    )
    const requestedAt = new Date().toISOString()
    await unitOfWork.run(organizationId, async (repositories) => {
      await repositories.cancellations.insert({
        id: `can_${scenario.suffix}`,
        organizationId,
        missionId: scenario.missionId,
        requestedBy: userId,
        reason: 'User cancelled the homecoming run',
        checkpoint: 'durable_effect',
        outcome: 'stopped_remaining_actions',
        compensatingPlanRequired: false,
        requestedAt,
      })
      await repositories.gatewayEffects.cancelPendingForMission({
        missionId: scenario.missionId,
        requestedAt,
      })
    })
    const relock = await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.materialize(materialization(scenario, 'relock')),
    )
    expect(relock).toMatchObject({
      status: 'created',
      effect: { cancellationPolicy: 'mandatory_relock' },
    })
    await expect(
      unitOfWork.run(organizationId, (repositories) =>
        repositories.gatewayEffects.materialize(materialization(scenario, 'pathwayLighting')),
      ),
    ).rejects.toThrow(/Cancelled missions cannot materialize new optional effects/)
    const secondCancellation = await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.cancelPendingForMission({
        missionId: scenario.missionId,
        requestedAt: new Date(Date.now() + 1).toISOString(),
      }),
    )
    expect(secondCancellation.preservedCommandIds).toContain(scenario.commands.relock.id)
  })

  it('isolates tenants and rejects forged evidence authority before persistence', async () => {
    const scenario = await seedScenario('tenantiso001')
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.materialize(materialization(scenario, 'preheat')),
    )
    await expect(
      unitOfWork.run(mirrorOrganizationId, (repositories) =>
        repositories.gatewayEffects.get(scenario.commands.preheat.id),
      ),
    ).resolves.toBeNull()
    await expect(
      unitOfWork.run(mirrorOrganizationId, (repositories) =>
        repositories.gatewayEffects.materialize(materialization(scenario, 'preheat')),
      ),
    ).rejects.toThrow(/authenticated organization/)

    const forged = {
      evidence: {
        id: `evd_forged_${scenario.suffix}`,
        organizationId,
        missionId: scenario.missionId,
        palaceId,
        observedAt: scenario.startedAt,
        type: 'identity_arrival',
        identityTagId,
        verified: true,
      },
      authorityReceipt: {
        id: `rcp_forged_${scenario.suffix}`,
        evidenceId: `evd_forged_${scenario.suffix}`,
        organizationId,
        missionId: scenario.missionId,
        palaceId,
        verifiedAt: scenario.startedAt,
        authority: 'application',
        producer: 'application_code',
        ruleId: 'identity.forged',
        ruleVersion: 1,
        inputEvidenceIds: [],
        derivationVerified: true,
      },
      persistedAt: scenario.startedAt,
    } as unknown as PersistedEvidenceRecord
    await expect(
      unitOfWork.run(organizationId, (repositories) => repositories.evidence.appendMany([forged])),
    ).rejects.toThrow()
  })

  it('does not require command rows for planned execution milestone identities', async () => {
    const scenario = await seedScenario('plannedids01')
    expect(
      await database.$count(gatewayCommands, eq(gatewayCommands.operationId, scenario.operationId)),
    ).toBe(0)
    const stored = await unitOfWork.run(organizationId, (repositories) =>
      repositories.executions.get(scenario.executionId),
    )
    expect(stored?.execution.milestones.map((milestone) => milestone.commandId)).toEqual([
      scenario.commands.preheat.id,
      null,
      scenario.commands.pathwayLighting.id,
      scenario.commands.unlock.id,
      scenario.commands.relock.id,
    ])
  })

  it('reports capability revocation at claim time without allocating a gateway attempt', async () => {
    const scenario = await seedScenario('capability01')
    await unitOfWork.run(organizationId, (repositories) =>
      repositories.gatewayEffects.materialize(materialization(scenario, 'preheat')),
    )
    await database
      .update(capabilities)
      .set({ enabled: false })
      .where(
        and(
          eq(capabilities.organizationId, organizationId),
          eq(capabilities.deviceId, thermostatId),
          eq(capabilities.kind, 'temperature_target'),
        ),
      )
    const result = await claim(scenario, 'preheat')
    expect(result).toMatchObject({ status: 'not_claimed', reason: 'capability_unavailable' })
    expect(
      await database.$count(attempts, eq(attempts.gatewayCommandId, scenario.commands.preheat.id)),
    ).toBe(0)
    await database
      .update(capabilities)
      .set({ enabled: true })
      .where(
        and(
          eq(capabilities.organizationId, organizationId),
          eq(capabilities.deviceId, thermostatId),
          eq(capabilities.kind, 'temperature_target'),
        ),
      )
  })
})

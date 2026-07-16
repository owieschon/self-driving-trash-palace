import { readFile, readdir } from 'node:fs/promises'

import {
  ApprovalService,
  CryptoIdGenerator,
  ExecutionDeadlineService,
  GatewayCallbackService,
  GatewayDispatchService,
  GatewayEffectReconciliationService,
  HmacIdentityTelemetryVerifier,
  HomecomingPlanSimulator,
  HomecomingPlanValidator,
  IdentityArrivalExecutionJobHandler,
  IdentityTelemetryIngressService,
  MissionLeaseService,
  NOOP_OBSERVABILITY,
  OperationService,
  OutboxDispatcher,
  PlanService,
  PersistedEvidenceExecutionService,
  SeededSessionService,
  VerificationService,
  type AuthContext,
  type ClockPort,
  type GatewayEffectRecord,
  type GatewayPort,
} from '@trash-palace/application'
import {
  ContextReceiptSchema,
  EvidenceSchema,
  GatewayFaultDurableOutcomeCatalogSchema,
  MissionSchema,
  OperationIdSchema,
  PlanActionIdSchema,
  PrincipalSchema,
  ToolCallIdSchema,
  VerificationIdSchema,
  type NightShiftHomecomingFixture,
  NightShiftHomecomingFixtureSchema,
  type Operation,
} from '@trash-palace/core'
import {
  PgBootstrapRepository,
  attempts,
  createDatabase,
  createIdentityTelemetryIngressUnitOfWork,
  createMissionExecutionUnitOfWork,
  createSystemOutboxRepository,
  createUnitOfWork,
  evidence,
  gatewayCallbacks,
  gatewayDispatches,
  missionLeases,
  operations,
  outboxMessages,
  reconciliationPolls,
  routines,
  routineVersions,
  verifications as verificationRows,
  type Database,
  type PgUnitOfWork,
} from '@trash-palace/db'
import {
  GATEWAY_FAULT_PROFILES,
  GatewaySimulator,
  signIdentityTelemetry,
  verifyGatewayCallbackWithReceipt,
  type GatewayFaultProfile,
  type GatewayVerificationKeyRecord,
  type SignedGatewayCallback,
} from '@trash-palace/gateway-simulator'
import {
  DeterministicDeviceModel,
  FLAGSHIP_ACTIVATION_AT,
  FLAGSHIP_VERIFICATION_AT,
  VirtualClock,
  deterministicEvidenceId,
  verifyApplicationEvidence,
} from '@trash-palace/testkit'
import { composePgBossWorkerGraph, type PgBossWorkerGraph } from '@trash-palace/worker'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  LEGACY_LAB_ACTIVATION_CONTRACT,
  LegacyLabActivationAdapter,
} from './legacy-lab-activation.js'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip
const ACTIVATION_TOOL_CALL_ID = ToolCallIdSchema.parse('call_flagship_activate_01')
const gatewaySigningKeyId = 'gwk_flagship_integration'
const gatewaySigningKey = 'flagship-integration-signing-key-with-more-than-32-bytes'
const identitySigningKeyId = 'itk_flagship_identity'
const identitySigningKey = 'flagship-identity-signing-key-with-more-than-32-bytes'

function gatewayVerificationKey(
  fixture: NightShiftHomecomingFixture,
): GatewayVerificationKeyRecord {
  return {
    key: gatewaySigningKey,
    keyVersion: 1,
    purpose: 'gateway_callback',
    principal: {
      id: 'gwp_flagship_gateway',
      organizationId: fixture.primaryTenant.organization.id,
    },
  }
}

class VirtualApplicationClock implements ClockPort {
  public constructor(public readonly virtual: VirtualClock) {}

  public now(): Date {
    return new Date(this.virtual.now)
  }
}

async function waitFor<Result>(input: {
  readonly label: string
  readonly read: () => Promise<Result>
  readonly matches: (result: Result) => boolean
  readonly timeoutMilliseconds?: number
}): Promise<Result> {
  const deadline = Date.now() + (input.timeoutMilliseconds ?? 15_000)
  let result = await input.read()
  while (!input.matches(result) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    result = await input.read()
  }
  if (!input.matches(result)) throw new Error(`Timed out waiting for ${input.label}`)
  return result
}

async function loadCanonicalFixture(): Promise<NightShiftHomecomingFixture> {
  const fixtureUrl = new URL('../../../evals/fixtures/night-shift-homecoming.ts', import.meta.url)
  const loaded = (await import(fixtureUrl.href)) as Readonly<{
    NIGHT_SHIFT_HOMECOMING_FIXTURE: unknown
  }>
  return NightShiftHomecomingFixtureSchema.parse(loaded.NIGHT_SHIFT_HOMECOMING_FIXTURE)
}

async function loadGatewayFaultCatalog() {
  const catalogUrl = new URL(
    '../../../evals/integration/gateway-fault-manifests/index.ts',
    import.meta.url,
  )
  const loaded = (await import(catalogUrl.href)) as Readonly<{
    GATEWAY_FAULT_DURABLE_OUTCOME_CATALOG: unknown
  }>
  return GatewayFaultDurableOutcomeCatalogSchema.parse(loaded.GATEWAY_FAULT_DURABLE_OUTCOME_CATALOG)
}

function ownerContext(fixture: NightShiftHomecomingFixture): AuthContext {
  return {
    sessionId: 'session_flagship_integration_00000001',
    principal: PrincipalSchema.parse({
      organizationId: fixture.primaryTenant.organization.id,
      actorId: fixture.primaryTenant.user.id,
      role: 'owner',
      operatorGrants: [],
      delegatedPermissions: [],
    }),
    csrfToken: 'csrf_flagship_integration_000000001',
    issuedAt: FLAGSHIP_ACTIVATION_AT,
    authenticatedAt: FLAGSHIP_ACTIVATION_AT,
    expiresAt: '2026-08-14T09:44:00.000Z',
  }
}

function approvedReplacementAction(fixture: NightShiftHomecomingFixture) {
  const action = fixture.approvedPlan.actions[0]
  if (action?.type !== 'replace_homecoming_routine') {
    throw new Error('Flagship fixture requires one homecoming replacement action')
  }
  return action
}

interface ActivatedScenario {
  readonly operation: Operation
  readonly missionFenceEpoch: number
  readonly clock: VirtualClock
  readonly applicationClock: VirtualApplicationClock
  readonly ids: CryptoIdGenerator
  readonly simulator: GatewaySimulator
  readonly dispatch: GatewayDispatchService
  readonly callbacks: GatewayCallbackService<SignedGatewayCallback>
}

databaseDescribe('night-shift-homecoming@1 PostgreSQL 17 flagship proof', () => {
  let fixture: NightShiftHomecomingFixture
  let pool: pg.Pool
  let database: Database
  let unitOfWork: PgUnitOfWork
  let schemaName: string
  let serverCreatedOperation: Operation
  let legacy: LegacyLabActivationAdapter

  beforeAll(async () => {
    fixture = await loadCanonicalFixture()
    schemaName = `trash_palace_flagship_${process.pid}_${Date.now()}`
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
    legacy = new LegacyLabActivationAdapter(database)
    await legacy.install()
  }, 30_000)

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE legacy_lab_operations, organizations, users CASCADE')
    const bootstrap = new PgBootstrapRepository(database)
    await bootstrap.insertOrganization(fixture.primaryTenant.organization)
    await bootstrap.insertOrganization(fixture.mirrorTenant.organization)
    await bootstrap.insertUser(fixture.primaryTenant.user)
    await bootstrap.insertUser(fixture.mirrorTenant.user)

    serverCreatedOperation = await unitOfWork.run(
      fixture.primaryTenant.organization.id,
      async (repositories) => {
        await repositories.records.insertMembership(fixture.primaryTenant.membership)
        await repositories.records.insertPalace(fixture.primaryTenant.palace)
        await repositories.records.insertCrewMember(fixture.primaryTenant.crewMember)
        for (const schedule of fixture.primaryTenant.schedules) {
          await repositories.records.insertCrewSchedule(schedule)
        }
        for (const preference of fixture.primaryTenant.preferences) {
          await repositories.records.insertCrewPreference(preference)
        }
        for (const tag of fixture.primaryTenant.identityTags) {
          await repositories.records.insertIdentityTag(tag)
        }
        for (const device of fixture.primaryTenant.devices) {
          await repositories.records.insertDevice(device)
        }
        for (const capability of fixture.primaryTenant.capabilities) {
          await repositories.records.insertCapability(capability)
        }
        await repositories.records.insertRoutine(
          fixture.primaryTenant.existingRoutine,
          fixture.primaryTenant.existingRoutineVersion,
        )
        await repositories.missions.insert(fixture.mission)
        if (fixture.mission.contextReceiptId === null || fixture.mission.runId === null) {
          throw new Error('Flagship fixture must pin its run and context receipt')
        }
        await repositories.contextReceipts.insert(
          ContextReceiptSchema.parse({
            id: fixture.mission.contextReceiptId,
            organizationId: fixture.primaryTenant.organization.id,
            missionId: fixture.mission.id,
            runId: fixture.mission.runId,
            policyHash: 'a'.repeat(64),
            toolRegistryHash: 'b'.repeat(64),
            sources: [
              {
                sourceId: 'flagship.tool-registry',
                version: 'tool-registry@1',
                contentHash: 'c'.repeat(64),
                authority: 'tool_contract',
              },
            ],
            createdAt: fixture.mission.createdAt,
          }),
        )
        await repositories.plans.insert(fixture.approvedPlan)
        await repositories.approvals.insert(fixture.approval)
        const [operation] = await repositories.operations.createForApprovedPlan(
          fixture.approval.id,
          fixture.approval.approvedAt ?? FLAGSHIP_ACTIVATION_AT,
        )
        if (operation === undefined) throw new Error('Approved fixture did not create an operation')
        return operation
      },
    )
    await unitOfWork.run(fixture.mirrorTenant.organization.id, async (repositories) => {
      await repositories.records.insertMembership(fixture.mirrorTenant.membership)
      await repositories.records.insertPalace(fixture.mirrorTenant.palace)
      await repositories.records.insertRoutine(
        fixture.mirrorTenant.similarRoutine,
        fixture.mirrorTenant.similarRoutineVersion,
      )
    })
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  async function activateThroughLostResponse(
    profile: GatewayFaultProfile = GATEWAY_FAULT_PROFILES.none,
  ): Promise<ActivatedScenario> {
    const clock = new VirtualClock({
      startsAt: fixture.clock.startsAt,
      virtualMinuteMilliseconds: fixture.clock.virtualMinuteMilliseconds,
    })
    clock.advanceTo(FLAGSHIP_ACTIVATION_AT)
    const applicationClock = new VirtualApplicationClock(clock)
    const ids = new CryptoIdGenerator()
    const missionUnitOfWork = createMissionExecutionUnitOfWork(database)
    const lease = await new MissionLeaseService(unitOfWork, applicationClock, ids).acquire({
      organizationId: fixture.primaryTenant.organization.id,
      missionId: fixture.mission.id,
      ownerId: 'flagship-worker',
    })
    const executionContext = {
      fence: lease.fence,
      signal: new AbortController().signal,
      principal: PrincipalSchema.parse({
        organizationId: fixture.primaryTenant.organization.id,
        actorId: fixture.primaryTenant.user.id,
        role: 'service',
        operatorGrants: [],
        delegatedPermissions: [],
      }),
    }
    const operationsService = new OperationService(
      unitOfWork,
      applicationClock,
      ids,
      NOOP_OBSERVABILITY,
      missionUnitOfWork,
      undefined,
      { shouldLoseCommittedResponse: () => true },
    )

    const activation = await operationsService.activate({
      authorization: 'mission_lease',
      context: executionContext,
      planId: fixture.approvedPlan.id,
      actionId: fixture.approvedPlan.actions[0]!.id,
      expectedVersion: 3,
      toolCallId: ACTIVATION_TOOL_CALL_ID,
    })
    if (activation.status !== 'committed' || activation.delivery.status !== 'unknown') {
      throw new Error('Flagship activation did not retain its configured response loss')
    }
    const reconciled = await operationsService.reconcile({
      organizationId: fixture.primaryTenant.organization.id,
      operationId: serverCreatedOperation.id,
      attemptId: activation.delivery.attemptId,
    })
    if (reconciled.resolution !== 'committed') {
      throw new Error('Committed flagship activation did not reconcile')
    }

    const deviceModel = new DeterministicDeviceModel({
      organizationId: fixture.primaryTenant.organization.id,
      palaceId: fixture.primaryTenant.palace.id,
      devices: fixture.primaryTenant.devices,
      identityTags: fixture.primaryTenant.identityTags,
      startsAt: fixture.clock.startsAt,
      batteryAvailablePercentage: fixture.primaryTenant.palace.batteryAvailablePercentage,
      initialTemperatureCelsius: 18,
    })
    const simulator = new GatewaySimulator({
      clock,
      deviceModel,
      signingKeyId: gatewaySigningKeyId,
      signingKey: gatewaySigningKey,
      faultProfile: profile,
    })
    const gateway: GatewayPort = {
      dispatch: async (command) => simulator.dispatch(command),
    }
    const dispatch = new GatewayDispatchService(unitOfWork, gateway, applicationClock, ids)
    const callbacks = new GatewayCallbackService<SignedGatewayCallback>(
      unitOfWork,
      {
        verify: async (raw) =>
          verifyGatewayCallbackWithReceipt(raw, {
            keyring: { [gatewaySigningKeyId]: gatewayVerificationKey(fixture) },
            now: applicationClock.now(),
          }),
      },
      undefined,
      applicationClock,
      ids,
    )
    await new MissionLeaseService(unitOfWork, applicationClock, ids).release(lease.fence)
    return {
      operation: reconciled.operation,
      missionFenceEpoch: lease.fence.epoch,
      clock,
      applicationClock,
      ids,
      simulator,
      dispatch,
      callbacks,
    }
  }

  async function effectsFor(operationId: Operation['id']): Promise<readonly GatewayEffectRecord[]> {
    return unitOfWork.run(fixture.primaryTenant.organization.id, (repositories) =>
      repositories.gatewayEffects.listForOperation(operationId),
    )
  }

  async function rawTenantMutationSurface(organizationId: string) {
    const [routineRows, operationRows, evidenceRows, callbackRows] = await Promise.all([
      database
        .select({ id: routineVersions.id, status: routineVersions.status })
        .from(routineVersions)
        .where(eq(routineVersions.organizationId, organizationId)),
      database
        .select({ id: operations.id, status: operations.status })
        .from(operations)
        .where(eq(operations.organizationId, organizationId)),
      database
        .select({ id: evidence.id, type: evidence.type })
        .from(evidence)
        .where(eq(evidence.organizationId, organizationId)),
      database
        .select({ id: gatewayCallbacks.id, status: gatewayCallbacks.status })
        .from(gatewayCallbacks)
        .where(eq(gatewayCallbacks.organizationId, organizationId)),
    ])
    const byId = <Row extends { readonly id: string }>(rows: readonly Row[]) =>
      [...rows].sort((left, right) => left.id.localeCompare(right.id))
    return {
      routines: byId(routineRows),
      operations: byId(operationRows),
      evidence: byId(evidenceRows),
      callbacks: byId(callbackRows),
    }
  }

  async function faultDurableState(
    scenario: ActivatedScenario,
    preheat: GatewayEffectRecord,
    callbackResults: readonly { readonly status: 'duplicate' | 'replayed' | 'stored' }[],
  ) {
    const organizationId = fixture.primaryTenant.organization.id
    const [ledger, durable, effectRows, outboxRows, generationRows, callbackRows] =
      await Promise.all([
        unitOfWork.run(organizationId, async (repositories) => ({
          mission: await repositories.missions.get(scenario.operation.missionId),
          attempts: await repositories.attempts.listForOperation(scenario.operation.id),
          verification: await repositories.verifications.findForMission(
            scenario.operation.missionId,
          ),
        })),
        Promise.all([
          database
            .select({ id: operations.id, status: operations.status, outcome: operations.outcome })
            .from(operations)
            .where(
              and(
                eq(operations.organizationId, organizationId),
                eq(operations.planId, scenario.operation.planId),
                eq(operations.planActionId, scenario.operation.planActionId),
              ),
            ),
          database
            .select({ id: routines.id })
            .from(routines)
            .where(
              and(
                eq(routines.organizationId, organizationId),
                eq(routines.id, approvedReplacementAction(fixture).replacementRoutineId),
              ),
            ),
          database
            .select({ id: routineVersions.id, status: routineVersions.status })
            .from(routineVersions)
            .where(
              and(
                eq(routineVersions.organizationId, organizationId),
                eq(
                  routineVersions.routineId,
                  approvedReplacementAction(fixture).replacementRoutineId,
                ),
              ),
            ),
          database
            .select({ id: routineVersions.id, status: routineVersions.status })
            .from(routineVersions)
            .where(
              and(
                eq(routineVersions.organizationId, organizationId),
                eq(
                  routineVersions.id,
                  approvedReplacementAction(fixture).protectedRoutineVersionId,
                ),
              ),
            ),
          database.$count(
            evidence,
            and(
              eq(evidence.organizationId, organizationId),
              eq(evidence.authorityCommandId, preheat.command.id),
            ),
          ),
          database.$count(
            verificationRows,
            and(
              eq(verificationRows.organizationId, organizationId),
              eq(verificationRows.missionId, scenario.operation.missionId),
            ),
          ),
        ]),
        effectsFor(scenario.operation.id),
        database
          .select({ topic: outboxMessages.topic, status: outboxMessages.status })
          .from(outboxMessages)
          .where(eq(outboxMessages.organizationId, organizationId)),
        database
          .select({ generation: gatewayDispatches.generation, status: gatewayDispatches.status })
          .from(gatewayDispatches)
          .where(eq(gatewayDispatches.commandId, preheat.command.id)),
        database
          .select({ status: gatewayCallbacks.status })
          .from(gatewayCallbacks)
          .where(eq(gatewayCallbacks.commandId, preheat.command.id)),
      ])
    const mission = ledger.mission
    const effect = effectRows[0]
    const [operationRows, replacementRows, replacementVersions, protectedVersions, evidenceCount] =
      durable
    if (mission === null || effect === undefined) {
      throw new Error('Fault checkpoint lacks its durable mission or effect')
    }
    const [activationAttempt, gatewayAttempt] = ledger.attempts
    if (activationAttempt === undefined || gatewayAttempt === undefined) {
      throw new Error('Fault checkpoint lacks its activation and gateway attempts')
    }
    const currentGeneration = [...generationRows].sort(
      (left, right) => right.generation - left.generation,
    )[0]
    if (currentGeneration === undefined || callbackRows[0] === undefined) {
      throw new Error('Fault checkpoint lacks its gateway generation or callback')
    }
    const statusesFor = (topic: string) =>
      outboxRows
        .filter((row) => row.topic === topic)
        .map((row) => row.status)
        .sort()
    const topicExpectation = (topic: string) => {
      const statuses = statusesFor(topic)
      return { count: statuses.length, statuses }
    }
    const attemptExpectation = (attempt: typeof activationAttempt) => ({
      sequence: attempt.sequence,
      transport: attempt.transport,
      status: attempt.status,
      retryable: attempt.retryable,
      errorCode: attempt.error?.code ?? null,
    })
    const dispatchUnknownReason =
      effect.dispatchState.status === 'unknown' ? effect.dispatchState.reason : null
    const dispatchErrorCode =
      effect.dispatchState.status === 'failed' ? effect.dispatchState.error.code : null
    const verificationCount = durable[5]
    const replacementActiveCount = replacementVersions.filter(
      (version) => version.status === 'active',
    ).length
    const operationOutcomeCount = operationRows.filter(
      (row) => row.status === 'committed' && row.outcome !== null,
    ).length

    return {
      mission: {
        state: mission.state,
        terminal: ['cancelled', 'failed', 'succeeded'].includes(mission.state.status),
      },
      verification: {
        presence: ledger.verification === null ? 'absent' : 'present',
        count: verificationCount,
        status: ledger.verification?.status ?? null,
        assertionCount: ledger.verification?.assertions.length ?? 0,
        reason: ledger.verification === null ? 'not_run_at_observation_point' : 'already_verified',
      },
      routines: {
        operationOutcomeCount,
        replacementRoutineCount: replacementRows.length,
        activeReplacementCount: replacementActiveCount,
        inactiveProtectedCount: protectedVersions.filter((version) => version.status === 'inactive')
          .length,
        duplicateDurableOutcomeCount: Math.max(0, operationOutcomeCount - 1),
      },
      effect: {
        materializedCount: effectRows.length,
        milestone: effect.milestone,
        status: effect.effectState.status,
        dispatchStatus: effect.dispatchState.status,
        dispatchUnknownReason,
        dispatchErrorCode,
        persistedEvidenceCount: evidenceCount,
      },
      attempts: {
        totalCount: ledger.attempts.length,
        activationTransport: attemptExpectation(activationAttempt),
        gatewayTransport: attemptExpectation(gatewayAttempt),
      },
      generation: {
        totalCount: generationRows.length,
        current: currentGeneration.generation,
        currentStatus: currentGeneration.status,
      },
      callback: {
        deliveredCount: scenario.simulator.deliveredCallbacks.length,
        persistedUniqueCount: callbackRows.length,
        duplicateDeliveryCount: scenario.simulator.deliveredCallbacks.length - callbackRows.length,
        terminalStatus: callbackRows[0].status,
        ingestionResults: callbackResults.map((result) => result.status),
      },
      outbox: {
        totalCount: outboxRows.length,
        operationReconcile: topicExpectation('operation.reconcile'),
        gatewayDispatch: topicExpectation('gateway.dispatch'),
        gatewayEffectReconcile: topicExpectation('gateway.effect.reconcile'),
        executionDeadline: topicExpectation('execution.deadline'),
        missionVerify: topicExpectation('mission.verify'),
        missionResume: topicExpectation('mission.resume'),
      },
    }
  }

  async function dispatchEffect(
    scenario: ActivatedScenario,
    effect: GatewayEffectRecord,
  ): Promise<Awaited<ReturnType<GatewayDispatchService['dispatch']>>> {
    return scenario.dispatch.dispatch({
      organizationId: fixture.primaryTenant.organization.id,
      operationId: scenario.operation.id,
      commandId: effect.command.id,
      generation: effect.dispatchState.generation,
    })
  }

  async function persistArrival(
    scenario: ActivatedScenario,
    arrival: NightShiftHomecomingFixture['observationSchedule'][number],
  ) {
    scenario.clock.advanceTo(arrival.observedAt)
    const eventSuffix = arrival.id.replace(/^evd_/, '')
    const signed = signIdentityTelemetry(
      {
        schemaVersion: 'identity-telemetry-event@1',
        providerEventId: `idt_${eventSuffix}_provider`,
        organizationId: arrival.organizationId,
        missionId: arrival.missionId,
        palaceId: arrival.palaceId,
        identityTagId: arrival.identityTagId,
        observedAt: arrival.observedAt,
        nonce: `itn_${eventSuffix}_0000000000000000`,
      },
      {
        keyId: identitySigningKeyId,
        key: identitySigningKey,
        timestamp: arrival.observedAt,
      },
    )
    const ingress = new IdentityTelemetryIngressService(
      createIdentityTelemetryIngressUnitOfWork(database),
      new HmacIdentityTelemetryVerifier(
        {
          resolve: async (keyId) =>
            keyId === identitySigningKeyId
              ? {
                  key: identitySigningKey,
                  principal: {
                    principalId: 'itp_flagship_gateway',
                    organizationId: fixture.primaryTenant.organization.id,
                    palaceId: fixture.primaryTenant.palace.id,
                    purpose: 'identity_telemetry_ingress',
                    keyId: identitySigningKeyId,
                    keyVersion: 1,
                    validFrom: fixture.clock.startsAt,
                    expiresAt: '2026-08-15T05:35:00.000Z',
                    revokedAt: null,
                  },
                }
              : null,
        },
        scenario.applicationClock,
      ),
      scenario.applicationClock,
    )
    const record = await ingress.ingest(signed)
    return new PersistedEvidenceExecutionService(
      unitOfWork,
      undefined,
      scenario.applicationClock,
      scenario.ids,
    ).apply({
      organizationId: fixture.primaryTenant.organization.id,
      operationId: scenario.operation.id,
      evidenceId: record.record.evidence.id,
    })
  }

  it('reconciles a committed activation after its response is lost with one operation and one replacement routine', async () => {
    const scenario = await activateThroughLostResponse()
    const [operationCount, attemptCount, pollCount, activeReplacementCount] = await Promise.all([
      database.$count(
        operations,
        and(
          eq(operations.organizationId, fixture.primaryTenant.organization.id),
          eq(operations.planId, fixture.approvedPlan.id),
          eq(operations.planActionId, fixture.approvedPlan.actions[0]!.id),
        ),
      ),
      database.$count(attempts, eq(attempts.operationId, scenario.operation.id)),
      database.$count(
        reconciliationPolls,
        eq(reconciliationPolls.operationId, scenario.operation.id),
      ),
      database.$count(
        routineVersions,
        and(
          eq(routineVersions.organizationId, fixture.primaryTenant.organization.id),
          eq(routineVersions.sourcePlanId, fixture.approvedPlan.id),
          eq(routineVersions.status, 'active'),
        ),
      ),
    ])
    expect({ operationCount, attemptCount, pollCount, activeReplacementCount }).toEqual({
      operationCount: 1,
      attemptCount: 1,
      pollCount: 1,
      activeReplacementCount: 1,
    })
    expect(scenario.operation).toMatchObject({
      id: serverCreatedOperation.id,
      serverCreated: true,
      status: 'committed',
      outcome: {
        routineId: approvedReplacementAction(fixture).replacementRoutineId,
        routineVersionId: approvedReplacementAction(fixture).replacementRoutineVersionId,
      },
    })
    const [protectedVersion] = await database
      .select({ status: routineVersions.status })
      .from(routineVersions)
      .where(eq(routineVersions.id, fixture.primaryTenant.existingRoutineVersion.id))
    expect(protectedVersion?.status).toBe('inactive')
    const storedExecution = await unitOfWork.run(
      fixture.primaryTenant.organization.id,
      (repositories) => repositories.executions.findForOperation(scenario.operation.id),
    )
    expect(storedExecution?.authorization).toEqual({
      kind: 'mission_lease',
      epoch: scenario.missionFenceEpoch,
    })
    expect((await effectsFor(scenario.operation.id))[0]?.authorization).toEqual({
      kind: 'mission_lease',
      epoch: scenario.missionFenceEpoch,
    })
    const [releasedLease] = await database
      .select({ releasedAt: missionLeases.releasedAt })
      .from(missionLeases)
      .where(eq(missionLeases.missionId, fixture.mission.id))
    expect(releasedLease?.releasedAt).toBeInstanceOf(Date)
  })

  it('completes the manual flagship through production services, outbox, pg-boss, WorkerRuntime, and verification', async () => {
    const connectionString = process.env.TEST_DATABASE_URL
    if (connectionString === undefined) throw new Error('TEST_DATABASE_URL is required')
    const mirrorBefore = await rawTenantMutationSurface(fixture.mirrorTenant.organization.id)
    const clock = new VirtualClock({
      startsAt: fixture.clock.startsAt,
      virtualMinuteMilliseconds: fixture.clock.virtualMinuteMilliseconds,
    })
    clock.advanceTo(FLAGSHIP_ACTIVATION_AT)
    const applicationClock = new VirtualApplicationClock(clock)
    const ids = new CryptoIdGenerator()
    const mission = MissionSchema.parse({
      ...fixture.mission,
      id: 'mis_manual_flagship',
      state: { status: 'running', phase: 'plan' },
      version: 5,
      runId: 'run_manual_flagship',
      contextReceiptId: 'ctx_manual_flagship',
      taskLedger: fixture.mission.taskLedger.map((item) => ({
        ...item,
        status: item.id === 'activate_once' ? 'pending' : item.status,
      })),
      updatedAt: FLAGSHIP_ACTIVATION_AT,
    })
    await unitOfWork.run(fixture.primaryTenant.organization.id, async (repositories) => {
      await repositories.missions.insert(mission)
      if (mission.contextReceiptId === null || mission.runId === null) {
        throw new Error('Manual flagship requires its context receipt binding')
      }
      await repositories.contextReceipts.insert(
        ContextReceiptSchema.parse({
          id: mission.contextReceiptId,
          organizationId: mission.organizationId,
          missionId: mission.id,
          runId: mission.runId,
          policyHash: 'a'.repeat(64),
          toolRegistryHash: 'b'.repeat(64),
          sources: [
            {
              sourceId: 'flagship.tool-registry',
              version: 'tool-registry@1',
              contentHash: 'c'.repeat(64),
              authority: 'tool_contract',
            },
          ],
          createdAt: mission.createdAt,
        }),
      )
    })

    const session = new SeededSessionService(
      'flagship-session-signing-key-with-more-than-32-bytes',
      applicationClock,
    )
    const context = session.verify(
      session.issue(
        PrincipalSchema.parse({
          organizationId: fixture.primaryTenant.organization.id,
          actorId: fixture.primaryTenant.user.id,
          role: 'owner',
          operatorGrants: [],
          delegatedPermissions: [],
        }),
      ),
    )
    const plans = new PlanService(
      unitOfWork,
      new HomecomingPlanValidator(unitOfWork),
      new HomecomingPlanSimulator(),
      applicationClock,
      ids,
    )
    expect(
      await unitOfWork.run(fixture.primaryTenant.organization.id, (repositories) =>
        repositories.routines.getCurrentVersion(
          approvedReplacementAction(fixture).protectedRoutineId,
        ),
      ),
    ).toEqual({
      routineId: approvedReplacementAction(fixture).protectedRoutineId,
      routineVersionId: approvedReplacementAction(fixture).protectedRoutineVersionId,
      version: approvedReplacementAction(fixture).expectedProtectedVersion,
    })
    const manualAction = {
      ...approvedReplacementAction(fixture),
      id: PlanActionIdSchema.parse('act_manual_homecoming'),
    } as const
    const candidate = await plans.propose({
      context,
      missionId: mission.id,
      revision: 1,
      actions: [manualAction],
      successCriteriaIds: mission.successCriteriaIds,
    })
    const validation = await plans.validate({ context, planId: candidate.id })
    if (!validation.valid) throw new Error(JSON.stringify(validation.checks, null, 2))
    const simulation = await plans.simulate({
      context,
      planId: candidate.id,
      scenarios: ['access', 'energy', 'timing', 'transport_failure'],
    })
    const approvals = new ApprovalService(unitOfWork, session, applicationClock, ids)
    const pendingApproval = await approvals.request({ context, planId: candidate.id })
    const decision = await approvals.decide({
      context,
      approvalId: pendingApproval.id,
      nonce: pendingApproval.nonce,
      decision: 'approve',
      csrfToken: context.csrfToken,
      origin: 'http://trash-palace.local',
      allowedOrigin: 'http://trash-palace.local',
    })
    if (decision.status !== 'approved') throw new Error('Manual flagship approval did not pass')
    const [operation] = decision.operations
    if (operation === undefined) throw new Error('Approval did not create a logical operation')
    const activation = await new OperationService(unitOfWork, applicationClock, ids).activate({
      authorization: 'manual',
      context,
      planId: candidate.id,
      actionId: manualAction.id,
      expectedVersion: 3,
      toolCallId: ACTIVATION_TOOL_CALL_ID,
    })
    if (activation.status !== 'committed') throw new Error('Manual flagship activation failed')

    expect(validation.valid).toBe(true)
    expect(simulation).toMatchObject({ feasible: true })
    expect(simulation.results.every((result) => result.passed)).toBe(true)
    expect(activation).toMatchObject({
      status: 'committed',
      replayed: false,
      operation: { id: operation.id, serverCreated: true },
    })
    expect(
      await unitOfWork.run(fixture.primaryTenant.organization.id, (repositories) =>
        repositories.missions.get(mission.id),
      ),
    ).toMatchObject({ state: { status: 'waiting_for_system', phase: 'observe' } })
    expect((await effectsFor(operation.id))[0]?.authorization).toEqual({ kind: 'manual' })

    const deviceModel = new DeterministicDeviceModel({
      organizationId: fixture.primaryTenant.organization.id,
      palaceId: fixture.primaryTenant.palace.id,
      devices: fixture.primaryTenant.devices,
      identityTags: fixture.primaryTenant.identityTags,
      startsAt: fixture.clock.startsAt,
      batteryAvailablePercentage: fixture.primaryTenant.palace.batteryAvailablePercentage,
      initialTemperatureCelsius: 18,
    })
    const simulator = new GatewaySimulator({
      clock,
      deviceModel,
      signingKeyId: gatewaySigningKeyId,
      signingKey: gatewaySigningKey,
    })
    const gateway: GatewayPort = { dispatch: async (command) => simulator.dispatch(command) }
    const gatewayDispatch = new GatewayDispatchService(unitOfWork, gateway, applicationClock, ids)
    const callbacks = new GatewayCallbackService<SignedGatewayCallback>(
      unitOfWork,
      {
        verify: async (raw) =>
          verifyGatewayCallbackWithReceipt(raw, {
            keyring: { [gatewaySigningKeyId]: gatewayVerificationKey(fixture) },
            now: applicationClock.now(),
          }),
      },
      undefined,
      applicationClock,
      ids,
    )
    const scenario: ActivatedScenario = {
      operation: activation.operation,
      missionFenceEpoch: 0,
      clock,
      applicationClock,
      ids,
      simulator,
      dispatch: gatewayDispatch,
      callbacks,
    }
    const workerId = 'manual-flagship-worker'
    const bossSchema = `tp_manual_boss_${process.pid}_${Date.now()}`
    let graph: PgBossWorkerGraph | undefined
    let outbox: OutboxDispatcher | undefined
    try {
      graph = await composePgBossWorkerGraph({
        connection: {
          connectionString,
          schema: bossSchema,
          application_name: 'trash-palace-manual-flagship',
        },
        buildDependencies: (queue) => {
          outbox = new OutboxDispatcher(
            unitOfWork,
            createSystemOutboxRepository(database),
            queue,
            applicationClock,
          )
          const servicePrincipal = PrincipalSchema.parse({
            organizationId: fixture.primaryTenant.organization.id,
            actorId: fixture.primaryTenant.user.id,
            role: 'service',
            operatorGrants: [],
            delegatedPermissions: [],
          })
          return {
            outbox,
            gatewayDispatch,
            gatewayEffectReconciliation: new GatewayEffectReconciliationService(
              unitOfWork,
              applicationClock,
              ids,
            ),
            executionDeadline: new ExecutionDeadlineService(unitOfWork, applicationClock, ids),
            identityArrivalExecution: new IdentityArrivalExecutionJobHandler(
              new PersistedEvidenceExecutionService(unitOfWork, undefined, applicationClock, ids),
            ),
            operations: new OperationService(unitOfWork, applicationClock, ids),
            verification: new VerificationService(unitOfWork, applicationClock, ids),
            leases: new MissionLeaseService(unitOfWork, applicationClock, ids),
            missionRunner: {
              resume: async () => {
                throw new Error('Manual flagship must not enqueue mission.resume')
              },
            },
            serviceContextFor: (organizationId) => {
              if (organizationId !== fixture.primaryTenant.organization.id) {
                throw new Error('Worker refused a foreign tenant context')
              }
              return { principal: servicePrincipal, source: 'worker' as const }
            },
            workerId,
          }
        },
      })
      await graph.runtime.start()
      if (outbox === undefined) throw new Error('Worker graph did not compose its outbox')

      await outbox.dispatchBatch({ ownerId: workerId })
      await waitFor({
        label: 'preheat dispatch through WorkerRuntime',
        read: () => effectsFor(operation.id),
        matches: (effects) =>
          effects.some(
            (effect) =>
              effect.milestone === 'preheat' && effect.dispatchState.status === 'accepted',
          ),
      })
      expect(simulator.recordedCommandCount).toBe(1)

      const [unverified, verified] = fixture.observationSchedule
      await persistArrival(scenario, { ...unverified, missionId: mission.id })
      await persistArrival(scenario, { ...verified, missionId: mission.id })
      await outbox.dispatchBatch({ ownerId: workerId })
      await waitFor({
        label: 'arrival effects through WorkerRuntime',
        read: () => effectsFor(operation.id),
        matches: (effects) =>
          ['pathway_lighting', 'unlock'].every((milestone) =>
            effects.some(
              (effect) =>
                effect.milestone === milestone && effect.dispatchState.status === 'accepted',
            ),
          ),
      })
      expect(simulator.recordedCommandCount).toBe(3)

      let callbackCursor = 0
      const ingestNewCallbacks = async () => {
        const delivered = simulator.deliveredCallbacks.slice(callbackCursor)
        callbackCursor += delivered.length
        for (const callback of delivered) await callbacks.ingest(callback)
      }
      clock.flushCurrent()
      await ingestNewCallbacks()

      const relock = (await effectsFor(operation.id)).find(
        (effect) => effect.milestone === 'relock',
      )
      if (relock === undefined) throw new Error('Unlock callback did not materialize relock')
      clock.advanceTo(relock.dispatchAt)
      await outbox.dispatchBatch({ ownerId: workerId })
      await waitFor({
        label: 'relock through WorkerRuntime',
        read: () => effectsFor(operation.id),
        matches: (effects) =>
          effects.some(
            (effect) => effect.milestone === 'relock' && effect.dispatchState.status === 'accepted',
          ),
      })
      expect(simulator.recordedCommandCount).toBe(4)
      clock.flushCurrent()
      await ingestNewCallbacks()

      clock.advanceTo(FLAGSHIP_VERIFICATION_AT)
      await ingestNewCallbacks()
      await outbox.dispatchBatch({ ownerId: workerId })
      const completedMission = await waitFor({
        label: 'deterministic verification through WorkerRuntime',
        read: () =>
          unitOfWork.run(fixture.primaryTenant.organization.id, (repositories) =>
            repositories.missions.get(mission.id),
          ),
        matches: (current) => current?.state.status === 'succeeded',
      })
      const verification = await unitOfWork.run(
        fixture.primaryTenant.organization.id,
        (repositories) => repositories.verifications.findForMission(mission.id),
      )

      expect(completedMission?.state).toEqual({ status: 'succeeded', phase: 'verify' })
      expect(verification?.status).toBe('passed')
      expect(verification?.assertions).toHaveLength(fixture.verifierPredicates.length)
      expect(
        (await effectsFor(operation.id)).every(
          (effect) => effect.effectState.status === 'completed',
        ),
      ).toBe(true)
      expect(simulator.deviceModel.snapshot(FLAGSHIP_VERIFICATION_AT)).toMatchObject({
        temperatureCelsius: 20,
        lightingIntensityPercent: 40,
        lockDesiredState: 'locked',
      })
      expect(await rawTenantMutationSurface(fixture.mirrorTenant.organization.id)).toEqual(
        mirrorBefore,
      )
    } finally {
      await graph?.runtime.stop().catch(() => undefined)
      await pool.query(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`)
    }
  }, 30_000)

  it('returns the original outcome for the same payload and conflicts on a changed expected version', async () => {
    const scenario = await activateThroughLostResponse()
    const service = new OperationService(unitOfWork, scenario.applicationClock, scenario.ids)
    const replay = await service.activate({
      authorization: 'manual',
      context: ownerContext(fixture),
      planId: fixture.approvedPlan.id,
      actionId: fixture.approvedPlan.actions[0]!.id,
      expectedVersion: 3,
      toolCallId: ACTIVATION_TOOL_CALL_ID,
    })
    const conflict = await service.activate({
      authorization: 'manual',
      context: ownerContext(fixture),
      planId: fixture.approvedPlan.id,
      actionId: fixture.approvedPlan.actions[0]!.id,
      expectedVersion: 4,
      toolCallId: ACTIVATION_TOOL_CALL_ID,
    })
    expect(replay).toMatchObject({
      status: 'committed',
      replayed: true,
      operation: { id: scenario.operation.id, outcome: scenario.operation.outcome },
    })
    expect(conflict).toMatchObject({
      status: 'conflict',
      reason: 'payload_mismatch',
      operation: { id: scenario.operation.id },
    })
    expect(
      await database.$count(
        routineVersions,
        eq(routineVersions.sourcePlanId, fixture.approvedPlan.id),
      ),
    ).toBe(1)
  })

  it('keeps the legacy blind retry lab-only, creates exactly two routines, and fails the corrected uniqueness assertion', async () => {
    const action = fixture.approvedPlan.actions[0]!
    if (action.type !== 'replace_homecoming_routine') throw new Error('Fixture action changed')
    const first = await legacy.activate({
      organizationId: fixture.primaryTenant.organization.id,
      clientOperationId: OperationIdSchema.parse('op_legacy_flagship_first'),
      plan: fixture.approvedPlan,
      action,
      approval: fixture.approval,
      payloadHash: serverCreatedOperation.payloadHash,
      at: FLAGSHIP_ACTIVATION_AT,
    })
    const secondAt = new Date(Date.parse(FLAGSHIP_ACTIVATION_AT) + 1_000).toISOString()
    const second = await legacy.activate({
      organizationId: fixture.primaryTenant.organization.id,
      clientOperationId: OperationIdSchema.parse('op_legacy_flagship_retry'),
      plan: fixture.approvedPlan,
      action,
      approval: fixture.approval,
      payloadHash: serverCreatedOperation.payloadHash,
      at: secondAt,
    })
    const rows = await database
      .select({
        routineId: routineVersions.routineId,
        routineVersionId: routineVersions.id,
      })
      .from(routineVersions)
      .where(
        and(
          eq(routineVersions.organizationId, fixture.primaryTenant.organization.id),
          eq(routineVersions.sourcePlanId, fixture.approvedPlan.id),
          eq(routineVersions.status, 'active'),
        ),
      )
    expect(LEGACY_LAB_ACTIVATION_CONTRACT).toMatchObject({
      labOnly: true,
      productionSelectable: false,
      mcpSelectable: false,
    })
    expect([first.id, second.id]).toHaveLength(2)
    expect(rows).toHaveLength(2)

    const predicate = fixture.verifierPredicates.find(
      (candidate) => candidate.type === 'active_routine_count',
    )
    if (predicate === undefined) throw new Error('Fixture uniqueness predicate is missing')
    const projected = rows.map((row, index) =>
      EvidenceSchema.parse({
        id: deterministicEvidenceId('legacy-routine-state', row.routineId),
        organizationId: fixture.primaryTenant.organization.id,
        missionId: fixture.mission.id,
        palaceId: fixture.primaryTenant.palace.id,
        observedAt: new Date(Date.parse(FLAGSHIP_ACTIVATION_AT) + index).toISOString(),
        type: 'routine_state',
        routineId: row.routineId,
        routineVersionId: row.routineVersionId,
        active: true,
        planId: fixture.approvedPlan.id,
        planHash: fixture.approvedPlan.hash,
      }),
    )
    const verification = verifyApplicationEvidence({
      verificationId: VerificationIdSchema.parse('ver_legacy_duplicate_result'),
      organizationId: fixture.primaryTenant.organization.id,
      missionId: fixture.mission.id,
      palaceId: fixture.primaryTenant.palace.id,
      planHash: fixture.approvedPlan.hash,
      predicates: [predicate],
      evidence: projected,
      completedAt: secondAt,
    })
    expect(verification.assertions[0]).toMatchObject({ passed: false })
    expect(verification.status).toBe('failed')
  })

  it('does not materialize unlock for an unverified arrival and materializes lighting plus unlock for the verified arrival', async () => {
    const scenario = await activateThroughLostResponse()
    const [unverified, verified] = fixture.observationSchedule
    const before = await persistArrival(scenario, unverified)
    expect(before.effects).toHaveLength(0)
    expect((await effectsFor(scenario.operation.id)).map((effect) => effect.milestone)).toEqual([
      'preheat',
    ])

    const after = await persistArrival(scenario, verified)
    expect(after.effects).toHaveLength(2)
    expect(
      (await effectsFor(scenario.operation.id)).map((effect) => effect.milestone).sort(),
    ).toEqual(['pathway_lighting', 'preheat', 'unlock'])
  })

  it('completes the nominal service-backed path through relock and deterministic verification', async () => {
    const mirrorBefore = await rawTenantMutationSurface(fixture.mirrorTenant.organization.id)
    const scenario = await activateThroughLostResponse()
    const [preheat] = await effectsFor(scenario.operation.id)
    if (preheat === undefined || preheat.milestone !== 'preheat') {
      throw new Error('Activation did not materialize preheat')
    }
    await dispatchEffect(scenario, preheat)

    const [unverified, verified] = fixture.observationSchedule
    await persistArrival(scenario, unverified)
    await persistArrival(scenario, verified)
    const arrivalEffects = await effectsFor(scenario.operation.id)
    const lighting = arrivalEffects.find((effect) => effect.milestone === 'pathway_lighting')
    const unlock = arrivalEffects.find((effect) => effect.milestone === 'unlock')
    if (lighting === undefined || unlock === undefined) {
      throw new Error('Verified arrival did not materialize its device effects')
    }
    await dispatchEffect(scenario, lighting)
    await dispatchEffect(scenario, unlock)
    scenario.clock.flushCurrent()

    let callbackCursor = 0
    const ingestNewCallbacks = async () => {
      const delivered = scenario.simulator.deliveredCallbacks.slice(callbackCursor)
      callbackCursor += delivered.length
      for (const callback of delivered) await scenario.callbacks.ingest(callback)
    }
    await ingestNewCallbacks()

    const relock = (await effectsFor(scenario.operation.id)).find(
      (effect) => effect.milestone === 'relock',
    )
    if (relock === undefined) throw new Error('Completed unlock did not materialize relock')
    expect(relock.authorization).toEqual({
      kind: 'mission_lease',
      epoch: scenario.missionFenceEpoch,
    })
    expect(Date.parse(relock.dispatchAt) - Date.parse(unlock.command.createdAt)).toBe(90_000)

    scenario.clock.advanceTo(relock.dispatchAt)
    await dispatchEffect(scenario, relock)
    scenario.clock.flushCurrent()
    await ingestNewCallbacks()
    scenario.clock.advanceTo(FLAGSHIP_VERIFICATION_AT)
    await ingestNewCallbacks()

    const durableEffects = await effectsFor(scenario.operation.id)
    expect(durableEffects.map((effect) => effect.milestone).sort()).toEqual([
      'pathway_lighting',
      'preheat',
      'relock',
      'unlock',
    ])
    expect(durableEffects.every((effect) => effect.effectState.status === 'completed')).toBe(true)
    const verification = await new VerificationService(
      unitOfWork,
      scenario.applicationClock,
      scenario.ids,
    ).run({
      organizationId: fixture.primaryTenant.organization.id,
      missionId: fixture.mission.id,
    })
    expect(
      verification.verification.status,
      JSON.stringify(verification.verification.assertions, null, 2),
    ).toBe('passed')
    expect(verification.verification.assertions).toHaveLength(fixture.verifierPredicates.length)
    expect(verification.verification.assertions.every((assertion) => assertion.passed)).toBe(true)
    expect(verification.mission.state).toEqual({ status: 'succeeded', phase: 'verify' })
    expect(scenario.simulator.deviceModel.snapshot(FLAGSHIP_VERIFICATION_AT)).toMatchObject({
      temperatureCelsius: 20,
      lightingIntensityPercent: 40,
      lightingActive: true,
      lockDesiredState: 'locked',
    })
    expect(await rawTenantMutationSurface(fixture.mirrorTenant.organization.id)).toEqual(
      mirrorBefore,
    )
  })

  const profileCases = Object.entries(GATEWAY_FAULT_PROFILES) as readonly [
    string,
    GatewayFaultProfile,
  ][]

  it.each(profileCases)(
    'persists the declared gateway outcome for the %s profile after service restart',
    async (name, profile) => {
      const scenario = await activateThroughLostResponse(profile)
      const [preheat] = await effectsFor(scenario.operation.id)
      if (preheat === undefined || preheat.milestone !== 'preheat') {
        throw new Error('Activation did not materialize preheat')
      }
      const dispatched = await dispatchEffect(scenario, preheat)
      scenario.clock.runUntilIdle({ maximumVirtualMilliseconds: 30 * 60 * 1_000 })

      const restartedUnitOfWork = createUnitOfWork(createDatabase(pool))
      const restartedCallbacks = new GatewayCallbackService<SignedGatewayCallback>(
        restartedUnitOfWork,
        {
          verify: async (raw) =>
            verifyGatewayCallbackWithReceipt(raw, {
              keyring: { [gatewaySigningKeyId]: gatewayVerificationKey(fixture) },
              now: scenario.applicationClock.now(),
            }),
        },
        undefined,
        scenario.applicationClock,
        scenario.ids,
      )
      const callbackResults: Awaited<ReturnType<typeof restartedCallbacks.ingest>>[] = []
      for (const callback of scenario.simulator.deliveredCallbacks) {
        callbackResults.push(await restartedCallbacks.ingest(callback))
      }

      const restored = await restartedUnitOfWork.run(
        fixture.primaryTenant.organization.id,
        (repositories) => repositories.gatewayEffects.get(preheat.command.id),
      )
      const storedExecution = await restartedUnitOfWork.run(
        fixture.primaryTenant.organization.id,
        (repositories) => repositories.executions.findForOperation(scenario.operation.id),
      )
      const preheatMilestone = storedExecution?.execution.milestones.find(
        (milestone) => milestone.name === 'preheat',
      )
      if (profile.kind === 'device_offline') {
        expect(dispatched).toMatchObject({
          status: 'finalized',
          gateway: { status: 'failed', code: 'DEVICE_OFFLINE' },
        })
        expect(restored?.effectState.status).toBe('failed')
        expect(preheatMilestone?.status).toBe('failed')
      } else {
        expect(restored?.effectState.status).toBe('completed')
        expect(preheatMilestone?.status).toBe('completed')
      }
      if (profile.kind === 'lost_ack' || profile.kind === 'response_timeout') {
        expect(dispatched).toMatchObject({
          status: 'finalized',
          gateway: { status: 'unknown' },
        })
      }
      if (profile.kind === 'duplicate_callback') {
        expect(callbackResults.map((result) => result.status)).toEqual(['stored', 'duplicate'])
      }
      expect(
        await database.$count(gatewayCallbacks, eq(gatewayCallbacks.commandId, preheat.command.id)),
      ).toBe(1)
      expect(
        await database.$count(evidence, eq(evidence.authorityCommandId, preheat.command.id)),
      ).toBeGreaterThan(0)
      const faultCatalog = await loadGatewayFaultCatalog()
      const manifest = faultCatalog.manifests.find((candidate) => candidate.faultProfile === name)
      if (manifest === undefined) throw new Error(`Fault profile ${name} has no manifest`)
      expect(await faultDurableState(scenario, preheat, callbackResults)).toEqual(
        manifest.expectedDurableState,
      )
    },
    20_000,
  )
})

import { readFile, readdir } from 'node:fs/promises'

import {
  CryptoIdGenerator,
  GatewayDispatchService,
  GatewayEffectReconciliationService,
  OutboxDispatcher,
  type ClockPort,
  type GatewayPort,
  type JsonValue,
  type OutboxRepository,
  type QueuePort,
  type QueuePublishOptions,
  type ServiceContext,
  type StoredExecution,
  type TenantRepositories,
  type UnitOfWorkPort,
} from '@trash-palace/application'
import {
  ApprovalSchema,
  CapabilityIdSchema,
  DeviceIdSchema,
  EvidenceIdSchema,
  ExecutionIdSchema,
  ExecutionSchema,
  MembershipIdSchema,
  MissionIdSchema,
  MissionSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PersistedEvidenceRecordSchema,
  PlanSchema,
  PrincipalSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  UserIdSchema,
  computePlanHash,
  createGatewayCommand,
  deriveGatewayCommandId,
  type GatewayCommand,
  type GatewayDispatchResult,
  type RoutineDefinition,
} from '@trash-palace/core'
import {
  PgBootstrapRepository,
  PgSystemOutboxRepository,
  createDatabase,
  createUnitOfWork,
  type Database,
  type PgUnitOfWork,
} from '@trash-palace/db'
import {
  composePgBossWorkerGraph,
  type PgBossWorkerGraph,
  type WorkerRuntimeDependencies,
} from '@trash-palace/worker'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

const databaseUrl = process.env.TEST_DATABASE_URL ?? null
const databaseDescribe = databaseUrl === null ? describe.skip : describe

const organizationId = OrganizationIdSchema.parse('org_workerrestart')
const userId = UserIdSchema.parse('usr_workerowner')
const palaceId = PalaceIdSchema.parse('pal_workerpalace')
const thermostatId = DeviceIdSchema.parse('dev_workerthermostat')

const definition: RoutineDefinition = {
  name: 'Worker restart homecoming',
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

interface SeededScenario {
  readonly command: GatewayCommand
  readonly dispatchOutboxDeduplicationKey: string
}

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: () => {
      resolvePromise?.()
      resolvePromise = undefined
    },
  }
}

class MutableClock implements ClockPort {
  public constructor(private value: Date) {}

  public now(): Date {
    return new Date(this.value)
  }

  public advance(milliseconds: number): void {
    this.value = new Date(this.value.valueOf() + milliseconds)
  }
}

class CommitThenLoseAcknowledgementGateway implements GatewayPort {
  readonly #firstCallStarted = deferred()
  readonly #releaseFirstCall = deferred()
  readonly #effects = new Map<string, string>()
  #firstCallReleased = false
  callCount = 0

  public get externalEffectCount(): number {
    return this.#effects.size
  }

  public waitForFirstCall(): Promise<void> {
    return this.#firstCallStarted.promise
  }

  public releaseFirstCall(): void {
    if (this.#firstCallReleased) return
    this.#firstCallReleased = true
    this.#releaseFirstCall.resolve()
  }

  public async dispatch(command: GatewayCommand): Promise<GatewayDispatchResult> {
    this.callCount += 1
    const priorFingerprint = this.#effects.get(command.id)
    if (priorFingerprint !== undefined && priorFingerprint !== command.payloadHash) {
      throw new Error('Gateway command identity changed across redelivery')
    }
    if (priorFingerprint === undefined) this.#effects.set(command.id, command.payloadHash)

    if (this.callCount === 1) {
      this.#firstCallStarted.resolve()
      await this.#releaseFirstCall.promise
      return { status: 'unknown', retryable: true, reason: 'lost_ack' }
    }
    return { status: 'accepted', acknowledgementId: 'gack_worker_restart' }
  }
}

class CrashBeforeFirstOutboxMark implements UnitOfWorkPort {
  #remainingCrashes = 1

  public constructor(private readonly delegate: UnitOfWorkPort) {}

  public run<Result>(
    tenantId: Parameters<UnitOfWorkPort['run']>[0],
    work: (repositories: TenantRepositories) => Promise<Result>,
  ): Promise<Result> {
    return this.delegate.run(tenantId, (repositories) => {
      const original = repositories.outbox
      const outbox: OutboxRepository = {
        findByDeduplicationKey: (key) => original.findByDeduplicationKey(key),
        insert: (message) => original.insert(message),
        markDispatched: (messageId, ownerId, dispatchedAt) => {
          if (this.#remainingCrashes > 0) {
            this.#remainingCrashes -= 1
            const error = new Error('Publisher stopped after queue publish and before outbox mark')
            Object.assign(error, { code: 'CRASH_AFTER_QUEUE_PUBLISH' })
            throw error
          }
          return original.markDispatched(messageId, ownerId, dispatchedAt)
        },
        release: (messageId, ownerId, availableAt, errorCode) =>
          original.release(messageId, ownerId, availableAt, errorCode),
      }
      return work({ ...repositories, outbox })
    })
  }
}

class RecordingQueuePublisher implements QueuePort {
  readonly publishes: {
    readonly topic: string
    readonly deduplicationKey: string
    readonly result: { readonly jobId: string | null; readonly duplicate: boolean }
  }[] = []

  public constructor(private readonly delegate: QueuePort) {}

  public async publish(
    topic: string,
    payload: Readonly<Record<string, JsonValue>>,
    options: QueuePublishOptions,
  ): Promise<{ readonly jobId: string | null; readonly duplicate: boolean }> {
    const result = await this.delegate.publish(topic, payload, options)
    this.publishes.push({ topic, deduplicationKey: options.deduplicationKey, result })
    return result
  }
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new TypeError('Unsafe SQL identifier')
  return `"${value}"`
}

function createApplicationPool(connectionString: string, schema: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 8,
    options: `-c search_path=${schema},public`,
  })
}

async function applyMigrations(pool: pg.Pool, schema: string): Promise<void> {
  const migrationDirectory = new URL('../../db/migrations/', import.meta.url)
  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort()
  for (const filename of filenames) {
    const migration = (await readFile(new URL(filename, migrationDirectory), 'utf8')).replaceAll(
      '"public".',
      `${quotedIdentifier(schema)}.`,
    )
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) await pool.query(statement)
    }
  }
}

function at(base: Date, offsetMilliseconds: number): string {
  return new Date(base.valueOf() + offsetMilliseconds).toISOString()
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

async function seedScenario(
  database: Database,
  unitOfWork: PgUnitOfWork,
  clock: MutableClock,
): Promise<SeededScenario> {
  const base = new Date(clock.now().valueOf() - 120_000)
  const createdAt = at(base, 0)
  const approvedAt = at(base, 1_000)
  const committedAt = at(base, 2_000)
  const startedAt = at(base, 3_000)
  const deadline = at(base, 10 * 60_000)
  const missionId = MissionIdSchema.parse('mis_workerrestart')
  const protectedRoutineId = RoutineIdSchema.parse('rtn_workerprotected')
  const protectedVersionId = RoutineVersionIdSchema.parse('rtv_workerprotected')
  const replacementRoutineId = RoutineIdSchema.parse('rtn_workerreplacement')
  const replacementVersionId = RoutineVersionIdSchema.parse('rtv_workerreplacement')
  const planId = 'pln_workerrestart'
  const actionId = 'act_workerreplace'
  const approvalId = 'apr_workerapproval'

  const bootstrap = new PgBootstrapRepository(database)
  await bootstrap.insertOrganization({
    id: organizationId,
    slug: 'worker-restart',
    name: 'Worker Restart',
    labTenant: true,
    createdAt,
  })
  await bootstrap.insertUser({ id: userId, displayName: 'Rocky', createdAt })
  await unitOfWork.run(organizationId, async (repositories) => {
    await repositories.records.insertMembership({
      id: MembershipIdSchema.parse('mem_workerowner'),
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
      name: 'Worker Restart Palace',
      timezone: 'America/New_York',
      batteryAvailablePercentage: 80,
      createdAt,
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
      id: CapabilityIdSchema.parse('cap_workertemperature'),
      organizationId,
      deviceId: thermostatId,
      kind: 'temperature_target',
      enabled: true,
      constraints: { minimumCelsius: 5, maximumCelsius: 35 },
    })
  })

  const mission = MissionSchema.parse({
    id: missionId,
    organizationId,
    palaceId,
    initiatedBy: userId,
    objective: 'Prove durable worker restart behavior',
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    successCriteriaIds: ['durable_worker_restart'],
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
    replacement: definition,
  }
  const hashPayload = {
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
  const { schemaVersion: _schemaVersion, ...planContent } = hashPayload
  const plan = PlanSchema.parse({
    ...planContent,
    hash: computePlanHash(hashPayload),
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
    nonce: 'approval_worker_restart_000000',
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
        name: 'Protected worker routine',
        activeVersionId: protectedVersionId,
        createdAt,
      },
      {
        id: protectedVersionId,
        routineId: protectedRoutineId,
        organizationId,
        version: 1,
        status: 'active',
        definition: { ...definition, name: 'Protected worker routine' },
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
    const [operation] = await repositories.operations.createForApprovedPlan(approvalId, approvedAt)
    if (!operation) throw new Error('Worker restart operation was not created')
    return repositories.activateApprovedOperation({
      operationId: operation.id,
      expectedVersion: 1,
      at: committedAt,
    })
  })
  if (committed.status !== 'committed' || !committed.outcome) {
    throw new Error('Worker restart operation was not committed')
  }

  const triggerEvidenceId = EvidenceIdSchema.parse('evd_workeractivation')
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
      id: 'rcp_workeractivation',
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
  const execution: StoredExecution = {
    operationId,
    authorization: { kind: 'manual' },
    execution: ExecutionSchema.parse({
      id: ExecutionIdSchema.parse('exe_workerrestart'),
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
  const command = createGatewayCommand({
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
  })
  const dispatchOutboxId = 'out_worker_restart_dispatch'
  await unitOfWork.run(organizationId, async (repositories) => {
    await repositories.evidence.appendMany([trigger])
    await repositories.executions.insert(execution)
    await repositories.gatewayEffects.materialize({
      intent: {
        command,
        dispatchAt: startedAt,
        milestone: 'preheat',
        cancellationPolicy: 'cancel_if_pending',
        authorization: { kind: 'manual' },
        createdAt: startedAt,
      },
      dispatchOutboxId,
    })
  })
  return {
    command,
    dispatchOutboxDeduplicationKey: `gateway.dispatch:${command.id}:1`,
  }
}

function workerDependencies(input: {
  readonly database: Database
  readonly unitOfWork: PgUnitOfWork
  readonly outboxQueue: QueuePort
  readonly clock: MutableClock
  readonly gateway: GatewayPort
  readonly workerId: string
  readonly crashBeforeFirstMark: boolean
}): Omit<WorkerRuntimeDependencies, 'queue'> {
  const outboxUnitOfWork = input.crashBeforeFirstMark
    ? new CrashBeforeFirstOutboxMark(input.unitOfWork)
    : input.unitOfWork
  const unavailable = async (): Promise<never> => {
    throw new Error('Unrelated worker service was invoked by the restart proof')
  }
  const serviceContext: ServiceContext = {
    principal: PrincipalSchema.parse({
      organizationId,
      actorId: userId,
      role: 'service',
      operatorGrants: [],
      delegatedPermissions: [],
    }),
    source: 'worker',
  }
  return {
    outbox: new OutboxDispatcher(
      outboxUnitOfWork,
      new PgSystemOutboxRepository(input.database),
      input.outboxQueue,
      input.clock,
    ),
    gatewayDispatch: new GatewayDispatchService(
      input.unitOfWork,
      input.gateway,
      input.clock,
      new CryptoIdGenerator(),
    ),
    gatewayEffectReconciliation: new GatewayEffectReconciliationService(
      input.unitOfWork,
      input.clock,
      new CryptoIdGenerator(),
      5,
      1_000,
    ),
    executionDeadline: { evaluate: unavailable },
    identityArrivalExecution: { handle: unavailable },
    operations: { reconcile: unavailable },
    verification: { run: unavailable },
    leases: { acquire: unavailable, renew: unavailable, release: unavailable },
    missionRunner: { resume: unavailable },
    serviceContextFor: () => serviceContext,
    workerId: input.workerId,
  }
}

async function waitFor<Result>(input: {
  readonly label: string
  readonly read: () => Promise<Result>
  readonly matches: (result: Result) => boolean
  readonly timeoutMilliseconds?: number
}): Promise<Result> {
  const timeout = input.timeoutMilliseconds ?? 20_000
  const deadline = Date.now() + timeout
  let result = await input.read()
  while (!input.matches(result) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    result = await input.read()
  }
  if (!input.matches(result)) {
    throw new Error(
      `Timed out waiting for ${input.label}; last observed: ${JSON.stringify(result).slice(0, 2000)}`,
    )
  }
  return result
}

async function outboxRow(pool: pg.Pool, deduplicationKey: string) {
  const result = await pool.query<{
    status: string
    delivery_attempts: number
    last_error_code: string | null
  }>(
    `select status, delivery_attempts, last_error_code
       from outbox_messages
      where deduplication_key = $1`,
    [deduplicationKey],
  )
  return result.rows[0] ?? null
}

databaseDescribe('production worker restart and redelivery', () => {
  it('runs the outbox through pg-boss, closes the publish/mark gap, and resumes on a new runtime', async () => {
    if (databaseUrl === null) throw new Error('TEST_DATABASE_URL is required')
    const suffix = `${process.pid}_${Date.now()}`
    const applicationSchema = `tp_worker_app_${suffix}`
    const bossSchema = `tp_worker_boss_${suffix}`
    const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
    const clock = new MutableClock(new Date())
    const gateway = new CommitThenLoseAcknowledgementGateway()
    let poolA: pg.Pool | undefined
    let poolB: pg.Pool | undefined
    let graphA: PgBossWorkerGraph | undefined
    let graphB: PgBossWorkerGraph | undefined
    let publisherA: RecordingQueuePublisher | undefined
    let runtimeAStopped: true | undefined
    let runtimeBStopped: true | undefined
    let poolAClosed: true | undefined
    let poolBClosed: true | undefined
    let schemasRemoved = false
    const cleanupErrors: unknown[] = []

    try {
      await adminPool.query(`create schema ${quotedIdentifier(applicationSchema)}`)
      poolA = createApplicationPool(databaseUrl, applicationSchema)
      await applyMigrations(poolA, applicationSchema)
      const databaseA = createDatabase(poolA)
      const unitOfWorkA = createUnitOfWork(databaseA)
      const scenario = await seedScenario(databaseA, unitOfWorkA, clock)
      const bossConnection = {
        connectionString: databaseUrl,
        schema: bossSchema,
        application_name: 'trash-palace-worker-restart-a',
      }
      graphA = await composePgBossWorkerGraph({
        connection: bossConnection,
        buildDependencies: (queue) => {
          publisherA = new RecordingQueuePublisher(queue)
          return workerDependencies({
            database: databaseA,
            unitOfWork: unitOfWorkA,
            outboxQueue: publisherA,
            clock,
            gateway,
            workerId: 'worker-restart-a',
            crashBeforeFirstMark: true,
          })
        },
      })
      await graphA.runtime.start()

      const firstSweep = await graphA.queue.publish(
        'system.outbox.sweep',
        {},
        { deduplicationKey: `restart-proof-first-${suffix}` },
      )
      expect(firstSweep).toMatchObject({ duplicate: false })
      await gateway.waitForFirstCall()
      const released = await waitFor({
        label: 'outbox release after the injected publish/mark crash gap',
        read: () => outboxRow(poolA!, scenario.dispatchOutboxDeduplicationKey),
        matches: (row) =>
          row?.status === 'pending' && row.last_error_code === 'CRASH_AFTER_QUEUE_PUBLISH',
      })
      expect(released?.delivery_attempts).toBe(1)

      clock.advance(3_000)
      const secondSweep = await graphA.queue.publish(
        'system.outbox.sweep',
        {},
        { deduplicationKey: `restart-proof-second-${suffix}` },
      )
      expect(secondSweep).toMatchObject({ duplicate: false })
      const dispatched = await waitFor({
        label: 'outbox mark after a duplicate pg-boss publish',
        read: () => outboxRow(poolA!, scenario.dispatchOutboxDeduplicationKey),
        matches: (row) => row?.status === 'dispatched' && row.delivery_attempts === 2,
      })
      expect(dispatched?.last_error_code).toBe('CRASH_AFTER_QUEUE_PUBLISH')
      if (publisherA === undefined) throw new Error('Outbox publisher was not composed')
      expect(
        publisherA.publishes
          .filter((entry) => entry.topic === 'gateway.dispatch')
          .map((entry) => ({
            deduplicationKey: entry.deduplicationKey,
            duplicate: entry.result.duplicate,
            jobIdPresent: entry.result.jobId !== null,
          })),
      ).toEqual([
        {
          deduplicationKey: scenario.dispatchOutboxDeduplicationKey,
          duplicate: false,
          jobIdPresent: true,
        },
        {
          deduplicationKey: scenario.dispatchOutboxDeduplicationKey,
          duplicate: true,
          jobIdPresent: false,
        },
      ])

      const queuedDispatches = await adminPool.query<{
        state: string
        singleton_key: string | null
      }>(
        `select state, singleton_key
             from ${quotedIdentifier(bossSchema)}.job
            where name = 'gateway.dispatch'`,
      )
      expect(queuedDispatches.rows).toEqual([
        {
          state: 'active',
          singleton_key: scenario.dispatchOutboxDeduplicationKey,
        },
      ])
      expect(gateway.callCount).toBe(1)
      expect(gateway.externalEffectCount).toBe(1)

      gateway.releaseFirstCall()
      const nonterminal = await waitFor({
        label: 'durable lost-ack checkpoint',
        read: () =>
          unitOfWorkA.run(organizationId, (repositories) =>
            repositories.gatewayEffects.get(scenario.command.id),
          ),
        matches: (effect) => effect?.dispatchState.status === 'unknown',
      })
      expect(nonterminal?.dispatchState).toMatchObject({
        generation: 1,
        status: 'unknown',
        retryable: true,
        reason: 'lost_ack',
      })

      await graphA.runtime.stop()
      runtimeAStopped = true
      graphA = undefined
      await poolA.end()
      poolAClosed = true
      poolA = undefined

      poolB = createApplicationPool(databaseUrl, applicationSchema)
      const databaseB = createDatabase(poolB)
      const unitOfWorkB = createUnitOfWork(databaseB)
      graphB = await composePgBossWorkerGraph({
        connection: {
          connectionString: databaseUrl,
          schema: bossSchema,
          application_name: 'trash-palace-worker-restart-b',
        },
        buildDependencies: (queue) =>
          workerDependencies({
            database: databaseB,
            unitOfWork: unitOfWorkB,
            outboxQueue: queue,
            clock,
            gateway,
            workerId: 'worker-restart-b',
            crashBeforeFirstMark: false,
          }),
      })
      await graphB.runtime.start()

      await graphB.queue.publish(
        'system.outbox.sweep',
        {},
        { deduplicationKey: `restart-proof-reconcile-${suffix}` },
      )
      await waitFor({
        label: 'reconciliation checkpoint and retry generation after restart',
        read: async () => {
          const result = await poolB!.query<{
            poll_count: number
            generation_count: number
          }>(
            `select
                 (select count(*)::int from gateway_effect_reconciliation_polls where command_id = $1) as poll_count,
                 (select count(*)::int from gateway_dispatches where command_id = $1) as generation_count`,
            [scenario.command.id],
          )
          return result.rows[0] ?? { poll_count: 0, generation_count: 0 }
        },
        matches: (snapshot) => snapshot.poll_count === 1 && snapshot.generation_count === 2,
      })

      await graphB.queue.publish(
        'system.outbox.sweep',
        {},
        { deduplicationKey: `restart-proof-retry-${suffix}` },
      )
      const recovered = await waitFor({
        label: 'accepted retry through runtime B',
        read: () =>
          unitOfWorkB.run(organizationId, (repositories) =>
            repositories.gatewayEffects.get(scenario.command.id),
          ),
        matches: (effect) =>
          effect?.dispatchState.generation === 2 && effect.dispatchState.status === 'accepted',
      })
      expect(recovered?.dispatchState).toMatchObject({ generation: 2, status: 'accepted' })
      expect(gateway.callCount).toBe(2)
      expect(gateway.externalEffectCount).toBe(1)

      const durableCounts = await poolB.query<{
        commands: number
        effects: number
        dispatches: number
        attempts: number
        polls: number
      }>(
        `select
             (select count(*)::int from gateway_commands where id = $1) as commands,
             (select count(*)::int from gateway_effects where command_id = $1) as effects,
             (select count(*)::int from gateway_dispatches where command_id = $1) as dispatches,
             (select count(*)::int from attempts where gateway_command_id = $1) as attempts,
             (select count(*)::int from gateway_effect_reconciliation_polls where command_id = $1) as polls`,
        [scenario.command.id],
      )
      expect(durableCounts.rows[0]).toEqual({
        commands: 1,
        effects: 1,
        dispatches: 2,
        attempts: 2,
        polls: 1,
      })

      await graphB.runtime.stop()
      runtimeBStopped = true
      graphB = undefined
      await poolB.end()
      poolBClosed = true
      poolB = undefined
    } finally {
      gateway.releaseFirstCall()
      if (graphB !== undefined) {
        try {
          await graphB.runtime.stop()
          runtimeBStopped = true
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (graphA !== undefined) {
        try {
          await graphA.runtime.stop()
          runtimeAStopped = true
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (poolB !== undefined) {
        try {
          await poolB.end()
          poolBClosed = true
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (poolA !== undefined) {
        try {
          await poolA.end()
          poolAClosed = true
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        await adminPool.query(`drop schema if exists ${quotedIdentifier(bossSchema)} cascade`)
        await adminPool.query(
          `drop schema if exists ${quotedIdentifier(applicationSchema)} cascade`,
        )
        const schemas = await adminPool.query<{ application: string | null; boss: string | null }>(
          'select to_regnamespace($1)::text as application, to_regnamespace($2)::text as boss',
          [applicationSchema, bossSchema],
        )
        const schemaState = schemas.rows[0]
        if (schemaState === undefined) {
          cleanupErrors.push(new Error('Schema cleanup query returned no row'))
        } else {
          schemasRemoved = schemaState.application === null && schemaState.boss === null
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        await adminPool.end()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }

    expect({
      runtimeAStopped,
      runtimeBStopped,
      poolAClosed,
      poolBClosed,
      schemasRemoved,
      cleanupErrors,
    }).toEqual({
      runtimeAStopped: true,
      runtimeBStopped: true,
      poolAClosed: true,
      poolBClosed: true,
      schemasRemoved: true,
      cleanupErrors: [],
    })
  }, 60_000)
})

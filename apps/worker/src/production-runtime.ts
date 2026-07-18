import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  CaretakerEvidenceRecorder,
  CaretakerLifecycleHost,
  CaretakerMissionRunnerAdapter,
  ClarificationCaretakerHumanPausePort,
  DeterministicCaretakerProgramDraftPort,
  DeterministicCaretakerProgramMaterialIssuePort,
  DeterministicHaulerAccessPlanningKernel,
  DeterministicHomecomingPlanningKernel,
  DispatcherCaretakerToolPort,
  NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY,
  RepositoryCaretakerProjectionPort,
  StaticCaretakerClarificationChoiceProjector,
  homecomingClarificationChoiceDescriptions,
} from '@trash-palace/agent'
import {
  ApprovalService,
  AuthenticatedToolDispatcher,
  CancellationService,
  ClarificationService,
  CryptoEntropy,
  CryptoIdGenerator,
  DelegatedToolMutationCoordinator,
  ExecutionDeadlineService,
  GatewayDispatchService,
  GatewayEffectReconciliationService,
  HmacToolInvocationScopeHasher,
  IdentityArrivalExecutionJobHandler,
  KnowledgeSearchService,
  MissionLeaseService,
  MissionLifecycleService,
  OperationService,
  OutboxDispatcher,
  PersistedEvidenceExecutionService,
  PlanService,
  ProductEvidenceProjector,
  RepositoryToolInvocationPolicy,
  SYSTEM_CLOCK,
  TenantReadService,
  ToolInvocationReconciliationEvidenceService,
  VerificationEvidenceService,
  VerificationService,
  createProductionMissionProgramRegistry,
  createToolServiceHandlers,
  type SensitiveMutationGuardPort,
  type ApplicationTransportFaultPolicyPort,
  type ToolInvocationClaimInput,
  type ToolInvocationClaimResult,
  type ToolInvocationCompletionInput,
  type ToolInvocationCompletionResult,
  type ToolInvocationLedgerPort,
} from '@trash-palace/application'
import { PrincipalSchema, type OrganizationId } from '@trash-palace/core'
import {
  PgCaretakerContextPreparationPort,
  PgCaretakerEvidenceDeliveryRepository,
  PgCaretakerFrozenContextPort,
  PgToolCallReceiptRepository,
  PgToolInvocationLedger,
  createDatabase,
  createDatabasePool,
  createMissionExecutionUnitOfWork,
  createSystemProductEvidenceDeliveryRepository,
  createSystemOutboxRepository,
  createUnitOfWork,
  type Database,
} from '@trash-palace/db'
import {
  AnalyticsAliaser,
  LocalJsonlEvidenceSink,
  SafeApplicationEvidenceAdapter,
} from '@trash-palace/observability'

import { composePgBossWorkerGraph, type PgBossWorkerGraph } from './composition.js'
import { createWorkerCaretakerHostClock, createWorkerDomainClock } from './domain-clock.js'
import { FixedOriginGatewayClient } from './gateway-http-client.js'
import { FilesystemCaretakerKnowledgeProvider } from './knowledge-provider.js'
import { RepositoryCaretakerRuntimeContextSnapshotPort } from './runtime-context-provider.js'
import type { WorkerServerConfiguration } from './server-configuration.js'
import { createWorkerDecisionProvider } from './decision-provider.js'

export interface ProductionWorkerResources {
  readonly graph: PgBossWorkerGraph
  readonly pool: ReturnType<typeof createDatabasePool>
  readonly evidence: CaretakerEvidenceRecorder
  readonly evidenceSink: LocalJsonlEvidenceSink
  readonly observability: SafeApplicationEvidenceAdapter
  readonly productEvidence: ProductEvidenceProjector
  probeDatabase(): Promise<void>
  closeDatabase(): Promise<void>
}

export function createApplicationTransportFaultPolicy(
  configuration: Pick<WorkerServerConfiguration, 'applicationTransportFault'>,
): ApplicationTransportFaultPolicyPort {
  return {
    shouldLoseCommittedResponse: ({ organizationId, authorization }) =>
      authorization === 'mission_lease' &&
      configuration.applicationTransportFault.kind === 'application_commit_then_response_lost' &&
      organizationId === configuration.applicationTransportFault.organizationId,
  }
}

/** Composes every production adapter without opening queue listeners or making network calls. */
export async function composeProductionWorker(
  configuration: WorkerServerConfiguration,
): Promise<ProductionWorkerResources> {
  const knowledge = await FilesystemCaretakerKnowledgeProvider.create({
    repositoryRoot: configuration.repositoryRoot,
    applicationVersion: configuration.applicationVersion,
  })
  await mkdir(dirname(configuration.evidenceSinkPath), { recursive: true, mode: 0o700 })

  const pool = createDatabasePool({
    connectionString: configuration.databaseUrl,
    application_name: configuration.workerId,
    max: 10,
  })
  const database = createDatabase(pool)
  const unitOfWork = createUnitOfWork(database)
  const missionUnitOfWork = createMissionExecutionUnitOfWork(database)
  const ids = new CryptoIdGenerator()
  const entropy = new CryptoEntropy()
  const domainClock = createWorkerDomainClock(configuration.domainClock)
  // Web never opens this file; the single worker process owns both evidence projectors.
  const evidenceSink = new LocalJsonlEvidenceSink(configuration.evidenceSinkPath, {
    exclusiveWriter: true,
  })
  const aliaser = new AnalyticsAliaser(configuration.evidenceAliasKey)
  const observability = new SafeApplicationEvidenceAdapter({
    sink: evidenceSink,
    aliaser,
    environment: configuration.evidenceEnvironment,
    dataOrigin: configuration.evidenceOrigin,
    appVersion: configuration.applicationVersion,
  })
  const productEvidence = new ProductEvidenceProjector(
    createSystemProductEvidenceDeliveryRepository(database),
    observability,
  )
  const applicationTransportFaultPolicy = createApplicationTransportFaultPolicy(configuration)
  const programs = createProductionMissionProgramRegistry(
    unitOfWork,
    configuration.domainClock.mode === 'fixture'
      ? {
          // The distributed fixture advances one virtual minute every 250 ms. These bounds
          // validate causal ordering without presenting container scheduling as live latency.
          maximumArrivalCommandDelaySeconds: 20 * 60,
          relockToleranceSeconds: 60,
        }
      : undefined,
  )
  // The repository fences lease expiry with PostgreSQL wall time. The service clock timestamps the
  // mission's lease-acquired domain transition, so it must match every other mission mutation.
  const leases = new MissionLeaseService(unitOfWork, domainClock, ids, entropy, observability)
  const scopes = new HmacToolInvocationScopeHasher(configuration.toolInvocationScopeKey)
  const receipts = {
    forTenant: ({
      organizationId,
      tenantScopeHash,
    }: {
      readonly organizationId: OrganizationId
      readonly tenantScopeHash: ReturnType<typeof scopes.tenant>
    }) => new PgToolCallReceiptRepository(database, organizationId, tenantScopeHash),
  }
  const operations = new OperationService(
    unitOfWork,
    domainClock,
    ids,
    observability,
    missionUnitOfWork,
    programs,
    applicationTransportFaultPolicy,
  )
  const identityArrivalExecution = new IdentityArrivalExecutionJobHandler(
    new PersistedEvidenceExecutionService(unitOfWork, programs, domainClock, ids),
  )
  const plans = new PlanService(
    unitOfWork,
    programs,
    programs,
    domainClock,
    ids,
    observability,
    missionUnitOfWork,
  )
  const humanMutationGuard: SensitiveMutationGuardPort = {
    assert: () => {
      throw new Error('Worker process cannot authorize a browser mutation')
    },
  }
  const approvals = new ApprovalService(
    unitOfWork,
    humanMutationGuard,
    domainClock,
    ids,
    entropy,
    observability,
    missionUnitOfWork,
  )
  const clarifications = new ClarificationService(
    unitOfWork,
    missionUnitOfWork,
    humanMutationGuard,
    domainClock,
    ids,
    observability,
  )
  const missionTransitions = new MissionLifecycleService(
    unitOfWork,
    domainClock,
    ids,
    observability,
    missionUnitOfWork,
  )
  const dispatcher = new AuthenticatedToolDispatcher({
    ledger: new TenantToolInvocationLedger(database),
    receipts,
    policy: new RepositoryToolInvocationPolicy(unitOfWork),
    reconciliationEvidence: new ToolInvocationReconciliationEvidenceService(
      unitOfWork,
      SYSTEM_CLOCK,
      ids,
    ),
    handlers: createToolServiceHandlers({
      tenantReads: new TenantReadService(unitOfWork),
      knowledge: new KnowledgeSearchService(unitOfWork),
      plans,
      approvals,
      operations,
      evidence: new VerificationEvidenceService(unitOfWork),
      cancellations: new CancellationService(
        unitOfWork,
        humanMutationGuard,
        domainClock,
        ids,
        observability,
      ),
      delegatedMutations: new DelegatedToolMutationCoordinator(leases),
    }),
    scopes,
    clock: SYSTEM_CLOCK,
    entropy,
  })
  const deliveryRepository = new PgCaretakerEvidenceDeliveryRepository(database)
  const decisionProvider = createWorkerDecisionProvider(configuration.decisionProvider)
  const decisionEngine = decisionProvider.engine
  const evidence = new CaretakerEvidenceRecorder({
    sink: evidenceSink,
    deliveries: deliveryRepository,
    aliaser,
    environment: configuration.evidenceEnvironment,
    dataOrigin: configuration.evidenceOrigin,
    appVersion: configuration.applicationVersion,
    harnessVersion: 'caretaker-host@1',
    modelConfigVersion: decisionEngine.id,
    deliveredAt: () => domainClock.now(),
  })
  const frozenContexts = new PgCaretakerFrozenContextPort({ database, knowledge })
  const planningKernel = new DeterministicHomecomingPlanningKernel(
    NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY,
  )
  const projections = new RepositoryCaretakerProjectionPort({
    unitOfWork: missionUnitOfWork,
    dispatcher,
    receipts,
    scopes,
    frozenContexts,
    drafts: new DeterministicCaretakerProgramDraftPort(
      planningKernel,
      new DeterministicHaulerAccessPlanningKernel(),
    ),
    materialIssues: new DeterministicCaretakerProgramMaterialIssuePort(planningKernel),
  })
  const host = new CaretakerLifecycleHost({
    unitOfWork: missionUnitOfWork,
    projections,
    tools: new DispatcherCaretakerToolPort({ dispatcher, receipts, scopes }),
    missionTransitions,
    humanPauses: new ClarificationCaretakerHumanPausePort({
      unitOfWork: missionUnitOfWork,
      clarifications,
      choices: new StaticCaretakerClarificationChoiceProjector(
        homecomingClarificationChoiceDescriptions(),
      ),
    }),
    decisionEngine,
    evidence,
    clock: createWorkerCaretakerHostClock(domainClock),
  })
  const missionRunner = new CaretakerMissionRunnerAdapter({
    unitOfWork: missionUnitOfWork,
    contextPreparation: new PgCaretakerContextPreparationPort({
      database,
      unitOfWork: missionUnitOfWork,
      knowledge,
      runtime: new RepositoryCaretakerRuntimeContextSnapshotPort(missionUnitOfWork),
      scopes,
    }),
    host,
  })

  try {
    const graph = await composePgBossWorkerGraph({
      connection: {
        connectionString: configuration.databaseUrl,
        application_name: `${configuration.workerId}-queue`,
      },
      buildDependencies: (queue) => ({
        onProductEvidenceDeliveryFailure: (error) => {
          console.error(
            `TrashPal product-evidence delivery deferred: ${error instanceof Error ? error.name : 'UnknownError'}`,
          )
        },
        outbox: new OutboxDispatcher(
          unitOfWork,
          createSystemOutboxRepository(database),
          queue,
          domainClock,
          observability,
        ),
        productEvidence,
        gatewayDispatch: new GatewayDispatchService(
          unitOfWork,
          new FixedOriginGatewayClient(undefined, fetch, configuration.gatewayTimeoutMilliseconds),
          domainClock,
          ids,
          observability,
        ),
        gatewayEffectReconciliation: new GatewayEffectReconciliationService(
          unitOfWork,
          domainClock,
          ids,
          // The accelerated fixture polls in five virtual-minute steps so a 25-minute device
          // effect can complete before its lost-ack budget expires. Live mode keeps 5 x 5 seconds.
          configuration.domainClock.mode === 'fixture' ? 6 : 5,
          configuration.domainClock.mode === 'fixture' ? 300_000 : 5_000,
        ),
        executionDeadline: new ExecutionDeadlineService(unitOfWork, domainClock, ids),
        identityArrivalExecution,
        operations,
        verification: new VerificationService(
          unitOfWork,
          domainClock,
          ids,
          observability,
          programs,
        ),
        leases,
        missionRunner,
        serviceContextFor: (organizationId) => ({
          principal: PrincipalSchema.parse({
            organizationId,
            actorId: configuration.serviceActorId,
            role: 'service',
            operatorGrants: [],
            delegatedPermissions: [],
          }),
          source: 'worker' as const,
        }),
        workerId: configuration.workerId,
        leaseTtlMilliseconds: configuration.leaseTtlMilliseconds,
        outboxPumpIntervalMilliseconds: configuration.outboxPumpIntervalMilliseconds,
      }),
    })
    return {
      graph,
      pool,
      evidence,
      evidenceSink,
      observability,
      productEvidence,
      probeDatabase: async () => {
        await pool.query('select 1')
      },
      closeDatabase: async () => pool.end(),
    }
  } catch (error) {
    await pool.end()
    throw error
  }
}

class TenantToolInvocationLedger implements ToolInvocationLedgerPort {
  public constructor(private readonly database: Database) {}

  public claim(input: ToolInvocationClaimInput): Promise<ToolInvocationClaimResult> {
    return this.#forTenant(input.organizationId).claim(input)
  }

  public complete(input: ToolInvocationCompletionInput): Promise<ToolInvocationCompletionResult> {
    return this.#forTenant(input.organizationId).complete(input)
  }

  #forTenant(organizationId: OrganizationId): PgToolInvocationLedger {
    return new PgToolInvocationLedger(this.database, organizationId)
  }
}

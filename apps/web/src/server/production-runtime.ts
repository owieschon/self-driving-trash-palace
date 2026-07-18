import {
  ApprovalService,
  AuthenticatedToolDispatcher,
  CancellationService,
  ClarificationService,
  CryptoEntropy,
  CryptoIdGenerator,
  DelegatedCredentialService,
  DelegatedToolMutationCoordinator,
  HmacToolInvocationScopeHasher,
  HumanTaskService,
  GatewayCallbackService,
  HmacIdentityTelemetryVerifier,
  IdentityTelemetryIngressService,
  KnowledgeSearchService,
  MissionLeaseService,
  MissionBootstrapService,
  MissionProgressService,
  HomecomingPlanningEvidenceProjector,
  ReferenceHomecomingBatteryForecast,
  OperationService,
  PersistentSessionService,
  PlanService,
  PalaceWorkspaceService,
  RepositoryToolInvocationPolicy,
  SYSTEM_CLOCK,
  SeededSessionService,
  TenantReadService,
  ToolInvocationReconciliationEvidenceService,
  VerificationEvidenceService,
  createProductionMissionProgramRegistry,
  createFlagshipDomainClock,
  createToolServiceHandlers,
  type ClockPort,
  type MissionBootstrapEvidencePort,
  type ToolInvocationClaimInput,
  type ToolInvocationClaimResult,
  type ToolInvocationCompletionInput,
  type ToolInvocationCompletionResult,
  type ToolInvocationLedgerPort,
} from '@trash-palace/application'
import { missionProgramKindOf, type OrganizationId } from '@trash-palace/core'
import {
  PgCredentialRepository,
  PgToolCallReceiptRepository,
  PgToolInvocationLedger,
  createDatabase,
  createDatabasePool,
  createIdentityTelemetryIngressUnitOfWork,
  createMissionExecutionUnitOfWork,
  createUnitOfWork,
  type Database,
} from '@trash-palace/db'
import { verifyGatewayCallbackWithReceipt } from '@trash-palace/gateway-simulator'
import { AnalyticsAliaser, SafeApplicationEvidenceAdapter } from '@trash-palace/observability'

import { createHttpApiRuntime, type HttpApiRuntime } from './api-runtime.js'
import { createManagementRoutes } from './management-routes.js'
import { createMissionProgressRoute } from './mission-progress-route.js'
import { createInternalIngressRoutes } from './internal-ingress-routes.js'
import { createManagedHttpApiRuntime, type ManagedHttpApiRuntime } from './managed-runtime.js'
import { createPalaceWorkspaceRoute } from './palace-workspace-route.js'
import {
  parseWebServerConfiguration,
  type WebDomainClockConfiguration,
} from './server-configuration.js'

export interface WebRuntimeClocks {
  readonly security: ClockPort
  readonly domain: ClockPort
}

export interface ProductionHttpApiRuntime extends ManagedHttpApiRuntime {
  readonly observability: SafeApplicationEvidenceAdapter
}

/** Keeps security and infrastructure expiry on wall time while fixture domain time accelerates. */
export function createWebRuntimeClocks(
  configuration: WebDomainClockConfiguration,
  security: ClockPort = SYSTEM_CLOCK,
): WebRuntimeClocks {
  return Object.freeze({ security, domain: createFlagshipDomainClock(configuration, security) })
}

export function createProductionHttpApiRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): ProductionHttpApiRuntime {
  const configuration = parseWebServerConfiguration(environment)
  const pool = createDatabasePool({
    connectionString: configuration.databaseUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 10,
  })
  const database = createDatabase(pool)
  const unitOfWork = createUnitOfWork(database)
  const missionUnitOfWork = createMissionExecutionUnitOfWork(database)
  const clocks = createWebRuntimeClocks(configuration.domainClock)
  const observability = new SafeApplicationEvidenceAdapter({
    aliaser: new AnalyticsAliaser(configuration.evidenceAliasKey),
    environment: configuration.evidenceEnvironment,
    dataOrigin: configuration.evidenceOrigin,
    appVersion: configuration.applicationVersion,
  })
  const ids = new CryptoIdGenerator()
  const entropy = new CryptoEntropy()
  const credentials = new PgCredentialRepository(database)
  const sessionEnvelope = new SeededSessionService(configuration.sessionSigningKey, clocks.security)
  const sessions = new PersistentSessionService(sessionEnvelope, credentials, clocks.security)
  const delegatedCredentials = new DelegatedCredentialService(credentials, clocks.security)
  const leases = new MissionLeaseService(unitOfWork, clocks.domain, ids, entropy, observability)
  const programs = createProductionMissionProgramRegistry(unitOfWork)
  const plans = new PlanService(
    unitOfWork,
    programs,
    programs,
    clocks.domain,
    ids,
    observability,
    missionUnitOfWork,
  )
  const approvals = new ApprovalService(
    unitOfWork,
    sessions,
    clocks.domain,
    ids,
    entropy,
    observability,
    missionUnitOfWork,
  )
  const clarifications = new ClarificationService(
    unitOfWork,
    missionUnitOfWork,
    sessions,
    clocks.domain,
    ids,
    observability,
  )
  const humanTasks = new HumanTaskService(unitOfWork)
  const palaceWorkspace = new PalaceWorkspaceService(unitOfWork, clocks.security, programs)
  const missionProgress = new MissionProgressService(unitOfWork, clocks.security)
  const homecomingPlanningEvidence = new HomecomingPlanningEvidenceProjector(
    new ReferenceHomecomingBatteryForecast(),
    {
      targetCelsius: 20,
      pathwayLightingIntensityPercent: 40,
      pathwayLightingDurationSeconds: 900,
    },
  )
  const planningEvidence: MissionBootstrapEvidencePort = {
    project: (input) =>
      missionProgramKindOf(input.mission) === 'night_shift_homecoming'
        ? homecomingPlanningEvidence.project(input)
        : Promise.resolve([]),
  }
  const missionBootstrap = new MissionBootstrapService(
    unitOfWork,
    sessions,
    ids,
    clocks.domain,
    observability,
    planningEvidence,
  )
  const gatewayCallbacks = new GatewayCallbackService(
    unitOfWork,
    {
      verify: async (raw) =>
        verifyGatewayCallbackWithReceipt(raw, {
          keyring: {
            [configuration.gatewayCallbackSigningKeyId]: {
              key: configuration.gatewayCallbackSigningKey,
              keyVersion: 1,
              purpose: 'gateway_callback',
              principal: {
                id: 'gwp_local_gateway',
                organizationId: configuration.localOrganizationId,
              },
            },
          },
          now: clocks.security.now(),
        }),
    },
    undefined,
    clocks.domain,
    ids,
    observability,
  )
  const identityTelemetry = new IdentityTelemetryIngressService(
    createIdentityTelemetryIngressUnitOfWork(database),
    new HmacIdentityTelemetryVerifier(
      {
        resolve: async (keyId) =>
          keyId === configuration.identityTelemetrySigningKeyId
            ? {
                key: configuration.identityTelemetrySigningKey,
                principal: {
                  principalId: configuration.identityTelemetryPrincipalId,
                  organizationId: configuration.localOrganizationId,
                  palaceId: configuration.localPalaceId,
                  purpose: 'identity_telemetry_ingress',
                  keyId: configuration.identityTelemetrySigningKeyId,
                  keyVersion: 1,
                  validFrom: '2020-01-01T00:00:00.000Z',
                  expiresAt: '2100-01-01T00:00:00.000Z',
                  revokedAt: null,
                },
              }
            : null,
      },
      clocks.security,
      {
        eventClock: clocks.domain,
        ...(configuration.domainClock.mode === 'fixture'
          ? { eventMaximumAgeMilliseconds: 2 * 60 * 60 * 1_000 }
          : {}),
      },
    ),
    clocks.domain,
    observability,
  )
  const operations = new OperationService(
    unitOfWork,
    clocks.domain,
    ids,
    observability,
    missionUnitOfWork,
    programs,
  )
  const dispatcher = new AuthenticatedToolDispatcher({
    ledger: new TenantToolInvocationLedger(database),
    receipts: {
      forTenant: ({ organizationId, tenantScopeHash }) =>
        new PgToolCallReceiptRepository(database, organizationId, tenantScopeHash),
    },
    policy: new RepositoryToolInvocationPolicy(unitOfWork),
    reconciliationEvidence: new ToolInvocationReconciliationEvidenceService(
      unitOfWork,
      clocks.security,
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
        sessions,
        clocks.domain,
        ids,
        observability,
      ),
      delegatedMutations: new DelegatedToolMutationCoordinator(leases, clocks.security),
    }),
    scopes: new HmacToolInvocationScopeHasher(configuration.toolInvocationScopeKey),
    clock: clocks.security,
  })
  const authentication = {
    authenticateSession: (value: string) => sessions.authenticate(value),
    authenticateBearer: (value: string) => delegatedCredentials.authenticate(value),
    assertSensitiveMutation: (input: Parameters<typeof sessions.assert>[0]) =>
      sessions.assert(input),
  }

  const routes: HttpApiRuntime = createHttpApiRuntime({
    internalIngress: createInternalIngressRoutes({
      callbacks: gatewayCallbacks,
      identityTelemetry,
    }),
    management: createManagementRoutes({
      allowedOrigin: configuration.allowedOrigin,
      sessions,
      delegatedCredentials,
      approvals,
      humanTasks,
      clarifications,
      missions: missionBootstrap,
      devBootstrap: configuration.devBootstrap,
    }),
    missionProgress: createMissionProgressRoute({
      allowedOrigin: configuration.allowedOrigin,
      sessions,
      progress: missionProgress,
    }),
    palaceWorkspace: createPalaceWorkspaceRoute({
      allowedOrigin: configuration.allowedOrigin,
      sessions,
      workspace: palaceWorkspace,
    }),
    tools: {
      allowedOrigin: configuration.allowedOrigin,
      authentication,
      dispatcher,
    },
    mcp: {
      authentication,
      dispatcher,
      allowedHosts: [new URL(configuration.allowedOrigin).host.toLowerCase()],
    },
  })
  return {
    ...createManagedHttpApiRuntime(routes, pool),
    observability,
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

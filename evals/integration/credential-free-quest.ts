import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { TrashPalaceApiClient, TrashPalaceApiError } from '../../apps/web/src/server/api-client.js'
import { applicationProductEvidenceEventId } from '../../packages/application/src/index.js'
import { ClarificationChoiceIdSchema, hashToolValue } from '../../packages/core/src/index.js'
import { runMcpSmoke } from '../../packages/mcp/src/client.js'
import {
  AnalyticsAliasSchema,
  canonicalJson,
  parseSafeEvidenceEvent,
  type JsonValue,
  type SafeEvidenceEvent,
} from '../../packages/observability/src/index.js'
import { resolveComposeCommand, runLocalStack } from '../../scripts/local-stack.js'
import { NIGHT_SHIFT_HOMECOMING_FIXTURE } from '../fixtures/night-shift-homecoming.js'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const COMPOSE_ENVIRONMENT = resolve(REPOSITORY_ROOT, 'artifacts/private/local-stack.env')
const RECEIPT_PATH = resolve(REPOSITORY_ROOT, 'evals/reports/credential-free-quest.json')
const ORIGIN = 'http://127.0.0.1:3300'
const MCP_ENDPOINT = `${ORIGIN}/api/mcp`
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const LOCAL_SERVICE_PROBE_TIMEOUT_MILLISECONDS = 15_000
const LOCAL_WORKFLOW_TIMEOUT_MILLISECONDS = 90_000
const ENERGY_FIRST = ClarificationChoiceIdSchema.parse('energy_first')
const REQUIRED_QUEST_EVIDENCE_EVENTS = Object.freeze([
  'mission created',
  'plan proposed',
  'plan simulated',
  'plan approved',
  'operation requested',
  'operation outcome unknown',
  'operation reconciled',
  'routine activated',
  'execution observed',
  'execution verified',
  'mission completed',
] as const)

const MissionEvidenceSnapshotSchema = z
  .object({
    missionAlias: AnalyticsAliasSchema,
    deliveries: z
      .array(
        z
          .object({
            eventHash: z.string().regex(/^[a-f0-9]{64}$/),
            eventName: z.string().min(1),
            eventSerialized: z.string().min(2).max(65_536),
            status: z.enum(['pending', 'delivered']),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()

export type MissionEvidenceSnapshot = z.infer<typeof MissionEvidenceSnapshotSchema>

const LedgerSnapshotSchema = z
  .object({
    missionStatus: z.literal('succeeded'),
    missionPhase: z.literal('verify'),
    planCount: z.literal(1),
    approvalCount: z.literal(1),
    operationCount: z.literal(1),
    committedOperationCount: z.literal(1),
    gatewayAttemptCount: z.number().int().positive(),
    unknownAttemptCount: z.number().int().positive(),
    applicationUnknownAttemptCount: z.literal(1),
    applicationResponseLossEvidenceCount: z.literal(1),
    activationUnknownReceiptCount: z.literal(1),
    applicationAttemptReceiptBound: z.literal(true),
    committedApplicationReconciliationCount: z.literal(1),
    applicationReconciliationOrderingValid: z.literal(true),
    lostAckDispatchCount: z.number().int().positive(),
    activeReplacementRoutineCount: z.literal(1),
    protectedRoutineInactive: z.literal(true),
    executionObservedCount: z.literal(1),
    verificationCount: z.literal(1),
    verificationPassed: z.literal(true),
    verificationAssertionsPassed: z.literal(true),
    contextReceiptCount: z.number().int().positive(),
    contextReceiptPerRun: z.literal(true),
    caretakerRunCount: z.number().int().positive(),
    completedCaretakerRunCount: z.number().int().nonnegative(),
    evidenceCount: z.number().int().positive(),
    mirrorRoutineCount: z.literal(1),
  })
  .strict()

const LedgerSummarySchema = LedgerSnapshotSchema.extend({
  completedCaretakerRunCount: z.number().int().positive(),
}).strict()

const QuestReceiptSchema = z
  .object({
    schemaVersion: z.literal('credential-free-quest-receipt@2'),
    fixture: z.literal('night-shift-homecoming@1'),
    proofLevel: z.literal('live_local_network_simulation'),
    services: z
      .object({
        postgres: z.literal('ready'),
        web: z.literal('ready'),
        gateway: z.literal('ready'),
        worker: z.literal('ready'),
      })
      .strict(),
    boundaries: z
      .object({
        credentialFree: z.literal(true),
        externalIntegrationsConfigured: z.literal(false),
        runtimeEgressIsolation: z.literal('not_enforced'),
        modelBackedBehavior: z.literal('blocked'),
        posthogIngestion: z.literal('blocked'),
      })
      .strict(),
    browserBoundary: z
      .object({
        exactHostAndOriginAccepted: z.literal(true),
        crossTenantMissionDenied: z.literal(true),
        mirrorTenantStatePreserved: z.literal(true),
      })
      .strict(),
    transportParity: z
      .object({
        tool: z.literal('knowledge.search'),
        toolCount: z.literal(15),
        resultDataHash: z.string().regex(/^[a-f0-9]{64}$/),
        exactDataMatch: z.literal(true),
      })
      .strict(),
    lifecycle: z
      .object({
        clarificationAnswered: z.literal('energy_first'),
        exactPlanApproved: z.literal(true),
        terminalState: z.literal('succeeded'),
        verification: z.literal('passed'),
      })
      .strict(),
    recovery: z
      .object({
        gatewayAndWorkerRestarted: z.literal(true),
        pendingApprovalSurvivedRestart: z.literal(true),
        fixtureClockArmedAfterRestart: z.literal(true),
        applicationCommitThenResponseLostObserved: z.literal(true),
        gatewayLostAcknowledgementObserved: z.literal(true),
        logicalOperationCount: z.literal(1),
      })
      .strict(),
    ledger: LedgerSummarySchema,
    evidence: z
      .object({
        schemaValidated: z.literal(true),
        missionScoped: z.literal(true),
        allOutboxDeliveriesAcknowledged: z.literal(true),
        requiredLifecycleEventsPresent: z.literal(true),
        outboxDeliveryCount: z.number().int().positive(),
        eventCount: z.number().int().positive(),
        eventNames: z.array(z.string()).min(1),
        eventSetHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict()

export type QuestReceipt = z.infer<typeof QuestReceiptSchema>

export async function runCredentialFreeQuest(): Promise<QuestReceipt> {
  await assertServiceReadiness()
  const mirrorTenantBefore = await readMirrorTenantStateHash()
  const browser = new SameOriginBrowser(ORIGIN)
  const api = new TrashPalaceApiClient(ORIGIN, browser.fetch)
  const session = await api.createDevSession()

  await assertCrossTenantMissionDenied(api, session.session.csrfToken)
  const created = await api.createMission(
    { csrfToken: session.session.csrfToken },
    {
      requestId: 'quest_night_shift_homecoming_01',
      palaceId: NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.palace.id,
      objective: NIGHT_SHIFT_HOMECOMING_FIXTURE.request.objective,
      constraints: NIGHT_SHIFT_HOMECOMING_FIXTURE.mission.constraints,
      successCriteriaIds: [...NIGHT_SHIFT_HOMECOMING_FIXTURE.mission.successCriteriaIds],
    },
  )
  if (created.result !== 'created') {
    throw new Error('Credential-free Quest requires a clean database and a newly created mission')
  }
  const missionId = created.mission.id

  const clarificationInbox = await waitFor({
    label: 'Caretaker clarification',
    read: () => api.getMissionTasks(missionId),
    matches: (inbox) => inbox.clarification !== null,
    timeoutMilliseconds: LOCAL_WORKFLOW_TIMEOUT_MILLISECONDS,
  })
  if (clarificationInbox.clarification === null) throw new Error('Clarification disappeared')
  const clarification = await api.getClarification(clarificationInbox.clarification.id)
  if (!clarification.request.choices.some((choice) => choice.id === ENERGY_FIRST)) {
    throw new Error('Canonical energy-first clarification choice is absent')
  }
  const delegated = await api.issueDelegatedToken(
    { csrfToken: session.session.csrfToken },
    { scopes: ['knowledge:read'], expiresInSeconds: 900 },
  )
  const knowledgeInput = {
    query: 'understand a safe homecoming routine before proposing a change',
    phase: clarification.mission.state.phase,
    limit: 6,
  }
  const directKnowledge = await api.invokeTool({
    toolName: 'knowledge.search',
    callId: 'call_quest_http_knowledge_01',
    missionId,
    body: knowledgeInput,
    bearerToken: delegated.token.bearerToken,
  })
  if (directKnowledge.status !== 'succeeded') throw new Error('HTTP knowledge search failed')
  const directDataHash = hashToolValue(directKnowledge.data)
  const mcp = await runMcpSmoke({
    endpoint: MCP_ENDPOINT,
    accessToken: delegated.token.bearerToken,
    missionId,
    invoke: { toolName: 'knowledge.search', input: knowledgeInput },
  })
  if (mcp.resultDataHash !== directDataHash) {
    throw new Error('HTTP and MCP returned different knowledge result data')
  }
  const answerableClarification = await api.getClarification(clarification.request.id)
  await api.answerClarification(
    { csrfToken: session.session.csrfToken },
    clarification.request.id,
    { choiceId: ENERGY_FIRST, expectedMissionVersion: answerableClarification.mission.version },
  )

  const approvalInbox = await waitFor({
    label: 'exact plan approval',
    read: () => api.getMissionTasks(missionId),
    matches: (inbox) => inbox.approval !== null,
    timeoutMilliseconds: LOCAL_WORKFLOW_TIMEOUT_MILLISECONDS,
  })
  if (approvalInbox.approval === null) throw new Error('Approval disappeared')
  const approvalBeforeRestart = await api.getApproval(approvalInbox.approval.id)
  if (approvalBeforeRestart.plan.actions.length !== 1) {
    throw new Error('Quest requires one exact replacement action')
  }

  await runLocalStack('restart')
  await assertServiceReadiness()
  const afterRestart = await api.getMissionTasks(missionId)
  if (afterRestart.approval?.id !== approvalBeforeRestart.approval.id) {
    throw new Error('Pending exact approval did not survive gateway and worker restart')
  }
  await runLocalStack('arm')
  await assertServiceReadiness()
  const afterArm = await api.getMissionTasks(missionId)
  if (afterArm.approval?.id !== approvalBeforeRestart.approval.id) {
    throw new Error('Pending exact approval did not survive fixture-clock arming')
  }
  const approvalAfterRestart = await api.getApproval(approvalBeforeRestart.approval.id)
  await api.decideApproval(
    { csrfToken: session.session.csrfToken },
    approvalAfterRestart.approval.id,
    { nonce: approvalAfterRestart.approval.nonce, decision: 'approve' },
  )

  const terminal = await waitFor({
    label: 'independently verified mission completion',
    read: () => api.getMissionTasks(missionId),
    matches: (inbox) => inbox.mission.state.status === 'succeeded',
    timeoutMilliseconds: 180_000,
    intervalMilliseconds: 250,
  })
  const ledgerSnapshot = await waitFor({
    label: 'terminal Caretaker run projection',
    read: () => readLedgerSnapshot(missionId),
    matches: (candidate) => candidate.completedCaretakerRunCount > 0,
    timeoutMilliseconds: LOCAL_WORKFLOW_TIMEOUT_MILLISECONDS,
    intervalMilliseconds: 100,
  })
  const ledger = LedgerSummarySchema.parse(ledgerSnapshot)
  const evidence = await readEvidenceSummary(missionId)
  const mirrorTenantAfter = await readMirrorTenantStateHash()
  if (mirrorTenantAfter !== mirrorTenantBefore) {
    throw new Error('Mirror-tenant routine state changed during the primary-tenant Quest')
  }

  await api.revokeDelegatedToken({ csrfToken: session.session.csrfToken }, delegated.token.id)
  const revocationStatuses: number[] = []
  let rejected = false
  try {
    await runMcpSmoke({
      endpoint: MCP_ENDPOINT,
      accessToken: delegated.token.bearerToken,
      missionId,
      fetch: async (input, init) => {
        const response = await fetch(input, init)
        revocationStatuses.push(response.status)
        return response
      },
    })
  } catch {
    rejected = true
  }
  await assertServiceReadiness()
  if (!rejected || !revocationStatuses.includes(401)) {
    throw new Error('Revoked delegated credential was not rejected with HTTP 401')
  }

  const receipt = QuestReceiptSchema.parse({
    schemaVersion: 'credential-free-quest-receipt@2',
    fixture: 'night-shift-homecoming@1',
    proofLevel: 'live_local_network_simulation',
    services: { postgres: 'ready', web: 'ready', gateway: 'ready', worker: 'ready' },
    boundaries: {
      credentialFree: true,
      externalIntegrationsConfigured: false,
      runtimeEgressIsolation: 'not_enforced',
      modelBackedBehavior: 'blocked',
      posthogIngestion: 'blocked',
    },
    browserBoundary: {
      exactHostAndOriginAccepted: true,
      crossTenantMissionDenied: true,
      mirrorTenantStatePreserved: true,
    },
    transportParity: {
      tool: 'knowledge.search',
      toolCount: mcp.toolCount,
      resultDataHash: directDataHash,
      exactDataMatch: true,
    },
    lifecycle: {
      clarificationAnswered: 'energy_first',
      exactPlanApproved: true,
      terminalState: terminal.mission.state.status,
      verification: 'passed',
    },
    recovery: {
      gatewayAndWorkerRestarted: true,
      pendingApprovalSurvivedRestart: true,
      fixtureClockArmedAfterRestart: true,
      applicationCommitThenResponseLostObserved: true,
      gatewayLostAcknowledgementObserved: true,
      logicalOperationCount: ledger.operationCount,
    },
    ledger,
    evidence,
  })
  await writeReceipt(receipt)
  return receipt
}

export class SameOriginBrowser {
  #cookie: string | undefined

  public constructor(
    private readonly origin: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  public readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const headers = new Headers(request.headers)
    if (request.method !== 'GET' && request.method !== 'HEAD') headers.set('origin', this.origin)
    if (!headers.has('authorization') && this.#cookie !== undefined) {
      headers.set('cookie', this.#cookie)
    }
    const response = await this.request(new Request(request, { headers, credentials: 'omit' }))
    const setCookie = response.headers.get('set-cookie')
    if (setCookie !== null) this.#captureSessionCookie(setCookie)
    return response
  }

  #captureSessionCookie(setCookie: string): void {
    const pair = setCookie.split(';', 1)[0]
    if (pair === undefined || !pair.startsWith('__Host-trash_palace_session=')) return
    this.#cookie = pair
  }
}

async function assertCrossTenantMissionDenied(
  api: TrashPalaceApiClient,
  csrfToken: string,
): Promise<void> {
  try {
    await api.createMission(
      { csrfToken },
      {
        requestId: 'quest_cross_tenant_denial_01',
        palaceId: NIGHT_SHIFT_HOMECOMING_FIXTURE.mirrorTenant.palace.id,
        objective: NIGHT_SHIFT_HOMECOMING_FIXTURE.request.objective,
        constraints: NIGHT_SHIFT_HOMECOMING_FIXTURE.mission.constraints,
        successCriteriaIds: [...NIGHT_SHIFT_HOMECOMING_FIXTURE.mission.successCriteriaIds],
      },
    )
  } catch (error) {
    if (error instanceof TrashPalaceApiError && [403, 404].includes(error.status)) return
    throw error
  }
  throw new Error('Cross-tenant mission creation was not denied')
}

async function assertServiceReadiness(): Promise<void> {
  const checks = [
    ['web health', `${ORIGIN}/api/v1/health`],
    ['web readiness', `${ORIGIN}/api/v1/ready`],
    ['gateway health', 'http://127.0.0.1:4319/healthz'],
    ['gateway readiness', 'http://127.0.0.1:4319/readyz'],
    ['worker health', 'http://127.0.0.1:4320/healthz'],
    ['worker readiness', 'http://127.0.0.1:4320/readyz'],
  ] as const
  for (const [label, url] of checks) {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(LOCAL_SERVICE_PROBE_TIMEOUT_MILLISECONDS),
    })
    if (!response.ok) throw new Error(`${label} returned status ${response.status}`)
    await response.body?.cancel()
  }
}

async function readLedgerSnapshot(missionId: string) {
  if (!/^mis_[a-z0-9][a-z0-9_-]{7,63}$/.test(missionId)) {
    throw new TypeError('Mission ID is invalid')
  }
  const organizationId = NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.organization.id
  const sql = `
    select json_build_object(
      'missionStatus', m.status,
      'missionPhase', m.phase,
      'planCount', (select count(*)::int from plans p where p.organization_id = m.organization_id and p.mission_id = m.id),
      'approvalCount', (select count(*)::int from approvals a where a.organization_id = m.organization_id and a.mission_id = m.id),
      'operationCount', (select count(*)::int from operations o where o.organization_id = m.organization_id and o.mission_id = m.id),
      'committedOperationCount', (select count(*)::int from operations o where o.organization_id = m.organization_id and o.mission_id = m.id and o.status = 'committed'),
      'gatewayAttemptCount', (select count(*)::int from attempts a join operations o on o.organization_id = a.organization_id and o.id = a.operation_id where o.mission_id = m.id and a.transport = 'gateway'),
      'unknownAttemptCount', (select count(*)::int from attempts a join operations o on o.organization_id = a.organization_id and o.id = a.operation_id where o.mission_id = m.id and a.status = 'unknown'),
      'applicationUnknownAttemptCount', (select count(*)::int from attempts a join operations o on o.organization_id = a.organization_id and o.id = a.operation_id where o.mission_id = m.id and a.transport = 'worker' and a.status = 'unknown' and a.error_code = 'APPLICATION_RESPONSE_LOST'),
      'applicationResponseLossEvidenceCount', (select count(*)::int from evidence e where e.organization_id = m.organization_id and e.mission_id = m.id and e.type = 'operation_transport' and e.authority = 'application' and e.application_rule_id = 'operation.application_response_lost' and e.application_rule_version = 1 and e.payload ->> 'transport' = 'worker' and e.payload ->> 'status' = 'unknown' and e.payload ->> 'errorCode' = 'APPLICATION_RESPONSE_LOST' and e.payload ->> 'operationCommitted' = 'true'),
      'activationUnknownReceiptCount', (select count(*)::int from tool_call_receipts r join attempts a on a.organization_id = r.organization_id and a.id = r.attempt_id join operations o on o.organization_id = a.organization_id and o.id = a.operation_id where o.mission_id = m.id and r.tool_name = 'plans.activate' and r.status = 'unknown' and a.transport = 'worker' and a.status = 'unknown' and a.error_code = 'APPLICATION_RESPONSE_LOST'),
      'applicationAttemptReceiptBound', exists (
        select 1
        from tool_call_receipts r
        join attempts a on a.organization_id = r.organization_id and a.id = r.attempt_id
        join operations o on o.organization_id = a.organization_id and o.id = a.operation_id
        join tool_call_receipt_evidence link on link.organization_id = r.organization_id and link.receipt_id = r.id
        join evidence e on e.organization_id = link.organization_id and e.id = link.evidence_id
        where o.mission_id = m.id
          and r.tool_name = 'plans.activate'
          and r.status = 'unknown'
          and e.type = 'operation_transport'
          and e.payload ->> 'operationId' = o.id
          and e.payload ->> 'attemptId' = a.id
          and e.payload ->> 'toolCallId' = r.call_id
      ),
      'committedApplicationReconciliationCount', (select count(*)::int from reconciliation_polls p join operations o on o.organization_id = p.organization_id and o.id = p.operation_id where o.mission_id = m.id and p.resolution = 'committed' and exists (select 1 from attempts a where a.organization_id = o.organization_id and a.operation_id = o.id and a.transport = 'worker' and a.status = 'unknown' and a.error_code = 'APPLICATION_RESPONSE_LOST')),
      'applicationReconciliationOrderingValid', coalesce((
        select min(e.sequence) filter (where e.event = 'execution_unknown') < min(e.sequence) filter (where e.event = 'reconcile_commit_found')
        from mission_events e
        where e.organization_id = m.organization_id and e.mission_id = m.id
      ), false),
      'lostAckDispatchCount', (select count(*)::int from gateway_dispatches d join operations o on o.organization_id = d.organization_id and o.id = d.operation_id where o.mission_id = m.id and d.unknown_reason = 'lost_ack'),
      'activeReplacementRoutineCount', (select count(*)::int from operations o join routines r on r.organization_id = o.organization_id and r.id = o.outcome->>'routineId' join routine_versions v on v.organization_id = r.organization_id and v.routine_id = r.id and v.id = r.active_version_id where o.organization_id = m.organization_id and o.mission_id = m.id and o.status = 'committed' and v.status = 'active'),
      'protectedRoutineInactive', not exists (select 1 from routine_versions v where v.organization_id = m.organization_id and v.id = 'rtv_midnight_entry_v3' and v.status = 'active'),
      'executionObservedCount', (select count(*)::int from executions x where x.organization_id = m.organization_id and x.mission_id = m.id and x.status = 'observed'),
      'verificationCount', (select count(*)::int from verifications v where v.organization_id = m.organization_id and v.mission_id = m.id),
      'verificationPassed', coalesce((select v.status = 'passed' from verifications v where v.organization_id = m.organization_id and v.mission_id = m.id), false),
      'verificationAssertionsPassed', coalesce((select bool_and((assertion ->> 'passed')::boolean) from verifications v cross join lateral jsonb_array_elements(v.assertions) assertion where v.organization_id = m.organization_id and v.mission_id = m.id), false),
      'contextReceiptCount', (select count(*)::int from context_receipts c where c.organization_id = m.organization_id and c.mission_id = m.id),
      'contextReceiptPerRun', (select count(*) from context_receipts c where c.organization_id = m.organization_id and c.mission_id = m.id) = (select count(*) from caretaker_runs c where c.organization_id = m.organization_id and c.mission_id = m.id),
      'caretakerRunCount', (select count(*)::int from caretaker_runs c where c.organization_id = m.organization_id and c.mission_id = m.id),
      'completedCaretakerRunCount', (select count(*)::int from caretaker_runs c where c.organization_id = m.organization_id and c.mission_id = m.id and c.status = 'completed'),
      'evidenceCount', (select count(*)::int from evidence e where e.organization_id = m.organization_id and e.mission_id = m.id),
      'mirrorRoutineCount', (select count(*)::int from routines r where r.organization_id = 'org_mirror_nest' and r.id = 'rtn_mirror_homecoming')
    )
    from missions m
    where m.organization_id = '${organizationId}' and m.id = '${missionId}'
  `
  const output = await composeCapture([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '-qAt',
    '--set',
    'ON_ERROR_STOP=1',
    '-U',
    'trash_palace',
    '-d',
    'trash_palace',
    '-c',
    sql,
  ])
  if (output.trim() === '') throw new Error('Mission ledger row is absent')
  return LedgerSnapshotSchema.parse(JSON.parse(output) as unknown)
}

async function readMirrorTenantStateHash(): Promise<string> {
  const output = await composeCapture([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '-qAt',
    '--set',
    'ON_ERROR_STOP=1',
    '-U',
    'trash_palace',
    '-d',
    'trash_palace',
    '-c',
    `
      select jsonb_build_object(
        'id', r.id,
        'organizationId', r.organization_id,
        'palaceId', r.palace_id,
        'name', r.name,
        'activeVersionId', r.active_version_id,
        'recordVersion', r.record_version,
        'versions', coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', v.id,
              'version', v.version,
              'status', v.status,
              'definition', v.definition,
              'sourcePlanId', v.source_plan_id,
              'sourcePlanHash', v.source_plan_hash
            ) order by v.version, v.id
          ) filter (where v.id is not null),
          '[]'::jsonb
        )
      )
      from routines r
      left join routine_versions v
        on v.organization_id = r.organization_id and v.routine_id = r.id
      where r.organization_id = 'org_mirror_nest' and r.id = 'rtn_mirror_homecoming'
      group by r.id, r.organization_id, r.palace_id, r.name, r.active_version_id, r.record_version
    `,
  ])
  if (output.trim() === '') throw new Error('Mirror-tenant routine state is absent')
  return hashToolValue(JSON.parse(output) as unknown)
}

async function readEvidenceSummary(missionId: string): Promise<QuestReceipt['evidence']> {
  const snapshot = await waitFor({
    label: 'mission-scoped product evidence delivery',
    read: () => readMissionEvidenceSnapshot(missionId),
    matches: (candidate) =>
      candidate.deliveries.every((delivery) => delivery.status === 'delivered') &&
      REQUIRED_QUEST_EVIDENCE_EVENTS.every((required) =>
        candidate.deliveries.some((delivery) => delivery.eventName === required),
      ),
    timeoutMilliseconds: LOCAL_WORKFLOW_TIMEOUT_MILLISECONDS,
    intervalMilliseconds: 100,
  })
  const output = await composeCapture([
    'exec',
    '-T',
    'worker',
    'node',
    '-e',
    "process.stdout.write(require('node:fs').readFileSync('/var/lib/trash-palace/evidence/caretaker.jsonl','utf8'))",
  ])
  return summarizeMissionEvidence(output, snapshot)
}

async function readMissionEvidenceSnapshot(missionId: string): Promise<MissionEvidenceSnapshot> {
  if (!/^mis_[a-z0-9][a-z0-9_-]{7,63}$/.test(missionId)) {
    throw new TypeError('Mission ID is invalid')
  }
  const missionCreatedEventId = applicationProductEvidenceEventId({
    event: 'mission created',
    durableIdentity: { missionId },
  })
  const output = await composeCapture([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '-qAt',
    '--set',
    'ON_ERROR_STOP=1',
    '-U',
    'trash_palace',
    '-d',
    'trash_palace',
    '-c',
    `
      with target as (
        select event_serialized::jsonb #>> '{properties,mission_alias}' as mission_alias
        from product_evidence_deliveries
        where logical_event_id = '${missionCreatedEventId}'
      ), scoped as (
        select
          event_hash,
          event_serialized,
          event_serialized::jsonb ->> 'event' as event_name,
          status
        from product_evidence_deliveries, target
        where event_serialized::jsonb #>> '{properties,mission_alias}' = target.mission_alias
      )
      select json_build_object(
        'missionAlias', (select mission_alias from target),
        'deliveries', coalesce(
          (
            select json_agg(
              json_build_object(
                'eventHash', event_hash,
                'eventName', event_name,
                'eventSerialized', event_serialized,
                'status', status
              ) order by event_name, event_hash
            )
            from scoped
          ),
          '[]'::json
        )
      )
    `,
  ])
  if (output.trim() === '') throw new Error('Mission evidence snapshot is absent')
  return MissionEvidenceSnapshotSchema.parse(JSON.parse(output) as unknown)
}

export function summarizeMissionEvidence(
  jsonl: string,
  snapshot: MissionEvidenceSnapshot,
  requiredEvents: readonly string[] = REQUIRED_QUEST_EVIDENCE_EVENTS,
): QuestReceipt['evidence'] {
  if (!snapshot.deliveries.every((delivery) => delivery.status === 'delivered')) {
    throw new Error('Mission product evidence contains an unacknowledged outbox delivery')
  }
  const parsedLines = jsonl
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const event = parseSafeEvidenceEvent(JSON.parse(line) as unknown)
      const canonical = canonicalJson(event as unknown as JsonValue)
      return { event, eventHash: createHash('sha256').update(canonical).digest('hex') }
    })
  const events = parsedLines.filter(({ event }) => missionAliasFor(event) === snapshot.missionAlias)
  if (events.length === 0) throw new Error('No evidence belongs to the current Quest mission')

  const capturedHashes = new Map<string, number>()
  for (const { eventHash } of events) {
    capturedHashes.set(eventHash, (capturedHashes.get(eventHash) ?? 0) + 1)
  }
  for (const delivery of snapshot.deliveries) {
    if (capturedHashes.get(delivery.eventHash) !== 1) {
      throw new Error('A mission outbox delivery is absent or duplicated in the evidence sink')
    }
    const parsedDelivery = parseSafeEvidenceEvent(JSON.parse(delivery.eventSerialized) as unknown)
    if (
      missionAliasFor(parsedDelivery) !== snapshot.missionAlias ||
      parsedDelivery.event !== delivery.eventName
    ) {
      throw new Error('A mission outbox delivery does not match its retained event metadata')
    }
  }

  const eventNames: string[] = [...new Set(events.map(({ event }) => event.event))].sort()
  if (!requiredEvents.every((event) => eventNames.includes(event))) {
    throw new Error('The current Quest is missing one or more required lifecycle evidence events')
  }
  return {
    schemaValidated: true,
    missionScoped: true,
    allOutboxDeliveriesAcknowledged: true,
    requiredLifecycleEventsPresent: true,
    outboxDeliveryCount: snapshot.deliveries.length,
    eventCount: events.length,
    eventNames,
    eventSetHash: hashToolValue(eventNames),
  }
}

function missionAliasFor(event: SafeEvidenceEvent): string | undefined {
  const properties = event.properties as Readonly<Record<string, unknown>>
  const value = properties.mission_alias
  return typeof value === 'string' ? value : undefined
}

async function composeCapture(arguments_: readonly string[]): Promise<string> {
  const compose = await resolveComposeCommand()
  return spawnCapture(compose.command, [
    ...compose.prefixArguments,
    '--env-file',
    COMPOSE_ENVIRONMENT,
    ...arguments_,
  ])
}

async function spawnCapture(command: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    const capture = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > MAX_CAPTURE_BYTES) {
        child.kill('SIGTERM')
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk))
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (bytes > MAX_CAPTURE_BYTES) {
        reject(new Error(`${command} output exceeded the bounded capture size`))
      } else if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString('utf8'))
      } else {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        reject(
          new Error(
            `${command} ${signal === null ? `exited with status ${String(code)}` : `exited after ${signal}`}${detail === '' ? '' : `: ${detail}`}`,
          ),
        )
      }
    })
  })
}

async function waitFor<Result>(input: {
  readonly label: string
  readonly read: () => Promise<Result>
  readonly matches: (result: Result) => boolean
  readonly timeoutMilliseconds: number
  readonly intervalMilliseconds?: number
}): Promise<Result> {
  const deadline = Date.now() + input.timeoutMilliseconds
  let result = await input.read()
  while (!input.matches(result) && Date.now() < deadline) {
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, input.intervalMilliseconds ?? 100),
    )
    result = await input.read()
  }
  if (!input.matches(result)) {
    throw new Error(
      `Timed out waiting for ${input.label}; last observed: ${JSON.stringify(result).slice(0, 2000)}`,
    )
  }
  return result
}

async function writeReceipt(receipt: QuestReceipt): Promise<void> {
  await mkdir(dirname(RECEIPT_PATH), { recursive: true })
  const temporary = `${RECEIPT_PATH}.tmp`
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  await rename(temporary, RECEIPT_PATH)
}

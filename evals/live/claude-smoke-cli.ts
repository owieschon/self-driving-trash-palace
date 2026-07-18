import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  CaretakerDecisionRequestSchema,
  ClaudeDecisionEngineError,
  createCaretakerFrozenContext,
  createClaudeDecisionEngine,
  hashHostPolicyContract,
  projectExactToolContracts,
  projectHostPolicy,
  sha256Text,
  type CaretakerDecisionObservation,
} from '../../packages/agent/src/index.js'

const REPORT_PATH = resolve('evals/reports/claude-live-smoke.json')

async function main(): Promise<void> {
  const approved = process.env.TRASH_PALACE_LIVE_EVAL_APPROVED === 'true'
  const apiKey = process.env.ANTHROPIC_API_KEY
  const authorizationId = process.env.TRASH_PALACE_LIVE_MODEL_AUTHORIZATION_ID
  const maximumCostUsd = Number(process.env.TRASH_PALACE_CLAUDE_MAX_COST_USD_PER_DECISION)
  if (!approved || apiKey === undefined || authorizationId === undefined) {
    throw new Error(
      'Credentialed Claude smoke requires explicit approval, credential, and authorization',
    )
  }
  if (!Number.isFinite(maximumCostUsd) || maximumCostUsd <= 0 || maximumCostUsd > 0.1) {
    throw new Error(
      'Credentialed Claude smoke requires a positive per-decision ceiling at or below $0.10',
    )
  }

  const factory = createClaudeDecisionEngine({
    apiKey,
    liveRequestAuthorization: { authorizationId, maximumCostUsdPerDecision: maximumCostUsd },
  })
  if (factory.status !== 'ready')
    throw new Error(`Claude adapter blocked: ${factory.receipt.blocker}`)

  const request = smokeRequest()
  let observation: CaretakerDecisionObservation | undefined
  const startedAt = new Date()
  let decision: Awaited<ReturnType<typeof factory.engine.decide>> | undefined
  let failureCode: string | null = null
  let validationDiagnostic: ClaudeDecisionEngineError['validationDiagnostic']
  try {
    decision = await factory.engine.decide(request, {
      signal: new AbortController().signal,
      attemptId: 'attempt.live.smoke.1',
      observe: (value) => {
        observation = value
        return Promise.resolve()
      },
    })
  } catch (error) {
    if (error instanceof ClaudeDecisionEngineError) {
      failureCode = error.code
      validationDiagnostic = error.validationDiagnostic
    } else {
      failureCode = 'unexpected_failure'
    }
  }
  const generation =
    observation !== undefined && observation.kind === 'model_generation' ? observation : null

  const report = {
    schemaVersion: 'claude-live-smoke@1',
    evidenceLabel:
      decision === undefined ? 'Blocked' : 'One bounded credentialed decision verified',
    scope: 'adapter decision only; corpus accuracy and production-composed behavior remain blocked',
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    adapter: {
      sdkVersion: factory.receipt.sdkVersion,
      model: factory.receipt.model,
      promptVersion: factory.receipt.promptVersion,
      builtInTools: factory.receipt.builtInTools,
      mcpServers: factory.receipt.sdkMcpServers,
      filesystemSettingsSources: factory.receipt.filesystemSettingsSources,
    },
    result:
      decision === undefined
        ? {
            status: 'failed_closed',
            failureCode,
            ...(validationDiagnostic === undefined ? {} : { validationDiagnostic }),
            usageReceiptRetained: generation !== null,
            ...(generation === null
              ? {}
              : {
                  provider: generation.provider,
                  model: generation.model,
                  inputTokens: generation.inputTokens,
                  outputTokens: generation.outputTokens,
                  cacheReadInputTokens: generation.cacheReadInputTokens,
                  cacheCreationInputTokens: generation.cacheCreationInputTokens,
                  durationMilliseconds: generation.durationMilliseconds,
                  apiDurationMilliseconds: generation.apiDurationMilliseconds,
                  totalCostUsd: generation.totalCostUsd,
                }),
          }
        : {
            status: 'succeeded',
            decisionKind: decision.kind,
            selectedTool: decision.kind === 'invoke_tool' ? decision.toolName : null,
            evidenceReferenceCount: decision.evidenceIds.length,
            evidenceReferencesBound: true,
            ...(generation === null
              ? {}
              : {
                  provider: generation.provider,
                  model: generation.model,
                  inputTokens: generation.inputTokens,
                  outputTokens: generation.outputTokens,
                  cacheReadInputTokens: generation.cacheReadInputTokens,
                  cacheCreationInputTokens: generation.cacheCreationInputTokens,
                  durationMilliseconds: generation.durationMilliseconds,
                  apiDurationMilliseconds: generation.apiDurationMilliseconds,
                  totalCostUsd: generation.totalCostUsd,
                }),
          },
    privacy: {
      credentialRetained: false,
      promptRetained: false,
      rawModelOutputRetained: false,
      privateReasoningRetained: false,
      customerDataRetained: false,
    },
    blockedClaims: [
      'corpus-scale recommendation quality',
      'production-composed agent loop',
      'live PostHog trace observation',
    ],
  }
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  if (decision === undefined) {
    process.stderr.write('Claude decision failed closed; retained a sanitized blocked receipt.\n')
    process.exitCode = 1
  } else {
    process.stdout.write('Verified one bounded Claude decision; retained a sanitized receipt.\n')
  }
}

function smokeRequest() {
  const contextReceiptId = 'ctx_livesmoke01'
  const contextBundleHash = 'a'.repeat(64)
  return CaretakerDecisionRequestSchema.parse({
    schemaVersion: 'caretaker-decision-request@1',
    requestId: 'request.live.smoke.1',
    contextReceiptId,
    contextBundleHash,
    frozenContext: createCaretakerFrozenContext({
      schemaVersion: 'caretaker-frozen-context@1',
      receiptId: contextReceiptId,
      receiptBindingHash: contextBundleHash,
      bundleId: 'bundle_livesmoke01',
      bundleHash: sha256Text('bounded-live-smoke'),
      frozenAt: '2026-07-16T00:00:00.000Z',
      hostPolicy: projectHostPolicy(hashHostPolicyContract()),
      exactContracts: projectExactToolContracts(['palaces.get']),
      sections: [],
      filtering: {
        confidentialSourcesExcluded: 0,
        tenantPrivateSourcesExcluded: 0,
        crossTenantSourcesExcluded: 0,
        runtimeSnapshotsExcluded: 0,
      },
    }),
    retrievedKnowledge: [],
    runId: 'run_livesmoke01',
    mission: {
      id: 'mis_livesmoke01',
      palaceId: 'pal_rockyhome',
      programKind: 'night_shift_homecoming',
      objective: 'Inspect the palace before proposing any change.',
      constraints: {
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
      state: { status: 'running', phase: 'understand' },
      version: 1,
      taskLedger: [],
    },
    turnIndex: 0,
    allowedTools: ['palaces.get'],
    budget: {
      toolCalls: { used: 0, max: 24 },
      planRevisions: { used: 0, max: 3 },
      clarifications: { used: 0, max: 2 },
      reconciliationPolls: { used: 0, max: 3 },
      activeRuntimeMilliseconds: { used: 0, max: 300_000 },
    },
    evidence: [{ id: 'evd_livesmoke01', kind: 'runtime_state', supports: ['palace.state'] }],
    liveState: {
      access: 'authorized',
      discovery: {
        palace: 'needed',
        crew: 'needed',
        capabilities: 'needed',
        routines: 'needed',
        knowledge: 'needed',
      },
      materialIssue: null,
      capabilityFit: 'supported',
      plan: {
        status: 'absent',
        proposal: null,
        planId: null,
        actionId: null,
        expectedVersion: null,
        protectedRoutineId: null,
        protectedRoutineVersionId: null,
      },
      operation: { status: 'absent', operationId: null, reconciliationRequired: false },
      verification: { status: 'not_ready', claims: [], failedCriteria: [] },
      integrityAlerts: [],
    },
    lastToolResult: null,
  })
}

await main()

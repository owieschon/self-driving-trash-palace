import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AnalyticsAliaser,
  EvidenceInsertConflictError,
  InMemoryEvidenceSink,
  LocalJsonlEvidenceSink,
  type EvidenceSink,
} from '@trash-palace/observability'
import { InMemoryApplicationStore } from '@trash-palace/application/testing'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CaretakerEvidenceRecorder,
  type CaretakerEvidenceRecorderConfig,
} from './caretaker-evidence.js'

const temporaryDirectories: string[] = []
const RUN = {
  runId: 'run_evidencerun001',
  activatedAt: '2026-07-15T12:00:00.000Z',
  organizationId: 'org_evidenceorg01',
  actorId: 'usr_evidenceactor01',
  palaceId: 'pal_evidencepalace1',
  missionId: 'mis_evidencemission',
  contextManifestHash: 'b'.repeat(64),
} as const
const CONTEXT_HASH = 'b'.repeat(64)
const OTHER_CONTEXT_HASH = 'c'.repeat(64)
const ZERO_COUNTERS = {
  toolCallCount: 0,
  planRevisionCount: 0,
  clarificationPauseCount: 0,
  reconciliationPollCount: 0,
  activeRuntimeMilliseconds: 0,
} as const

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function recorder(sink: EvidenceSink): CaretakerEvidenceRecorder {
  return new CaretakerEvidenceRecorder({
    sink,
    deliveries: new InMemoryApplicationStore(),
    aliaser: new AnalyticsAliaser('test-only-caretaker-alias-key-with-at-least-32-bytes'),
    environment: 'test',
    dataOrigin: 'fixture',
    appVersion: '0.0.0-test',
    harnessVersion: 'caretaker-host@1',
    modelConfigVersion: 'deterministic-caretaker@1',
    featureFlags: {
      'caretaker-write-authority': true,
      'caretaker-context': 'focused-v1',
    },
  })
}

function configuredRecorder(
  overrides: Partial<CaretakerEvidenceRecorderConfig> = {},
): CaretakerEvidenceRecorder {
  return new CaretakerEvidenceRecorder({
    sink: new InMemoryEvidenceSink(),
    deliveries: new InMemoryApplicationStore(),
    aliaser: new AnalyticsAliaser('test-only-caretaker-alias-key-with-at-least-32-bytes'),
    environment: 'test',
    dataOrigin: 'fixture',
    appVersion: '0.0.0-test',
    harnessVersion: 'caretaker-host@1',
    modelConfigVersion: 'deterministic-caretaker@1',
    featureFlags: {
      'caretaker-write-authority': true,
      'caretaker-context': 'focused-v1',
    },
    ...overrides,
  })
}

async function captureDeterministicRun(evidence: ReturnType<CaretakerEvidenceRecorder['begin']>) {
  await evidence.recordContext({
    identity: 'ctx_evidencecontext1',
    contextManifestHash: CONTEXT_HASH,
    occurredAt: '2026-07-15T12:00:00.010Z',
    latencyMilliseconds: 12,
    status: 'succeeded',
  })
  await evidence.recordDecision({
    identity: 'request_evidence_decision_1',
    contextManifestHash: CONTEXT_HASH,
    occurredAt: '2026-07-15T12:00:00.025Z',
    latencyMilliseconds: 3,
    status: 'succeeded',
  })
  await evidence.recordTool({
    identity: 'call_evidencereconcile',
    contextManifestHash: CONTEXT_HASH,
    occurredAt: '2026-07-15T12:00:00.030Z',
    latencyMilliseconds: 21,
    status: 'succeeded',
    toolName: 'operations.get',
  })
  await evidence.recordVerification({
    identity: 'evd_evidenceverifier1',
    contextManifestHash: CONTEXT_HASH,
    occurredAt: '2026-07-15T12:00:00.055Z',
    latencyMilliseconds: 8,
    status: 'succeeded',
  })
  await evidence.finish({
    contextManifestHash: CONTEXT_HASH,
    completedAt: '2026-07-15T12:00:00.080Z',
    outcome: 'verified',
    counters: {
      ...ZERO_COUNTERS,
      toolCallCount: 1,
      reconciliationPollCount: 1,
      activeRuntimeMilliseconds: 44,
    },
    budgetExhausted: false,
  })
}

describe('Caretaker privacy-safe evidence hierarchy', () => {
  it('binds activation identity to byte-affecting configuration without retaining the alias key', () => {
    const first = recorder(new InMemoryEvidenceSink())
    const reordered = new CaretakerEvidenceRecorder({
      sink: new InMemoryEvidenceSink(),
      deliveries: new InMemoryApplicationStore(),
      aliaser: new AnalyticsAliaser('test-only-caretaker-alias-key-with-at-least-32-bytes'),
      environment: 'test',
      dataOrigin: 'fixture',
      appVersion: '0.0.0-test',
      harnessVersion: 'caretaker-host@1',
      modelConfigVersion: 'deterministic-caretaker@1',
      featureFlags: {
        'caretaker-context': 'focused-v1',
        'caretaker-write-authority': true,
      },
    })
    const rotated = new CaretakerEvidenceRecorder({
      sink: new InMemoryEvidenceSink(),
      deliveries: new InMemoryApplicationStore(),
      aliaser: new AnalyticsAliaser('rotated-caretaker-alias-key-with-at-least-32-bytes'),
      environment: 'test',
      dataOrigin: 'fixture',
      appVersion: '0.0.0-test',
      harnessVersion: 'caretaker-host@1',
      modelConfigVersion: 'deterministic-caretaker@1',
      featureFlags: {
        'caretaker-write-authority': true,
        'caretaker-context': 'focused-v1',
      },
    })

    expect(first.configurationHash()).toBe(reordered.configurationHash())
    expect(rotated.configurationHash()).not.toBe(first.configurationHash())
    expect(first.configurationHash()).not.toContain('test-only-caretaker')
  })

  it('fails closed when any frozen byte configuration changes during a durable run', () => {
    const baseline = configuredRecorder()
    const profile = baseline.profile(RUN)
    const serialized = JSON.stringify(profile)

    expect(
      configuredRecorder({
        featureFlags: {
          'caretaker-context': 'focused-v1',
          'caretaker-write-authority': true,
        },
      }).assertCompatibleProfile(profile),
    ).toEqual(profile)
    for (const privateValue of [
      RUN.runId,
      RUN.organizationId,
      RUN.actorId,
      RUN.palaceId,
      RUN.missionId,
      'test-only-caretaker-alias-key-with-at-least-32-bytes',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }

    const drifted = [
      configuredRecorder({ appVersion: '0.0.1-test' }),
      configuredRecorder({ harnessVersion: 'caretaker-host@2' }),
      configuredRecorder({ modelConfigVersion: 'deterministic-caretaker@2' }),
      configuredRecorder({ environment: 'local' }),
      configuredRecorder({ dataOrigin: 'evaluation' }),
      configuredRecorder({
        featureFlags: {
          'caretaker-write-authority': false,
          'caretaker-context': 'focused-v1',
        },
      }),
      configuredRecorder({
        aliaser: new AnalyticsAliaser('rotated-caretaker-alias-key-with-at-least-32-bytes'),
      }),
    ]
    for (const current of drifted) {
      expect(() => current.assertCompatibleProfile(profile)).toThrow(
        /evidence configuration changed during a durable run/,
      )
    }
  })

  it('retains one exact-replay-safe run trace with an ordered deterministic timeline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trash-palace-caretaker-evidence-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'caretaker.jsonl')

    await captureDeterministicRun(recorder(new LocalJsonlEvidenceSink(filePath)).begin(RUN))
    await captureDeterministicRun(recorder(new LocalJsonlEvidenceSink(filePath)).begin(RUN))

    const sink = new LocalJsonlEvidenceSink(filePath)
    const events = await sink.all()
    const aiEvents = events.filter((event) => event.kind === 'ai')
    expect(events).toHaveLength(5)
    expect(new Set(events.map((event) => event.insertId)).size).toBe(5)
    expect(new Set(aiEvents.map((event) => event.properties.$ai_session_id)).size).toBe(1)
    expect(new Set(aiEvents.map((event) => event.properties.$ai_trace_id)).size).toBe(1)
    expect(aiEvents.filter((event) => event.event === '$ai_generation')).toHaveLength(0)
    expect(events.map((event) => event.occurredAt)).toEqual([
      '2026-07-15T12:00:00.010Z',
      '2026-07-15T12:00:00.025Z',
      '2026-07-15T12:00:00.030Z',
      '2026-07-15T12:00:00.055Z',
      '2026-07-15T12:00:00.000Z',
    ])

    const trace = aiEvents.find((event) => event.event === '$ai_trace')
    expect(trace?.properties).toMatchObject({
      outcome: 'verified',
      generation_count: 0,
      tool_call_count: 1,
      reconciliation_poll_count: 1,
      active_runtime_ms: 44,
      budget_exhausted: false,
      $ai_latency: 0.08,
    })
    const decision = aiEvents.find(
      (event) =>
        event.event === '$ai_span' && event.properties.$ai_span_name === 'caretaker.decision',
    )
    expect(decision?.properties).toMatchObject({ span_kind: 'other', status: 'succeeded' })
    const reconciliation = aiEvents.find(
      (event) => event.event === '$ai_span' && event.properties.span_kind === 'reconciliation',
    )
    expect(reconciliation?.properties).toMatchObject({
      $ai_span_name: 'caretaker.reconcile',
      tool_name: 'operations.get',
    })

    const serialized = await readFile(filePath, 'utf8')
    for (const privateValue of [
      RUN.runId,
      RUN.organizationId,
      RUN.actorId,
      RUN.palaceId,
      RUN.missionId,
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(serialized).not.toContain('"$ai_input":')
    expect(serialized).not.toContain('"$ai_output_choices":')
    expect(serialized.trim().split('\n')).toHaveLength(5)
  })

  it('records actual provider usage without treating deterministic decisions as generations', async () => {
    const sink = new InMemoryEvidenceSink()
    const evidence = recorder(sink).begin(RUN)
    await evidence.recordGeneration({
      identity: 'request_model_attempt_001',
      contextManifestHash: CONTEXT_HASH,
      occurredAt: '2026-07-15T12:00:00.020Z',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 431,
      outputTokens: 87,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 40,
      cacheReportingExclusive: true,
      latencyMilliseconds: 707,
      sdkDurationMilliseconds: 812,
      timeToFirstTokenMilliseconds: 209,
      streamed: false,
      totalCostUsd: 0.0042,
      stopReason: 'end_turn',
      isError: false,
      inputRedactionCount: 0,
      outputRedactionCount: 0,
      completionClaim: 'none',
    })
    await evidence.finish({
      contextManifestHash: CONTEXT_HASH,
      completedAt: '2026-07-15T12:00:01.000Z',
      outcome: 'safe_refusal',
      counters: { ...ZERO_COUNTERS, activeRuntimeMilliseconds: 812 },
      budgetExhausted: false,
    })

    const events = await sink.all()
    const generation = events.find((event) => event.event === '$ai_generation')
    expect(generation?.properties).toMatchObject({
      $ai_input_tokens: 431,
      $ai_output_tokens: 87,
      $ai_cache_read_input_tokens: 200,
      $ai_cache_creation_input_tokens: 40,
      cache_token_counts_exclusive: true,
      $ai_latency: 0.707,
      sdk_duration_seconds: 0.812,
      $ai_time_to_first_token: 0.209,
      $ai_total_cost_usd: 0.0042,
    })
    const trace = events.find((event) => event.event === '$ai_trace')
    expect(trace?.properties).toMatchObject({
      outcome: 'safe_refusal',
      generation_count: 1,
      $ai_is_error: false,
    })
  })

  it('maps one model observation to PostHog generation semantics without retaining content', async () => {
    const sink = new InMemoryEvidenceSink()
    const evidence = recorder(sink).begin(RUN)

    await evidence.recordDecisionObservation({
      contextManifestHash: CONTEXT_HASH,
      occurredAt: '2026-07-15T12:00:00.020Z',
      measuredLatencyMilliseconds: 900,
      observation: {
        schemaVersion: 'caretaker-decision-observation@1',
        kind: 'model_generation',
        requestId: 'request_model_observation_001',
        attemptId: 'attempt_model_observation_001',
        engineId: 'claude-agent-sdk@1/claude-sonnet-4-6',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        status: 'succeeded',
        resultSubtype: 'success',
        inputTokens: 31,
        outputTokens: 7,
        cacheReadInputTokens: 11,
        cacheCreationInputTokens: 2,
        cacheReportingExclusive: true,
        durationMilliseconds: 900,
        apiDurationMilliseconds: 740,
        timeToFirstTokenMilliseconds: 120,
        totalCostUsd: 0.0009,
        stopReason: 'end_turn',
        streamed: false,
        failureCode: null,
      },
    })

    const [generation] = await sink.all()
    expect(generation).toMatchObject({
      event: '$ai_generation',
      properties: {
        $ai_latency: 0.74,
        sdk_duration_seconds: 0.9,
        $ai_time_to_first_token: 0.12,
        completion_claim: 'none',
      },
    })
    expect(Object.hasOwn(generation?.properties ?? {}, '$ai_input')).toBe(false)
    expect(Object.hasOwn(generation?.properties ?? {}, '$ai_output_choices')).toBe(false)
  })

  it('maps deterministic and adapter failures to spans rather than invented generations', async () => {
    const sink = new InMemoryEvidenceSink()
    const evidence = recorder(sink).begin(RUN)
    await evidence.recordDecisionObservation({
      contextManifestHash: CONTEXT_HASH,
      occurredAt: '2026-07-15T12:00:00.010Z',
      measuredLatencyMilliseconds: 4,
      observation: {
        schemaVersion: 'caretaker-decision-observation@1',
        kind: 'deterministic_decision',
        requestId: 'request_deterministic_observation_001',
        attemptId: 'attempt_deterministic_observation_001',
        engineId: 'deterministic-caretaker@1',
        status: 'succeeded',
        decisionKind: 'invoke_tool',
        failureCode: null,
      },
    })
    await evidence.recordDecisionObservation({
      contextManifestHash: CONTEXT_HASH,
      occurredAt: '2026-07-15T12:00:00.020Z',
      measuredLatencyMilliseconds: 5,
      observation: {
        schemaVersion: 'caretaker-decision-observation@1',
        kind: 'adapter_failure',
        requestId: null,
        attemptId: 'attempt_adapter_failure_001',
        engineId: 'claude-agent-sdk@1/claude-sonnet-4-6',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        failureCode: 'sdk_query_failed',
        generationUsageAvailable: false,
      },
    })

    const events = await sink.all()
    expect(events).toHaveLength(2)
    expect(events.every((event) => event.event === '$ai_span')).toBe(true)
    expect(events[1]?.properties).toMatchObject({
      status: 'failed',
      error_code: 'sdk_query_failed',
      $ai_is_error: true,
    })
  })

  it('distinguishes an exact export replay from a new execution attempt', async () => {
    const sink = new InMemoryEvidenceSink()
    const evidence = recorder(sink).begin(RUN)
    const first = {
      identity: 'request_attempt_001',
      contextManifestHash: CONTEXT_HASH,
      occurredAt: '2026-07-15T12:00:00.020Z',
      latencyMilliseconds: 5,
      status: 'succeeded' as const,
    }
    await expect(evidence.recordDecision(first)).resolves.toMatchObject({ status: 'stored' })
    await expect(evidence.recordDecision(first)).resolves.toMatchObject({ status: 'duplicate' })
    await expect(
      evidence.recordDecision({ ...first, latencyMilliseconds: 6 }),
    ).rejects.toBeInstanceOf(EvidenceInsertConflictError)
    await expect(
      evidence.recordDecision({
        ...first,
        identity: 'request_attempt_002',
        latencyMilliseconds: 6,
      }),
    ).resolves.toMatchObject({ status: 'stored' })
  })

  it('pins one context manifest and rejects impossible trace or status combinations', async () => {
    const evidence = recorder(new InMemoryEvidenceSink()).begin(RUN)
    await evidence.recordContext({
      identity: 'ctx_manifest_pin_001',
      contextManifestHash: CONTEXT_HASH,
      occurredAt: '2026-07-15T12:00:00.010Z',
      latencyMilliseconds: 1,
      status: 'succeeded',
    })
    expect(() =>
      evidence.recordDecision({
        identity: 'request_manifest_drift_001',
        contextManifestHash: OTHER_CONTEXT_HASH,
        occurredAt: '2026-07-15T12:00:00.020Z',
        latencyMilliseconds: 1,
        status: 'succeeded',
      }),
    ).toThrow(/frozen context manifest/)
    await expect(
      evidence.finish({
        contextManifestHash: CONTEXT_HASH,
        completedAt: '2026-07-15T12:00:00.030Z',
        outcome: 'verified',
        counters: ZERO_COUNTERS,
        budgetExhausted: true,
        pauseReason: 'budget',
        errorCode: 'verification_failed',
      }),
    ).rejects.toThrow()
    expect(() =>
      evidence.recordTool({
        identity: 'call_unknown_without_code',
        contextManifestHash: CONTEXT_HASH,
        occurredAt: '2026-07-15T12:00:00.020Z',
        latencyMilliseconds: 1,
        status: 'unknown',
        toolName: 'operations.get',
      }),
    ).toThrow()
  })

  it('classifies denied outcomes as safe policy results and conflicts as errors', async () => {
    const sink = new InMemoryEvidenceSink()
    const evidence = recorder(sink).begin(RUN)
    await evidence.recordTool({
      identity: 'call_denied_policy_001',
      contextManifestHash: CONTEXT_HASH,
      occurredAt: '2026-07-15T12:00:00.010Z',
      latencyMilliseconds: 1,
      status: 'denied',
      errorCode: 'authorization_denied',
      toolName: 'plans.activate',
    })
    await evidence.recordTool({
      identity: 'call_conflict_001',
      contextManifestHash: CONTEXT_HASH,
      occurredAt: '2026-07-15T12:00:00.020Z',
      latencyMilliseconds: 1,
      status: 'conflict',
      errorCode: 'protected_state_conflict',
      toolName: 'plans.activate',
    })
    const spans = (await sink.all()).filter((event) => event.event === '$ai_span')
    expect(spans[0]?.properties.$ai_is_error).toBe(false)
    expect(spans[1]?.properties.$ai_is_error).toBe(true)
  })

  it('classifies verifier receipt retrieval as a verification span', async () => {
    const sink = new InMemoryEvidenceSink()
    const evidence = recorder(sink).begin(RUN)

    await evidence.recordTool({
      identity: 'call_verifier_receipt_001',
      contextManifestHash: CONTEXT_HASH,
      occurredAt: '2026-07-15T12:00:00.010Z',
      latencyMilliseconds: 9,
      status: 'succeeded',
      toolName: 'verification.get_evidence',
    })

    const [event] = await sink.all()
    expect(event?.properties).toMatchObject({
      $ai_span_name: 'caretaker.verification',
      span_kind: 'verification',
      tool_name: 'verification.get_evidence',
    })
  })

  it('rejects credential-shaped metadata before evidence is stored', async () => {
    const sink = new InMemoryEvidenceSink()
    const evidence = recorder(sink).begin(RUN)

    await expect(
      Promise.resolve().then(() =>
        evidence.recordGeneration({
          identity: 'request_evidence_unsafe_1',
          contextManifestHash: CONTEXT_HASH,
          occurredAt: '2026-07-15T12:00:00.010Z',
          model: ['sk', 'ant', 'syntheticcredential000000'].join('-'),
          provider: 'anthropic',
          inputTokens: 1,
          outputTokens: 1,
          latencyMilliseconds: 1,
          streamed: false,
          isError: true,
          errorCode: 'model_rejected',
          inputRedactionCount: 1,
          outputRedactionCount: 0,
          completionClaim: 'none',
        }),
      ),
    ).rejects.toThrow()
    await expect(sink.all()).resolves.toHaveLength(0)
  })
})

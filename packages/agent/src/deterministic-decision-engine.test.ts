import { describe, expect, it } from 'vitest'

import {
  CaretakerDecisionRequestSchema,
  createCaretakerFrozenContext,
  type CaretakerDecisionActivation,
  type CaretakerDecisionObservation,
  type CaretakerDecisionRequest,
} from './decision-engine.js'
import { projectExactToolContracts } from './context-contracts.js'
import { DeterministicCaretakerDecisionEngine } from './deterministic-decision-engine.js'
import { hashHostPolicyContract, projectHostPolicy } from './host-policy.js'

function frozenContext(
  receiptId: string,
  receiptBindingHash: string,
  tools: Parameters<typeof projectExactToolContracts>[0] = ['palaces.get'],
) {
  return createCaretakerFrozenContext({
    schemaVersion: 'caretaker-frozen-context@1',
    receiptId,
    receiptBindingHash,
    bundleId: 'bundle_deterministic01',
    bundleHash: 'b'.repeat(64),
    frozenAt: '2026-07-15T09:00:00.000Z',
    hostPolicy: projectHostPolicy(hashHostPolicyContract()),
    exactContracts: projectExactToolContracts(tools),
    sections: [],
    filtering: {
      confidentialSourcesExcluded: 0,
      tenantPrivateSourcesExcluded: 0,
      crossTenantSourcesExcluded: 0,
      runtimeSnapshotsExcluded: 0,
    },
  })
}

function decisionRequest(): CaretakerDecisionRequest {
  const contextReceiptId = 'ctx_context01'
  const contextBundleHash = 'a'.repeat(64)
  return CaretakerDecisionRequestSchema.parse({
    schemaVersion: 'caretaker-decision-request@1',
    requestId: 'request.deterministic.1',
    contextReceiptId,
    contextBundleHash,
    frozenContext: frozenContext(contextReceiptId, contextBundleHash),
    retrievedKnowledge: [],
    runId: 'run_activation1',
    mission: {
      id: 'mis_nightshift',
      palaceId: 'pal_rockyhome',
      programKind: 'night_shift_homecoming',
      objective: 'Inspect the palace and prepare a safe homecoming routine.',
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
    evidence: [
      {
        id: 'evd_runtime01',
        kind: 'runtime_state',
        supports: ['palace.state'],
      },
    ],
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
      operation: {
        status: 'absent',
        operationId: null,
        reconciliationRequired: false,
      },
      verification: {
        status: 'not_ready',
        claims: [],
        failedCriteria: [],
      },
      integrityAlerts: [],
    },
    lastToolResult: null,
  })
}

function activation(
  observations: CaretakerDecisionObservation[],
  attemptId = 'decision.deterministic.001',
): CaretakerDecisionActivation {
  return {
    signal: new AbortController().signal,
    attemptId,
    observe: (observation) => {
      observations.push(observation)
      return Promise.resolve()
    },
  }
}

describe('deterministic Caretaker decision observations', () => {
  it('rejects status-only knowledge readiness and a tampered frozen projection', () => {
    const request = decisionRequest()
    expect(
      CaretakerDecisionRequestSchema.safeParse({
        ...request,
        liveState: {
          ...request.liveState,
          discovery: { ...request.liveState.discovery, knowledge: 'ready' },
        },
      }).success,
    ).toBe(false)
    expect(
      CaretakerDecisionRequestSchema.safeParse({
        ...request,
        frozenContext: {
          ...request.frozenContext,
          bundleHash: 'c'.repeat(64),
        },
      }).success,
    ).toBe(false)
  })

  it('emits one deterministic decision observation without model-generation fields', async () => {
    const observations: CaretakerDecisionObservation[] = []
    const engine = new DeterministicCaretakerDecisionEngine()

    await expect(engine.decide(decisionRequest(), activation(observations))).resolves.toMatchObject(
      {
        kind: 'invoke_tool',
        toolName: 'palaces.get',
      },
    )

    expect(observations).toEqual([
      {
        schemaVersion: 'caretaker-decision-observation@1',
        kind: 'deterministic_decision',
        requestId: 'request.deterministic.1',
        attemptId: 'decision.deterministic.001',
        engineId: 'deterministic-caretaker@1',
        status: 'succeeded',
        decisionKind: 'invoke_tool',
        failureCode: null,
      },
    ])
    expect(observations[0]).not.toHaveProperty('model')
    expect(observations[0]).not.toHaveProperty('inputTokens')
    expect(observations[0]).not.toHaveProperty('outputTokens')
    expect(observations[0]).not.toHaveProperty('totalCostUsd')
  })

  it('uses a stable program term instead of the conjunctive mission brief for retrieval', async () => {
    const base = decisionRequest()
    const request = CaretakerDecisionRequestSchema.parse({
      ...base,
      frozenContext: frozenContext(base.contextReceiptId, base.contextBundleHash, [
        'knowledge.search',
      ]),
      allowedTools: ['knowledge.search'],
      liveState: {
        ...base.liveState,
        discovery: {
          palace: 'ready',
          crew: 'ready',
          capabilities: 'ready',
          routines: 'ready',
          knowledge: 'needed',
        },
      },
    })

    await expect(
      new DeterministicCaretakerDecisionEngine().decide(request, activation([])),
    ).resolves.toMatchObject({
      kind: 'invoke_tool',
      toolName: 'knowledge.search',
      input: { query: 'homecoming', phase: 'understand', limit: 6 },
    })
  })

  it('continues an approved durable plan without replaying planning discovery', async () => {
    const base = decisionRequest()
    const request = CaretakerDecisionRequestSchema.parse({
      ...base,
      frozenContext: frozenContext(base.contextReceiptId, base.contextBundleHash, [
        'plans.activate',
      ]),
      mission: {
        ...base.mission,
        state: { status: 'running', phase: 'execute' },
      },
      allowedTools: ['plans.activate'],
      evidence: [
        { id: 'evd_approval01', kind: 'runtime_state', supports: ['approval.status'] },
        { id: 'evd_planhash01', kind: 'runtime_state', supports: ['plan.hash'] },
      ],
      liveState: {
        ...base.liveState,
        plan: {
          status: 'approved',
          proposal: null,
          planId: 'pln_approvedplan1',
          actionId: 'act_approvedaction1',
          expectedVersion: 3,
          protectedRoutineId: null,
          protectedRoutineVersionId: null,
        },
      },
    })

    await expect(
      new DeterministicCaretakerDecisionEngine().decide(request, activation([])),
    ).resolves.toMatchObject({ kind: 'invoke_tool', toolName: 'plans.activate' })
  })

  it('reconciles an existing uncertain operation instead of activating the plan again', async () => {
    const base = decisionRequest()
    const request = CaretakerDecisionRequestSchema.parse({
      ...base,
      frozenContext: frozenContext(base.contextReceiptId, base.contextBundleHash, [
        'operations.get',
      ]),
      mission: {
        ...base.mission,
        state: { status: 'running', phase: 'reconcile' },
      },
      allowedTools: ['operations.get'],
      budget: {
        ...base.budget,
        toolCalls: { used: 1, max: 24 },
        reconciliationPolls: { used: 0, max: 3 },
      },
      evidence: [
        {
          id: 'evd_operation01',
          kind: 'runtime_state',
          supports: ['operation.id', 'operation.status'],
        },
      ],
      liveState: {
        ...base.liveState,
        operation: {
          status: 'outcome_unknown',
          operationId: 'op_reconcile01',
          reconciliationRequired: true,
        },
      },
      lastToolResult: {
        toolName: 'plans.activate',
        status: 'unknown',
        errorCode: null,
        evidenceIds: ['evd_operation01'],
      },
    })

    await expect(
      new DeterministicCaretakerDecisionEngine().decide(request, activation([])),
    ).resolves.toMatchObject({
      kind: 'invoke_tool',
      toolName: 'operations.get',
      input: { operationId: 'op_reconcile01' },
    })
  })

  it('emits one sanitized deterministic failure for an invalid request', async () => {
    const observations: CaretakerDecisionObservation[] = []
    const engine = new DeterministicCaretakerDecisionEngine()
    const invalid = { ...decisionRequest(), requestId: 'NOT VALID' } as CaretakerDecisionRequest

    await expect(engine.decide(invalid, activation(observations))).rejects.toThrow()

    expect(observations).toEqual([
      {
        schemaVersion: 'caretaker-decision-observation@1',
        kind: 'deterministic_decision',
        requestId: null,
        attemptId: 'decision.deterministic.001',
        engineId: 'deterministic-caretaker@1',
        status: 'failed',
        decisionKind: null,
        failureCode: 'decision_request_invalid',
      },
    ])
  })
})

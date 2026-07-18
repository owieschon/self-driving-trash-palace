import { describe, expect, it } from 'vitest'

import {
  CaretakerDecisionSchema,
  CaretakerDecisionRequestSchema,
  parseDecisionForRequest,
  ToolInvocationDecisionSchema,
  type CaretakerDecision,
  type CaretakerDecisionEngine,
} from '../../packages/agent/src/decision-engine.js'
import { DeterministicCaretakerDecisionEngine } from '../../packages/agent/src/deterministic-decision-engine.js'
import {
  runDeterministicScenario,
  scoreScenario,
} from '../../packages/agent/src/deterministic-harness.js'
import {
  CARETAKER_DETERMINISTIC_CASES,
  CaretakerDecisionContractEnvironment,
} from './deterministic-cases.js'
import { CARETAKER_SCENARIO_MANIFESTS } from './manifests.js'

const engine = new DeterministicCaretakerDecisionEngine()

function caseById(id: string) {
  const scenario = CARETAKER_DETERMINISTIC_CASES.find((candidate) => candidate.manifest.id === id)
  if (scenario === undefined) throw new Error(`Missing deterministic case ${id}`)
  return scenario
}

describe('Caretaker deterministic corpus', () => {
  it('pins all 12 versioned held-out case manifests', () => {
    expect(CARETAKER_SCENARIO_MANIFESTS).toHaveLength(12)
    expect(new Set(CARETAKER_SCENARIO_MANIFESTS.map((manifest) => manifest.case)).size).toBe(12)
    expect(CARETAKER_SCENARIO_MANIFESTS.every((manifest) => manifest.id.endsWith('@1'))).toBe(true)
  })

  it.each(CARETAKER_DETERMINISTIC_CASES)(
    '$manifest.id reaches its declared durable outcome',
    async ({ manifest, createEnvironment }) => {
      const result = await runDeterministicScenario(engine, createEnvironment(), manifest)

      expect(result.score.issues).toEqual([])
      expect(result.score.passed).toBe(true)
      expect(result.observation.terminalOutcome).toBe(manifest.expectedTerminalOutcome)
      expect(result.observation.budgetUsage).toEqual({
        toolCalls: manifest.maxToolCalls,
        planRevisions: manifest.maxPlanRevisions,
        clarifications: manifest.maxClarifications,
        reconciliationPolls: manifest.maxReconciliationPolls,
      })
      expect(result.receipt).toMatchObject({
        proofLevel: 'decision_contract_simulation',
        manifestId: manifest.id,
        terminalOutcome: manifest.expectedTerminalOutcome,
      })
    },
    60_000,
  )

  it('changes the next decision when protected live state changes', async () => {
    const baseline = caseById('clear-paraphrase@1').createEnvironment()
    const changed = caseById('stale-protected-version@1').createEnvironment()
    const baselineRequest = await baseline.nextRequest()
    const changedRequest = await changed.nextRequest()
    if (baselineRequest === null || changedRequest === null) throw new Error('Cases must start')

    const baselineDecision = await engine.decide(baselineRequest)
    const changedDecision = await engine.decide(changedRequest)

    expect(baselineDecision).toMatchObject({ kind: 'invoke_tool', toolName: 'plans.propose' })
    expect(changedDecision).toMatchObject({ kind: 'invoke_tool', toolName: 'routines.get' })
  })

  it('fails a fixed baseline transcript after protected live state changes', async () => {
    const baselineEnvironment = caseById('clear-paraphrase@1').createEnvironment()
    const baselineRequest = await baselineEnvironment.nextRequest()
    if (baselineRequest === null) throw new Error('Baseline case must start')
    const baselineDecision = await engine.decide(baselineRequest)

    const scriptedEngine: CaretakerDecisionEngine = {
      id: 'fixed-baseline-transcript@1',
      decide: () => Promise.resolve(baselineDecision),
    }
    const changedCase = caseById('stale-protected-version@1')
    const result = await runDeterministicScenario(
      scriptedEngine,
      changedCase.createEnvironment(),
      changedCase.manifest,
    )

    expect(result.score.passed).toBe(false)
    expect(result.score.issues.map((issue) => issue.code)).toContain('terminal_outcome_mismatch')
  })
})

describe('Caretaker decision boundary', () => {
  it('covers the exact 15-tool registry and derives the host clarification ceiling', async () => {
    const request = await caseById('energy-conflict@1').createEnvironment().nextRequest()
    if (request === null) throw new Error('Case must start')

    expect(ToolInvocationDecisionSchema.options).toHaveLength(15)
    expect(request.budget.clarifications.max).toBe(2)
  })

  it('rejects a direct mission-state mutation or self-declared success', () => {
    const invalid = {
      schemaVersion: 'caretaker-decision@1',
      kind: 'grounded_summary',
      reason: 'I changed the mission directly.',
      evidenceIds: ['evd_verifier_receipt'],
      status: 'verifier_receipt_available',
      claims: [
        {
          field: 'verification.status',
          value: 'passed',
          evidenceIds: ['evd_verifier_receipt'],
        },
      ],
      missionState: { status: 'succeeded', phase: 'verify' },
      verifiedSuccess: true,
    }

    expect(CaretakerDecisionSchema.safeParse(invalid).success).toBe(false)
  })

  it('rejects malformed input for a registered tool', () => {
    const invalid: unknown = {
      schemaVersion: 'caretaker-decision@1',
      kind: 'invoke_tool',
      toolName: 'operations.get',
      input: { operationId: 'not-an-operation' },
      reason: 'Reconcile the operation.',
      evidenceIds: [],
    }

    expect(CaretakerDecisionSchema.safeParse(invalid).success).toBe(false)
  })

  it('binds a clarification to the host-projected material issue', async () => {
    const request = await caseById('energy-conflict@1').createEnvironment().nextRequest()
    if (request === null) throw new Error('Case must start')
    const invalid = {
      schemaVersion: 'caretaker-decision@1',
      kind: 'request_clarification',
      reason: 'Ask a different question.',
      evidenceIds: ['evd_material_issue'],
      materialField: 'preference.temperature_celsius',
      question: 'Choose a temperature.',
      choices: [
        { id: 'cold', label: 'Cold' },
        { id: 'warm', label: 'Warm' },
      ],
    }

    expect(() => parseDecisionForRequest(request, invalid)).toThrow(
      'Clarification must match the unresolved host-projected material issue',
    )
  })

  it('rejects a grounded claim when its evidence does not support that field', async () => {
    const environment = caseById('duplicate-callback@1').createEnvironment()
    const first = await environment.nextRequest()
    if (first === null) throw new Error('Case must start')
    await environment.applyDecision(await engine.decide(first))
    const verifierRequest = await environment.nextRequest()
    if (verifierRequest === null) throw new Error('Verifier checkpoint must remain')
    const invalid = {
      schemaVersion: 'caretaker-decision@1',
      kind: 'grounded_summary',
      reason: 'Cite an unrelated field.',
      evidenceIds: ['evd_runtime_state'],
      status: 'verifier_receipt_available',
      claims: [
        {
          field: 'verification.status',
          value: 'passed',
          evidenceIds: ['evd_runtime_state'],
        },
      ],
    }

    expect(() => parseDecisionForRequest(verifierRequest, invalid)).toThrow(
      'Claim verification.status lacks evidence that supports that field',
    )
  })

  it('requires retained evidence for pauses and escalations', () => {
    const pause = {
      schemaVersion: 'caretaker-decision@1',
      kind: 'pause',
      reason: 'Wait.',
      evidenceIds: [],
      pauseReason: 'human_action_required',
      resumeWhen: 'A human responds.',
    }
    const escalation = {
      schemaVersion: 'caretaker-decision@1',
      kind: 'escalate',
      reason: 'Stop.',
      evidenceIds: [],
      escalationReason: 'hard_invariant_risk',
      disposition: 'human_review',
      safestAction: 'Keep state unchanged.',
    }

    expect(CaretakerDecisionSchema.safeParse(pause).success).toBe(false)
    expect(CaretakerDecisionSchema.safeParse(escalation).success).toBe(false)
  })

  it('selects missing discovery state instead of following a turn number', async () => {
    const baseline = await caseById('clear-paraphrase@1').createEnvironment().nextRequest()
    if (baseline === null) throw new Error('Case must start')
    const absentPlan = {
      status: 'absent' as const,
      proposal: null,
      planId: null,
      actionId: null,
      expectedVersion: null,
      protectedRoutineId: null,
      protectedRoutineVersionId: null,
    }
    const palaceRequest = CaretakerDecisionRequestSchema.parse({
      ...baseline,
      requestId: 'discovery.palace',
      mission: { ...baseline.mission, state: { status: 'running', phase: 'understand' } },
      liveState: {
        ...baseline.liveState,
        discovery: { ...baseline.liveState.discovery, palace: 'needed' },
        plan: absentPlan,
      },
    })
    const crewRequest = CaretakerDecisionRequestSchema.parse({
      ...palaceRequest,
      requestId: 'discovery.crew',
      liveState: {
        ...palaceRequest.liveState,
        discovery: { ...palaceRequest.liveState.discovery, palace: 'ready', crew: 'needed' },
      },
    })

    expect(await engine.decide(palaceRequest)).toMatchObject({
      kind: 'invoke_tool',
      toolName: 'palaces.get',
    })
    expect(await engine.decide(crewRequest)).toMatchObject({
      kind: 'invoke_tool',
      toolName: 'crews.list',
    })
  })

  it('rejects last-tool evidence outside the retained request catalog', async () => {
    const request = await caseById('clear-paraphrase@1').createEnvironment().nextRequest()
    if (request === null) throw new Error('Case must start')
    const invalid = {
      ...request,
      lastToolResult: {
        toolName: 'palaces.get',
        status: 'succeeded',
        errorCode: null,
        evidenceIds: ['evd_foreign_result'],
      },
    }

    expect(CaretakerDecisionRequestSchema.safeParse(invalid).success).toBe(false)
  })

  it('pauses or escalates when host-derived budgets are exhausted', async () => {
    const toolRequest = await caseById('clear-paraphrase@1').createEnvironment().nextRequest()
    const clarificationRequest = await caseById('energy-conflict@1')
      .createEnvironment()
      .nextRequest()
    const reconciliationRequest = await caseById('commit-then-timeout@1')
      .createEnvironment()
      .nextRequest()
    if (toolRequest === null || clarificationRequest === null || reconciliationRequest === null) {
      throw new Error('Budget cases must start')
    }

    const toolExhausted = CaretakerDecisionRequestSchema.parse({
      ...toolRequest,
      allowedTools: [],
      budget: {
        ...toolRequest.budget,
        toolCalls: { ...toolRequest.budget.toolCalls, used: toolRequest.budget.toolCalls.max },
      },
    })
    const clarificationExhausted = CaretakerDecisionRequestSchema.parse({
      ...clarificationRequest,
      budget: {
        ...clarificationRequest.budget,
        clarifications: {
          ...clarificationRequest.budget.clarifications,
          used: clarificationRequest.budget.clarifications.max,
        },
      },
    })
    const reconciliationExhausted = CaretakerDecisionRequestSchema.parse({
      ...reconciliationRequest,
      budget: {
        ...reconciliationRequest.budget,
        reconciliationPolls: {
          ...reconciliationRequest.budget.reconciliationPolls,
          used: reconciliationRequest.budget.reconciliationPolls.max,
        },
      },
    })

    expect(await engine.decide(toolExhausted)).toMatchObject({
      kind: 'pause',
      pauseReason: 'budget_exhausted',
    })
    expect(await engine.decide(clarificationExhausted)).toMatchObject({
      kind: 'escalate',
      escalationReason: 'hard_invariant_risk',
    })
    expect(await engine.decide(reconciliationExhausted)).toMatchObject({
      kind: 'escalate',
      escalationReason: 'reconciliation_exhausted',
    })

    const runtimeExhausted = CaretakerDecisionRequestSchema.parse({
      ...toolRequest,
      budget: {
        ...toolRequest.budget,
        activeRuntimeMilliseconds: {
          ...toolRequest.budget.activeRuntimeMilliseconds,
          used: toolRequest.budget.activeRuntimeMilliseconds.max,
        },
      },
    })
    expect(await engine.decide(runtimeExhausted)).toMatchObject({
      kind: 'pause',
      pauseReason: 'budget_exhausted',
    })
  })

  it('rejects provider attempts to bypass semantic or active-runtime ceilings', async () => {
    const proposalRequest = await caseById('clear-paraphrase@1').createEnvironment().nextRequest()
    const reconciliationRequest = await caseById('commit-then-timeout@1')
      .createEnvironment()
      .nextRequest()
    if (proposalRequest === null || reconciliationRequest === null) {
      throw new Error('Budget bypass cases must start')
    }

    const proposal = await engine.decide(proposalRequest)
    const reconciliation = await engine.decide(reconciliationRequest)
    const unauthorizedReconciliationPoll = {
      schemaVersion: 'caretaker-decision@1',
      kind: 'invoke_tool',
      reason: 'Attempt to spend an exhausted reconciliation budget.',
      evidenceIds: reconciliation.evidenceIds,
      toolName: 'operations.get',
      input: { operationId: reconciliationRequest.liveState.operation.operationId },
    }
    const planBudgetExhausted = CaretakerDecisionRequestSchema.parse({
      ...proposalRequest,
      budget: {
        ...proposalRequest.budget,
        planRevisions: {
          ...proposalRequest.budget.planRevisions,
          used: proposalRequest.budget.planRevisions.max,
        },
      },
    })
    const reconciliationBudgetExhausted = CaretakerDecisionRequestSchema.parse({
      ...reconciliationRequest,
      budget: {
        ...reconciliationRequest.budget,
        reconciliationPolls: {
          ...reconciliationRequest.budget.reconciliationPolls,
          used: reconciliationRequest.budget.reconciliationPolls.max,
        },
      },
    })
    const runtimeExhausted = CaretakerDecisionRequestSchema.parse({
      ...proposalRequest,
      budget: {
        ...proposalRequest.budget,
        activeRuntimeMilliseconds: {
          ...proposalRequest.budget.activeRuntimeMilliseconds,
          used: proposalRequest.budget.activeRuntimeMilliseconds.max,
        },
      },
    })

    expect(() => parseDecisionForRequest(planBudgetExhausted, proposal)).toThrow(
      /plan-revision budget/,
    )
    expect(() =>
      parseDecisionForRequest(reconciliationBudgetExhausted, unauthorizedReconciliationPoll),
    ).toThrow(/reconciliation-poll budget/)
    expect(() => parseDecisionForRequest(runtimeExhausted, proposal)).toThrow(
      /active-runtime budget/,
    )
  })

  it('cannot expose a verifier-receipt summary before application verification passes', async () => {
    const request = await caseById('clear-paraphrase@1').createEnvironment().nextRequest()
    if (request === null) throw new Error('Case must start')
    const invalid = {
      schemaVersion: 'caretaker-decision@1',
      kind: 'grounded_summary',
      reason: 'Claim completion too early.',
      evidenceIds: ['evd_verifier_receipt'],
      status: 'verifier_receipt_available',
      claims: [
        {
          field: 'verification.status',
          value: 'passed',
          evidenceIds: ['evd_verifier_receipt'],
        },
      ],
    }

    expect(() => parseDecisionForRequest(request, invalid)).toThrow(
      'Only an application verifier pass can expose a verifier receipt summary',
    )
  })
})

describe('Outcome and durable-state scoring', () => {
  it('fails forbidden mutations, missing evidence, budget overruns, and invariant breaks', async () => {
    const scenario = caseById('clear-paraphrase@1')
    const environment = new CaretakerDecisionContractEnvironment(scenario.manifest)
    const passing = await runDeterministicScenario(engine, environment, scenario.manifest)
    const brokenObservation = {
      ...passing.observation,
      mutations: [
        {
          kind: 'restore_routine_version',
          resourceId: 'rtn_night_shift_home',
          logicalOutcomeId: 'outcome_forbidden_restore',
        },
      ],
      evidence: passing.observation.evidence.filter((evidence) => evidence.id !== 'evd_plan_hash'),
      budgetUsage: {
        ...passing.observation.budgetUsage,
        toolCalls: scenario.manifest.maxToolCalls + 1,
      },
      hardInvariantViolations: ['verified_identity_required_for_unlock'],
      falseCompletionClaims: 1,
      duplicateDurableOutcomes: 1,
    }

    const score = scoreScenario(scenario.manifest, brokenObservation)
    const codes = score.issues.map((entry) => entry.code)
    expect(score.passed).toBe(false)
    expect(codes).toEqual(
      expect.arrayContaining([
        'mutation_not_allowed',
        'claim_evidence_missing',
        'budget_exceeded',
        'hard_invariant_violation',
        'false_completion_claim',
        'duplicate_durable_outcome',
      ]),
    )
  }, 60_000)

  it('does not accept transcript data as an evaluation signal', async () => {
    const scenario = caseById('duplicate-callback@1')
    const result = await runDeterministicScenario(
      engine,
      scenario.createEnvironment(),
      scenario.manifest,
    )
    const withTranscript = {
      ...result.observation,
      expectedTranscript: ['plans.activate', 'verification.get_evidence'],
    }

    expect(() => scoreScenario(scenario.manifest, withTranscript)).toThrow()
  })

  it('keeps fixed decisions typed even when an environment rejects their semantics', async () => {
    const scenario = caseById('unsupported-lighting-capability@1')
    const request = await scenario.createEnvironment().nextRequest()
    if (request === null) throw new Error('Case must start')
    const decision: CaretakerDecision = await engine.decide(request)

    expect(CaretakerDecisionSchema.parse(decision).kind).toBe('escalate')
  })
})

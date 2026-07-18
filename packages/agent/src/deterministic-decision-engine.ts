import { RoutineIdSchema, hashToolValue, type ToolName } from '@trash-palace/core'

import {
  CaretakerDecisionObservationDeliveryError,
  CaretakerDecisionRequestSchema,
  emitCaretakerDecisionObservation,
  parseDecisionForRequest,
  type CaretakerDecision,
  type CaretakerDecisionActivation,
  type CaretakerDecisionEngine,
  type CaretakerDecisionRequest,
} from './decision-engine.js'

function evidenceFor(
  request: CaretakerDecisionRequest,
  ...fields: readonly string[]
): CaretakerDecisionRequest['evidence'][number]['id'][] {
  const matches = request.evidence.filter((entry) =>
    entry.supports.some((supportedField) => fields.includes(supportedField)),
  )
  return matches.map((entry) => entry.id)
}

function allEvidence(request: CaretakerDecisionRequest) {
  return request.evidence.map((entry) => entry.id)
}

function retrievedKnowledgeEvidence(request: CaretakerDecisionRequest) {
  return [...new Set(request.retrievedKnowledge.flatMap((entry) => entry.provenance.evidenceIds))]
}

function retrievedKnowledgeIdentity(request: CaretakerDecisionRequest): string {
  const first = request.retrievedKnowledge[0]
  if (first === undefined) return 'no retrieved knowledge'
  const label = `${first.sourceId.slice(0, 80)}@${first.sourceVersion.slice(0, 40)}`
  const projectionHash = hashToolValue(
    request.retrievedKnowledge.map((entry) => ({
      sourceId: entry.sourceId,
      sourceVersion: entry.sourceVersion,
      excerptHash: entry.excerptHash,
    })),
  )
  return `${label} (projection ${projectionHash.slice(0, 16)})`
}

function parse(request: CaretakerDecisionRequest, decision: unknown): CaretakerDecision {
  return parseDecisionForRequest(request, decision)
}

function pauseForBudget(request: CaretakerDecisionRequest, reason: string): CaretakerDecision {
  return parse(request, {
    schemaVersion: 'caretaker-decision@1',
    kind: 'pause',
    reason,
    evidenceIds: allEvidence(request),
    pauseReason: 'budget_exhausted',
    resumeWhen: 'A human reviews the current evidence and explicitly starts a new bounded run.',
  })
}

function invokeTool(
  request: CaretakerDecisionRequest,
  toolName: ToolName,
  input: unknown,
  reason: string,
  evidenceIds: readonly string[] = [],
): CaretakerDecision {
  if (request.budget.toolCalls.used >= request.budget.toolCalls.max) {
    return pauseForBudget(
      request,
      'The host tool-call ceiling is exhausted before another bounded action can run.',
    )
  }
  return parse(request, {
    schemaVersion: 'caretaker-decision@1',
    kind: 'invoke_tool',
    toolName,
    input,
    reason,
    evidenceIds,
  })
}

function escalate(
  request: CaretakerDecisionRequest,
  escalationReason:
    | 'authorization_denied'
    | 'unsupported_capability'
    | 'untrusted_context'
    | 'stale_protected_state'
    | 'reconciliation_exhausted'
    | 'hard_invariant_risk'
    | 'host_inconsistency',
  disposition: 'safe_refusal' | 'human_review',
  reason: string,
  safestAction: string,
  evidenceIds = allEvidence(request),
): CaretakerDecision {
  return parse(request, {
    schemaVersion: 'caretaker-decision@1',
    kind: 'escalate',
    escalationReason,
    disposition,
    reason,
    safestAction,
    evidenceIds,
  })
}

/**
 * Credential-free reference adapter. Its branches depend on normalized live state, never a turn
 * number or a transcript position. Production model adapters implement the same engine interface.
 */
export class DeterministicCaretakerDecisionEngine implements CaretakerDecisionEngine {
  /** Durable compatibility identity; the Pal alias is the public runtime surface. */
  readonly id = 'deterministic-caretaker@1'

  public async decide(
    input: CaretakerDecisionRequest,
    activation?: CaretakerDecisionActivation,
  ): Promise<CaretakerDecision> {
    const parsedRequestId = CaretakerDecisionRequestSchema.shape.requestId.safeParse(
      (input as Partial<CaretakerDecisionRequest>).requestId,
    )
    const requestId = parsedRequestId.success ? parsedRequestId.data : null
    try {
      const decision = await this.#decide(input)
      await emitCaretakerDecisionObservation(activation, {
        schemaVersion: 'caretaker-decision-observation@1',
        kind: 'deterministic_decision',
        requestId,
        engineId: this.id,
        status: 'succeeded',
        decisionKind: decision.kind,
        failureCode: null,
      })
      return decision
    } catch (error) {
      if (error instanceof CaretakerDecisionObservationDeliveryError) throw error
      await emitCaretakerDecisionObservation(activation, {
        schemaVersion: 'caretaker-decision-observation@1',
        kind: 'deterministic_decision',
        requestId,
        engineId: this.id,
        status: 'failed',
        decisionKind: null,
        failureCode: parsedRequestId.success
          ? 'deterministic_decision_failed'
          : 'decision_request_invalid',
      })
      throw error
    }
  }

  #decide(input: CaretakerDecisionRequest): Promise<CaretakerDecision> {
    const request = CaretakerDecisionRequestSchema.parse(input)
    const { liveState } = request

    if (
      request.budget.activeRuntimeMilliseconds.used >= request.budget.activeRuntimeMilliseconds.max
    ) {
      return Promise.resolve(
        pauseForBudget(
          request,
          'The host active-runtime ceiling is exhausted before another bounded action can run.',
        ),
      )
    }

    if (
      liveState.access === 'denied' ||
      liveState.integrityAlerts.includes('cross_tenant_identifier') ||
      liveState.integrityAlerts.includes('forged_approval')
    ) {
      return Promise.resolve(
        escalate(
          request,
          'authorization_denied',
          'safe_refusal',
          'The requested tenant or approval authority is not present in host-derived state.',
          'Refuse the mutation and require an authenticated in-tenant approval flow.',
          evidenceFor(request, 'tenant.access', 'approval.authority'),
        ),
      )
    }

    if (liveState.capabilityFit === 'unsupported') {
      return Promise.resolve(
        escalate(
          request,
          'unsupported_capability',
          'safe_refusal',
          'The requested behavior is outside the capabilities reported by the current palace.',
          'Keep durable state unchanged and explain the missing capability.',
          evidenceFor(request, 'capability.fit'),
        ),
      )
    }

    if (liveState.operation.reconciliationRequired) {
      if (request.budget.reconciliationPolls.used >= request.budget.reconciliationPolls.max) {
        return Promise.resolve(
          escalate(
            request,
            'reconciliation_exhausted',
            'human_review',
            'The logical operation is still unknown after the bounded reconciliation budget.',
            'Pause without creating another logical operation and present the retained evidence.',
            evidenceFor(request, 'operation.status'),
          ),
        )
      }
      const operationId = liveState.operation.operationId
      if (operationId === null) {
        throw new Error('An operation requiring reconciliation must have a durable operation ID')
      }
      return Promise.resolve(
        invokeTool(
          request,
          'operations.get',
          { operationId },
          'Reconcile the existing logical operation before considering another activation.',
          evidenceFor(request, 'operation.id', 'operation.status'),
        ),
      )
    }

    if (liveState.plan.status === 'stale') {
      return Promise.resolve(
        invokeTool(
          request,
          'routines.get',
          {
            routineId: RoutineIdSchema.parse(liveState.plan.protectedRoutineId),
          },
          'Refresh the protected routine after its approved version became stale.',
          evidenceFor(request, 'plan.protected_version'),
        ),
      )
    }

    const { discovery, plan } = liveState
    const discoveryRequired = plan.status === 'absent' || plan.status === 'draft_ready'
    if (discoveryRequired && discovery.palace === 'needed') {
      return Promise.resolve(
        invokeTool(
          request,
          'palaces.get',
          { palaceId: request.mission.palaceId },
          'Load the current palace configuration before planning.',
        ),
      )
    }
    if (discoveryRequired && discovery.crew === 'needed') {
      return Promise.resolve(
        invokeTool(
          request,
          'crews.list',
          { palaceId: request.mission.palaceId, activeOnly: true },
          'Load authorized crew, schedules, identity tags, and preferences.',
        ),
      )
    }
    if (discoveryRequired && discovery.capabilities === 'needed') {
      return Promise.resolve(
        invokeTool(
          request,
          'capabilities.list',
          { palaceId: request.mission.palaceId },
          'Inspect current capabilities before selecting an action.',
        ),
      )
    }
    if (discoveryRequired && discovery.routines === 'needed') {
      return Promise.resolve(
        invokeTool(
          request,
          'routines.list',
          { palaceId: request.mission.palaceId },
          'Inspect current routines for conflicts and protected state.',
        ),
      )
    }
    if (discoveryRequired && discovery.knowledge === 'needed') {
      return Promise.resolve(
        invokeTool(
          request,
          'knowledge.search',
          {
            // PostgreSQL web-search terms are conjunctive by default. The full objective is an
            // execution brief, not a retrieval query, and can require a phrase no source contains.
            query: 'homecoming',
            phase: request.mission.state.phase,
            limit: 6,
          },
          'Load cited homecoming guidance after mandatory runtime state is known.',
        ),
      )
    }

    const materialIssue = liveState.materialIssue
    if (materialIssue !== null && materialIssue.resolvedChoiceId === null) {
      if (request.budget.clarifications.used >= request.budget.clarifications.max) {
        return Promise.resolve(
          escalate(
            request,
            'hard_invariant_risk',
            'human_review',
            'A material ambiguity remains after the bounded clarification budget is exhausted.',
            'Leave durable state unchanged and ask a human to resolve the conflicting constraint.',
            materialIssue.evidenceIds,
          ),
        )
      }
      return Promise.resolve(
        parse(request, {
          schemaVersion: 'caretaker-decision@1',
          kind: 'request_clarification',
          reason: 'The answer changes the consequential plan and cannot be inferred safely.',
          evidenceIds: materialIssue.evidenceIds,
          materialField: materialIssue.field,
          question: materialIssue.question,
          choices: materialIssue.choices,
        }),
      )
    }

    if (liveState.verification.status === 'verifier_passed') {
      return Promise.resolve(
        parse(request, {
          schemaVersion: 'caretaker-decision@1',
          kind: 'grounded_summary',
          reason:
            'Application verification has produced a receipt; the agent only projects its grounded fields.',
          evidenceIds: [
            ...new Set(liveState.verification.claims.flatMap((claim) => claim.evidenceIds)),
          ],
          status: 'verifier_receipt_available',
          claims: liveState.verification.claims,
        }),
      )
    }

    if (liveState.verification.status === 'verifier_failed') {
      return Promise.resolve(
        escalate(
          request,
          'hard_invariant_risk',
          'human_review',
          `Application verification failed: ${liveState.verification.failedCriteria.join(', ')}.`,
          'Retain the failed verifier receipt and require a newly validated, approved correction.',
          evidenceFor(request, 'verification.status'),
        ),
      )
    }

    if (
      liveState.operation.status === 'committed' ||
      liveState.verification.status === 'evidence_needed'
    ) {
      return Promise.resolve(
        invokeTool(
          request,
          'verification.get_evidence',
          { missionId: request.mission.id },
          'Read normalized evidence for the independent application verifier.',
          evidenceFor(request, 'operation.status'),
        ),
      )
    }

    if (plan.status === 'draft_ready') {
      if (request.budget.planRevisions.used >= request.budget.planRevisions.max) {
        return Promise.resolve(
          pauseForBudget(
            request,
            'The host plan-revision ceiling is exhausted before another proposal can be persisted.',
          ),
        )
      }
      return Promise.resolve(
        invokeTool(
          request,
          'plans.propose',
          plan.proposal,
          `Persist the current candidate as an immutable plan revision grounded in ${retrievedKnowledgeIdentity(request)}.`,
          [
            ...new Set([
              ...evidenceFor(request, 'plan.proposal'),
              ...retrievedKnowledgeEvidence(request),
            ]),
          ],
        ),
      )
    }
    if (plan.status === 'candidate') {
      return Promise.resolve(
        invokeTool(
          request,
          'plans.validate',
          { planId: plan.planId },
          'Run schema, capability, conflict, and hard-invariant validation.',
          evidenceFor(request, 'plan.id'),
        ),
      )
    }
    if (plan.status === 'validated') {
      return Promise.resolve(
        invokeTool(
          request,
          'plans.simulate',
          {
            planId: plan.planId,
            scenarios: ['timing', 'access', 'energy', 'transport_failure'],
          },
          'Simulate timing, access, energy, and transport-failure conditions.',
          evidenceFor(request, 'plan.validation'),
        ),
      )
    }
    if (plan.status === 'simulated') {
      return Promise.resolve(
        invokeTool(
          request,
          'plans.request_approval',
          { planId: plan.planId },
          'Pause for authenticated approval of the exact simulated plan.',
          evidenceFor(request, 'plan.simulation'),
        ),
      )
    }
    if (plan.status === 'awaiting_approval') {
      return Promise.resolve(
        parse(request, {
          schemaVersion: 'caretaker-decision@1',
          kind: 'pause',
          reason: 'Consequential activation requires an authenticated human decision.',
          evidenceIds: evidenceFor(request, 'approval.status', 'plan.id'),
          pauseReason: 'awaiting_approval',
          resumeWhen: 'The host records approval or rejection for the exact plan hash.',
        }),
      )
    }
    if (plan.status === 'approved') {
      return Promise.resolve(
        invokeTool(
          request,
          'plans.activate',
          {
            planId: plan.planId,
            actionId: plan.actionId,
            expectedVersion: plan.expectedVersion,
          },
          'Activate only the server-created action covered by the exact approval.',
          evidenceFor(request, 'approval.status', 'plan.hash'),
        ),
      )
    }

    return Promise.resolve(
      escalate(
        request,
        liveState.integrityAlerts.includes('prompt_injection')
          ? 'untrusted_context'
          : 'host_inconsistency',
        'human_review',
        'No bounded decision is valid for the supplied durable state.',
        'Retain evidence and have the host or a human resolve the inconsistent checkpoint.',
      ),
    )
  }
}

/** Public name for the one deterministic bounded-decision implementation. */
export { DeterministicCaretakerDecisionEngine as DeterministicPalDecisionEngine }

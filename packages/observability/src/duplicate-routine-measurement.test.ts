import { EventIdSchema } from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import {
  AnalyticsAliaser,
  CREDENTIAL_FREE_MEASUREMENT_EVIDENCE,
  DUPLICATE_ROUTINE_MEASUREMENT_INPUT_ALLOWLISTS,
  DuplicateRoutineMeasurementError,
  compareDuplicateRoutineControls,
  createDuplicateRoutineMeasurementReport,
  type DuplicateRoutineMeasurementInput,
} from './index.js'

const aliaser = new AnalyticsAliaser(
  'duplicate-routine-measurement-test-key-with-at-least-32-bytes',
)
const WINDOW = {
  startedAt: '2026-07-15T01:30:00.000Z',
  endedAt: '2026-07-15T02:30:00.000Z',
} as const
const OBSERVED_AT = '2026-07-15T02:05:00.000Z'
const ACTIVATED_AT = '2026-07-15T02:00:00.000Z'
const FIXTURE_COHORT_HASH = 'a'.repeat(64)

function alias(namespace: string, value: string) {
  return aliaser.alias(namespace, `private-${value}`)
}

function evidenceId(value: string) {
  return aliaser.insertId('measurement record', EventIdSchema.parse(`evt_measure_${value}`))
}

const reference = {
  organizationAlias: alias('organization', 'organization'),
  missionAlias: alias('mission', 'mission'),
  activationIntentAlias: alias('activation_intent', 'activation-intent'),
  planAlias: alias('plan', 'plan'),
  planActionAlias: alias('plan_action', 'plan-action'),
} as const

function operationReference(operationNumber: number) {
  return {
    ...reference,
    operationAlias: alias('operation', `operation-${operationNumber}`),
  }
}

function fixture(control: 'broken' | 'corrected'): DuplicateRoutineMeasurementInput {
  const firstOperation = operationReference(1)
  const secondOperation = operationReference(2)
  const isBroken = control === 'broken'

  return {
    schemaVersion: 'duplicate-routine-measurement-input@1',
    evidenceBasis: 'credential_free_deterministic_fixture',
    scenario: 'two_routines_one_timeout',
    fixtureCohortHash: FIXTURE_COHORT_HASH,
    control,
    window: WINDOW,
    activationIntents: [
      {
        evidenceId: evidenceId(`${control}_activation_intent`),
        observedAt: '2026-07-15T01:50:00.000Z',
        ...reference,
        intentKind: 'activate_homecoming_routine',
      },
    ],
    planActions: [
      {
        evidenceId: evidenceId(`${control}_plan_action`),
        observedAt: '2026-07-15T01:52:00.000Z',
        ...reference,
        actionKind: 'replace_homecoming_routine',
      },
    ],
    operations: [
      {
        evidenceId: evidenceId(`${control}_operation_1`),
        observedAt: '2026-07-15T01:59:00.000Z',
        ...firstOperation,
        outcome: 'committed',
      },
      ...(isBroken
        ? [
            {
              evidenceId: evidenceId(`${control}_operation_2`),
              observedAt: '2026-07-15T02:00:03.000Z',
              ...secondOperation,
              outcome: 'committed' as const,
            },
          ]
        : []),
    ],
    attempts: [
      {
        evidenceId: evidenceId(`${control}_attempt_1`),
        observedAt: '2026-07-15T02:00:01.000Z',
        ...firstOperation,
        attemptAlias: alias('attempt', `${control}-attempt-1`),
        sequence: 1,
        transport: 'http',
        outcome: 'unknown',
      },
      ...(isBroken
        ? [
            {
              evidenceId: evidenceId(`${control}_attempt_2`),
              observedAt: '2026-07-15T02:00:04.000Z',
              ...secondOperation,
              attemptAlias: alias('attempt', `${control}-attempt-2`),
              sequence: 1,
              transport: 'http' as const,
              outcome: 'committed' as const,
            },
          ]
        : []),
    ],
    activeDurableRoutineOutcomes: [
      {
        evidenceId: evidenceId(`${control}_routine_1`),
        observedAt: OBSERVED_AT,
        ...firstOperation,
        resourceAlias: alias('resource', `${control}-routine-1`),
        activatedAt: ACTIVATED_AT,
        durability: 'database',
        stateAtWindowEnd: 'active',
      },
      ...(isBroken
        ? [
            {
              evidenceId: evidenceId(`${control}_routine_2`),
              observedAt: OBSERVED_AT,
              ...secondOperation,
              resourceAlias: alias('resource', `${control}-routine-2`),
              activatedAt: '2026-07-15T02:00:03.000Z',
              durability: 'database' as const,
              stateAtWindowEnd: 'active' as const,
            },
          ]
        : []),
    ],
    verifierResults: [
      {
        evidenceId: evidenceId(`${control}_verification`),
        observedAt: '2026-07-15T02:08:00.000Z',
        ...reference,
        verificationAlias: alias('verification', `${control}-verification`),
        passed: !isBroken,
        assertionCount: 6,
        failedAssertionCount: isBroken ? 1 : 0,
      },
    ],
    activationLatencies: [
      {
        evidenceId: evidenceId(`${control}_activation_latency`),
        observedAt: OBSERVED_AT,
        ...reference,
        latencyAlias: alias('latency', `${control}-activation-latency`),
        durationMs: isBroken ? 10_000 : 8_000,
      },
    ],
    reconciliations: [
      {
        evidenceId: evidenceId(`${control}_reconciliation`),
        observedAt: '2026-07-15T02:00:05.000Z',
        ...firstOperation,
        reconciliationAlias: alias('reconciliation', `${control}-reconciliation`),
        resolution: 'committed',
        durationMs: isBroken ? 4_000 : 1_500,
      },
    ],
    cancellationSafetyChecks: [
      {
        evidenceId: evidenceId(`${control}_cancellation`),
        observedAt: OBSERVED_AT,
        ...reference,
        cancellationAlias: alias('cancellation', `${control}-cancellation`),
        checkpoint: 'after_commit_before_callback',
        passed: true,
      },
    ],
    userInterventions: isBroken
      ? [
          {
            evidenceId: evidenceId(`${control}_intervention`),
            observedAt: '2026-07-15T02:10:00.000Z',
            ...reference,
            interventionAlias: alias('intervention', `${control}-intervention`),
            kind: 'manual_duplicate_cleanup',
          },
        ]
      : [],
    modelCosts: [
      {
        evidenceId: evidenceId(`${control}_model_cost`),
        observedAt: '2026-07-15T01:56:00.000Z',
        ...reference,
        generationAlias: alias('generation', `${control}-generation`),
        inputTokens: 900,
        outputTokens: 180,
        totalCostUsd: isBroken ? 0.009 : 0.006,
      },
    ],
  }
}

function emptyFixture(control: 'broken' | 'corrected'): DuplicateRoutineMeasurementInput {
  return {
    schemaVersion: 'duplicate-routine-measurement-input@1',
    evidenceBasis: 'credential_free_deterministic_fixture',
    scenario: 'two_routines_one_timeout',
    fixtureCohortHash: FIXTURE_COHORT_HASH,
    control,
    window: WINDOW,
    activationIntents: [],
    planActions: [],
    operations: [],
    attempts: [],
    activeDurableRoutineOutcomes: [],
    verifierResults: [],
    activationLatencies: [],
    reconciliations: [],
    cancellationSafetyChecks: [],
    userInterventions: [],
    modelCosts: [],
  }
}

describe('duplicate-routine measurement contract', () => {
  it('reports the broken durable outcome and a corrected zero on the same fixture cohort', () => {
    const comparison = compareDuplicateRoutineControls({
      broken: fixture('broken'),
      corrected: fixture('corrected'),
    })

    expect(comparison.broken.primaryMetric.result).toEqual({
      state: 'measured',
      numerator: 1,
      denominator: 1,
      value: 1_000,
    })
    expect(comparison.corrected.primaryMetric.result).toEqual({
      state: 'measured',
      numerator: 0,
      denominator: 1,
      value: 0,
    })
    expect(comparison.broken.duplicateClusters).toEqual([
      expect.objectContaining({
        operationCount: 2,
        unknownAttemptCount: 1,
        activeDurableRoutineCount: 2,
        manualDuplicateCleanupCount: 1,
      }),
    ])
    expect(comparison.corrected.duplicateClusters).toEqual([])
    expect(comparison.primaryMetricDeltaPer1000).toBe(-1_000)
    expect(comparison.duplicatePlanDelta).toBe(-1)
    expect(comparison.controlGate).toEqual({
      status: 'passed',
      sameFixtureCohort: true,
      nonzeroActivationIntentDenominator: true,
      brokenControlCreatedExactlyTwoActiveRoutines: true,
      brokenControlReportedDuplication: true,
      correctedControlReportedZeroDuplication: true,
      primaryMetricImproved: true,
    })
  })

  it('computes every guardrail from typed normalized evidence', () => {
    const broken = createDuplicateRoutineMeasurementReport(fixture('broken'))
    const corrected = createDuplicateRoutineMeasurementReport(fixture('corrected'))

    expect(broken.signals).toEqual({
      unknownOperationAttemptCount: 1,
      planActionWithMultipleOperationsCount: 1,
      planWithMultipleActiveRoutinesCount: 1,
      manualDuplicateCleanupCount: 1,
    })
    expect(broken.guardrails).toEqual({
      verifierPassRatePercent: {
        state: 'measured',
        numerator: 0,
        denominator: 1,
        value: 0,
      },
      activationLatency: {
        state: 'measured',
        count: 1,
        medianMs: 10_000,
        p95Ms: 10_000,
        maximumMs: 10_000,
      },
      reconciliationLatency: {
        state: 'measured',
        count: 1,
        medianMs: 4_000,
        p95Ms: 4_000,
        maximumMs: 4_000,
      },
      cancellationSafetyPassRatePercent: {
        state: 'measured',
        numerator: 1,
        denominator: 1,
        value: 100,
      },
      userInterventionsPer1000ActivationIntents: {
        state: 'measured',
        numerator: 1,
        denominator: 1,
        value: 1_000,
      },
      modelCost: {
        totalCostUsd: 0.009,
        averageCostPerActivationIntentUsd: {
          state: 'measured',
          numerator: 0.009,
          denominator: 1,
          value: 0.009,
        },
        inputTokens: 900,
        outputTokens: 180,
      },
    })
    expect(corrected.guardrails.verifierPassRatePercent).toMatchObject({ value: 100 })
    expect(corrected.guardrails.activationLatency).toMatchObject({ medianMs: 8_000 })
    expect(corrected.guardrails.reconciliationLatency).toMatchObject({ medianMs: 1_500 })
    expect(corrected.guardrails.userInterventionsPer1000ActivationIntents).toMatchObject({
      numerator: 0,
      value: 0,
    })
  })

  it('does not turn an empty observation window into a zero-valued measured rate', () => {
    const report = createDuplicateRoutineMeasurementReport(emptyFixture('corrected'))
    const comparison = compareDuplicateRoutineControls({
      broken: emptyFixture('broken'),
      corrected: emptyFixture('corrected'),
    })

    expect(report.primaryMetric.result).toEqual({
      state: 'zero_denominator',
      numerator: 0,
      denominator: 0,
      value: null,
    })
    expect(report.guardrails.userInterventionsPer1000ActivationIntents).toMatchObject({
      state: 'zero_denominator',
      value: null,
    })
    expect(report.guardrails.modelCost.averageCostPerActivationIntentUsd).toMatchObject({
      state: 'zero_denominator',
      value: null,
    })
    expect(comparison.primaryMetricDeltaPer1000).toBeNull()
    expect(comparison.controlGate.status).toBe('not_comparable')
  })

  it('deduplicates exact and semantically identical replays without changing the metric', () => {
    const input = fixture('broken')
    const activationReplay = structuredClone(input.activationIntents[0]!)
    const routineReplay = {
      ...structuredClone(input.activeDurableRoutineOutcomes[0]!),
      evidenceId: evidenceId('broken_routine_1_delivery_replay'),
    }
    input.activationIntents.push(activationReplay)
    input.activeDurableRoutineOutcomes.push(routineReplay)

    const report = createDuplicateRoutineMeasurementReport(input)

    expect(report.primaryMetric.result).toMatchObject({ numerator: 1, value: 1_000 })
    expect(report.duplicateClusters[0]?.activeDurableRoutineCount).toBe(2)
    expect(report.evidenceInventory.replayedRecordCount).toBe(2)
    expect(report.evidenceInventory.collections.activationIntents).toEqual({
      received: 2,
      unique: 1,
      replayed: 1,
    })
    expect(report.evidenceInventory.collections.activeDurableRoutineOutcomes).toEqual({
      received: 3,
      unique: 2,
      replayed: 1,
    })
  })

  it('fails closed on conflicting stable evidence and semantic identities', () => {
    const evidenceConflict = fixture('broken')
    evidenceConflict.operations.push({
      ...structuredClone(evidenceConflict.operations[0]!),
      outcome: 'failed',
    })
    expect(() => createDuplicateRoutineMeasurementReport(evidenceConflict)).toThrow(
      expect.objectContaining({ code: 'conflicting_evidence_identity' }),
    )

    const semanticConflict = fixture('broken')
    semanticConflict.activeDurableRoutineOutcomes.push({
      ...structuredClone(semanticConflict.activeDurableRoutineOutcomes[0]!),
      evidenceId: evidenceId('broken_conflicting_semantic_routine'),
      activatedAt: '2026-07-15T02:00:02.000Z',
    })
    expect(() => createDuplicateRoutineMeasurementReport(semanticConflict)).toThrow(
      expect.objectContaining({ code: 'conflicting_evidence_identity' }),
    )
  })

  it('rejects cross-tenant and mismatched plan-action evidence instead of excluding it', () => {
    const crossTenant = fixture('corrected')
    crossTenant.operations[0]!.organizationAlias = alias('organization', 'other-tenant')
    expect(() => createDuplicateRoutineMeasurementReport(crossTenant)).toThrow(
      expect.objectContaining({ code: 'cross_tenant_binding' }),
    )

    const wrongPlan = fixture('corrected')
    wrongPlan.operations[0]!.planAlias = alias('plan', 'other-plan')
    expect(() => createDuplicateRoutineMeasurementReport(wrongPlan)).toThrow(
      expect.objectContaining({ code: 'mismatched_plan_action' }),
    )

    const missingOperation = fixture('corrected')
    missingOperation.activeDurableRoutineOutcomes[0]!.operationAlias = alias(
      'operation',
      'missing-operation',
    )
    expect(() => createDuplicateRoutineMeasurementReport(missingOperation)).toThrow(
      expect.objectContaining({ code: 'missing_reference' }),
    )
  })

  it('rejects evidence outside the bounded observation window', () => {
    const input = fixture('corrected')
    input.modelCosts[0]!.observedAt = '2026-07-15T03:00:00.000Z'

    expect(() => createDuplicateRoutineMeasurementReport(input)).toThrow(
      expect.objectContaining({ code: 'out_of_window' }),
    )
  })

  it('uses strict privacy allowlists with analytics-safe aliases only', () => {
    for (const allowedFields of Object.values(DUPLICATE_ROUTINE_MEASUREMENT_INPUT_ALLOWLISTS)) {
      expect(allowedFields).not.toContain('organizationId')
      expect(allowedFields).not.toContain('prompt')
      expect(allowedFields).not.toContain('apiKey')
      expect(allowedFields).not.toContain('properties')
    }

    const extraPrompt = fixture('corrected') as unknown as {
      operations: (Record<string, unknown> & { prompt?: string })[]
    }
    extraPrompt.operations[0]!.prompt = 'private model content'
    expect(() => createDuplicateRoutineMeasurementReport(extraPrompt)).toThrow()

    const rawTenantId = fixture('corrected') as unknown as {
      operations: (Record<string, unknown> & { organizationAlias: string })[]
    }
    rawTenantId.operations[0]!.organizationAlias = 'org_private_tenant'
    expect(() => createDuplicateRoutineMeasurementReport(rawTenantId)).toThrow()
  })

  it('labels deterministic evidence honestly and fixes external proof states to Blocked', () => {
    const report = createDuplicateRoutineMeasurementReport(fixture('corrected'))
    const serialized = JSON.stringify(report)

    expect(report.evidenceClassification).toEqual(CREDENTIAL_FREE_MEASUREMENT_EVIDENCE)
    expect(report.evidenceClassification).toEqual({
      basis: 'credential_free_deterministic_fixture',
      reportContract: 'Implemented',
      deterministicMeasurement: 'Deterministic-verified',
      posthogIngestion: 'Blocked',
      liveImprovementLoop: 'Blocked',
    })
    expect(serialized).not.toContain('PostHog-ingestion-verified')
    expect(serialized).not.toContain('Live-loop-verified')
    expect(serialized).not.toContain('private-')
  })

  it('fails the gate when the broken control loses its duplicate outcome', () => {
    const brokenMutation = fixture('broken')
    brokenMutation.activeDurableRoutineOutcomes.pop()

    const comparison = compareDuplicateRoutineControls({
      broken: brokenMutation,
      corrected: fixture('corrected'),
    })

    expect(comparison.broken.signals.planActionWithMultipleOperationsCount).toBe(1)
    expect(comparison.broken.primaryMetric.result.numerator).toBe(0)
    expect(comparison.controlGate).toMatchObject({
      status: 'failed',
      brokenControlCreatedExactlyTwoActiveRoutines: false,
      brokenControlReportedDuplication: false,
    })
  })

  it('fails the gate when the corrected control regresses to the blind-retry outcome', () => {
    const correctedMutation = fixture('broken')
    correctedMutation.control = 'corrected'

    const comparison = compareDuplicateRoutineControls({
      broken: fixture('broken'),
      corrected: correctedMutation,
    })

    expect(comparison.corrected.primaryMetric.result.numerator).toBe(1)
    expect(comparison.controlGate).toMatchObject({
      status: 'failed',
      correctedControlReportedZeroDuplication: false,
      primaryMetricImproved: false,
    })
  })

  it('rejects comparisons that are not the same deterministic cohort', () => {
    const corrected = fixture('corrected')
    corrected.fixtureCohortHash = 'b'.repeat(64)

    expect(() => compareDuplicateRoutineControls({ broken: fixture('broken'), corrected })).toThrow(
      DuplicateRoutineMeasurementError,
    )
  })
})

import {
  EventIdSchema,
  OperationIdSchema,
  OrganizationIdSchema,
  PlanActionIdSchema,
} from '@trash-palace/core'

import { createAiEvidenceEvent } from './contracts.js'
import { AnalyticsAliaser } from './identifiers.js'
import {
  DuplicateRoutineEvidenceAdapterError,
  PostgresDuplicateRoutineLedgerSchema,
  createDuplicateRoutineMeasurementInputFromEvidence,
} from './duplicate-routine-evidence-adapter.js'
import { compareDuplicateRoutineControls } from './duplicate-routine-measurement.js'
import { describe, expect, it } from 'vitest'

const ALIAS_KEY = 'duplicate-routine-source-adapter-test-key-is-long-enough'
const COHORT_HASH = 'c'.repeat(64)
const WINDOW = {
  startedAt: '2026-08-14T05:30:00.000Z',
  endedAt: '2026-08-14T06:30:00.000Z',
} as const

function ledger(control: 'broken' | 'corrected') {
  const broken = control === 'broken'
  return PostgresDuplicateRoutineLedgerSchema.parse({
    schemaVersion: 'duplicate-routine-postgres-ledger@1',
    source: 'postgresql_projection',
    control,
    fixtureCohortHash: COHORT_HASH,
    window: WINDOW,
    activationIntent: {
      organizationId: 'org_rocky_roost',
      missionId: 'mis_night_shift_home',
      activationIntentId: 'activation_intent_homecoming',
      runId: `run_measure_${control}`,
      planId: 'pln_homecoming_energy',
      planActionId: 'act_replace_homecoming',
      actionKind: 'replace_homecoming_routine',
      requestedAt: '2026-08-14T05:59:52.000Z',
    },
    operations: [
      {
        id: `op_measure_${control}_first`,
        organizationId: 'org_rocky_roost',
        missionId: 'mis_night_shift_home',
        planId: 'pln_homecoming_energy',
        planActionId: 'act_replace_homecoming',
        status: 'committed',
        createdAt: '2026-08-14T05:59:59.000Z',
        committedAt: '2026-08-14T06:00:00.000Z',
      },
      ...(broken
        ? [
            {
              id: 'op_measure_broken_retry',
              organizationId: 'org_rocky_roost',
              missionId: 'mis_night_shift_home',
              planId: 'pln_homecoming_energy',
              planActionId: 'act_replace_homecoming',
              status: 'committed' as const,
              createdAt: '2026-08-14T06:00:01.000Z',
              committedAt: '2026-08-14T06:00:02.000Z',
            },
          ]
        : []),
    ],
    attempts: [
      {
        id: `att_measure_${control}_lost`,
        organizationId: 'org_rocky_roost',
        operationId: `op_measure_${control}_first`,
        sequence: 1,
        transport: 'http',
        status: 'unknown',
        startedAt: '2026-08-14T05:59:59.000Z',
        completedAt: '2026-08-14T06:00:00.000Z',
      },
      ...(broken
        ? [
            {
              id: 'att_measure_broken_retry',
              organizationId: 'org_rocky_roost',
              operationId: 'op_measure_broken_retry',
              sequence: 1,
              transport: 'http' as const,
              status: 'succeeded' as const,
              startedAt: '2026-08-14T06:00:01.000Z',
              completedAt: '2026-08-14T06:00:02.000Z',
            },
          ]
        : []),
    ],
    routineVersions: [
      {
        id: `rtv_measure_${control}_first`,
        routineId: `rtn_measure_${control}_first`,
        organizationId: 'org_rocky_roost',
        sourcePlanId: 'pln_homecoming_energy',
        sourceOperationId: `op_measure_${control}_first`,
        status: 'active',
        createdAt: '2026-08-14T06:00:00.000Z',
      },
      ...(broken
        ? [
            {
              id: 'rtv_measure_broken_retry',
              routineId: 'rtn_measure_broken_retry',
              organizationId: 'org_rocky_roost',
              sourcePlanId: 'pln_homecoming_energy',
              sourceOperationId: 'op_measure_broken_retry',
              status: 'active' as const,
              createdAt: '2026-08-14T06:00:02.000Z',
            },
          ]
        : []),
    ],
    verifications: [
      {
        id: `ver_measure_${control}_result`,
        organizationId: 'org_rocky_roost',
        missionId: 'mis_night_shift_home',
        status: broken ? 'failed' : 'passed',
        assertionResults: broken ? [true, false, true] : [true, true, true],
        completedAt: '2026-08-14T06:08:00.000Z',
      },
    ],
    reconciliationPolls: [
      {
        organizationId: 'org_rocky_roost',
        operationId: `op_measure_${control}_first`,
        sequence: 1,
        resolution: 'committed',
        occurredAt: broken ? '2026-08-14T06:00:04.000Z' : '2026-08-14T06:00:01.500Z',
      },
    ],
  })
}

function generationJsonl(control: 'broken' | 'corrected', aliaser: AnalyticsAliaser): string {
  const missionAlias = aliaser.alias('mission', 'mis_night_shift_home')
  const runAlias = aliaser.alias('run', `run_measure_${control}`)
  const event = createAiEvidenceEvent({
    insertId: aliaser.insertId(
      '$ai_generation',
      EventIdSchema.parse(`evt_measure_generation_${control}`),
    ),
    occurredAt: '2026-08-14T05:58:00.000Z',
    distinctId: aliaser.alias('person', 'usr_rocky_founder'),
    event: '$ai_generation',
    properties: {
      schema_version: '1',
      environment: 'test',
      data_origin: 'fixture',
      privacy_classification: 'analytics_safe',
      app_version: '0.0.0-test',
      organization_alias: aliaser.alias('organization', 'org_rocky_roost'),
      mission_alias: missionAlias,
      run_alias: runAlias,
      $ai_session_id: missionAlias,
      $ai_trace_id: runAlias,
      $ai_span_id: aliaser.alias('ai_span', `${control}:generation:1`),
      $ai_span_name: 'caretaker.plan',
      $ai_model: 'deterministic-fixture',
      $ai_provider: 'local',
      $ai_input_tokens: 900,
      $ai_output_tokens: 180,
      $ai_latency: 0.25,
      $ai_stream: false,
      $ai_total_cost_usd: control === 'broken' ? 0.009 : 0.006,
      $ai_is_error: false,
      input_redaction_count: 0,
      output_redaction_count: 0,
      completion_claim: 'none',
    },
  })
  return `${JSON.stringify(event)}\n`
}

function normalize(control: 'broken' | 'corrected') {
  const aliaser = new AnalyticsAliaser(ALIAS_KEY)
  return createDuplicateRoutineMeasurementInputFromEvidence({
    ledger: ledger(control),
    evidenceJsonl: generationJsonl(control, aliaser),
    aliaser,
  })
}

describe('PostgreSQL and JSONL duplicate-routine evidence adapter', () => {
  it('derives the broken and corrected normal forms from bounded source evidence', () => {
    const broken = normalize('broken')
    const corrected = normalize('corrected')
    const comparison = compareDuplicateRoutineControls({ broken, corrected })

    expect(broken.activeDurableRoutineOutcomes).toHaveLength(2)
    expect(corrected.activeDurableRoutineOutcomes).toHaveLength(1)
    expect(broken.operations).toHaveLength(2)
    expect(corrected.operations).toHaveLength(1)
    expect(broken.attempts.map((attempt) => attempt.outcome)).toEqual(['unknown', 'committed'])
    expect(corrected.attempts.map((attempt) => attempt.outcome)).toEqual(['unknown'])
    expect(broken.activationLatencies[0]?.durationMs).toBe(10_000)
    expect(corrected.activationLatencies[0]?.durationMs).toBe(8_000)
    expect(broken.reconciliations[0]?.durationMs).toBe(4_000)
    expect(corrected.reconciliations[0]?.durationMs).toBe(1_500)
    expect(comparison.controlGate.status).toBe('passed')
  })

  it('uses JSONL generation evidence for measured model cost', () => {
    const broken = normalize('broken')
    const corrected = normalize('corrected')

    expect(broken.modelCosts).toHaveLength(1)
    expect(broken.modelCosts[0]).toMatchObject({
      inputTokens: 900,
      outputTokens: 180,
      totalCostUsd: 0.009,
    })
    expect(corrected.modelCosts[0]?.totalCostUsd).toBe(0.006)
  })

  it('is deterministic and removes private ledger identifiers from the normal form', () => {
    const first = normalize('corrected')
    const second = normalize('corrected')
    const serialized = JSON.stringify(first)

    expect(second).toEqual(first)
    expect(serialized).not.toContain('org_rocky_roost')
    expect(serialized).not.toContain('mis_night_shift_home')
    expect(serialized).not.toContain('pln_homecoming_energy')
    expect(serialized).not.toContain('op_measure_')
    expect(serialized).not.toContain('run_measure_')
  })

  it('fails closed when source rows cross a tenant or plan-action boundary', () => {
    const crossTenant = ledger('corrected')
    crossTenant.routineVersions[0]!.organizationId = OrganizationIdSchema.parse('org_mirror_roost')
    const aliaser = new AnalyticsAliaser(ALIAS_KEY)
    expect(() =>
      createDuplicateRoutineMeasurementInputFromEvidence({
        ledger: crossTenant,
        evidenceJsonl: generationJsonl('corrected', aliaser),
        aliaser,
      }),
    ).toThrow(expect.objectContaining({ code: 'cross_tenant_binding' }))

    const wrongAction = ledger('corrected')
    wrongAction.operations[0]!.planActionId = PlanActionIdSchema.parse('act_other_homecoming')
    expect(() =>
      createDuplicateRoutineMeasurementInputFromEvidence({
        ledger: wrongAction,
        evidenceJsonl: generationJsonl('corrected', aliaser),
        aliaser,
      }),
    ).toThrow(expect.objectContaining({ code: 'mismatched_plan_action' }))
  })

  it('rejects malformed or missing JSONL evidence instead of inventing model cost', () => {
    const aliaser = new AnalyticsAliaser(ALIAS_KEY)
    expect(() =>
      createDuplicateRoutineMeasurementInputFromEvidence({
        ledger: ledger('corrected'),
        evidenceJsonl: '{not-json}\n',
        aliaser,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_jsonl' }))

    expect(() =>
      createDuplicateRoutineMeasurementInputFromEvidence({
        ledger: ledger('corrected'),
        evidenceJsonl: '',
        aliaser,
      }),
    ).toThrow(expect.objectContaining({ code: 'missing_jsonl_generation' }))
  })

  it('rejects a source row whose operation is absent from the bounded projection', () => {
    const source = ledger('corrected')
    source.routineVersions[0]!.sourceOperationId = OperationIdSchema.parse('op_measure_missing')
    const aliaser = new AnalyticsAliaser(ALIAS_KEY)

    expect(() =>
      createDuplicateRoutineMeasurementInputFromEvidence({
        ledger: source,
        evidenceJsonl: generationJsonl('corrected', aliaser),
        aliaser,
      }),
    ).toThrow(DuplicateRoutineEvidenceAdapterError)
  })
})

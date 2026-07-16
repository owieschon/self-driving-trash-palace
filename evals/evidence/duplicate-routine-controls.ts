import { createHash } from 'node:crypto'

import {
  EventIdSchema,
  ReplaceHomecomingRoutineActionSchema,
} from '../../packages/core/src/index.js'
import { LEGACY_LAB_ACTIVATION_CONTRACT } from '../../packages/integration/src/legacy-lab-activation.js'
import {
  AnalyticsAliaser,
  CREDENTIAL_FREE_MEASUREMENT_EVIDENCE,
  PostgresDuplicateRoutineLedgerSchema,
  assertPublicationSafe,
  canonicalJson,
  compareDuplicateRoutineControls,
  createAiEvidenceEvent,
  createDuplicateRoutineMeasurementInputFromEvidence,
  type DuplicateRoutineControlComparison,
  type JsonValue,
  type PostgresDuplicateRoutineLedger,
} from '../../packages/observability/src/index.js'
import { NIGHT_SHIFT_HOMECOMING_FIXTURE } from '../fixtures/night-shift-homecoming.js'
import { z } from 'zod'

const PUBLIC_FIXTURE_ALIAS_KEY = 'trash-palace-public-duplicate-routine-fixture-alias-key-v1'
const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
const action = ReplaceHomecomingRoutineActionSchema.parse(fixture.approvedPlan.actions[0])

const JsonRecordSchema = z.record(z.string(), z.json())

export const DuplicateRoutineExecutableEvidenceReportSchema = z
  .object({
    schemaVersion: z.literal('duplicate-routine-executable-evidence-report@1'),
    title: z.literal('Ambiguous activation responses create duplicate routines'),
    generatedFrom: z
      .object({
        fixtureManifestId: z.literal(fixture.manifest.id),
        fixtureCohortHash: z.string().regex(/^[a-f0-9]{64}$/),
        adapterInput: z.literal('bounded_postgresql_projection_plus_safe_local_jsonl'),
        legacyControl: z
          .object({
            kind: z.literal('legacy_negative_control'),
            labOnly: z.literal(true),
            productionSelectable: z.literal(false),
            mcpSelectable: z.literal(false),
            expectedCreatedRoutineCount: z.literal(2),
          })
          .strict(),
      })
      .strict(),
    acceptance: z
      .object({
        status: z.literal('passed'),
        brokenActiveRoutineCount: z.literal(2),
        correctedActiveRoutineCount: z.literal(1),
        brokenVerifierStatus: z.literal('failed'),
        correctedVerifierStatus: z.literal('passed'),
      })
      .strict(),
    evidenceClassification: z
      .object({
        basis: z.literal('credential_free_deterministic_fixture'),
        reportContract: z.literal('Implemented'),
        deterministicMeasurement: z.literal('Deterministic-verified'),
        posthogIngestion: z.literal('Blocked'),
        liveImprovementLoop: z.literal('Blocked'),
      })
      .strict(),
    proofBoundary: z
      .object({
        proves: z.array(z.string().min(1)).min(1),
        doesNotProve: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    comparison: JsonRecordSchema,
  })
  .strict()

export interface DuplicateRoutineExecutableEvidenceReport {
  readonly schemaVersion: 'duplicate-routine-executable-evidence-report@1'
  readonly title: 'Ambiguous activation responses create duplicate routines'
  readonly generatedFrom: {
    readonly fixtureManifestId: typeof fixture.manifest.id
    readonly fixtureCohortHash: string
    readonly adapterInput: 'bounded_postgresql_projection_plus_safe_local_jsonl'
    readonly legacyControl: {
      readonly kind: 'legacy_negative_control'
      readonly labOnly: true
      readonly productionSelectable: false
      readonly mcpSelectable: false
      readonly expectedCreatedRoutineCount: 2
    }
  }
  readonly acceptance: {
    readonly status: 'passed'
    readonly brokenActiveRoutineCount: 2
    readonly correctedActiveRoutineCount: 1
    readonly brokenVerifierStatus: 'failed'
    readonly correctedVerifierStatus: 'passed'
  }
  readonly evidenceClassification: typeof CREDENTIAL_FREE_MEASUREMENT_EVIDENCE
  readonly proofBoundary: {
    readonly proves: readonly string[]
    readonly doesNotProve: readonly string[]
  }
  readonly comparison: DuplicateRoutineControlComparison
}

function fixtureCohortHash(): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion: 'duplicate-routine-fixture-cohort@1',
        manifestId: fixture.manifest.id,
        faultProfile: fixture.manifest.faultProfile,
        planHash: fixture.approvedPlan.hash,
        planActionId: action.id,
        expectedResourceCount: fixture.manifest.expectedResourceCount,
      }),
    )
    .digest('hex')
}

function at(offsetMilliseconds: number): string {
  return new Date(Date.parse(fixture.clock.startsAt) + offsetMilliseconds).toISOString()
}

function buildLedger(control: 'broken' | 'corrected'): PostgresDuplicateRoutineLedger {
  const broken = control === 'broken'
  const firstOperationId = `op_evidence_${control}_primary`
  const retryOperationId = 'op_evidence_broken_retry'
  const firstRoutineId = broken ? 'rtn_evidence_broken_primary' : action.replacementRoutineId
  const firstRoutineVersionId = broken
    ? 'rtv_evidence_broken_primary'
    : action.replacementRoutineVersionId
  const requestedAt = at(20 * 60_000)
  const firstCommittedAt = at(20 * 60_000 + 8_000)
  const retryCommittedAt = at(20 * 60_000 + 10_000)

  return PostgresDuplicateRoutineLedgerSchema.parse({
    schemaVersion: 'duplicate-routine-postgres-ledger@1',
    source: 'postgresql_projection',
    control,
    fixtureCohortHash: fixtureCohortHash(),
    window: {
      startedAt: at(0),
      endedAt: at(60 * 60_000),
    },
    activationIntent: {
      organizationId: fixture.primaryTenant.organization.id,
      missionId: fixture.mission.id,
      activationIntentId: `activation-intent:${fixture.manifest.id}`,
      runId: `run_duplicate_${control}`,
      planId: fixture.approvedPlan.id,
      planActionId: action.id,
      actionKind: action.type,
      requestedAt,
    },
    operations: [
      {
        id: firstOperationId,
        organizationId: fixture.primaryTenant.organization.id,
        missionId: fixture.mission.id,
        planId: fixture.approvedPlan.id,
        planActionId: action.id,
        status: 'committed',
        createdAt: at(20 * 60_000 + 7_000),
        committedAt: firstCommittedAt,
      },
      ...(broken
        ? [
            {
              id: retryOperationId,
              organizationId: fixture.primaryTenant.organization.id,
              missionId: fixture.mission.id,
              planId: fixture.approvedPlan.id,
              planActionId: action.id,
              status: 'committed',
              createdAt: at(20 * 60_000 + 9_000),
              committedAt: retryCommittedAt,
            },
          ]
        : []),
    ],
    attempts: [
      {
        id: `att_evidence_${control}_lost_response`,
        organizationId: fixture.primaryTenant.organization.id,
        operationId: firstOperationId,
        sequence: 1,
        transport: 'http',
        status: 'unknown',
        startedAt: at(20 * 60_000 + 7_000),
        completedAt: firstCommittedAt,
      },
      ...(broken
        ? [
            {
              id: 'att_evidence_broken_blind_retry',
              organizationId: fixture.primaryTenant.organization.id,
              operationId: retryOperationId,
              sequence: 1,
              transport: 'http',
              status: 'succeeded',
              startedAt: at(20 * 60_000 + 9_000),
              completedAt: retryCommittedAt,
            },
          ]
        : []),
    ],
    routineVersions: [
      {
        id: firstRoutineVersionId,
        routineId: firstRoutineId,
        organizationId: fixture.primaryTenant.organization.id,
        sourcePlanId: fixture.approvedPlan.id,
        sourceOperationId: firstOperationId,
        status: 'active',
        createdAt: firstCommittedAt,
      },
      ...(broken
        ? [
            {
              id: 'rtv_evidence_broken_retry',
              routineId: 'rtn_evidence_broken_retry',
              organizationId: fixture.primaryTenant.organization.id,
              sourcePlanId: fixture.approvedPlan.id,
              sourceOperationId: retryOperationId,
              status: 'active',
              createdAt: retryCommittedAt,
            },
          ]
        : []),
    ],
    verifications: [
      {
        id: `ver_evidence_${control}_result`,
        organizationId: fixture.primaryTenant.organization.id,
        missionId: fixture.mission.id,
        status: broken ? 'failed' : 'passed',
        assertionResults: fixture.verifierPredicates.map((predicate) =>
          broken && predicate.type === 'active_routine_count' ? false : true,
        ),
        completedAt: at(30 * 60_000),
      },
    ],
    reconciliationPolls: [
      {
        organizationId: fixture.primaryTenant.organization.id,
        operationId: firstOperationId,
        sequence: 1,
        resolution: 'committed',
        occurredAt: broken ? at(20 * 60_000 + 12_000) : at(20 * 60_000 + 9_500),
      },
    ],
  })
}

function buildGenerationJsonl(control: 'broken' | 'corrected', aliaser: AnalyticsAliaser): string {
  const missionAlias = aliaser.alias('mission', fixture.mission.id)
  const runAlias = aliaser.alias('run', `run_duplicate_${control}`)
  const event = createAiEvidenceEvent({
    insertId: aliaser.insertId(
      '$ai_generation',
      EventIdSchema.parse(`evt_duplicate_generation_${control}`),
    ),
    occurredAt: at(15 * 60_000),
    distinctId: aliaser.alias('person', fixture.primaryTenant.user.id),
    event: '$ai_generation',
    properties: {
      schema_version: '1',
      environment: 'evaluation',
      data_origin: 'fixture',
      privacy_classification: 'analytics_safe',
      app_version: '0.0.0-fixture',
      organization_alias: aliaser.alias('organization', fixture.primaryTenant.organization.id),
      palace_alias: aliaser.alias('palace', fixture.primaryTenant.palace.id),
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
  return `${canonicalJson(event as unknown as JsonValue)}\n`
}

export function assertDuplicateRoutineExecutableControlGate(input: {
  readonly brokenActiveRoutineCount: number
  readonly correctedActiveRoutineCount: number
  readonly comparison: DuplicateRoutineControlComparison
}): void {
  const legacyControl = z
    .object({
      labOnly: z.boolean(),
      productionSelectable: z.boolean(),
      mcpSelectable: z.boolean(),
      expectedCreatedRoutineCount: z.number().int().nonnegative(),
    })
    .parse(LEGACY_LAB_ACTIVATION_CONTRACT)
  const expectedResourceCount = z
    .object({
      corrected: z.number().int().nonnegative(),
      legacyNegativeControl: z.number().int().nonnegative(),
    })
    .parse(fixture.manifest.expectedResourceCount)
  const externalProof = z
    .object({
      posthogIngestion: z.string(),
      liveImprovementLoop: z.string(),
    })
    .parse(input.comparison.evidenceClassification)

  if (!legacyControl.labOnly) {
    throw new Error('The legacy control is not lab-only')
  }
  if (legacyControl.productionSelectable || legacyControl.mcpSelectable) {
    throw new Error('The legacy control escaped its production and MCP quarantine')
  }
  if (
    legacyControl.expectedCreatedRoutineCount !== 2 ||
    expectedResourceCount.legacyNegativeControl !== 2 ||
    input.brokenActiveRoutineCount !== 2
  ) {
    throw new Error('The lab-only broken control must produce exactly two active routines')
  }
  if (expectedResourceCount.corrected !== 1 || input.correctedActiveRoutineCount !== 1) {
    throw new Error('The corrected control must produce exactly one active routine')
  }
  if (input.comparison.controlGate.status !== 'passed') {
    throw new Error('The broken-versus-corrected measurement control gate did not pass')
  }
  if (
    externalProof.posthogIngestion !== 'Blocked' ||
    externalProof.liveImprovementLoop !== 'Blocked'
  ) {
    throw new Error('Credential-free evidence cannot promote external proof states')
  }
}

export function buildDuplicateRoutineExecutableEvidenceReport(): DuplicateRoutineExecutableEvidenceReport {
  const aliaser = new AnalyticsAliaser(PUBLIC_FIXTURE_ALIAS_KEY)
  const brokenLedger = buildLedger('broken')
  const correctedLedger = buildLedger('corrected')
  const broken = createDuplicateRoutineMeasurementInputFromEvidence({
    ledger: brokenLedger,
    evidenceJsonl: buildGenerationJsonl('broken', aliaser),
    aliaser,
  })
  const corrected = createDuplicateRoutineMeasurementInputFromEvidence({
    ledger: correctedLedger,
    evidenceJsonl: buildGenerationJsonl('corrected', aliaser),
    aliaser,
  })
  const comparison = compareDuplicateRoutineControls({ broken, corrected })
  const brokenActiveRoutineCount = broken.activeDurableRoutineOutcomes.length
  const correctedActiveRoutineCount = corrected.activeDurableRoutineOutcomes.length
  assertDuplicateRoutineExecutableControlGate({
    brokenActiveRoutineCount,
    correctedActiveRoutineCount,
    comparison,
  })

  const report: DuplicateRoutineExecutableEvidenceReport = {
    schemaVersion: 'duplicate-routine-executable-evidence-report@1',
    title: 'Ambiguous activation responses create duplicate routines',
    generatedFrom: {
      fixtureManifestId: fixture.manifest.id,
      fixtureCohortHash: brokenLedger.fixtureCohortHash,
      adapterInput: 'bounded_postgresql_projection_plus_safe_local_jsonl',
      legacyControl: {
        kind: LEGACY_LAB_ACTIVATION_CONTRACT.kind,
        labOnly: LEGACY_LAB_ACTIVATION_CONTRACT.labOnly,
        productionSelectable: LEGACY_LAB_ACTIVATION_CONTRACT.productionSelectable,
        mcpSelectable: LEGACY_LAB_ACTIVATION_CONTRACT.mcpSelectable,
        expectedCreatedRoutineCount: LEGACY_LAB_ACTIVATION_CONTRACT.expectedCreatedRoutineCount,
      },
    },
    acceptance: {
      status: 'passed',
      brokenActiveRoutineCount: 2,
      correctedActiveRoutineCount: 1,
      brokenVerifierStatus: 'failed',
      correctedVerifierStatus: 'passed',
    },
    evidenceClassification: CREDENTIAL_FREE_MEASUREMENT_EVIDENCE,
    proofBoundary: {
      proves: [
        'The bounded PostgreSQL row projection and strict local JSONL adapter produce one privacy-safe normal form.',
        'The quarantined legacy fixture produces two active routines while the corrected fixture produces one.',
        'The retained metric, guardrails, aliases, and stable evidence identities are deterministic.',
      ],
      doesNotProve: [
        'A live model chooses the same plan, tools, or recovery behavior.',
        'A hosted PostgreSQL deployment or PostHog project accepted this retained fixture evidence.',
        'A reviewed change was deployed and improved a live observation window.',
      ],
    },
    comparison,
  }
  DuplicateRoutineExecutableEvidenceReportSchema.parse(report)
  assertPublicationSafe(report)
  return report
}

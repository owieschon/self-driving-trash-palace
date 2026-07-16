import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  EventIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  RunIdSchema,
  UserIdSchema,
} from '../../packages/core/src/index.js'
import {
  AnalyticsAliaser,
  aiCorrelationProperties,
  correlationProperties,
  createAiEvidenceEvent,
  createAnalyticsCorrelation,
  createPostHogEvidenceExporterFromEnvironment,
  createProductEvidenceEvent,
  type PostHogExportEnvironment,
  type SafeEvidenceEvent,
} from '../../packages/observability/src/index.js'

const REPORT_PATH = resolve('evals/reports/posthog-ingestion-live.json')

function compactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replaceAll(/[-:.TZ]/g, '')
    .toLowerCase()
}

async function main(): Promise<void> {
  const startedAt = new Date()
  const runKey = compactTimestamp(startedAt)
  const aliaser = new AnalyticsAliaser(randomBytes(32))
  const correlation = createAnalyticsCorrelation(aliaser, {
    distinctId: UserIdSchema.parse(`usr_liveprobe_${runKey}`),
    organizationId: OrganizationIdSchema.parse(`org_liveprobe_${runKey}`),
    palaceId: PalaceIdSchema.parse(`pal_liveprobe_${runKey}`),
    missionId: MissionIdSchema.parse(`mis_liveprobe_${runKey}`),
    runId: RunIdSchema.parse(`run_liveprobe_${runKey}`),
  })
  const spanAlias = aliaser.alias('span', `transport-probe:${runKey}`)
  const commonAiProperties = {
    schema_version: '1' as const,
    environment: 'evaluation' as const,
    data_origin: 'evaluation' as const,
    privacy_classification: 'analytics_safe' as const,
    app_version: '0.0.0-live-eval',
    organization_alias: correlation.organizationAlias,
    palace_alias: correlation.palaceAlias,
    ...aiCorrelationProperties(correlation),
  }
  const occurredAt = startedAt.toISOString()
  const events: SafeEvidenceEvent[] = [
    createProductEvidenceEvent({
      event: 'mission created',
      insertId: aliaser.insertId(
        'mission created',
        EventIdSchema.parse(`evt_liveproduct_${runKey}`),
      ),
      occurredAt,
      distinctId: correlation.distinctAlias,
      properties: {
        schema_version: '1',
        environment: 'evaluation',
        data_origin: 'evaluation',
        privacy_classification: 'analytics_safe',
        app_version: '0.0.0-live-eval',
        ...correlationProperties(correlation),
        mission_alias: correlation.missionAlias!,
        source_surface: 'fixture',
        objective_class: 'scheduled_hauler_access',
      },
    }),
    createAiEvidenceEvent({
      event: '$ai_span',
      insertId: aliaser.insertId('$ai_span', EventIdSchema.parse(`evt_livespan_${runKey}`)),
      occurredAt,
      distinctId: correlation.distinctAlias,
      properties: {
        ...commonAiProperties,
        $ai_span_id: spanAlias,
        $ai_span_name: 'posthog.ingestion_probe',
        $ai_latency: 0,
        $ai_is_error: false,
        span_kind: 'other',
        status: 'succeeded',
      },
    }),
    createAiEvidenceEvent({
      event: '$ai_trace',
      insertId: aliaser.insertId('$ai_trace', EventIdSchema.parse(`evt_livetrace_${runKey}`)),
      occurredAt,
      distinctId: correlation.distinctAlias,
      properties: {
        ...commonAiProperties,
        $ai_span_name: 'caretaker.ingestion_probe',
        $ai_latency: 0,
        $ai_is_error: false,
        outcome: 'verified',
        generation_count: 0,
        tool_call_count: 0,
        plan_revision_count: 0,
        clarification_pause_count: 0,
        reconciliation_poll_count: 0,
        active_runtime_ms: 0,
        budget_exhausted: false,
      },
    }),
  ]

  const environment: PostHogExportEnvironment = {
    TRASH_PALACE_POSTHOG_EXPORT_ENABLED: process.env.TRASH_PALACE_POSTHOG_EXPORT_ENABLED,
    TRASH_PALACE_POSTHOG_PROJECT_TOKEN: process.env.TRASH_PALACE_POSTHOG_PROJECT_TOKEN,
    TRASH_PALACE_POSTHOG_REGION: process.env.TRASH_PALACE_POSTHOG_REGION,
  }
  const exporter = await createPostHogEvidenceExporterFromEnvironment(environment)
  const submission = await exporter.exportBatch(events)
  const shutdown = await exporter.shutdown()
  if (
    submission.target !== 'posthog_us' ||
    submission.submittedCount !== events.length ||
    submission.flushStatus !== 'succeeded' ||
    shutdown.status !== 'succeeded'
  ) {
    throw new Error('PostHog export did not complete successfully')
  }

  const report = {
    schemaVersion: 'posthog-ingestion-live@1',
    status: 'awaiting_server_verification',
    projectId: 508977,
    region: 'us',
    startedAt: occurredAt,
    completedAt: new Date().toISOString(),
    eventNames: events.map((event) => event.event),
    insertIds: events.map((event) => event.insertId),
    traceAlias: correlation.runAlias,
    submission,
    shutdown,
    serverObservation: null,
    privacy: {
      secretValuesRetained: false,
      rawIdentifiersRetained: false,
      promptsRetained: false,
      customerDataRetained: false,
    },
    claims: {
      posthogIngestion: 'Awaiting server verification',
      liveModel: 'Blocked',
      liveLoop: 'Blocked',
    },
  }
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(
    `Submitted ${events.length} sanitized evaluation events to PostHog US; server verification pending.\n`,
  )
}

await main()

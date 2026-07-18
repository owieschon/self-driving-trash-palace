import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  createPostHogEvidenceExporterFromEnvironment,
  parseSafeEvidenceEvent,
  type PostHogExportEnvironment,
  type SafeEvidenceEvent,
} from '../../packages/observability/src/index.js'

const REPORT_PATH = resolve('evals/reports/posthog-product-path-live.json')

async function main(): Promise<void> {
  const input = await readStandardInput()
  const retainedEvents = input
    .split(/\n+/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseSafeEvidenceEvent(JSON.parse(line) as unknown))
  const selectedEvents = retainedEvents.filter(
    (event) =>
      event.properties.environment === 'evaluation' &&
      event.properties.data_origin === 'evaluation',
  )
  const projectionStartedAt = new Date()
  const events = rebaseFixtureTimestamps(selectedEvents, projectionStartedAt)
  if (events.length === 0) throw new Error('Product-path export requires retained worker evidence')

  const environment: PostHogExportEnvironment = {
    TRASH_PALACE_POSTHOG_EXPORT_ENABLED: process.env.TRASH_PALACE_POSTHOG_EXPORT_ENABLED,
    TRASH_PALACE_POSTHOG_PROJECT_TOKEN: process.env.TRASH_PALACE_POSTHOG_PROJECT_TOKEN,
    TRASH_PALACE_POSTHOG_REGION: process.env.TRASH_PALACE_POSTHOG_REGION,
  }
  const exporter = await createPostHogEvidenceExporterFromEnvironment(environment)
  const startedAt = new Date()
  const submission = await exporter.exportBatch(events)
  const shutdown = await exporter.shutdown()
  if (
    submission.target !== 'posthog_us' ||
    submission.submittedCount !== events.length ||
    submission.flushStatus !== 'succeeded' ||
    shutdown.status !== 'succeeded'
  ) {
    throw new Error('Product-path PostHog export did not complete successfully')
  }

  const report = {
    schemaVersion: 'posthog-product-path-live@1',
    status: 'awaiting_server_verification',
    projectId: 508977,
    region: 'us',
    source: 'composed-local-product-path',
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    eventNames: [...new Set(events.map((event) => event.event))].sort(),
    insertIds: events.map((event) => event.insertId),
    excludedNonEvaluationCount: retainedEvents.length - events.length,
    timestampProjection: {
      kind: 'fixture-order-rebased-for-ingestion',
      projectedCount: events.length,
      originalMinimum: selectedEvents.map((event) => event.occurredAt).sort()[0],
      originalMaximum: selectedEvents
        .map((event) => event.occurredAt)
        .sort()
        .at(-1),
      projectedMinimum: events.map((event) => event.occurredAt).sort()[0],
      projectedMaximum: events
        .map((event) => event.occurredAt)
        .sort()
        .at(-1),
    },
    submission,
    shutdown,
    serverObservation: null,
    privacy: {
      secretValuesRetained: false,
      rawIdentifiersRetained: false,
      promptsRetained: false,
      customerDataRetained: false,
      fixtureEvidenceOnly: true,
    },
    claims: {
      productPathTransport: 'Awaiting server verification',
      productionTraffic: 'Blocked',
      liveModel: 'Blocked',
      liveLoop: 'Blocked',
    },
  }
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(
    `Submitted ${events.length} sanitized product-path events; server verification pending.\n`,
  )
}

export function rebaseFixtureTimestamps(
  events: readonly SafeEvidenceEvent[],
  startedAt: Date,
): readonly SafeEvidenceEvent[] {
  return [...events]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .map((event, index) =>
      parseSafeEvidenceEvent({
        ...event,
        occurredAt: new Date(startedAt.getTime() + index).toISOString(),
        insertId: `tpi_v1_${createHash('sha256')
          .update(`product-path-export@1:${event.insertId}`)
          .digest('base64url')}`,
      }),
    )
}

async function readStandardInput(): Promise<string> {
  process.stdin.setEncoding('utf8')
  const chunks: string[] = []
  for await (const chunk of process.stdin as AsyncIterable<string>) chunks.push(chunk)
  return chunks.join('')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}

import {
  EventIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  RunIdSchema,
  UserIdSchema,
  type EventId,
} from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

vi.mock('posthog-node', () => ({
  PostHog: function NetworkForbiddenPostHogClient() {
    throw new Error('The real PostHog client is forbidden in deterministic tests')
  },
}))

import {
  AnalyticsAliaser,
  POSTHOG_EXPORT_HOSTS,
  PostHogExportConfigurationError,
  PostHogExportInitializationError,
  aiCorrelationProperties,
  correlationProperties,
  createAiEvidenceEvent,
  createAnalyticsCorrelation,
  createPostHogEvidenceExporter,
  createPostHogEvidenceExporterFromEnvironment,
  createProductEvidenceEvent,
  parsePostHogExportEnvironment,
  toPostHogCaptureMessage,
  type AiEvidenceEvent,
  type PostHogCaptureMessage,
  type PostHogClientConfiguration,
  type PostHogClientPort,
  type ProductEvidenceEvent,
  type SafeEvidenceEvent,
} from './index.js'

const PROJECT_TOKEN = `phc_${'a'.repeat(24)}`
const SEEDED_HOME_PATH = ['', 'Users', 'fixture-home', 'trash-palace'].join('/')
const SEEDED_PRIVATE_POSTHOG_URL = [
  'https://us.posthog.com',
  'project',
  'fixture-project',
  'trace',
  '1',
].join('/')
const aliaser = new AnalyticsAliaser('posthog-export-test-key-with-at-least-32-bytes')
const correlation = createAnalyticsCorrelation(aliaser, {
  distinctId: UserIdSchema.parse('usr_exportperson0001'),
  organizationId: OrganizationIdSchema.parse('org_exporttenant0001'),
  palaceId: PalaceIdSchema.parse('pal_exportpalace0001'),
  missionId: MissionIdSchema.parse('mis_exportmission0001'),
  runId: RunIdSchema.parse('run_exportrun0000001'),
})

function eventId(value: string): EventId {
  return EventIdSchema.parse(value)
}

function productEvent(
  logicalEventId: EventId = eventId('evt_posthog_product_001'),
  occurredAt = '2026-07-15T06:00:00.000Z',
  environment: 'evaluation' | 'hosted_demo' | 'local' | 'test' = 'evaluation',
): ProductEvidenceEvent {
  return createProductEvidenceEvent({
    event: 'mission created',
    insertId: aliaser.insertId('mission created', logicalEventId),
    occurredAt,
    distinctId: correlation.distinctAlias,
    properties: {
      schema_version: '1',
      environment,
      data_origin: environment === 'evaluation' ? 'evaluation' : 'fixture',
      privacy_classification: 'analytics_safe',
      app_version: '0.0.0-test',
      ...correlationProperties(correlation),
      mission_alias: correlation.missionAlias!,
      source_surface: 'fixture',
      objective_class: 'homecoming_routine',
    },
  })
}

function aiEvent(): Extract<AiEvidenceEvent, { event: '$ai_generation' }> {
  return createAiEvidenceEvent<'$ai_generation'>({
    event: '$ai_generation',
    insertId: aliaser.insertId('$ai_generation', eventId('evt_posthog_generation_001')),
    occurredAt: '2026-07-15T06:00:01.000Z',
    distinctId: correlation.distinctAlias,
    properties: {
      schema_version: '1',
      environment: 'evaluation',
      data_origin: 'evaluation',
      privacy_classification: 'analytics_safe',
      app_version: '0.0.0-test',
      organization_alias: correlation.organizationAlias,
      palace_alias: correlation.palaceAlias,
      ...aiCorrelationProperties(correlation),
      $ai_span_id: aliaser.alias('span', 'posthog-export-span-001'),
      $ai_span_name: 'caretaker.plan',
      $ai_model: 'claude-test-v1',
      $ai_provider: 'anthropic',
      $ai_input_tokens: 321,
      $ai_output_tokens: 87,
      $ai_latency: 1.25,
      $ai_time_to_first_token: 0.21,
      $ai_stream: true,
      $ai_total_cost_usd: 0.0042,
      $ai_is_error: false,
      $ai_stop_reason: 'end_turn',
      input_redaction_count: 2,
      output_redaction_count: 1,
      completion_claim: 'none',
    },
  })
}

class RecordingPostHogClient implements PostHogClientPort {
  public readonly captures: PostHogCaptureMessage[] = []
  public captureCalls = 0
  public flushCalls = 0
  public shutdownCalls = 0
  public captureFailureIndexes = new Set<number>()
  public flushFailuresRemaining = 0
  public shutdownShouldFail = false
  public sensitiveFailureMessage = ''

  public capture(message: PostHogCaptureMessage): void {
    const index = this.captureCalls
    this.captureCalls += 1
    if (this.captureFailureIndexes.has(index)) {
      throw new Error(this.sensitiveFailureMessage || 'capture failed')
    }
    this.captures.push(message)
  }

  public async flush(): Promise<void> {
    this.flushCalls += 1
    if (this.flushFailuresRemaining > 0) {
      this.flushFailuresRemaining -= 1
      throw new Error(this.sensitiveFailureMessage || 'flush failed')
    }
  }

  public async shutdown(): Promise<void> {
    this.shutdownCalls += 1
    if (this.shutdownShouldFail) {
      throw new Error(this.sensitiveFailureMessage || 'shutdown failed')
    }
  }
}

function enabledConfig(region: 'eu' | 'us' = 'us'): {
  readonly enabled: true
  readonly projectToken: string
  readonly region: 'eu' | 'us'
} {
  return { enabled: true, projectToken: PROJECT_TOKEN, region }
}

describe('PostHog export configuration', () => {
  it('defaults to disabled without constructing an SDK client', async () => {
    const clientFactory = vi.fn(() => new RecordingPostHogClient())
    const exporter = await createPostHogEvidenceExporter(undefined, { clientFactory })

    await expect(exporter.exportBatch([productEvent()])).resolves.toMatchObject({
      target: 'disabled',
      receivedCount: 1,
      disabledCount: 1,
      flushStatus: 'not_run',
    })
    await expect(exporter.shutdown()).resolves.toMatchObject({ status: 'disabled' })
    expect(clientFactory).not.toHaveBeenCalled()
  })

  it('requires an explicit valid region and project token when enabled', () => {
    expect(parsePostHogExportEnvironment({})).toEqual({ enabled: false })
    expect(
      parsePostHogExportEnvironment({
        TRASH_PALACE_POSTHOG_EXPORT_ENABLED: 'false',
        TRASH_PALACE_POSTHOG_PROJECT_TOKEN: 'unused',
        TRASH_PALACE_POSTHOG_REGION: 'unused',
      }),
    ).toEqual({ enabled: false })

    for (const environment of [
      { TRASH_PALACE_POSTHOG_EXPORT_ENABLED: 'yes' },
      { TRASH_PALACE_POSTHOG_EXPORT_ENABLED: 'true' },
      {
        TRASH_PALACE_POSTHOG_EXPORT_ENABLED: 'true',
        TRASH_PALACE_POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN,
      },
      {
        TRASH_PALACE_POSTHOG_EXPORT_ENABLED: 'true',
        TRASH_PALACE_POSTHOG_PROJECT_TOKEN: `phx_${'b'.repeat(24)}`,
        TRASH_PALACE_POSTHOG_REGION: 'us',
      },
      {
        TRASH_PALACE_POSTHOG_EXPORT_ENABLED: 'true',
        TRASH_PALACE_POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN,
        TRASH_PALACE_POSTHOG_REGION: 'apac',
      },
    ]) {
      expect(() => parsePostHogExportEnvironment(environment)).toThrow(
        PostHogExportConfigurationError,
      )
    }
  })

  it('derives only the fixed US and EU ingestion hosts', async () => {
    const configurations: PostHogClientConfiguration[] = []
    const clientFactory = (configuration: PostHogClientConfiguration): PostHogClientPort => {
      configurations.push(configuration)
      return new RecordingPostHogClient()
    }

    const us = await createPostHogEvidenceExporter(enabledConfig('us'), { clientFactory })
    const eu = await createPostHogEvidenceExporter(enabledConfig('eu'), { clientFactory })

    expect(configurations.map(({ host, region }) => ({ host, region }))).toEqual([
      { host: POSTHOG_EXPORT_HOSTS.us, region: 'us' },
      { host: POSTHOG_EXPORT_HOSTS.eu, region: 'eu' },
    ])
    expect(configurations.every(({ projectToken }) => projectToken === PROJECT_TOKEN)).toBe(true)
    await us.shutdown()
    await eu.shutdown()
  })

  it('does not expose factory failures or the injected token', async () => {
    const initialization = createPostHogEvidenceExporter(enabledConfig(), {
      clientFactory() {
        throw new Error(`Authorization: Bearer ${PROJECT_TOKEN}`)
      },
    })

    await expect(initialization).rejects.toBeInstanceOf(PostHogExportInitializationError)
    await expect(initialization).rejects.not.toThrow(PROJECT_TOKEN)
  })

  it('blocks the real SDK transport inside deterministic tests', async () => {
    await expect(createPostHogEvidenceExporter(enabledConfig())).rejects.toBeInstanceOf(
      PostHogExportInitializationError,
    )
  })
})

describe('PostHog export duplicate cache', () => {
  it('bounds confirmed insert IDs and permits an evicted ID to be delivered again', async () => {
    const client = new RecordingPostHogClient()
    const exporter = await createPostHogEvidenceExporter(enabledConfig(), {
      clientFactory: () => client,
      maxConfirmedInsertIds: 2,
    })
    const first = productEvent(eventId('evt_posthog_cache_001'))
    const second = productEvent(eventId('evt_posthog_cache_002'))
    const third = productEvent(eventId('evt_posthog_cache_003'))

    await exporter.exportBatch([first, second, third])
    const redelivered = await exporter.exportBatch([first])

    expect(redelivered).toMatchObject({ submittedCount: 1, duplicateCount: 0 })
    expect(client.captureCalls).toBe(4)
  })
})

describe('PostHog capture mapping', () => {
  it('maps aliases, organization group, timestamp, and stable insert ID exactly', () => {
    const event = productEvent()
    const message = toPostHogCaptureMessage(event)

    expect(message).toEqual({
      distinctId: correlation.distinctAlias,
      event: 'mission created',
      groups: { organization: correlation.organizationAlias },
      properties: {
        ...event.properties,
        $insert_id: event.insertId,
      },
      timestamp: new Date(event.occurredAt),
    })
    const serialized = JSON.stringify(message)
    expect(serialized).not.toContain('usr_exportperson0001')
    expect(serialized).not.toContain('org_exporttenant0001')
    expect(serialized).not.toContain('pal_exportpalace0001')
  })

  it('preserves the safe AI hierarchy and operational metrics without model content', () => {
    const event = aiEvent()
    const message = toPostHogCaptureMessage(event)

    expect(message.properties).toMatchObject({
      $ai_session_id: correlation.missionAlias,
      $ai_trace_id: correlation.runAlias,
      run_alias: correlation.runAlias,
      $ai_span_id: event.properties.$ai_span_id,
      $ai_input_tokens: 321,
      $ai_output_tokens: 87,
      $ai_latency: 1.25,
      $ai_time_to_first_token: 0.21,
      $ai_total_cost_usd: 0.0042,
      $insert_id: event.insertId,
    })
    expect(message.properties).not.toHaveProperty('$ai_input')
    expect(message.properties).not.toHaveProperty('$ai_output_choices')
    expect(message.properties).not.toHaveProperty('$ai_tools')
  })

  it('keeps test and local evidence on the local sink', async () => {
    const client = new RecordingPostHogClient()
    const exporter = await createPostHogEvidenceExporter(enabledConfig(), {
      clientFactory: () => client,
    })

    const receipt = await exporter.exportBatch([
      productEvent(eventId('evt_posthog_local_001'), '2026-07-15T06:01:00.000Z', 'local'),
      productEvent(eventId('evt_posthog_test_001'), '2026-07-15T06:01:01.000Z', 'test'),
    ])

    expect(receipt).toMatchObject({
      receivedCount: 2,
      rejectedCount: 2,
      submittedCount: 0,
      flushStatus: 'not_run',
    })
    expect(receipt.results.map((result) => result.errorCode)).toEqual([
      'local_only_environment',
      'local_only_environment',
    ])
    expect(client.captureCalls).toBe(0)
    expect(client.flushCalls).toBe(0)
  })
})

describe('PostHog batch export receipts', () => {
  it('deduplicates idempotent input before capture and across successful batches', async () => {
    const client = new RecordingPostHogClient()
    const exporter = await createPostHogEvidenceExporter(enabledConfig(), {
      clientFactory: () => client,
    })
    const event = productEvent()

    const first = await exporter.exportBatch([event, event])
    const second = await exporter.exportBatch([event])

    expect(first).toMatchObject({
      receivedCount: 2,
      submittedCount: 1,
      duplicateCount: 1,
      flushStatus: 'succeeded',
    })
    expect(first.results.map(({ status }) => status)).toEqual(['submitted', 'duplicate'])
    expect(second).toMatchObject({
      receivedCount: 1,
      submittedCount: 0,
      duplicateCount: 1,
      flushStatus: 'not_run',
    })
    expect(client.captureCalls).toBe(1)
    expect(client.flushCalls).toBe(1)
  })

  it('rejects a reused insert ID with a different payload', async () => {
    const client = new RecordingPostHogClient()
    const exporter = await createPostHogEvidenceExporter(enabledConfig(), {
      clientFactory: () => client,
    })
    const first = productEvent()
    const conflict = productEvent(eventId('evt_posthog_product_001'), '2026-07-15T06:05:00.000Z')

    await exporter.exportBatch([first])
    const receipt = await exporter.exportBatch([conflict])

    expect(receipt).toMatchObject({ rejectedCount: 1, flushStatus: 'not_run' })
    expect(receipt.results[0]).toMatchObject({
      insertId: first.insertId,
      status: 'rejected',
      errorCode: 'insert_id_conflict',
    })
    expect(client.captureCalls).toBe(1)
  })

  it('continues after an event-level client failure without retaining sensitive errors', async () => {
    const client = new RecordingPostHogClient()
    client.captureFailureIndexes.add(0)
    client.sensitiveFailureMessage = `Bearer ${PROJECT_TOKEN} at ${SEEDED_HOME_PATH}/agent.ts`
    const exporter = await createPostHogEvidenceExporter(enabledConfig(), {
      clientFactory: () => client,
    })
    const first = productEvent(eventId('evt_posthog_capture_fail_001'))
    const second = productEvent(eventId('evt_posthog_capture_ok_001'), '2026-07-15T06:06:00.000Z')

    const receipt = await exporter.exportBatch([first, second])
    const serialized = JSON.stringify(receipt)

    expect(receipt).toMatchObject({
      receivedCount: 2,
      submittedCount: 1,
      captureFailedCount: 1,
      flushStatus: 'succeeded',
    })
    expect(receipt.results.map(({ status }) => status)).toEqual(['capture_failed', 'submitted'])
    expect(client.captureCalls).toBe(2)
    expect(serialized).not.toContain(PROJECT_TOKEN)
    expect(serialized).not.toContain(SEEDED_HOME_PATH)
  })

  it('labels a failed flush as delivery unknown and permits an insert-ID-safe retry', async () => {
    const client = new RecordingPostHogClient()
    client.flushFailuresRemaining = 1
    const exporter = await createPostHogEvidenceExporter(enabledConfig(), {
      clientFactory: () => client,
    })
    const event = productEvent()

    const unknown = await exporter.exportBatch([event])
    const retried = await exporter.exportBatch([event])

    expect(unknown).toMatchObject({
      submittedCount: 0,
      deliveryUnknownCount: 1,
      flushStatus: 'failed',
    })
    expect(unknown.results[0]?.status).toBe('delivery_unknown')
    expect(retried).toMatchObject({
      submittedCount: 1,
      deliveryUnknownCount: 0,
      flushStatus: 'succeeded',
    })
    expect(client.captureCalls).toBe(2)
    expect(client.flushCalls).toBe(2)
  })

  it('labels same-batch coalesced retries delivery unknown when their shared flush fails', async () => {
    const client = new RecordingPostHogClient()
    client.flushFailuresRemaining = 1
    const exporter = await createPostHogEvidenceExporter(enabledConfig(), {
      clientFactory: () => client,
    })
    const event = productEvent()

    const unknown = await exporter.exportBatch([event, event])
    const retried = await exporter.exportBatch([event])

    expect(unknown).toMatchObject({
      receivedCount: 2,
      submittedCount: 0,
      duplicateCount: 0,
      deliveryUnknownCount: 2,
      flushStatus: 'failed',
    })
    expect(unknown.results.map(({ status }) => status)).toEqual([
      'delivery_unknown',
      'delivery_unknown',
    ])
    expect(retried).toMatchObject({ submittedCount: 1, flushStatus: 'succeeded' })
    expect(client.captureCalls).toBe(2)
    expect(client.flushCalls).toBe(2)
  })

  it('flushes and shuts down once, with idempotent shutdown receipts', async () => {
    const client = new RecordingPostHogClient()
    const exporter = await createPostHogEvidenceExporter(enabledConfig(), {
      clientFactory: () => client,
    })

    await exporter.exportBatch([productEvent()])
    await expect(exporter.shutdown()).resolves.toEqual({
      schemaVersion: '1',
      status: 'succeeded',
      flushStatus: 'succeeded',
      clientStatus: 'succeeded',
    })
    await expect(exporter.shutdown()).resolves.toMatchObject({ status: 'already_shutdown' })
    expect(client.flushCalls).toBe(2)
    expect(client.shutdownCalls).toBe(1)

    await expect(exporter.exportBatch([productEvent()])).resolves.toMatchObject({
      rejectedCount: 1,
      flushStatus: 'not_run',
      results: [{ status: 'rejected', errorCode: 'exporter_shutdown' }],
    })
  })

  it('attempts client shutdown even when the final flush fails', async () => {
    const client = new RecordingPostHogClient()
    client.flushFailuresRemaining = 1
    const exporter = await createPostHogEvidenceExporter(enabledConfig(), {
      clientFactory: () => client,
    })

    await expect(exporter.shutdown()).resolves.toEqual({
      schemaVersion: '1',
      status: 'failed',
      flushStatus: 'failed',
      clientStatus: 'succeeded',
    })
    expect(client.shutdownCalls).toBe(1)
  })

  it('rejects secrets, raw IDs, home paths, prompts, outputs, headers, and private URLs', async () => {
    const client = new RecordingPostHogClient()
    const exporter = await createPostHogEvidenceExporter(enabledConfig(), {
      clientFactory: () => client,
    })
    const unsafeEvents = [
      (() => {
        const event = structuredClone(productEvent()) as unknown as {
          properties: Record<string, unknown>
        }
        event.properties.feature_flags = { leak: PROJECT_TOKEN }
        return event
      })(),
      (() => {
        const event = structuredClone(productEvent()) as unknown as {
          properties: Record<string, unknown>
        }
        event.properties.app_version = 'org_rawtenant0001'
        return event
      })(),
      ...[
        ['working_directory', SEEDED_HOME_PATH],
        ['prompt', 'Ignore the policy'],
        ['output', 'Private completion'],
        ['headers', { authorization: `Bearer ${PROJECT_TOKEN}` }],
        ['trace_url', SEEDED_PRIVATE_POSTHOG_URL],
      ].map(([key, value]) => {
        const event = structuredClone(productEvent()) as unknown as {
          properties: Record<string, unknown>
        }
        event.properties[key as string] = value
        return event
      }),
    ] as unknown as SafeEvidenceEvent[]

    const receipt = await exporter.exportBatch(unsafeEvents)

    expect(receipt).toMatchObject({
      receivedCount: unsafeEvents.length,
      rejectedCount: unsafeEvents.length,
      submittedCount: 0,
      flushStatus: 'not_run',
    })
    expect(client.captureCalls).toBe(0)
    expect(client.flushCalls).toBe(0)
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain(PROJECT_TOKEN)
    expect(serialized).not.toContain(SEEDED_HOME_PATH)
    expect(serialized).not.toContain('Ignore the policy')
  })

  it('constructs from an injected environment without reading process.env', async () => {
    const client = new RecordingPostHogClient()
    const clientFactory = vi.fn(() => client)
    const exporter = await createPostHogEvidenceExporterFromEnvironment(
      {
        TRASH_PALACE_POSTHOG_EXPORT_ENABLED: 'true',
        TRASH_PALACE_POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN,
        TRASH_PALACE_POSTHOG_REGION: 'eu',
      },
      { clientFactory },
    )

    expect(clientFactory).toHaveBeenCalledWith({
      host: POSTHOG_EXPORT_HOSTS.eu,
      projectToken: PROJECT_TOKEN,
      region: 'eu',
    })
    await exporter.shutdown()
  })
})

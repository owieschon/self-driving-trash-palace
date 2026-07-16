import { z } from 'zod'

import { canonicalJson, type JsonValue } from './canonical.js'
import {
  allowedPropertiesFor,
  parseSafeEvidenceEvent,
  type SafeEvidenceEvent,
} from './contracts.js'
import type { AnalyticsAlias, StableInsertId } from './identifiers.js'
import { assertPublicationSafe } from './redaction.js'

export const POSTHOG_EXPORT_HOSTS = Object.freeze({
  eu: 'https://eu.i.posthog.com',
  us: 'https://us.i.posthog.com',
} as const)

export const POSTHOG_ORGANIZATION_GROUP_TYPE = 'organization'

const PostHogExportRegionSchema = z.enum(['eu', 'us'])
const PostHogProjectTokenSchema = z
  .string()
  .min(24)
  .max(256)
  .regex(/^phc_[A-Za-z0-9]+$/)

const DisabledPostHogExportConfigSchema = z
  .object({
    enabled: z.literal(false),
  })
  .strict()

const EnabledPostHogExportConfigSchema = z
  .object({
    enabled: z.literal(true),
    projectToken: PostHogProjectTokenSchema,
    region: PostHogExportRegionSchema,
  })
  .strict()

const PostHogExportConfigSchema = z.discriminatedUnion('enabled', [
  DisabledPostHogExportConfigSchema,
  EnabledPostHogExportConfigSchema,
])

export type PostHogExportRegion = z.infer<typeof PostHogExportRegionSchema>
export type PostHogExportConfig = z.infer<typeof PostHogExportConfigSchema>

export interface PostHogExportEnvironment {
  readonly TRASH_PALACE_POSTHOG_EXPORT_ENABLED?: string
  readonly TRASH_PALACE_POSTHOG_PROJECT_TOKEN?: string
  readonly TRASH_PALACE_POSTHOG_REGION?: string
}

export class PostHogExportConfigurationError extends Error {
  public constructor() {
    super('PostHog export configuration is invalid')
    this.name = 'PostHogExportConfigurationError'
  }
}

export class PostHogExportInitializationError extends Error {
  public constructor() {
    super('PostHog export client initialization failed')
    this.name = 'PostHogExportInitializationError'
  }
}

export function parsePostHogExportConfig(input: unknown): PostHogExportConfig {
  const parsed = PostHogExportConfigSchema.safeParse(input)
  if (!parsed.success) {
    throw new PostHogExportConfigurationError()
  }
  return parsed.data
}

export function parsePostHogExportEnvironment(
  environment: PostHogExportEnvironment,
): PostHogExportConfig {
  const enabled = environment.TRASH_PALACE_POSTHOG_EXPORT_ENABLED
  if (enabled === undefined || enabled === 'false') {
    return { enabled: false }
  }
  if (enabled !== 'true') {
    throw new PostHogExportConfigurationError()
  }

  return parsePostHogExportConfig({
    enabled: true,
    projectToken: environment.TRASH_PALACE_POSTHOG_PROJECT_TOKEN,
    region: environment.TRASH_PALACE_POSTHOG_REGION,
  })
}

export interface PostHogCaptureMessage {
  readonly distinctId: AnalyticsAlias
  readonly event: string
  readonly groups: Readonly<Record<typeof POSTHOG_ORGANIZATION_GROUP_TYPE, AnalyticsAlias>>
  readonly properties: Readonly<
    Record<string, JsonValue> & {
      $insert_id: StableInsertId
    }
  >
  readonly timestamp: Date
}

export interface PostHogClientPort {
  capture(message: PostHogCaptureMessage): Promise<void> | void
  flush(): Promise<void>
  shutdown(): Promise<void>
}

export interface PostHogClientConfiguration {
  readonly host: (typeof POSTHOG_EXPORT_HOSTS)[PostHogExportRegion]
  readonly projectToken: string
  readonly region: PostHogExportRegion
}

export type PostHogClientFactory = (
  configuration: PostHogClientConfiguration,
) => Promise<PostHogClientPort> | PostHogClientPort

interface PreparedPostHogEvent {
  readonly insertId: StableInsertId
  readonly message: PostHogCaptureMessage
  readonly serialized: string
}

export type PostHogEventExportErrorCode =
  | 'capture_failed'
  | 'event_validation_failed'
  | 'exporter_shutdown'
  | 'insert_id_conflict'
  | 'local_only_environment'

export type PostHogEventExportStatus =
  'capture_failed' | 'delivery_unknown' | 'disabled' | 'duplicate' | 'rejected' | 'submitted'

export interface PostHogEventExportResult {
  readonly errorCode?: PostHogEventExportErrorCode
  readonly index: number
  readonly insertId?: StableInsertId
  readonly status: PostHogEventExportStatus
}

export interface PostHogBatchExportReceipt {
  readonly schemaVersion: '1'
  readonly target: 'disabled' | 'posthog_eu' | 'posthog_us'
  readonly receivedCount: number
  readonly submittedCount: number
  readonly duplicateCount: number
  readonly disabledCount: number
  readonly rejectedCount: number
  readonly captureFailedCount: number
  readonly deliveryUnknownCount: number
  readonly flushStatus: 'failed' | 'not_run' | 'succeeded'
  readonly results: readonly PostHogEventExportResult[]
}

export interface PostHogShutdownReceipt {
  readonly schemaVersion: '1'
  readonly status: 'already_shutdown' | 'disabled' | 'failed' | 'succeeded'
  readonly flushStatus: 'failed' | 'not_run' | 'succeeded'
  readonly clientStatus: 'failed' | 'not_run' | 'succeeded'
}

export interface PostHogEvidenceExporter {
  exportBatch(events: readonly SafeEvidenceEvent[]): Promise<PostHogBatchExportReceipt>
  shutdown(): Promise<PostHogShutdownReceipt>
}

class UnsafePostHogEventError extends Error {
  public readonly code: Extract<
    PostHogEventExportErrorCode,
    'event_validation_failed' | 'local_only_environment'
  >

  public constructor(code: UnsafePostHogEventError['code']) {
    super(code)
    this.name = 'UnsafePostHogEventError'
    this.code = code
  }
}

function eventProperties(event: SafeEvidenceEvent): Readonly<Record<string, JsonValue>> {
  const properties = event.properties as Readonly<Record<string, JsonValue>>
  const allowed = new Set(allowedPropertiesFor(event.event))
  const supplied = Object.keys(properties)
  if (supplied.some((property) => !allowed.has(property))) {
    throw new UnsafePostHogEventError('event_validation_failed')
  }

  const projected: Record<string, JsonValue> = {}
  for (const property of allowedPropertiesFor(event.event)) {
    if (!Object.hasOwn(properties, property)) {
      continue
    }
    const value = properties[property]
    if (value === undefined) {
      throw new UnsafePostHogEventError('event_validation_failed')
    }
    projected[property] = value
  }
  assertPublicationSafe(projected)
  return projected
}

function preparePostHogEvent(input: SafeEvidenceEvent): PreparedPostHogEvent {
  let event: SafeEvidenceEvent
  try {
    event = parseSafeEvidenceEvent(input)
  } catch {
    throw new UnsafePostHogEventError('event_validation_failed')
  }

  if (event.properties.environment === 'local' || event.properties.environment === 'test') {
    throw new UnsafePostHogEventError('local_only_environment')
  }

  let properties: Readonly<Record<string, JsonValue>>
  try {
    properties = eventProperties(event)
  } catch (error) {
    if (error instanceof UnsafePostHogEventError) {
      throw error
    }
    throw new UnsafePostHogEventError('event_validation_failed')
  }

  const message: PostHogCaptureMessage = {
    distinctId: event.distinctId,
    event: event.event,
    groups: {
      [POSTHOG_ORGANIZATION_GROUP_TYPE]: event.properties.organization_alias,
    },
    properties: {
      ...properties,
      $insert_id: event.insertId,
    },
    timestamp: new Date(event.occurredAt),
  }

  return {
    insertId: event.insertId,
    message,
    serialized: canonicalJson(event as unknown as JsonValue),
  }
}

export function toPostHogCaptureMessage(input: SafeEvidenceEvent): PostHogCaptureMessage {
  return preparePostHogEvent(input).message
}

async function defaultPostHogClientFactory(
  configuration: PostHogClientConfiguration,
): Promise<PostHogClientPort> {
  const { PostHog } = await import('posthog-node')
  const client = new PostHog(configuration.projectToken, {
    disableGeoip: true,
    enableExceptionAutocapture: false,
    enableLocalEvaluation: false,
    flushAt: 20,
    flushInterval: 10_000,
    host: configuration.host,
    requestTimeout: 10_000,
  })

  return {
    capture(message) {
      client.capture({
        distinctId: message.distinctId,
        event: message.event,
        groups: { ...message.groups },
        properties: { ...message.properties },
        timestamp: message.timestamp,
      })
    },
    flush() {
      return client.flush()
    },
    shutdown() {
      return client._shutdown(10_000)
    },
  }
}

function targetFor(config: PostHogExportConfig): PostHogBatchExportReceipt['target'] {
  return config.enabled ? `posthog_${config.region}` : 'disabled'
}

function countStatus(
  results: readonly PostHogEventExportResult[],
  status: PostHogEventExportStatus,
): number {
  return results.filter((result) => result.status === status).length
}

function batchReceipt(
  target: PostHogBatchExportReceipt['target'],
  receivedCount: number,
  flushStatus: PostHogBatchExportReceipt['flushStatus'],
  results: readonly PostHogEventExportResult[],
): PostHogBatchExportReceipt {
  return {
    schemaVersion: '1',
    target,
    receivedCount,
    submittedCount: countStatus(results, 'submitted'),
    duplicateCount: countStatus(results, 'duplicate'),
    disabledCount: countStatus(results, 'disabled'),
    rejectedCount: countStatus(results, 'rejected'),
    captureFailedCount: countStatus(results, 'capture_failed'),
    deliveryUnknownCount: countStatus(results, 'delivery_unknown'),
    flushStatus,
    results,
  }
}

class ConfiguredPostHogEvidenceExporter implements PostHogEvidenceExporter {
  readonly #client: PostHogClientPort | undefined
  readonly #config: PostHogExportConfig
  readonly #confirmed = new Map<StableInsertId, string>()
  #closed = false
  #queue: Promise<void> = Promise.resolve()

  public constructor(config: PostHogExportConfig, client?: PostHogClientPort) {
    this.#config = config
    this.#client = client
  }

  public exportBatch(events: readonly SafeEvidenceEvent[]): Promise<PostHogBatchExportReceipt> {
    const operation = this.#queue.then(() => this.#exportBatch(events))
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  public shutdown(): Promise<PostHogShutdownReceipt> {
    const operation = this.#queue.then(() => this.#shutdown())
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  async #exportBatch(events: readonly SafeEvidenceEvent[]): Promise<PostHogBatchExportReceipt> {
    if (!this.#config.enabled) {
      const results = events.map<PostHogEventExportResult>((_event, index) => ({
        index,
        status: this.#closed ? 'rejected' : 'disabled',
        ...(this.#closed ? { errorCode: 'exporter_shutdown' as const } : {}),
      }))
      return batchReceipt('disabled', events.length, 'not_run', results)
    }

    const client = this.#client
    if (client === undefined) {
      throw new PostHogExportInitializationError()
    }

    const staged = new Map<StableInsertId, { serialized: string }>()
    const stagedDuplicateIndexes = new Set<number>()
    const results: PostHogEventExportResult[] = []

    for (const [index, input] of events.entries()) {
      if (this.#closed) {
        results.push({ index, status: 'rejected', errorCode: 'exporter_shutdown' })
        continue
      }

      let prepared: PreparedPostHogEvent
      try {
        // Parsing, property projection, and publication checks happen on the last code path
        // before capture so callers cannot bypass the SafeEvidenceEvent allowlist.
        prepared = preparePostHogEvent(input)
      } catch (error) {
        results.push({
          index,
          status: 'rejected',
          errorCode:
            error instanceof UnsafePostHogEventError ? error.code : 'event_validation_failed',
        })
        continue
      }

      const confirmed = this.#confirmed.get(prepared.insertId)
      const pending = staged.get(prepared.insertId)
      const existing = confirmed ?? pending?.serialized
      if (existing !== undefined) {
        if (existing === prepared.serialized) {
          results.push({ index, insertId: prepared.insertId, status: 'duplicate' })
          if (confirmed === undefined && pending !== undefined) {
            stagedDuplicateIndexes.add(index)
          }
        } else {
          results.push({
            index,
            insertId: prepared.insertId,
            status: 'rejected',
            errorCode: 'insert_id_conflict',
          })
        }
        continue
      }

      try {
        await client.capture(prepared.message)
        staged.set(prepared.insertId, { serialized: prepared.serialized })
        results.push({ index, insertId: prepared.insertId, status: 'submitted' })
      } catch {
        results.push({
          index,
          insertId: prepared.insertId,
          status: 'capture_failed',
          errorCode: 'capture_failed',
        })
      }
    }

    if (staged.size === 0) {
      return batchReceipt(targetFor(this.#config), events.length, 'not_run', results)
    }

    try {
      await client.flush()
      for (const [insertId, stagedEvent] of staged) {
        this.#confirmed.set(insertId, stagedEvent.serialized)
      }
      return batchReceipt(targetFor(this.#config), events.length, 'succeeded', results)
    } catch {
      const unknownResults = results.map<PostHogEventExportResult>((result) =>
        result.status === 'submitted' || stagedDuplicateIndexes.has(result.index)
          ? {
              ...result,
              status: 'delivery_unknown',
            }
          : result,
      )
      return batchReceipt(targetFor(this.#config), events.length, 'failed', unknownResults)
    }
  }

  async #shutdown(): Promise<PostHogShutdownReceipt> {
    if (this.#closed) {
      return {
        schemaVersion: '1',
        status: 'already_shutdown',
        flushStatus: 'not_run',
        clientStatus: 'not_run',
      }
    }
    this.#closed = true

    if (!this.#config.enabled) {
      return {
        schemaVersion: '1',
        status: 'disabled',
        flushStatus: 'not_run',
        clientStatus: 'not_run',
      }
    }

    const client = this.#client
    if (client === undefined) {
      return {
        schemaVersion: '1',
        status: 'failed',
        flushStatus: 'not_run',
        clientStatus: 'not_run',
      }
    }

    let flushStatus: PostHogShutdownReceipt['flushStatus'] = 'succeeded'
    let clientStatus: PostHogShutdownReceipt['clientStatus'] = 'succeeded'
    try {
      await client.flush()
    } catch {
      flushStatus = 'failed'
    }

    try {
      await client.shutdown()
    } catch {
      clientStatus = 'failed'
    }

    return {
      schemaVersion: '1',
      status: flushStatus === 'succeeded' && clientStatus === 'succeeded' ? 'succeeded' : 'failed',
      flushStatus,
      clientStatus,
    }
  }
}

export interface CreatePostHogEvidenceExporterDependencies {
  readonly clientFactory?: PostHogClientFactory
}

export async function createPostHogEvidenceExporter(
  input: unknown = { enabled: false },
  dependencies: CreatePostHogEvidenceExporterDependencies = {},
): Promise<PostHogEvidenceExporter> {
  const config = parsePostHogExportConfig(input)
  if (!config.enabled) {
    return new ConfiguredPostHogEvidenceExporter(config)
  }

  const clientFactory = dependencies.clientFactory ?? defaultPostHogClientFactory
  let client: PostHogClientPort
  try {
    client = await clientFactory({
      host: POSTHOG_EXPORT_HOSTS[config.region],
      projectToken: config.projectToken,
      region: config.region,
    })
  } catch {
    throw new PostHogExportInitializationError()
  }
  return new ConfiguredPostHogEvidenceExporter(config, client)
}

export function createPostHogEvidenceExporterFromEnvironment(
  environment: PostHogExportEnvironment,
  dependencies: CreatePostHogEvidenceExporterDependencies = {},
): Promise<PostHogEvidenceExporter> {
  return createPostHogEvidenceExporter(parsePostHogExportEnvironment(environment), dependencies)
}

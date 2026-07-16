import type { JsonValue } from './canonical.js'
import { parseSafeEvidenceEvent, type SafeEvidenceEvent } from './contracts.js'
import { AnalyticsAliasSchema, type AnalyticsAlias, type StableInsertId } from './identifiers.js'
import { scrubForPublication, type RedactionReason } from './redaction.js'

const INTERNAL_CORRELATION_KEYS = new Set([
  '$ai_parent_id',
  '$ai_session_id',
  '$ai_span_id',
  '$ai_trace_id',
  'actor_alias',
  'attempt_alias',
  'browser_session_alias',
  'execution_alias',
  'mission_alias',
  'operation_alias',
  'organization_alias',
  'palace_alias',
  'plan_alias',
  'resource_alias',
  'run_alias',
])

export interface PublicEvidenceCorrelation {
  readonly mission?: AnalyticsAlias
  readonly run?: AnalyticsAlias
  readonly plan?: AnalyticsAlias
  readonly operation?: AnalyticsAlias
  readonly attempt?: AnalyticsAlias
  readonly resource?: AnalyticsAlias
  readonly execution?: AnalyticsAlias
  readonly aiSession?: AnalyticsAlias
  readonly aiTrace?: AnalyticsAlias
  readonly aiSpan?: AnalyticsAlias
  readonly aiParent?: AnalyticsAlias
}

export interface PublicEvidenceRecord {
  readonly schemaVersion: '1'
  readonly kind: 'ai' | 'product'
  readonly event: string
  readonly insertId: StableInsertId
  readonly occurredAt: string
  readonly correlation: PublicEvidenceCorrelation
  readonly properties: Readonly<Record<string, JsonValue>>
  readonly redactions: Partial<Record<RedactionReason, number>>
}

export interface PublicEvidenceBundle {
  readonly schemaVersion: '1'
  readonly recordCount: number
  readonly records: readonly PublicEvidenceRecord[]
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function aliasProperty(
  properties: Readonly<Record<string, unknown>>,
  key: string,
): AnalyticsAlias | undefined {
  const value = properties[key]
  const parsed = AnalyticsAliasSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function compactCorrelation(
  properties: Readonly<Record<string, unknown>>,
): PublicEvidenceCorrelation {
  const mission = aliasProperty(properties, 'mission_alias')
  const run = aliasProperty(properties, 'run_alias')
  const plan = aliasProperty(properties, 'plan_alias')
  const operation = aliasProperty(properties, 'operation_alias')
  const attempt = aliasProperty(properties, 'attempt_alias')
  const resource = aliasProperty(properties, 'resource_alias')
  const execution = aliasProperty(properties, 'execution_alias')
  const aiSession = aliasProperty(properties, '$ai_session_id')
  const aiTrace = aliasProperty(properties, '$ai_trace_id')
  const aiSpan = aliasProperty(properties, '$ai_span_id')
  const aiParent = aliasProperty(properties, '$ai_parent_id')

  return {
    ...(mission === undefined ? {} : { mission }),
    ...(run === undefined ? {} : { run }),
    ...(plan === undefined ? {} : { plan }),
    ...(operation === undefined ? {} : { operation }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(resource === undefined ? {} : { resource }),
    ...(execution === undefined ? {} : { execution }),
    ...(aiSession === undefined ? {} : { aiSession }),
    ...(aiTrace === undefined ? {} : { aiTrace }),
    ...(aiSpan === undefined ? {} : { aiSpan }),
    ...(aiParent === undefined ? {} : { aiParent }),
  }
}

function projectRecord(input: SafeEvidenceEvent): PublicEvidenceRecord {
  const event = parseSafeEvidenceEvent(input)
  const publicProperties = Object.fromEntries(
    Object.entries(event.properties).filter(([key]) => !INTERNAL_CORRELATION_KEYS.has(key)),
  )
  const scrubbed = scrubForPublication(publicProperties)
  if (
    scrubbed.value === null ||
    Array.isArray(scrubbed.value) ||
    typeof scrubbed.value !== 'object'
  ) {
    throw new Error('Public evidence properties must be a JSON object')
  }

  const redactions = Object.fromEntries(
    Object.entries(scrubbed.counts).filter(([, count]) => count > 0),
  ) as Partial<Record<RedactionReason, number>>

  return {
    schemaVersion: '1',
    kind: event.kind,
    event: event.event,
    insertId: event.insertId,
    occurredAt: event.occurredAt,
    correlation: compactCorrelation(event.properties),
    properties: scrubbed.value,
    redactions,
  }
}

export function projectPublicEvidence(events: readonly SafeEvidenceEvent[]): PublicEvidenceBundle {
  const records = events
    .map(projectRecord)
    .sort(
      (left, right) =>
        compareText(left.occurredAt, right.occurredAt) ||
        compareText(left.insertId, right.insertId),
    )

  return {
    schemaVersion: '1',
    recordCount: records.length,
    records,
  }
}

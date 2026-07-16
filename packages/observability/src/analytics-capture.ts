import type { JsonValue } from './canonical.js'
import {
  parseSafeEvidenceEvent,
  type ProductEventName,
  type SafeEvidenceEvent,
} from './contracts.js'
import type { AiEventName } from './contracts.js'
import type { AnalyticsAlias, StableInsertId } from './identifiers.js'
import { assertPublicationSafe } from './redaction.js'

export interface AnalyticsCapture {
  readonly distinctId: AnalyticsAlias
  readonly event: ProductEventName | AiEventName
  readonly timestamp: string
  readonly properties: Readonly<
    Record<string, JsonValue> & {
      $insert_id: StableInsertId
    }
  >
}

export function toAnalyticsCapture(input: SafeEvidenceEvent): AnalyticsCapture {
  const event = parseSafeEvidenceEvent(input)
  assertPublicationSafe(event.properties)
  return {
    distinctId: event.distinctId,
    event: event.event,
    timestamp: event.occurredAt,
    properties: {
      ...(event.properties as Record<string, JsonValue>),
      $insert_id: event.insertId,
    },
  }
}

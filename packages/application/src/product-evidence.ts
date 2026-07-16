import { EventIdSchema, hashToolValue, type OrganizationId } from '@trash-palace/core'
import { parseFrozenApplicationProductEvidenceEnvelope } from '@trash-palace/observability'
import type {
  CompleteApplicationProductObservation,
  FrozenApplicationProductEvidenceEnvelope,
  PrivateCorrelationInput,
  ProductEventName,
  RuntimeProductEventProperties,
} from '@trash-palace/observability'

import type { ObservabilityPort } from './observability.js'
import type { JsonValue } from './models.js'
import type { TenantRepositories } from './ports.js'

export interface ApplicationProductEvidenceInput<Name extends ProductEventName> {
  readonly event: Name
  readonly durableIdentity: JsonValue
  readonly occurredAt: string
  readonly correlation: PrivateCorrelationInput
  readonly properties: RuntimeProductEventProperties<Name>
}

/** Stable across delivery retries; distinct durable transitions must supply distinct identities. */
export function applicationProductEvidenceEventId<Name extends ProductEventName>(
  input: Pick<ApplicationProductEvidenceInput<Name>, 'durableIdentity' | 'event'>,
) {
  const digest = hashToolValue({
    schemaVersion: 'application-product-evidence-identity@1',
    event: input.event,
    durableIdentity: input.durableIdentity,
  })
  return EventIdSchema.parse(`evt_application_${digest.slice(0, 32)}`)
}

export function createApplicationProductObservation<Name extends ProductEventName>(
  input: ApplicationProductEvidenceInput<Name>,
): CompleteApplicationProductObservation {
  const outerCorrelation = {
    organizationId: input.correlation.organizationId,
    ...(input.correlation.missionId === undefined
      ? {}
      : { missionId: input.correlation.missionId }),
    ...(input.correlation.runId === undefined ? {} : { runId: input.correlation.runId }),
    ...(input.correlation.planId === undefined ? {} : { planId: input.correlation.planId }),
    ...(input.correlation.operationId === undefined
      ? {}
      : { operationId: input.correlation.operationId }),
    ...(input.correlation.attemptId === undefined
      ? {}
      : { attemptId: input.correlation.attemptId }),
  }
  return {
    name: 'evidence.product',
    occurredAt: input.occurredAt,
    correlation: outerCorrelation,
    evidence: {
      event: input.event,
      logicalEventId: applicationProductEvidenceEventId(input),
      occurredAt: input.occurredAt,
      correlation: input.correlation,
      properties: input.properties,
    },
  } as CompleteApplicationProductObservation
}

export type ProductEvidenceEnqueueResult =
  | Readonly<{ kind: 'enqueued'; envelope: FrozenApplicationProductEvidenceEnvelope }>
  | Readonly<{ kind: 'replayed'; envelope: FrozenApplicationProductEvidenceEnvelope }>

export interface ProductEvidenceDelivery {
  readonly organizationId: OrganizationId
  readonly envelope: FrozenApplicationProductEvidenceEnvelope
  readonly status: 'delivered' | 'pending'
  readonly createdAt: string
  readonly deliveredAt: string | null
  readonly captureStatus: 'duplicate' | 'stored' | null
}

export { parseFrozenApplicationProductEvidenceEnvelope }

/**
 * Freezes and stores evidence inside the transaction that owns the durable fact. A disabled
 * diagnostic-only observability port intentionally creates no delivery row.
 */
export async function enqueueApplicationProductEvidence<Name extends ProductEventName>(
  repositories: Pick<TenantRepositories, 'productEvidence'>,
  observability: ObservabilityPort,
  input: ApplicationProductEvidenceInput<Name>,
): Promise<ProductEvidenceEnqueueResult | null> {
  if (observability.freezeProduct === undefined) return null
  const missionId = input.correlation.missionId
  if (missionId === undefined) {
    throw new TypeError('Transactional application product evidence requires a mission binding')
  }
  const envelope = observability.freezeProduct(createApplicationProductObservation(input).evidence)
  return repositories.productEvidence.enqueue({ missionId, envelope })
}

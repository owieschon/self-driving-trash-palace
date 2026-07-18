import { createHash } from 'node:crypto'

import {
  AnalyticsSessionIdSchema,
  AttemptIdSchema,
  EventIdSchema,
  ExecutionIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OperationIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PlanIdSchema,
  RoutineIdSchema,
  RunIdSchema,
  Sha256Schema,
  UserIdSchema,
  type EventId,
  type Sha256,
} from '@trash-palace/core'
import { z } from 'zod'

import { canonicalJson, type JsonValue } from './canonical.js'
import {
  EvidenceEnvironmentSchema,
  EvidenceOriginSchema,
  correlationProperties,
  createProductEvidenceEvent,
  parseSafeEvidenceEvent,
  type ProductEventName,
  type ProductEventPropertiesByName,
  type ProductEvidenceInput,
  type SafeEvidenceEvent,
} from './contracts.js'
import { createAnalyticsCorrelation } from './identifiers.js'
import type { AnalyticsAliaser, PrivateCorrelationInput } from './identifiers.js'
import type { EvidenceCaptureResult, EvidenceSink } from './sink.js'

const DIAGNOSTIC_OBSERVATION_NAMES = new Set([
  'identity telemetry accepted',
  'mission.transitioned',
])

const SafeLabelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+~-]*$/)

const FeatureFlagsSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]{0,95}$/), z.union([z.boolean(), SafeLabelSchema]))
  .optional()

const PrivateCorrelationSchema = z
  .object({
    distinctId: UserIdSchema,
    organizationId: OrganizationIdSchema,
    actorId: UserIdSchema.optional(),
    palaceId: PalaceIdSchema.optional(),
    browserSessionId: AnalyticsSessionIdSchema.optional(),
    missionId: MissionIdSchema.optional(),
    runId: RunIdSchema.optional(),
    planId: PlanIdSchema.optional(),
    operationId: OperationIdSchema.optional(),
    attemptId: AttemptIdSchema.optional(),
    resourceId: RoutineIdSchema.optional(),
    executionId: ExecutionIdSchema.optional(),
  })
  .strict()

type GeneratedProductProperty =
  | 'schema_version'
  | 'environment'
  | 'data_origin'
  | 'privacy_classification'
  | 'app_version'
  | 'organization_alias'
  | 'actor_alias'
  | 'palace_alias'
  | 'browser_session_alias'
  | 'mission_alias'
  | 'run_alias'
  | 'plan_alias'
  | 'operation_alias'
  | 'attempt_alias'
  | 'resource_alias'
  | 'execution_alias'
  | 'feature_flags'

const GENERATED_PRODUCT_PROPERTIES = new Set<GeneratedProductProperty>([
  'schema_version',
  'environment',
  'data_origin',
  'privacy_classification',
  'app_version',
  'organization_alias',
  'actor_alias',
  'palace_alias',
  'browser_session_alias',
  'mission_alias',
  'run_alias',
  'plan_alias',
  'operation_alias',
  'attempt_alias',
  'resource_alias',
  'execution_alias',
  'feature_flags',
])

export type RuntimeProductEventProperties<Name extends ProductEventName> = Omit<
  ProductEventPropertiesByName[Name],
  GeneratedProductProperty
>

type RuntimeProductEvidenceInputMap = {
  [Name in ProductEventName]: Readonly<{
    event: Name
    logicalEventId: EventId
    occurredAt: string
    correlation: PrivateCorrelationInput
    properties: RuntimeProductEventProperties<Name>
  }>
}

/**
 * Private, application-facing input. The adapter owns aliasing, common properties, and insert IDs;
 * callers supply only a durable logical event identity and event-complete semantic properties.
 */
export type RuntimeProductEvidenceInput = RuntimeProductEvidenceInputMap[ProductEventName]

export interface ApplicationObservationCorrelation {
  readonly organizationId: string
  readonly missionId?: string
  readonly runId?: string
  readonly planId?: string
  readonly operationId?: string
  readonly attemptId?: string
}

export interface IncompleteApplicationObservation {
  readonly name: string
  readonly occurredAt: string
  readonly correlation: ApplicationObservationCorrelation
  readonly attributes?: Readonly<Record<string, boolean | number | string>>
}

/** This discriminant is the only application observation eligible for evidence projection. */
export interface CompleteApplicationProductObservation extends Omit<
  IncompleteApplicationObservation,
  'name'
> {
  readonly name: 'evidence.product'
  readonly evidence: RuntimeProductEvidenceInput
}

export interface ApplicationSpanLike {
  readonly name: string
  readonly kind: 'domain' | 'operation' | 'worker'
  readonly correlation: ApplicationObservationCorrelation
  readonly attributes?: Readonly<Record<string, boolean | number | string>>
}

export type RuntimeEvidenceDiagnostic = Readonly<{
  code: 'application_evidence_delivery_failed' | 'application_observation_not_event_complete'
  observationName: string
}>

export interface SafeApplicationEvidenceAdapterOptions {
  /** Omit in command processes. Only the worker projector owns an evidence sink. */
  readonly sink?: EvidenceSink
  readonly aliaser: AnalyticsAliaser
  readonly environment: z.output<typeof EvidenceEnvironmentSchema>
  readonly dataOrigin: z.output<typeof EvidenceOriginSchema>
  readonly appVersion: string
  readonly featureFlags?: Readonly<Record<string, boolean | string>>
  readonly onDiagnostic?: (diagnostic: RuntimeEvidenceDiagnostic) => void
}

export class UnsafeRuntimeEvidenceInputError extends Error {
  public override readonly name = 'UnsafeRuntimeEvidenceInputError'
}

export interface FrozenApplicationProductEvidenceEnvelope {
  readonly schemaVersion: 'application-product-evidence@1'
  readonly logicalEventId: EventId
  /** Hash of the event-complete application input, excluding runtime rendering configuration. */
  readonly semanticHash: Sha256
  /** Hash of the exact canonical event bytes retained for delivery. */
  readonly eventHash: Sha256
  readonly eventSerialized: string
  readonly event: SafeEvidenceEvent
}

export class EvidenceSinkNotConfiguredError extends Error {
  public override readonly name = 'EvidenceSinkNotConfiguredError'

  public constructor() {
    super('This application evidence adapter can freeze events but cannot deliver them')
  }
}

/**
 * Bridges application observability to the typed evidence registry without treating spans as
 * product outcomes. Incomplete observations intentionally produce no evidence.
 */
export class SafeApplicationEvidenceAdapter {
  readonly #sink: EvidenceSink | undefined
  readonly #aliaser: AnalyticsAliaser
  readonly #environment: z.output<typeof EvidenceEnvironmentSchema>
  readonly #dataOrigin: z.output<typeof EvidenceOriginSchema>
  readonly #appVersion: string
  readonly #featureFlags: Readonly<Record<string, boolean | string>> | undefined
  readonly #onDiagnostic: ((diagnostic: RuntimeEvidenceDiagnostic) => void) | undefined

  public constructor(options: SafeApplicationEvidenceAdapterOptions) {
    this.#sink = options.sink
    this.#aliaser = options.aliaser
    this.#environment = EvidenceEnvironmentSchema.parse(options.environment)
    this.#dataOrigin = EvidenceOriginSchema.parse(options.dataOrigin)
    this.#appVersion = SafeLabelSchema.parse(options.appVersion)
    this.#featureFlags = FeatureFlagsSchema.parse(options.featureFlags)
    this.#onDiagnostic = options.onDiagnostic
  }

  public trace<Result>(_span: ApplicationSpanLike, work: () => Promise<Result>): Promise<Result> {
    return work()
  }

  public async record(
    observation: IncompleteApplicationObservation | CompleteApplicationProductObservation,
  ): Promise<void> {
    if (!isCompleteProductObservation(observation)) {
      this.#diagnose(observation.name)
      return
    }
    assertObservationBinding(observation)
    const frozen = this.freezeProduct(observation.evidence)
    try {
      await this.captureFrozen(frozen)
    } catch {
      // The domain observation was valid and frozen. Delivery can retry elsewhere without
      // turning an analytics outage into a customer-facing failure.
      this.#diagnoseDeliveryFailure()
    }
  }

  public async captureProduct(input: RuntimeProductEvidenceInput): Promise<EvidenceCaptureResult> {
    return this.captureFrozen(this.freezeProduct(input))
  }

  /**
   * Freezes every byte-affecting setting before the owning database transaction commits.
   * Delivery must persist and replay this envelope instead of rendering the event again.
   */
  public freezeProduct(
    input: RuntimeProductEvidenceInput,
  ): FrozenApplicationProductEvidenceEnvelope {
    const logicalEventId = EventIdSchema.parse(input.logicalEventId)
    const occurredAt = IsoDateTimeSchema.parse(input.occurredAt)
    const privateCorrelation = parsePrivateCorrelation(input.correlation)
    assertSemanticProperties(input.properties)
    const correlation = createAnalyticsCorrelation(this.#aliaser, privateCorrelation)
    const semanticInput = {
      event: input.event,
      logicalEventId,
      occurredAt,
      correlation: privateCorrelation,
      properties: input.properties as Record<string, JsonValue>,
    } as const
    const event = createProductEvidenceEvent({
      event: input.event,
      insertId: this.#aliaser.insertId(input.event, logicalEventId),
      occurredAt,
      distinctId: correlation.distinctAlias,
      properties: {
        ...(input.properties as Record<string, JsonValue>),
        schema_version: '1',
        environment: this.#environment,
        data_origin: this.#dataOrigin,
        privacy_classification: 'analytics_safe',
        app_version: this.#appVersion,
        ...correlationProperties(correlation),
        ...(this.#featureFlags === undefined ? {} : { feature_flags: this.#featureFlags }),
      },
    } as ProductEvidenceInput<ProductEventName>) as SafeEvidenceEvent
    const eventSerialized = canonicalJson(event as unknown as JsonValue)
    return {
      schemaVersion: 'application-product-evidence@1',
      logicalEventId,
      semanticHash: sha256Canonical(semanticInput as unknown as JsonValue),
      eventHash: sha256Text(eventSerialized),
      eventSerialized,
      event,
    }
  }

  /** Delivers a previously frozen event without consulting current adapter configuration. */
  public async captureFrozen(
    input: FrozenApplicationProductEvidenceEnvelope,
  ): Promise<EvidenceCaptureResult> {
    if (this.#sink === undefined) throw new EvidenceSinkNotConfiguredError()
    const envelope = parseFrozenApplicationProductEvidenceEnvelope(input)
    return this.#sink.capture(envelope.event)
  }

  public aliasConfigurationFingerprint(): string {
    return this.#aliaser.configurationFingerprint()
  }

  #diagnose(name: string): void {
    this.#onDiagnostic?.({
      code: 'application_observation_not_event_complete',
      observationName: safeDiagnosticName(name),
    })
  }

  #diagnoseDeliveryFailure(): void {
    this.#onDiagnostic?.({
      code: 'application_evidence_delivery_failed',
      observationName: 'evidence.product',
    })
  }
}

export function parseFrozenApplicationProductEvidenceEnvelope(
  raw: unknown,
): FrozenApplicationProductEvidenceEnvelope {
  const input = FrozenApplicationProductEvidenceEnvelopeInputSchema.parse(raw)
  const semanticHash = input.semanticHash
  const eventHash = input.eventHash
  const logicalEventId = EventIdSchema.parse(input.logicalEventId)
  const event = parseSafeEvidenceEvent(input.event)
  const eventSerialized = canonicalJson(event as unknown as JsonValue)
  if (input.eventSerialized !== eventSerialized || sha256Text(eventSerialized) !== eventHash) {
    throw new UnsafeRuntimeEvidenceInputError(
      'Application evidence event bytes do not match their immutable hash',
    )
  }
  return {
    schemaVersion: 'application-product-evidence@1',
    logicalEventId,
    semanticHash,
    eventHash,
    eventSerialized,
    event,
  }
}

const FrozenApplicationProductEvidenceEnvelopeInputSchema = z
  .object({
    schemaVersion: z.literal('application-product-evidence@1'),
    logicalEventId: EventIdSchema,
    semanticHash: Sha256Schema,
    eventHash: Sha256Schema,
    eventSerialized: z.string(),
    event: z.unknown(),
  })
  .strict()

function sha256Text(value: string): Sha256 {
  return Sha256Schema.parse(createHash('sha256').update(value, 'utf8').digest('hex'))
}

function sha256Canonical(value: JsonValue): Sha256 {
  return sha256Text(canonicalJson(value))
}

function isCompleteProductObservation(
  observation: IncompleteApplicationObservation | CompleteApplicationProductObservation,
): observation is CompleteApplicationProductObservation {
  return observation.name === 'evidence.product' && 'evidence' in observation
}

function assertObservationBinding(observation: CompleteApplicationProductObservation): void {
  const evidence = observation.evidence
  if (
    observation.occurredAt !== evidence.occurredAt ||
    observation.correlation.organizationId !== evidence.correlation.organizationId ||
    !sameOptional(observation.correlation.missionId, evidence.correlation.missionId) ||
    !sameOptional(observation.correlation.runId, evidence.correlation.runId) ||
    !sameOptional(observation.correlation.planId, evidence.correlation.planId) ||
    !sameOptional(observation.correlation.operationId, evidence.correlation.operationId) ||
    !sameOptional(observation.correlation.attemptId, evidence.correlation.attemptId)
  ) {
    throw new UnsafeRuntimeEvidenceInputError(
      'Application observation and evidence correlation must describe the same durable event',
    )
  }
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || left === right
}

function assertSemanticProperties(properties: object): void {
  for (const key of Object.keys(properties)) {
    if (GENERATED_PRODUCT_PROPERTIES.has(key as GeneratedProductProperty)) {
      throw new UnsafeRuntimeEvidenceInputError(
        'Application evidence cannot override adapter-generated properties',
      )
    }
  }
}

function safeDiagnosticName(name: string): string {
  return DIAGNOSTIC_OBSERVATION_NAMES.has(name) ? name : 'unrecognized'
}

function parsePrivateCorrelation(input: PrivateCorrelationInput): PrivateCorrelationInput {
  const parsed = PrivateCorrelationSchema.parse(input)
  return {
    distinctId: parsed.distinctId,
    organizationId: parsed.organizationId,
    ...(parsed.actorId === undefined ? {} : { actorId: parsed.actorId }),
    ...(parsed.palaceId === undefined ? {} : { palaceId: parsed.palaceId }),
    ...(parsed.browserSessionId === undefined ? {} : { browserSessionId: parsed.browserSessionId }),
    ...(parsed.missionId === undefined ? {} : { missionId: parsed.missionId }),
    ...(parsed.runId === undefined ? {} : { runId: parsed.runId }),
    ...(parsed.planId === undefined ? {} : { planId: parsed.planId }),
    ...(parsed.operationId === undefined ? {} : { operationId: parsed.operationId }),
    ...(parsed.attemptId === undefined ? {} : { attemptId: parsed.attemptId }),
    ...(parsed.resourceId === undefined ? {} : { resourceId: parsed.resourceId }),
    ...(parsed.executionId === undefined ? {} : { executionId: parsed.executionId }),
  }
}

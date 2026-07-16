import { z } from 'zod'
import { createHash } from 'node:crypto'

import {
  AttemptTransportSchema,
  CARETAKER_BUDGETS,
  ReplaceHomecomingRoutineActionSchema,
  ReplaceScheduledHaulerAccessRoutineActionSchema,
  RestoreRoutineVersionActionSchema,
} from '@trash-palace/core'
import {
  AnalyticsAliasSchema,
  StableInsertIdSchema,
  type AnalyticsAlias,
  type AnalyticsCorrelation,
  type StableInsertId,
} from './identifiers.js'
import { canonicalJson, type JsonValue } from './canonical.js'

export const EvidenceEnvironmentSchema = z.enum(['test', 'local', 'hosted_demo', 'evaluation'])
export const EvidenceOriginSchema = z.enum(['fixture', 'live', 'evaluation'])
export const PrivacyClassificationSchema = z.literal('analytics_safe')

const SafeLabelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+~-]*$/)
const SafeEventCodeSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_.-]*$/)
const SafeToolNameSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_.-]*$/)
const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const CountSchema = z.number().int().nonnegative()
const DurationMillisecondsSchema = z.number().nonnegative()
const DurationSecondsSchema = z.number().nonnegative()
const CostSchema = z.number().nonnegative()
const IsoTimestampSchema = z.iso.datetime({ offset: true })
const FlagVariantSchema = z.union([z.boolean(), SafeLabelSchema])
const FeatureFlagsSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]{0,95}$/), FlagVariantSchema)
  .optional()

const MAX_CARETAKER_GENERATIONS_PER_RUN = CARETAKER_BUDGETS.maxToolCallsPerRun * 3 + 16
const ERROR_SPAN_STATUSES = new Set(['conflict', 'unknown', 'failed'])
const CODED_SPAN_STATUSES = new Set(['denied', ...ERROR_SPAN_STATUSES])

const CommonProductPropertiesSchema = z
  .object({
    schema_version: z.literal('1'),
    environment: EvidenceEnvironmentSchema,
    data_origin: EvidenceOriginSchema,
    privacy_classification: PrivacyClassificationSchema,
    app_version: SafeLabelSchema,
    organization_alias: AnalyticsAliasSchema,
    actor_alias: AnalyticsAliasSchema.optional(),
    palace_alias: AnalyticsAliasSchema.optional(),
    browser_session_alias: AnalyticsAliasSchema.optional(),
    mission_alias: AnalyticsAliasSchema.optional(),
    run_alias: AnalyticsAliasSchema.optional(),
    plan_alias: AnalyticsAliasSchema.optional(),
    operation_alias: AnalyticsAliasSchema.optional(),
    attempt_alias: AnalyticsAliasSchema.optional(),
    resource_alias: AnalyticsAliasSchema.optional(),
    execution_alias: AnalyticsAliasSchema.optional(),
    context_manifest_hash: ContentHashSchema.optional(),
    tool_registry_hash: ContentHashSchema.optional(),
    feature_flags: FeatureFlagsSchema,
  })
  .strict()

const MissionProductPropertiesSchema = CommonProductPropertiesSchema.extend({
  mission_alias: AnalyticsAliasSchema,
}).strict()

const ProductEventPropertySchemas = {
  'mission created': MissionProductPropertiesSchema.extend({
    source_surface: z.enum(['control_room', 'mission_workspace', 'api', 'mcp', 'fixture']),
    objective_class: z.enum(['homecoming_routine', 'scheduled_hauler_access']),
  }).strict(),
  'clarification requested': MissionProductPropertiesSchema.extend({
    clarification_reason: z.enum(['safety', 'feasibility', 'preference_conflict']),
    question_count: CountSchema.min(1),
  }).strict(),
  'plan proposed': MissionProductPropertiesSchema.extend({
    plan_alias: AnalyticsAliasSchema,
    plan_revision: CountSchema.min(1),
    action_count: CountSchema,
    context_source_count: CountSchema,
  }).strict(),
  'plan simulated': MissionProductPropertiesSchema.extend({
    plan_alias: AnalyticsAliasSchema,
    plan_revision: CountSchema.min(1),
    scenario_count: CountSchema.min(1),
    failed_scenario_count: CountSchema,
    passed: z.boolean(),
  }).strict(),
  'plan approved': MissionProductPropertiesSchema.extend({
    plan_alias: AnalyticsAliasSchema,
    plan_revision: CountSchema.min(1),
    approval_surface: z.enum(['mission_workspace', 'api']),
  }).strict(),
  'operation requested': MissionProductPropertiesSchema.extend({
    operation_alias: AnalyticsAliasSchema,
    operation_kind: z.union([
      ReplaceHomecomingRoutineActionSchema.shape.type,
      ReplaceScheduledHaulerAccessRoutineActionSchema.shape.type,
      RestoreRoutineVersionActionSchema.shape.type,
    ]),
  }).strict(),
  'operation outcome unknown': MissionProductPropertiesSchema.extend({
    operation_alias: AnalyticsAliasSchema,
    attempt_alias: AnalyticsAliasSchema,
    attempt_transport: AttemptTransportSchema,
    unknown_reason: z.enum([
      'timeout',
      'connection_lost',
      'callback_missing',
      'worker_restart',
      'malformed_result',
    ]),
    attempt_count: CountSchema.min(1),
    reconciliation_budget_ms: DurationMillisecondsSchema,
    retryable: z.literal(true),
  }).strict(),
  'operation reconciled': MissionProductPropertiesSchema.extend({
    operation_alias: AnalyticsAliasSchema,
    resolution: z.enum(['committed', 'absent_retrying', 'still_unknown', 'failed']),
    attempt_count: CountSchema.min(1),
    duration_ms: DurationMillisecondsSchema,
  }).strict(),
  'routine activated': MissionProductPropertiesSchema.extend({
    operation_alias: AnalyticsAliasSchema,
    resource_alias: AnalyticsAliasSchema,
    routine_version: CountSchema.min(1),
    activation_source: z.enum(['manual', 'mission_lease']),
  }).strict(),
  'execution observed': MissionProductPropertiesSchema.extend({
    execution_alias: AnalyticsAliasSchema,
    gateway_status: z.enum(['accepted', 'committed', 'rejected', 'unknown']),
    evidence_count: CountSchema,
  }).strict(),
  'execution verified': MissionProductPropertiesSchema.extend({
    execution_alias: AnalyticsAliasSchema,
    passed: z.boolean(),
    assertion_count: CountSchema.min(1),
    failed_assertion_count: CountSchema,
  }).strict(),
  'mission completed': MissionProductPropertiesSchema.extend({
    duration_ms: DurationMillisecondsSchema,
    tool_call_count: CountSchema,
    reconciliation_count: CountSchema,
  }).strict(),
  'mission failed': MissionProductPropertiesSchema.extend({
    failure_class: z.enum([
      'authorization',
      'policy',
      'validation',
      'model',
      'tool',
      'gateway',
      'verification',
      'budget',
      'unknown',
    ]),
    phase: z.enum([
      'understand',
      'plan',
      'validate',
      'approve',
      'execute',
      'reconcile',
      'observe',
      'verify',
    ]),
    retryable: z.boolean(),
  }).strict(),
  'mission cancelled': MissionProductPropertiesSchema.extend({
    phase: z.enum([
      'understand',
      'plan',
      'validate',
      'approve',
      'execute',
      'reconcile',
      'observe',
      'verify',
    ]),
    cancellation_source: z.enum(['user', 'system', 'budget']),
  }).strict(),
  'agent overridden': MissionProductPropertiesSchema.extend({
    override_kind: z.enum(['plan_edited', 'plan_rejected', 'manual_correction']),
    field_class: z.enum(['trigger', 'condition', 'action', 'constraint', 'rollback', 'other']),
    material: z.boolean(),
  }).strict(),
  'guide completed': CommonProductPropertiesSchema.extend({
    guide_slug: SafeEventCodeSchema,
    executable_steps_completed: CountSchema,
  }).strict(),
  'assessment submitted': CommonProductPropertiesSchema.extend({
    assessment_slug: SafeEventCodeSchema,
    item_count: CountSchema.min(1),
    correct_count: CountSchema,
    response_recording_consented: z.boolean(),
  }).strict(),
} as const

export const PRODUCT_EVENT_NAMES = Object.freeze(
  Object.keys(ProductEventPropertySchemas) as (keyof typeof ProductEventPropertySchemas)[],
)
export const ProductEventNameSchema = z.enum(PRODUCT_EVENT_NAMES)
export type ProductEventName = z.infer<typeof ProductEventNameSchema>

export type ProductEventPropertiesByName = {
  [Name in ProductEventName]: z.infer<(typeof ProductEventPropertySchemas)[Name]>
}

const CommonAiPropertiesSchema = z
  .object({
    schema_version: z.literal('1'),
    environment: EvidenceEnvironmentSchema,
    data_origin: EvidenceOriginSchema,
    privacy_classification: PrivacyClassificationSchema,
    app_version: SafeLabelSchema,
    organization_alias: AnalyticsAliasSchema,
    palace_alias: AnalyticsAliasSchema.optional(),
    mission_alias: AnalyticsAliasSchema,
    run_alias: AnalyticsAliasSchema,
    operation_alias: AnalyticsAliasSchema.optional(),
    attempt_alias: AnalyticsAliasSchema.optional(),
    context_manifest_hash: ContentHashSchema.optional(),
    tool_registry_hash: ContentHashSchema.optional(),
    model_config_version: SafeLabelSchema.optional(),
    harness_version: SafeLabelSchema.optional(),
    feature_flags: FeatureFlagsSchema,
    $ai_session_id: AnalyticsAliasSchema,
    $ai_trace_id: AnalyticsAliasSchema,
  })
  .strict()

const AiEventPropertySchemas = {
  $ai_generation: CommonAiPropertiesSchema.extend({
    $ai_span_id: AnalyticsAliasSchema,
    $ai_parent_id: AnalyticsAliasSchema.optional(),
    $ai_span_name: SafeEventCodeSchema,
    $ai_model: SafeLabelSchema,
    $ai_provider: SafeLabelSchema,
    $ai_input_tokens: CountSchema,
    $ai_output_tokens: CountSchema,
    $ai_cache_read_input_tokens: CountSchema.optional(),
    $ai_cache_creation_input_tokens: CountSchema.optional(),
    cache_token_counts_exclusive: z.boolean().optional(),
    $ai_latency: DurationSecondsSchema,
    sdk_duration_seconds: DurationSecondsSchema.optional(),
    $ai_time_to_first_token: DurationSecondsSchema.optional(),
    $ai_stream: z.boolean(),
    $ai_http_status: z.number().int().min(100).max(599).optional(),
    $ai_total_cost_usd: CostSchema.optional(),
    $ai_is_error: z.boolean(),
    $ai_stop_reason: SafeLabelSchema.optional(),
    error_code: SafeEventCodeSchema.optional(),
    input_redaction_count: CountSchema,
    output_redaction_count: CountSchema,
    completion_claim: z.enum(['none', 'verifier_receipt_available', 'safe_stop']),
  })
    .strict()
    .superRefine((generation, context) => {
      if (generation.$ai_is_error !== (generation.error_code !== undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['error_code'],
          message: 'Generation error state and error code must agree',
        })
      }
      if (generation.$ai_is_error && generation.completion_claim !== 'none') {
        context.addIssue({
          code: 'custom',
          path: ['completion_claim'],
          message: 'A failed generation cannot carry a completion claim',
        })
      }
      const cacheFields = [
        generation.$ai_cache_read_input_tokens,
        generation.$ai_cache_creation_input_tokens,
      ]
      if (
        generation.cache_token_counts_exclusive !== undefined &&
        cacheFields.every((value) => value === undefined)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['cache_token_counts_exclusive'],
          message: 'Cache reporting semantics require at least one cache-token count',
        })
      }
    }),
  $ai_span: CommonAiPropertiesSchema.extend({
    $ai_span_id: AnalyticsAliasSchema,
    $ai_parent_id: AnalyticsAliasSchema.optional(),
    $ai_span_name: SafeEventCodeSchema,
    $ai_latency: DurationSecondsSchema,
    $ai_is_error: z.boolean(),
    span_kind: z.enum([
      'context',
      'retrieval',
      'tool',
      'api',
      'simulation',
      'reconciliation',
      'verification',
      'other',
    ]),
    tool_name: SafeToolNameSchema.optional(),
    status: z.enum(['succeeded', 'pending', 'denied', 'conflict', 'unknown', 'failed']),
    error_code: SafeEventCodeSchema.optional(),
  })
    .strict()
    .superRefine((span, context) => {
      const isErrorStatus = ERROR_SPAN_STATUSES.has(span.status)
      if (span.$ai_is_error !== isErrorStatus) {
        context.addIssue({
          code: 'custom',
          path: ['$ai_is_error'],
          message: 'Span error state must agree with its status',
        })
      }
      if (CODED_SPAN_STATUSES.has(span.status) !== (span.error_code !== undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['error_code'],
          message: 'A denied, conflicting, unknown, or failed span requires one error code',
        })
      }
    }),
  $ai_trace: CommonAiPropertiesSchema.extend({
    $ai_span_name: SafeEventCodeSchema,
    $ai_latency: DurationSecondsSchema,
    $ai_is_error: z.boolean(),
    outcome: z.enum([
      'waiting_for_user',
      'waiting_for_system',
      'verified',
      'safe_refusal',
      'failed',
      'cancelled',
      'unknown',
    ]),
    generation_count: CountSchema.max(MAX_CARETAKER_GENERATIONS_PER_RUN),
    tool_call_count: CountSchema.max(CARETAKER_BUDGETS.maxToolCallsPerRun),
    plan_revision_count: CountSchema.max(CARETAKER_BUDGETS.maxPlanRevisions),
    clarification_pause_count: CountSchema.max(CARETAKER_BUDGETS.maxClarificationPauses),
    reconciliation_poll_count: CountSchema.max(CARETAKER_BUDGETS.maxReconciliationPolls),
    active_runtime_ms: DurationMillisecondsSchema.max(
      CARETAKER_BUDGETS.maxActiveRuntimeSeconds * 1_000,
    ),
    budget_exhausted: z.boolean(),
    pause_reason: z
      .enum(['approval', 'budget', 'clarification', 'human_review', 'system'])
      .optional(),
    error_code: SafeEventCodeSchema.optional(),
  })
    .strict()
    .superRefine((trace, context) => {
      const isErrorOutcome = trace.outcome === 'failed' || trace.outcome === 'unknown'
      if (trace.$ai_is_error !== isErrorOutcome) {
        context.addIssue({
          code: 'custom',
          path: ['$ai_is_error'],
          message: 'Trace error state must agree with its outcome',
        })
      }
      if (isErrorOutcome !== (trace.error_code !== undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['error_code'],
          message: 'A failed or unknown trace requires one error code',
        })
      }
      const waiting = trace.outcome === 'waiting_for_user' || trace.outcome === 'waiting_for_system'
      if (waiting !== (trace.pause_reason !== undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['pause_reason'],
          message: 'Only a waiting trace carries a pause reason',
        })
      }
      if (trace.outcome === 'waiting_for_system' && trace.pause_reason !== 'system') {
        context.addIssue({
          code: 'custom',
          path: ['pause_reason'],
          message: 'A system wait requires the system pause reason',
        })
      }
      if (trace.outcome === 'waiting_for_user' && trace.pause_reason === 'system') {
        context.addIssue({
          code: 'custom',
          path: ['pause_reason'],
          message: 'A user wait cannot carry the system pause reason',
        })
      }
      if (trace.budget_exhausted !== (trace.pause_reason === 'budget')) {
        context.addIssue({
          code: 'custom',
          path: ['budget_exhausted'],
          message: 'Budget exhaustion requires and is required by a budget pause',
        })
      }
    }),
} as const

export const AI_EVENT_NAMES = Object.freeze(
  Object.keys(AiEventPropertySchemas) as (keyof typeof AiEventPropertySchemas)[],
)
export const AiEventNameSchema = z.enum(AI_EVENT_NAMES)
export type AiEventName = z.infer<typeof AiEventNameSchema>

type AiEventPropertiesByName = {
  [Name in AiEventName]: z.infer<(typeof AiEventPropertySchemas)[Name]>
}

interface EvidenceEnvelope {
  readonly insertId: StableInsertId
  readonly occurredAt: string
  readonly distinctId: AnalyticsAlias
  readonly privacy: 'analytics_safe'
}

type ProductEvidenceEventMap = {
  [Name in ProductEventName]: EvidenceEnvelope & {
    readonly kind: 'product'
    readonly event: Name
    readonly properties: ProductEventPropertiesByName[Name]
  }
}

type AiEvidenceEventMap = {
  [Name in AiEventName]: EvidenceEnvelope & {
    readonly kind: 'ai'
    readonly event: Name
    readonly properties: AiEventPropertiesByName[Name]
  }
}

export type ProductEvidenceEvent = ProductEvidenceEventMap[ProductEventName]
export type AiEvidenceEvent = AiEvidenceEventMap[AiEventName]
export type SafeEvidenceEvent = ProductEvidenceEvent | AiEvidenceEvent

export type ProductEvidenceInput<Name extends ProductEventName> = Omit<
  ProductEvidenceEventMap[Name],
  'kind' | 'privacy'
>
export type AiEvidenceInput<Name extends AiEventName> = Omit<
  AiEvidenceEventMap[Name],
  'kind' | 'privacy'
>

const EnvelopeInputSchema = z
  .object({
    insertId: StableInsertIdSchema,
    occurredAt: IsoTimestampSchema,
    distinctId: AnalyticsAliasSchema,
  })
  .strict()

const StoredEnvelopeSchema = EnvelopeInputSchema.extend({
  kind: z.enum(['product', 'ai']),
  event: z.string(),
  privacy: PrivacyClassificationSchema,
  properties: z.unknown(),
}).strict()

export function createProductEvidenceEvent<Name extends ProductEventName>(
  input: ProductEvidenceInput<Name>,
): ProductEvidenceEventMap[Name] {
  const envelope = EnvelopeInputSchema.parse({
    insertId: input.insertId,
    occurredAt: input.occurredAt,
    distinctId: input.distinctId,
  })
  const properties = ProductEventPropertySchemas[input.event].parse(input.properties)
  return {
    ...envelope,
    kind: 'product',
    event: input.event,
    privacy: 'analytics_safe',
    properties,
  } as ProductEvidenceEventMap[Name]
}

export function createAiEvidenceEvent<Name extends AiEventName>(
  input: AiEvidenceInput<Name>,
): AiEvidenceEventMap[Name] {
  const envelope = EnvelopeInputSchema.parse({
    insertId: input.insertId,
    occurredAt: input.occurredAt,
    distinctId: input.distinctId,
  })
  const properties = AiEventPropertySchemas[input.event].parse(input.properties)
  if (properties.mission_alias !== properties.$ai_session_id) {
    throw new Error('AI session and mission aliases must identify the same mission')
  }
  if (properties.run_alias !== properties.$ai_trace_id) {
    throw new Error('AI trace and run aliases must identify the same run')
  }
  return {
    ...envelope,
    kind: 'ai',
    event: input.event,
    privacy: 'analytics_safe',
    properties,
  } as AiEvidenceEventMap[Name]
}

export function parseSafeEvidenceEvent(input: unknown): SafeEvidenceEvent {
  const envelope = StoredEnvelopeSchema.parse(input)
  if (envelope.kind === 'product') {
    const event = ProductEventNameSchema.parse(envelope.event)
    return createProductEvidenceEvent({
      insertId: envelope.insertId,
      occurredAt: envelope.occurredAt,
      distinctId: envelope.distinctId,
      event,
      properties: ProductEventPropertySchemas[event].parse(envelope.properties),
    })
  }

  const event = AiEventNameSchema.parse(envelope.event)
  return createAiEvidenceEvent({
    insertId: envelope.insertId,
    occurredAt: envelope.occurredAt,
    distinctId: envelope.distinctId,
    event,
    properties: AiEventPropertySchemas[event].parse(envelope.properties),
  })
}

type PropertyAllowlist = Readonly<Record<ProductEventName | AiEventName, readonly string[]>>

export const EVENT_PROPERTY_ALLOWLISTS: PropertyAllowlist = Object.freeze(
  Object.fromEntries(
    [...PRODUCT_EVENT_NAMES, ...AI_EVENT_NAMES].map((event) => {
      const schema =
        event in ProductEventPropertySchemas
          ? ProductEventPropertySchemas[event as ProductEventName]
          : AiEventPropertySchemas[event as AiEventName]
      return [event, Object.freeze(Object.keys(schema.shape).sort())]
    }),
  ) as Record<ProductEventName | AiEventName, readonly string[]>,
)

export function allowedPropertiesFor(event: ProductEventName | AiEventName): readonly string[] {
  return EVENT_PROPERTY_ALLOWLISTS[event]
}

export interface EvidenceEventSchemaProjection {
  readonly schemaVersion: 'evidence-event-contract@1'
  readonly event: ProductEventName | AiEventName
  readonly category: 'product' | 'ai'
  readonly propertySchema: JsonValue
  readonly propertySchemaHash: string
  readonly allowedProperties: readonly string[]
}

function hashEvidenceContract(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function projectEvidenceEventRegistry(): EvidenceEventSchemaProjection[] {
  return [...PRODUCT_EVENT_NAMES, ...AI_EVENT_NAMES].sort().map((event) => {
    const isProduct = event in ProductEventPropertySchemas
    const schema = isProduct
      ? ProductEventPropertySchemas[event as ProductEventName]
      : AiEventPropertySchemas[event as AiEventName]
    const propertySchema = z.json().parse(z.toJSONSchema(schema))
    return {
      schemaVersion: 'evidence-event-contract@1',
      event,
      category: isProduct ? 'product' : 'ai',
      propertySchema,
      propertySchemaHash: hashEvidenceContract(propertySchema),
      allowedProperties: [...EVENT_PROPERTY_ALLOWLISTS[event]],
    }
  })
}

export const EVIDENCE_EVENT_SCHEMA_PROJECTIONS = Object.freeze(projectEvidenceEventRegistry())
export const EVIDENCE_EVENT_REGISTRY_HASH = hashEvidenceContract(
  EVIDENCE_EVENT_SCHEMA_PROJECTIONS as unknown as JsonValue,
)

export function correlationProperties(correlation: AnalyticsCorrelation): {
  organization_alias: AnalyticsAlias
  actor_alias?: AnalyticsAlias
  palace_alias?: AnalyticsAlias
  browser_session_alias?: AnalyticsAlias
  mission_alias?: AnalyticsAlias
  run_alias?: AnalyticsAlias
  plan_alias?: AnalyticsAlias
  operation_alias?: AnalyticsAlias
  attempt_alias?: AnalyticsAlias
  resource_alias?: AnalyticsAlias
  execution_alias?: AnalyticsAlias
} {
  return {
    organization_alias: correlation.organizationAlias,
    ...(correlation.actorAlias === undefined ? {} : { actor_alias: correlation.actorAlias }),
    ...(correlation.palaceAlias === undefined ? {} : { palace_alias: correlation.palaceAlias }),
    ...(correlation.browserSessionAlias === undefined
      ? {}
      : { browser_session_alias: correlation.browserSessionAlias }),
    ...(correlation.missionAlias === undefined ? {} : { mission_alias: correlation.missionAlias }),
    ...(correlation.runAlias === undefined ? {} : { run_alias: correlation.runAlias }),
    ...(correlation.planAlias === undefined ? {} : { plan_alias: correlation.planAlias }),
    ...(correlation.operationAlias === undefined
      ? {}
      : { operation_alias: correlation.operationAlias }),
    ...(correlation.attemptAlias === undefined ? {} : { attempt_alias: correlation.attemptAlias }),
    ...(correlation.resourceAlias === undefined
      ? {}
      : { resource_alias: correlation.resourceAlias }),
    ...(correlation.executionAlias === undefined
      ? {}
      : { execution_alias: correlation.executionAlias }),
  }
}

export function aiCorrelationProperties(correlation: AnalyticsCorrelation): {
  $ai_session_id: AnalyticsAlias
  $ai_trace_id: AnalyticsAlias
  mission_alias: AnalyticsAlias
  run_alias: AnalyticsAlias
} {
  if (correlation.missionAlias === undefined || correlation.runAlias === undefined) {
    throw new Error('AI evidence requires mission and run correlation aliases')
  }

  return {
    $ai_session_id: correlation.missionAlias,
    $ai_trace_id: correlation.runAlias,
    mission_alias: correlation.missionAlias,
    run_alias: correlation.runAlias,
  }
}

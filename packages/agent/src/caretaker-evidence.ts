import { createHash } from 'node:crypto'

import {
  CaretakerRunCountersSchema,
  type SystemCaretakerEvidenceDeliveryPort,
} from '@trash-palace/application'
import {
  EventIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  RunIdSchema,
  Sha256Schema,
  TOOL_REGISTRY_HASH,
  ToolNameSchema,
  UserIdSchema,
  type ToolName,
} from '@trash-palace/core'
import {
  EvidenceEnvironmentSchema,
  EvidenceOriginSchema,
  EVIDENCE_EVENT_REGISTRY_HASH,
  CARETAKER_EVIDENCE_RENDERER_VERSION,
  aiCorrelationProperties,
  createAiEvidenceEvent,
  createCaretakerEvidenceProfile,
  createCaretakerTerminalEvidenceEnvelope,
  hashCaretakerEvidenceByteConfiguration,
  CaretakerEvidenceProfileSchema,
  type AiEvidenceEvent,
  type AnalyticsAlias,
  type AnalyticsAliaser,
  type AnalyticsCorrelation,
  type EvidenceCaptureResult,
  type EvidenceSink,
  type CaretakerEvidenceProfile,
  type CaretakerEvidenceByteConfiguration,
  type CaretakerTerminalEvidenceEnvelope,
} from '@trash-palace/observability'
import { z } from 'zod'

import {
  CaretakerDecisionObservationSchema,
  type CaretakerDecisionObservation,
} from './decision-engine.js'

const SafeEventCodeSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_.-]*$/)

const SafeLabelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+~-]*$/)

const FeatureFlagsSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]{0,95}$/), z.union([z.boolean(), SafeLabelSchema]))
  .optional()

const NonnegativeIntegerSchema = z.number().int().nonnegative()
const NonnegativeNumberSchema = z.number().nonnegative()

const EvidenceStatusSchema = z.enum([
  'succeeded',
  'pending',
  'denied',
  'conflict',
  'unknown',
  'failed',
])

const CodedEvidenceStatuses = new Set(['denied', 'conflict', 'unknown', 'failed'])
const ErrorEvidenceStatuses = new Set(['conflict', 'unknown', 'failed'])

const CommonSpanInputSchema = z
  .object({
    identity: SafeLabelSchema,
    contextManifestHash: Sha256Schema,
    occurredAt: IsoDateTimeSchema,
    latencyMilliseconds: NonnegativeNumberSchema,
    status: EvidenceStatusSchema,
    errorCode: SafeEventCodeSchema.optional(),
  })
  .strict()
  .superRefine((span, context) => {
    if (CodedEvidenceStatuses.has(span.status) !== (span.errorCode !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'Denied, conflicting, unknown, or failed evidence requires one safe code',
      })
    }
  })

const GenerationEvidenceInputSchema = z
  .object({
    identity: SafeLabelSchema,
    contextManifestHash: Sha256Schema,
    occurredAt: IsoDateTimeSchema,
    model: SafeLabelSchema,
    provider: SafeLabelSchema,
    inputTokens: NonnegativeIntegerSchema,
    outputTokens: NonnegativeIntegerSchema,
    cacheReadInputTokens: NonnegativeIntegerSchema.optional(),
    cacheCreationInputTokens: NonnegativeIntegerSchema.optional(),
    cacheReportingExclusive: z.boolean().optional(),
    latencyMilliseconds: NonnegativeNumberSchema,
    sdkDurationMilliseconds: NonnegativeNumberSchema.optional(),
    timeToFirstTokenMilliseconds: NonnegativeNumberSchema.optional(),
    streamed: z.boolean(),
    totalCostUsd: NonnegativeNumberSchema.optional(),
    stopReason: SafeLabelSchema.optional(),
    isError: z.boolean(),
    errorCode: SafeEventCodeSchema.optional(),
    inputRedactionCount: NonnegativeIntegerSchema,
    outputRedactionCount: NonnegativeIntegerSchema,
    completionClaim: z.enum(['none', 'verifier_receipt_available', 'safe_stop']),
  })
  .strict()
  .superRefine((generation, context) => {
    if (generation.isError !== (generation.errorCode !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'Generation error state and error code must agree',
      })
    }
    if (generation.isError && generation.completionClaim !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['completionClaim'],
        message: 'A failed generation cannot carry a completion claim',
      })
    }
    if (
      generation.cacheReportingExclusive !== undefined &&
      generation.cacheReadInputTokens === undefined &&
      generation.cacheCreationInputTokens === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['cacheReportingExclusive'],
        message: 'Cache reporting semantics require a cache-token count',
      })
    }
  })

const TraceOutcomeSchema = z.enum([
  'waiting_for_user',
  'waiting_for_system',
  'verified',
  'safe_refusal',
  'failed',
  'cancelled',
  'unknown',
])

const TraceEvidenceInputSchema = z
  .object({
    contextManifestHash: Sha256Schema,
    completedAt: IsoDateTimeSchema,
    outcome: TraceOutcomeSchema,
    counters: CaretakerRunCountersSchema,
    budgetExhausted: z.boolean(),
    pauseReason: z
      .enum(['approval', 'budget', 'clarification', 'human_review', 'system'])
      .optional(),
    errorCode: SafeEventCodeSchema.optional(),
  })
  .strict()
  .superRefine((trace, context) => {
    const errorOutcome = trace.outcome === 'failed' || trace.outcome === 'unknown'
    if (errorOutcome !== (trace.errorCode !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'A failed or unknown trace requires one safe error code',
      })
    }
    const waiting = trace.outcome === 'waiting_for_user' || trace.outcome === 'waiting_for_system'
    if (waiting !== (trace.pauseReason !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['pauseReason'],
        message: 'Only a waiting trace carries a pause reason',
      })
    }
    if (trace.outcome === 'waiting_for_system' && trace.pauseReason !== 'system') {
      context.addIssue({
        code: 'custom',
        path: ['pauseReason'],
        message: 'A system wait requires the system pause reason',
      })
    }
    if (trace.outcome === 'waiting_for_user' && trace.pauseReason === 'system') {
      context.addIssue({
        code: 'custom',
        path: ['pauseReason'],
        message: 'A user wait cannot carry the system pause reason',
      })
    }
    if (trace.budgetExhausted !== (trace.pauseReason === 'budget')) {
      context.addIssue({
        code: 'custom',
        path: ['budgetExhausted'],
        message: 'Budget exhaustion requires and is required by a budget pause',
      })
    }
  })

export interface CaretakerEvidenceRecorderConfig {
  readonly sink: EvidenceSink
  readonly deliveries: SystemCaretakerEvidenceDeliveryPort
  readonly aliaser: AnalyticsAliaser
  readonly environment: z.input<typeof EvidenceEnvironmentSchema>
  readonly dataOrigin: z.input<typeof EvidenceOriginSchema>
  readonly appVersion: string
  readonly harnessVersion: string
  readonly modelConfigVersion: string
  readonly featureFlags?: Readonly<Record<string, boolean | string>>
  readonly deliveredAt?: () => Date
}

export interface CaretakerRunEvidenceInput {
  readonly runId: string
  readonly activatedAt: string
  readonly organizationId: string
  readonly actorId: string
  readonly palaceId: string
  readonly missionId: string
  readonly contextManifestHash: string
}

export interface FrozenCaretakerRunEvidenceInput {
  readonly runId: string
  readonly profile: CaretakerEvidenceProfile
  readonly activatedAt: string
}

export type CaretakerTraceOutcome = z.output<typeof TraceOutcomeSchema>
export type CaretakerEvidenceStatus = z.output<typeof EvidenceStatusSchema>
export type CaretakerGenerationEvidenceInput = z.input<typeof GenerationEvidenceInputSchema>
export type CaretakerTraceEvidenceInput = z.input<typeof TraceEvidenceInputSchema>

export interface CaretakerSpanEvidenceInput {
  readonly identity: string
  readonly contextManifestHash: string
  readonly occurredAt: string
  readonly latencyMilliseconds: number
  readonly status: CaretakerEvidenceStatus
  readonly errorCode?: string
}

export interface CaretakerDecisionObservationEvidenceInput {
  readonly observation: CaretakerDecisionObservation
  readonly contextManifestHash: string
  readonly occurredAt: string
  readonly measuredLatencyMilliseconds: number
}

type CommonAiProperties = ReturnType<typeof aiCorrelationProperties> & {
  readonly schema_version: '1'
  readonly environment: z.output<typeof EvidenceEnvironmentSchema>
  readonly data_origin: z.output<typeof EvidenceOriginSchema>
  readonly privacy_classification: 'analytics_safe'
  readonly app_version: string
  readonly organization_alias: AnalyticsAlias
  readonly palace_alias: AnalyticsAlias
  readonly tool_registry_hash: typeof TOOL_REGISTRY_HASH
  readonly model_config_version: string
  readonly harness_version: string
  readonly feature_flags?: Readonly<Record<string, boolean | string>>
}

function logicalEventId(runId: string, event: string, identity: string) {
  const digest = createHash('sha256')
    .update(`caretaker-evidence@2\0${runId}\0${event}\0${identity}`, 'utf8')
    .digest('hex')
  return EventIdSchema.parse(`evt_${digest.slice(0, 40)}`)
}

function millisecondsToSeconds(value: number): number {
  return NonnegativeNumberSchema.parse(value) / 1_000
}

function elapsedMilliseconds(start: string, end: string): number {
  const elapsed = Date.parse(end) - Date.parse(start)
  if (elapsed < 0) throw new Error('Evidence completion cannot precede its start')
  return elapsed
}

/** Projects immutable run evidence into one privacy-safe PostHog trace hierarchy. */
export class CaretakerRunEvidence {
  readonly #runId: ReturnType<typeof RunIdSchema.parse>
  readonly #activatedAt: string
  readonly #common: Omit<CommonAiProperties, 'context_manifest_hash'>
  readonly #correlation: AnalyticsCorrelation
  readonly #contextManifestHash: ReturnType<typeof Sha256Schema.parse>

  public constructor(
    private readonly config: CaretakerEvidenceRecorderConfig,
    input: FrozenCaretakerRunEvidenceInput,
  ) {
    const profile = CaretakerEvidenceProfileSchema.parse(input.profile)
    this.#runId = RunIdSchema.parse(input.runId)
    this.#activatedAt = IsoDateTimeSchema.parse(input.activatedAt)
    this.#contextManifestHash = profile.contextManifestHash
    const configuration = profile.configuration
    const aliases = profile.correlationAliases

    this.#correlation = {
      distinctAlias: aliases.distinctAlias,
      organizationAlias: aliases.organizationAlias,
      actorAlias: aliases.initiatorAlias,
      palaceAlias: aliases.palaceAlias,
      missionAlias: aliases.missionAlias,
      runAlias: aliases.runAlias,
    }
    this.#common = {
      schema_version: '1',
      environment: configuration.environment,
      data_origin: configuration.dataOrigin,
      privacy_classification: 'analytics_safe',
      app_version: configuration.appVersion,
      organization_alias: aliases.organizationAlias,
      palace_alias: aliases.palaceAlias,
      tool_registry_hash: TOOL_REGISTRY_HASH,
      model_config_version: configuration.modelConfigVersion,
      harness_version: configuration.harnessVersion,
      ...(configuration.featureFlags === undefined
        ? {}
        : { feature_flags: configuration.featureFlags }),
      ...aiCorrelationProperties(this.#correlation),
    }
  }

  public recordContext(input: CaretakerSpanEvidenceInput): Promise<EvidenceCaptureResult> {
    return this.#captureSpan(input, {
      eventIdentity: `context:${input.identity}`,
      spanName: 'caretaker.context',
      spanKind: 'context',
    })
  }

  public recordDecision(input: CaretakerSpanEvidenceInput): Promise<EvidenceCaptureResult> {
    return this.#captureSpan(input, {
      eventIdentity: `decision:${input.identity}`,
      spanName: 'caretaker.decision',
      spanKind: 'other',
    })
  }

  /** Maps a validated decision-engine observation to the matching PostHog AI event shape. */
  public recordDecisionObservation(
    input: CaretakerDecisionObservationEvidenceInput,
  ): Promise<EvidenceCaptureResult> {
    const observation = CaretakerDecisionObservationSchema.parse(input.observation)
    if (observation.kind === 'model_generation') {
      return this.recordGeneration({
        identity: observation.attemptId,
        contextManifestHash: input.contextManifestHash,
        occurredAt: input.occurredAt,
        model: observation.model,
        provider: observation.provider,
        inputTokens: observation.inputTokens,
        outputTokens: observation.outputTokens,
        cacheReadInputTokens: observation.cacheReadInputTokens,
        cacheCreationInputTokens: observation.cacheCreationInputTokens,
        cacheReportingExclusive: observation.cacheReportingExclusive,
        // PostHog's Claude Agent SDK integration defines generation latency as API duration.
        latencyMilliseconds: observation.apiDurationMilliseconds,
        sdkDurationMilliseconds: observation.durationMilliseconds,
        ...(observation.timeToFirstTokenMilliseconds === undefined
          ? {}
          : { timeToFirstTokenMilliseconds: observation.timeToFirstTokenMilliseconds }),
        streamed: observation.streamed,
        totalCostUsd: observation.totalCostUsd,
        ...(observation.stopReason === null ? {} : { stopReason: observation.stopReason }),
        isError: observation.status === 'failed',
        ...(observation.failureCode === null ? {} : { errorCode: observation.failureCode }),
        inputRedactionCount: 0,
        outputRedactionCount: 0,
        completionClaim: 'none',
      })
    }

    const failed = observation.kind === 'adapter_failure' || observation.status === 'failed'
    const errorCode = observation.failureCode
    return this.recordDecision({
      identity: observation.attemptId,
      contextManifestHash: input.contextManifestHash,
      occurredAt: input.occurredAt,
      latencyMilliseconds: input.measuredLatencyMilliseconds,
      status: failed ? 'failed' : 'succeeded',
      ...(errorCode === null ? {} : { errorCode }),
    })
  }

  public recordTool(
    input: CaretakerSpanEvidenceInput & { readonly toolName: ToolName },
  ): Promise<EvidenceCaptureResult> {
    const { toolName: toolNameInput, ...spanInput } = input
    const toolName = ToolNameSchema.parse(toolNameInput)
    const spanKind =
      toolName === 'knowledge.search'
        ? 'retrieval'
        : toolName === 'plans.simulate'
          ? 'simulation'
          : toolName === 'operations.get'
            ? 'reconciliation'
            : toolName === 'verification.get_evidence'
              ? 'verification'
              : 'tool'
    return this.#captureSpan(spanInput, {
      eventIdentity: `tool:${input.identity}`,
      spanName:
        spanKind === 'retrieval'
          ? 'caretaker.retrieval'
          : spanKind === 'simulation'
            ? 'caretaker.simulation'
            : spanKind === 'reconciliation'
              ? 'caretaker.reconcile'
              : spanKind === 'verification'
                ? 'caretaker.verification'
                : 'caretaker.tool',
      spanKind,
      toolName,
    })
  }

  public recordVerification(input: CaretakerSpanEvidenceInput): Promise<EvidenceCaptureResult> {
    return this.#captureSpan(input, {
      eventIdentity: `verification:${input.identity}`,
      spanName: 'caretaker.verification',
      spanKind: 'verification',
    })
  }

  public recordGeneration(
    inputValue: CaretakerGenerationEvidenceInput,
  ): Promise<EvidenceCaptureResult> {
    const input = GenerationEvidenceInputSchema.parse(inputValue)
    const event = '$ai_generation' as const
    const identity = `generation:${input.identity}`
    const contextManifestHash = this.#pinContextManifest(input.contextManifestHash)
    this.#assertRunTimestamp(input.occurredAt)
    return this.config.sink.capture(
      createAiEvidenceEvent({
        event,
        insertId: this.config.aliaser.insertId(event, logicalEventId(this.#runId, event, identity)),
        occurredAt: input.occurredAt,
        distinctId: this.#correlation.distinctAlias,
        properties: {
          ...this.#common,
          context_manifest_hash: contextManifestHash,
          $ai_span_id: this.#spanAlias(identity),
          $ai_parent_id: this.#correlation.runAlias,
          $ai_span_name: 'caretaker.decision',
          $ai_model: input.model,
          $ai_provider: input.provider,
          $ai_input_tokens: input.inputTokens,
          $ai_output_tokens: input.outputTokens,
          ...(input.cacheReadInputTokens === undefined
            ? {}
            : { $ai_cache_read_input_tokens: input.cacheReadInputTokens }),
          ...(input.cacheCreationInputTokens === undefined
            ? {}
            : { $ai_cache_creation_input_tokens: input.cacheCreationInputTokens }),
          ...(input.cacheReportingExclusive === undefined
            ? {}
            : { cache_token_counts_exclusive: input.cacheReportingExclusive }),
          $ai_latency: millisecondsToSeconds(input.latencyMilliseconds),
          ...(input.sdkDurationMilliseconds === undefined
            ? {}
            : { sdk_duration_seconds: millisecondsToSeconds(input.sdkDurationMilliseconds) }),
          ...(input.timeToFirstTokenMilliseconds === undefined
            ? {}
            : {
                $ai_time_to_first_token: millisecondsToSeconds(input.timeToFirstTokenMilliseconds),
              }),
          $ai_stream: input.streamed,
          ...(input.totalCostUsd === undefined ? {} : { $ai_total_cost_usd: input.totalCostUsd }),
          ...(input.stopReason === undefined ? {} : { $ai_stop_reason: input.stopReason }),
          $ai_is_error: input.isError,
          ...(input.errorCode === undefined ? {} : { error_code: input.errorCode }),
          input_redaction_count: input.inputRedactionCount,
          output_redaction_count: input.outputRedactionCount,
          completion_claim: input.completionClaim,
        },
      }),
    )
  }

  public async finish(inputValue: CaretakerTraceEvidenceInput): Promise<EvidenceCaptureResult> {
    return this.config.sink.capture(await this.buildTerminalEvent(inputValue))
  }

  public async buildTerminalEvent(
    inputValue: CaretakerTraceEvidenceInput,
  ): Promise<AiEvidenceEvent> {
    const input = TraceEvidenceInputSchema.parse(inputValue)
    const event = '$ai_trace' as const
    const contextManifestHash = this.#pinContextManifest(input.contextManifestHash)
    const traceAlias = this.#correlation.runAlias
    if (traceAlias === undefined) throw new Error('Caretaker run evidence requires a run alias')
    const retained = await this.config.sink.all()
    const generationCount = retained.filter(
      (candidate): candidate is Extract<AiEvidenceEvent, { event: '$ai_generation' }> =>
        candidate.kind === 'ai' &&
        candidate.event === '$ai_generation' &&
        candidate.properties.$ai_trace_id === traceAlias,
    ).length
    const isError = input.outcome === 'failed' || input.outcome === 'unknown'
    return createAiEvidenceEvent({
      event,
      insertId: this.config.aliaser.insertId(event, logicalEventId(this.#runId, event, 'run')),
      occurredAt: this.#activatedAt,
      distinctId: this.#correlation.distinctAlias,
      properties: {
        ...this.#common,
        context_manifest_hash: contextManifestHash,
        $ai_span_name: 'caretaker.run',
        $ai_latency: millisecondsToSeconds(
          elapsedMilliseconds(this.#activatedAt, input.completedAt),
        ),
        $ai_is_error: isError,
        outcome: input.outcome,
        generation_count: generationCount,
        tool_call_count: input.counters.toolCallCount,
        plan_revision_count: input.counters.planRevisionCount,
        clarification_pause_count: input.counters.clarificationPauseCount,
        reconciliation_poll_count: input.counters.reconciliationPollCount,
        active_runtime_ms: input.counters.activeRuntimeMilliseconds,
        budget_exhausted: input.budgetExhausted,
        ...(input.pauseReason === undefined ? {} : { pause_reason: input.pauseReason }),
        ...(input.errorCode === undefined ? {} : { error_code: input.errorCode }),
      },
    })
  }

  #captureSpan(
    inputValue: CaretakerSpanEvidenceInput,
    shape: Readonly<{
      eventIdentity: string
      spanName: string
      spanKind:
        | 'context'
        | 'retrieval'
        | 'tool'
        | 'api'
        | 'simulation'
        | 'reconciliation'
        | 'verification'
        | 'other'
      toolName?: ToolName
    }>,
  ): Promise<EvidenceCaptureResult> {
    const input = CommonSpanInputSchema.parse(inputValue)
    const event = '$ai_span' as const
    const contextManifestHash = this.#pinContextManifest(input.contextManifestHash)
    this.#assertRunTimestamp(input.occurredAt)
    return this.config.sink.capture(
      createAiEvidenceEvent({
        event,
        insertId: this.config.aliaser.insertId(
          event,
          logicalEventId(this.#runId, event, shape.eventIdentity),
        ),
        occurredAt: input.occurredAt,
        distinctId: this.#correlation.distinctAlias,
        properties: {
          ...this.#common,
          context_manifest_hash: contextManifestHash,
          $ai_span_id: this.#spanAlias(shape.eventIdentity),
          $ai_parent_id: this.#correlation.runAlias,
          $ai_span_name: SafeEventCodeSchema.parse(shape.spanName),
          $ai_latency: millisecondsToSeconds(input.latencyMilliseconds),
          $ai_is_error: ErrorEvidenceStatuses.has(input.status),
          span_kind: shape.spanKind,
          ...(shape.toolName === undefined ? {} : { tool_name: shape.toolName }),
          status: input.status,
          ...(input.errorCode === undefined ? {} : { error_code: input.errorCode }),
        },
      }),
    )
  }

  #pinContextManifest(value: string): ReturnType<typeof Sha256Schema.parse> {
    const hash = Sha256Schema.parse(value)
    if (this.#contextManifestHash !== hash) {
      throw new Error('Caretaker run evidence cannot change its frozen context manifest')
    }
    return hash
  }

  #assertRunTimestamp(value: string): void {
    const occurredAt = IsoDateTimeSchema.parse(value)
    if (Date.parse(occurredAt) < Date.parse(this.#activatedAt)) {
      throw new Error('Caretaker child evidence cannot precede its run')
    }
  }

  #spanAlias(identity: string): AnalyticsAlias {
    return this.config.aliaser.alias('span', `${this.#runId}:${identity}`)
  }
}

export class CaretakerEvidenceRecorder {
  public constructor(private readonly config: CaretakerEvidenceRecorderConfig) {}

  #byteConfiguration(): CaretakerEvidenceByteConfiguration {
    const environment = EvidenceEnvironmentSchema.parse(this.config.environment)
    const dataOrigin = EvidenceOriginSchema.parse(this.config.dataOrigin)
    const featureFlags = FeatureFlagsSchema.parse(this.config.featureFlags)
    const canonicalFlags =
      featureFlags === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(featureFlags).sort(([left], [right]) => left.localeCompare(right)),
          )
    return {
      rendererVersion: CARETAKER_EVIDENCE_RENDERER_VERSION,
      aliasConfigurationFingerprint: Sha256Schema.parse(
        this.config.aliaser.configurationFingerprint(),
      ),
      environment,
      dataOrigin,
      appVersion: SafeLabelSchema.parse(this.config.appVersion),
      harnessVersion: SafeLabelSchema.parse(this.config.harnessVersion),
      modelConfigVersion: SafeLabelSchema.parse(this.config.modelConfigVersion),
      toolRegistryHash: TOOL_REGISTRY_HASH,
      evidenceEventRegistryHash: EVIDENCE_EVENT_REGISTRY_HASH,
      ...(canonicalFlags === undefined ? {} : { featureFlags: canonicalFlags }),
    }
  }

  /** Returns a non-secret commitment to every setting that can change retained event bytes. */
  public configurationHash(): ReturnType<typeof Sha256Schema.parse> {
    return hashCaretakerEvidenceByteConfiguration(this.#byteConfiguration())
  }

  /** Freezes run-specific aliases and byte-affecting settings without retaining private IDs. */
  public profile(inputValue: CaretakerRunEvidenceInput): CaretakerEvidenceProfile {
    const input = {
      runId: RunIdSchema.parse(inputValue.runId),
      organizationId: OrganizationIdSchema.parse(inputValue.organizationId),
      actorId: UserIdSchema.parse(inputValue.actorId),
      palaceId: PalaceIdSchema.parse(inputValue.palaceId),
      missionId: MissionIdSchema.parse(inputValue.missionId),
      contextManifestHash: Sha256Schema.parse(inputValue.contextManifestHash),
    }
    const configuration = this.#byteConfiguration()
    return createCaretakerEvidenceProfile({
      schemaVersion: 'caretaker-evidence-profile@1',
      configuration,
      configurationHash: hashCaretakerEvidenceByteConfiguration(configuration),
      contextManifestHash: input.contextManifestHash,
      correlationAliases: {
        distinctAlias: this.config.aliaser.alias('person', input.actorId),
        organizationAlias: this.config.aliaser.alias('organization', input.organizationId),
        initiatorAlias: this.config.aliaser.alias('actor', input.actorId),
        palaceAlias: this.config.aliaser.alias('palace', input.palaceId),
        missionAlias: this.config.aliaser.alias('mission', input.missionId),
        runAlias: this.config.aliaser.alias('run', input.runId),
      },
    })
  }

  public assertCompatibleProfile(input: CaretakerEvidenceProfile): CaretakerEvidenceProfile {
    const profile = CaretakerEvidenceProfileSchema.parse(input)
    if (profile.configurationHash !== this.configurationHash()) {
      throw new Error('Caretaker evidence configuration changed during a durable run')
    }
    return profile
  }

  public begin(
    input: FrozenCaretakerRunEvidenceInput | CaretakerRunEvidenceInput,
  ): CaretakerRunEvidence {
    if (!('profile' in input)) {
      return new CaretakerRunEvidence(this.config, {
        runId: input.runId,
        activatedAt: input.activatedAt,
        profile: this.profile(input),
      })
    }
    return new CaretakerRunEvidence(this.config, {
      ...input,
      profile: this.assertCompatibleProfile(input.profile),
    })
  }

  public async terminalEnvelope(
    input: FrozenCaretakerRunEvidenceInput & CaretakerTraceEvidenceInput,
  ): Promise<CaretakerTerminalEvidenceEnvelope> {
    const { profile, runId, activatedAt, ...trace } = input
    const event = await this.begin({ profile, runId, activatedAt }).buildTerminalEvent(trace)
    return createCaretakerTerminalEvidenceEnvelope(event)
  }

  /** Delivers and acknowledges an immutable envelope without consulting a mission lease. */
  public async deliverTerminal(runIdValue: string): Promise<'already_delivered' | 'delivered'> {
    const runId = RunIdSchema.parse(runIdValue)
    const delivery = await this.config.deliveries.get(runId)
    if (delivery === null) throw new Error('Caretaker terminal evidence handoff is absent')
    if (delivery.status === 'delivered') return 'already_delivered'
    const captured = z
      .object({ insertId: z.string().min(1), status: z.enum(['stored', 'duplicate']) })
      .strict()
      .parse(await this.config.sink.capture(delivery.envelope.event))
    if (captured.insertId !== delivery.envelope.event.insertId) {
      throw new Error('Evidence sink returned an invalid Caretaker terminal acknowledgement')
    }
    const deliveredAt = (this.config.deliveredAt?.() ?? new Date()).toISOString()
    await this.config.deliveries.acknowledge({
      runId,
      eventHash: delivery.envelope.eventHash,
      captureStatus: captured.status,
      deliveredAt,
    })
    return 'delivered'
  }

  public async deliverPending(limit = 100): Promise<number> {
    const pending = await this.config.deliveries.listPending(limit)
    for (const delivery of pending) await this.deliverTerminal(delivery.runId)
    return pending.length
  }
}

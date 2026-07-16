import { z } from 'zod'

import { MissionStateSchema } from './missions.js'

export const GATEWAY_FAULT_DURABLE_OUTCOME_SCHEMA_VERSION =
  'gateway-fault-durable-outcome@1' as const
export const GATEWAY_FAULT_OBSERVATION_POINT = 'post_preheat_callback_ingested' as const

export const GatewayFaultProfileNameSchema = z.enum([
  'none',
  'delayed_callback',
  'device_offline',
  'stale_state',
  'duplicate_callback',
  'lost_ack',
  'response_timeout',
])

export type GatewayFaultProfileName = z.infer<typeof GatewayFaultProfileNameSchema>

export const CanonicalGatewayFaultInjectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('delayed_callback'),
      delayVirtualMilliseconds: z.literal(4_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('device_offline'),
      offlineForVirtualMilliseconds: z.literal(30_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stale_state'),
      staleByVirtualMilliseconds: z.literal(10_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('duplicate_callback'),
      copies: z.literal(2),
      separationVirtualMilliseconds: z.literal(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('lost_ack'),
      callbackDelayVirtualMilliseconds: z.literal(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal('response_timeout'),
      callbackDelayVirtualMilliseconds: z.literal(5_000),
    })
    .strict(),
])

export type CanonicalGatewayFaultInjection = z.infer<typeof CanonicalGatewayFaultInjectionSchema>

const AttemptExpectationSchema = z
  .object({
    sequence: z.number().int().positive(),
    transport: z.enum(['mcp', 'gateway']),
    status: z.enum(['succeeded', 'unknown', 'failed']),
    retryable: z.boolean(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
      .nullable(),
  })
  .strict()

const OutboxTopicExpectationSchema = z
  .object({
    count: z.number().int().nonnegative(),
    statuses: z.array(z.enum(['pending', 'claimed', 'dispatched', 'cancelled'])),
  })
  .strict()
  .superRefine((expectation, context) => {
    if (expectation.statuses.length !== expectation.count) {
      context.addIssue({
        code: 'custom',
        path: ['statuses'],
        message: 'Outbox status count must equal the declared row count',
      })
    }
  })

const DurableOutboxExpectationSchema = z
  .object({
    totalCount: z.number().int().nonnegative(),
    operationReconcile: OutboxTopicExpectationSchema,
    gatewayDispatch: OutboxTopicExpectationSchema,
    gatewayEffectReconcile: OutboxTopicExpectationSchema,
    executionDeadline: OutboxTopicExpectationSchema,
    missionVerify: OutboxTopicExpectationSchema,
    missionResume: OutboxTopicExpectationSchema,
  })
  .strict()
  .superRefine((outbox, context) => {
    const topicCount =
      outbox.operationReconcile.count +
      outbox.gatewayDispatch.count +
      outbox.gatewayEffectReconcile.count +
      outbox.executionDeadline.count +
      outbox.missionVerify.count +
      outbox.missionResume.count
    if (topicCount !== outbox.totalCount) {
      context.addIssue({
        code: 'custom',
        path: ['totalCount'],
        message: 'Outbox total must equal the sum of every canonical topic expectation',
      })
    }
  })

const GatewayFaultDurableStateSchema = z
  .object({
    mission: z
      .object({
        state: MissionStateSchema,
        terminal: z.literal(false),
      })
      .strict(),
    verification: z
      .object({
        presence: z.literal('absent'),
        count: z.literal(0),
        status: z.null(),
        assertionCount: z.literal(0),
        reason: z.literal('not_run_at_observation_point'),
      })
      .strict(),
    routines: z
      .object({
        operationOutcomeCount: z.literal(1),
        replacementRoutineCount: z.literal(1),
        activeReplacementCount: z.literal(1),
        inactiveProtectedCount: z.literal(1),
        duplicateDurableOutcomeCount: z.literal(0),
      })
      .strict(),
    effect: z
      .object({
        materializedCount: z.literal(1),
        milestone: z.literal('preheat'),
        status: z.enum(['completed', 'failed']),
        dispatchStatus: z.enum(['accepted', 'unknown', 'failed']),
        dispatchUnknownReason: z.enum(['lost_ack', 'timeout']).nullable(),
        dispatchErrorCode: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
          .nullable(),
        persistedEvidenceCount: z.union([z.literal(1), z.literal(3)]),
      })
      .strict(),
    attempts: z
      .object({
        totalCount: z.literal(2),
        activationTransport: AttemptExpectationSchema,
        gatewayTransport: AttemptExpectationSchema,
      })
      .strict(),
    generation: z
      .object({
        totalCount: z.literal(1),
        current: z.literal(1),
        currentStatus: z.enum(['accepted', 'unknown', 'failed']),
      })
      .strict(),
    callback: z
      .object({
        deliveredCount: z.number().int().positive(),
        persistedUniqueCount: z.literal(1),
        duplicateDeliveryCount: z.number().int().nonnegative(),
        terminalStatus: z.enum(['completed', 'failed']),
        ingestionResults: z.array(z.enum(['stored', 'duplicate', 'replayed'])).min(1),
      })
      .strict(),
    outbox: DurableOutboxExpectationSchema,
  })
  .strict()

export const GatewayFaultDurableOutcomeManifestSchema = z
  .object({
    schemaVersion: z.literal(GATEWAY_FAULT_DURABLE_OUTCOME_SCHEMA_VERSION),
    id: z.string().regex(/^gateway-fault-[a-z][a-z0-9_-]+-post-preheat@1$/),
    fixtureId: z.literal('night-shift-homecoming@1'),
    observationPoint: z.literal(GATEWAY_FAULT_OBSERVATION_POINT),
    faultProfile: GatewayFaultProfileNameSchema,
    injection: CanonicalGatewayFaultInjectionSchema,
    recoverability: z
      .object({
        scope: z.literal('current_preheat_gateway_effect'),
        classification: z.enum(['not_applicable', 'recoverable', 'unrecoverable_within_execution']),
        outcomeAtObservationPoint: z.enum([
          'completed_without_fault',
          'recovered',
          'completed_with_stale_evidence',
          'terminal_effect_failure',
        ]),
        mechanism: z.enum([
          'normal_delivery',
          'bounded_delayed_callback',
          'terminal_failure_callback',
          'stale_evidence_retained_for_verification',
          'duplicate_callback_deduplicated',
          'signed_terminal_callback_after_unknown_dispatch',
        ]),
      })
      .strict(),
    terminalOutcome: z
      .object({
        expected: z.null(),
        reason: z.literal('checkpoint_precedes_deterministic_verification'),
      })
      .strict(),
    expectedDurableState: GatewayFaultDurableStateSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const expectedId = `gateway-fault-${manifest.faultProfile}-post-preheat@1`
    if (manifest.id !== expectedId) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'Gateway fault manifest ID must derive from its profile and checkpoint',
      })
    }
    if (manifest.injection.kind !== manifest.faultProfile) {
      context.addIssue({
        code: 'custom',
        path: ['injection', 'kind'],
        message: 'Gateway fault injection must match the declared profile',
      })
    }

    const expectedRecovery = {
      none: ['not_applicable', 'completed_without_fault', 'normal_delivery'],
      delayed_callback: ['recoverable', 'recovered', 'bounded_delayed_callback'],
      device_offline: [
        'unrecoverable_within_execution',
        'terminal_effect_failure',
        'terminal_failure_callback',
      ],
      stale_state: [
        'recoverable',
        'completed_with_stale_evidence',
        'stale_evidence_retained_for_verification',
      ],
      duplicate_callback: ['recoverable', 'recovered', 'duplicate_callback_deduplicated'],
      lost_ack: ['recoverable', 'recovered', 'signed_terminal_callback_after_unknown_dispatch'],
      response_timeout: [
        'recoverable',
        'recovered',
        'signed_terminal_callback_after_unknown_dispatch',
      ],
    } as const
    const recovery = expectedRecovery[manifest.faultProfile]
    if (
      manifest.recoverability.classification !== recovery[0] ||
      manifest.recoverability.outcomeAtObservationPoint !== recovery[1] ||
      manifest.recoverability.mechanism !== recovery[2]
    ) {
      context.addIssue({
        code: 'custom',
        path: ['recoverability'],
        message: 'Recoverability must match the versioned profile outcome at this checkpoint',
      })
    }

    const state = manifest.expectedDurableState
    if (
      state.attempts.activationTransport.sequence !== 1 ||
      state.attempts.activationTransport.transport !== 'mcp' ||
      state.attempts.activationTransport.status !== 'unknown' ||
      !state.attempts.activationTransport.retryable ||
      state.attempts.activationTransport.errorCode !== 'TOOL_RESPONSE_LOST'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedDurableState', 'attempts', 'activationTransport'],
        message: 'Every gateway profile begins after the same lost activation response',
      })
    }
    if (
      state.attempts.gatewayTransport.sequence !== 2 ||
      state.attempts.gatewayTransport.transport !== 'gateway'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedDurableState', 'attempts', 'gatewayTransport'],
        message: 'The preheat gateway attempt is the second operation attempt',
      })
    }
    if (state.generation.currentStatus !== state.effect.dispatchStatus) {
      context.addIssue({
        code: 'custom',
        path: ['expectedDurableState', 'generation', 'currentStatus'],
        message: 'Current dispatch generation status must match the durable effect dispatch',
      })
    }
    if (
      state.callback.ingestionResults.length !== state.callback.deliveredCount ||
      state.callback.duplicateDeliveryCount !==
        state.callback.deliveredCount - state.callback.persistedUniqueCount
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedDurableState', 'callback'],
        message: 'Callback delivery, ingestion, and deduplication counts must reconcile',
      })
    }
    if (
      state.outbox.operationReconcile.count !== 1 ||
      state.outbox.gatewayDispatch.count !== 1 ||
      state.outbox.executionDeadline.count !== 1 ||
      state.outbox.missionResume.count !== 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedDurableState', 'outbox'],
        message: 'The checkpoint requires its common operation, dispatch, and deadline messages',
      })
    }

    const deviceOffline = manifest.faultProfile === 'device_offline'
    const unknownDispatch =
      manifest.faultProfile === 'lost_ack' || manifest.faultProfile === 'response_timeout'
    const duplicateCallback = manifest.faultProfile === 'duplicate_callback'

    if (deviceOffline) {
      if (
        manifest.recoverability.classification !== 'unrecoverable_within_execution' ||
        manifest.recoverability.outcomeAtObservationPoint !== 'terminal_effect_failure' ||
        state.effect.status !== 'failed' ||
        state.effect.dispatchStatus !== 'failed' ||
        state.effect.dispatchErrorCode !== 'DEVICE_OFFLINE' ||
        state.effect.dispatchUnknownReason !== null ||
        state.effect.persistedEvidenceCount !== 1 ||
        state.attempts.gatewayTransport.status !== 'failed' ||
        !state.attempts.gatewayTransport.retryable ||
        state.attempts.gatewayTransport.errorCode !== 'DEVICE_OFFLINE' ||
        state.callback.terminalStatus !== 'failed' ||
        state.mission.state.status !== 'running' ||
        state.mission.state.phase !== 'verify' ||
        state.outbox.gatewayEffectReconcile.count !== 1 ||
        state.outbox.missionVerify.count !== 1
      ) {
        context.addIssue({
          code: 'custom',
          path: ['expectedDurableState'],
          message: 'Device-offline must retain its terminal effect failure before verification',
        })
      }
      return
    }

    if (
      state.effect.status !== 'completed' ||
      state.effect.dispatchErrorCode !== null ||
      state.effect.persistedEvidenceCount !== 3 ||
      state.callback.terminalStatus !== 'completed' ||
      state.mission.state.status !== 'waiting_for_system' ||
      state.mission.state.phase !== 'observe' ||
      state.outbox.missionVerify.count !== 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedDurableState'],
        message:
          'Recovered preheat effects remain in observation until the full execution resolves',
      })
    }

    if (unknownDispatch) {
      const expectedReason = manifest.faultProfile === 'lost_ack' ? 'lost_ack' : 'timeout'
      const expectedError =
        manifest.faultProfile === 'lost_ack' ? 'GATEWAY_LOST_ACK' : 'GATEWAY_TIMEOUT'
      if (
        state.effect.dispatchStatus !== 'unknown' ||
        state.effect.dispatchUnknownReason !== expectedReason ||
        state.attempts.gatewayTransport.status !== 'unknown' ||
        !state.attempts.gatewayTransport.retryable ||
        state.attempts.gatewayTransport.errorCode !== expectedError ||
        state.outbox.gatewayEffectReconcile.count !== 1
      ) {
        context.addIssue({
          code: 'custom',
          path: ['expectedDurableState'],
          message: 'Unknown dispatch must retain its exact reason and reconciliation message',
        })
      }
    } else if (
      state.effect.dispatchStatus !== 'accepted' ||
      state.effect.dispatchUnknownReason !== null ||
      state.attempts.gatewayTransport.status !== 'succeeded' ||
      state.attempts.gatewayTransport.retryable ||
      state.attempts.gatewayTransport.errorCode !== null ||
      state.outbox.gatewayEffectReconcile.count !== 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedDurableState'],
        message: 'Accepted dispatches must not invent reconciliation work',
      })
    }

    if (
      (duplicateCallback &&
        (state.callback.deliveredCount !== 2 ||
          state.callback.duplicateDeliveryCount !== 1 ||
          state.callback.ingestionResults.join(',') !== 'stored,duplicate')) ||
      (!duplicateCallback &&
        (state.callback.deliveredCount !== 1 ||
          state.callback.duplicateDeliveryCount !== 0 ||
          state.callback.ingestionResults.join(',') !== 'stored'))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedDurableState', 'callback'],
        message: 'Only the duplicate-callback profile delivers a replay at this checkpoint',
      })
    }
  })

export type GatewayFaultDurableOutcomeManifest = z.infer<
  typeof GatewayFaultDurableOutcomeManifestSchema
>

export const GatewayFaultDurableOutcomeCatalogSchema = z
  .object({
    schemaVersion: z.literal('gateway-fault-durable-outcome-catalog@1'),
    fixtureId: z.literal('night-shift-homecoming@1'),
    observationPoint: z.literal(GATEWAY_FAULT_OBSERVATION_POINT),
    manifests: z.array(GatewayFaultDurableOutcomeManifestSchema).length(7),
  })
  .strict()
  .superRefine((catalog, context) => {
    const profileNames = catalog.manifests.map((manifest) => manifest.faultProfile)
    const ids = catalog.manifests.map((manifest) => manifest.id)
    const requiredProfiles = GatewayFaultProfileNameSchema.options
    if (
      new Set(profileNames).size !== requiredProfiles.length ||
      !requiredProfiles.every((profile) => profileNames.includes(profile))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['manifests'],
        message: 'Catalog must contain every canonical gateway fault profile exactly once',
      })
    }
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['manifests'],
        message: 'Gateway fault manifest IDs must be unique',
      })
    }
  })

export type GatewayFaultDurableOutcomeCatalog = z.infer<
  typeof GatewayFaultDurableOutcomeCatalogSchema
>

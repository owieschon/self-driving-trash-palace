import { GatewayFaultDurableOutcomeManifestSchema } from '../../../packages/core/src/index.js'

export const DUPLICATE_CALLBACK_GATEWAY_FAULT_MANIFEST =
  GatewayFaultDurableOutcomeManifestSchema.parse({
    schemaVersion: 'gateway-fault-durable-outcome@1',
    id: 'gateway-fault-duplicate_callback-post-preheat@1',
    fixtureId: 'night-shift-homecoming@1',
    observationPoint: 'post_preheat_callback_ingested',
    faultProfile: 'duplicate_callback',
    injection: {
      kind: 'duplicate_callback',
      copies: 2,
      separationVirtualMilliseconds: 1,
    },
    recoverability: {
      scope: 'current_preheat_gateway_effect',
      classification: 'recoverable',
      outcomeAtObservationPoint: 'recovered',
      mechanism: 'duplicate_callback_deduplicated',
    },
    terminalOutcome: {
      expected: null,
      reason: 'checkpoint_precedes_deterministic_verification',
    },
    expectedDurableState: {
      mission: {
        state: { status: 'waiting_for_system', phase: 'observe' },
        terminal: false,
      },
      verification: {
        presence: 'absent',
        count: 0,
        status: null,
        assertionCount: 0,
        reason: 'not_run_at_observation_point',
      },
      routines: {
        operationOutcomeCount: 1,
        replacementRoutineCount: 1,
        activeReplacementCount: 1,
        inactiveProtectedCount: 1,
        duplicateDurableOutcomeCount: 0,
      },
      effect: {
        materializedCount: 1,
        milestone: 'preheat',
        status: 'completed',
        dispatchStatus: 'accepted',
        dispatchUnknownReason: null,
        dispatchErrorCode: null,
        persistedEvidenceCount: 3,
      },
      attempts: {
        totalCount: 2,
        activationTransport: {
          sequence: 1,
          transport: 'worker',
          status: 'unknown',
          retryable: true,
          errorCode: 'APPLICATION_RESPONSE_LOST',
        },
        gatewayTransport: {
          sequence: 2,
          transport: 'gateway',
          status: 'succeeded',
          retryable: false,
          errorCode: null,
        },
      },
      generation: { totalCount: 1, current: 1, currentStatus: 'accepted' },
      callback: {
        deliveredCount: 2,
        persistedUniqueCount: 1,
        duplicateDeliveryCount: 1,
        terminalStatus: 'completed',
        ingestionResults: ['stored', 'duplicate'],
      },
      outbox: {
        totalCount: 3,
        operationReconcile: { count: 1, statuses: ['pending'] },
        gatewayDispatch: { count: 1, statuses: ['pending'] },
        gatewayEffectReconcile: { count: 0, statuses: [] },
        executionDeadline: { count: 1, statuses: ['pending'] },
        missionVerify: { count: 0, statuses: [] },
        missionResume: { count: 0, statuses: [] },
      },
    },
  })

import { GatewayFaultDurableOutcomeManifestSchema } from '../../../packages/core/src/index.js'

export const RESPONSE_TIMEOUT_GATEWAY_FAULT_MANIFEST =
  GatewayFaultDurableOutcomeManifestSchema.parse({
    schemaVersion: 'gateway-fault-durable-outcome@1',
    id: 'gateway-fault-response_timeout-post-preheat@1',
    fixtureId: 'night-shift-homecoming@1',
    observationPoint: 'post_preheat_callback_ingested',
    faultProfile: 'response_timeout',
    injection: { kind: 'response_timeout', callbackDelayVirtualMilliseconds: 5_000 },
    recoverability: {
      scope: 'current_preheat_gateway_effect',
      classification: 'recoverable',
      outcomeAtObservationPoint: 'recovered',
      mechanism: 'signed_terminal_callback_after_unknown_dispatch',
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
        dispatchStatus: 'unknown',
        dispatchUnknownReason: 'timeout',
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
          status: 'unknown',
          retryable: true,
          errorCode: 'GATEWAY_TIMEOUT',
        },
      },
      generation: { totalCount: 1, current: 1, currentStatus: 'unknown' },
      callback: {
        deliveredCount: 1,
        persistedUniqueCount: 1,
        duplicateDeliveryCount: 0,
        terminalStatus: 'completed',
        ingestionResults: ['stored'],
      },
      outbox: {
        totalCount: 4,
        operationReconcile: { count: 1, statuses: ['pending'] },
        gatewayDispatch: { count: 1, statuses: ['pending'] },
        gatewayEffectReconcile: { count: 1, statuses: ['pending'] },
        executionDeadline: { count: 1, statuses: ['pending'] },
        missionVerify: { count: 0, statuses: [] },
        missionResume: { count: 0, statuses: [] },
      },
    },
  })

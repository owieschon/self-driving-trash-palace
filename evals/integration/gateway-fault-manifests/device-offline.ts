import { GatewayFaultDurableOutcomeManifestSchema } from '../../../packages/core/src/index.js'

export const DEVICE_OFFLINE_GATEWAY_FAULT_MANIFEST = GatewayFaultDurableOutcomeManifestSchema.parse(
  {
    schemaVersion: 'gateway-fault-durable-outcome@1',
    id: 'gateway-fault-device_offline-post-preheat@1',
    fixtureId: 'night-shift-homecoming@1',
    observationPoint: 'post_preheat_callback_ingested',
    faultProfile: 'device_offline',
    injection: { kind: 'device_offline', offlineForVirtualMilliseconds: 30_000 },
    recoverability: {
      scope: 'current_preheat_gateway_effect',
      classification: 'unrecoverable_within_execution',
      outcomeAtObservationPoint: 'terminal_effect_failure',
      mechanism: 'terminal_failure_callback',
    },
    terminalOutcome: {
      expected: null,
      reason: 'checkpoint_precedes_deterministic_verification',
    },
    expectedDurableState: {
      mission: {
        state: { status: 'running', phase: 'verify' },
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
        status: 'failed',
        dispatchStatus: 'failed',
        dispatchUnknownReason: null,
        dispatchErrorCode: 'DEVICE_OFFLINE',
        persistedEvidenceCount: 1,
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
          status: 'failed',
          retryable: true,
          errorCode: 'DEVICE_OFFLINE',
        },
      },
      generation: { totalCount: 1, current: 1, currentStatus: 'failed' },
      callback: {
        deliveredCount: 1,
        persistedUniqueCount: 1,
        duplicateDeliveryCount: 0,
        terminalStatus: 'failed',
        ingestionResults: ['stored'],
      },
      outbox: {
        totalCount: 5,
        operationReconcile: { count: 1, statuses: ['pending'] },
        gatewayDispatch: { count: 1, statuses: ['pending'] },
        gatewayEffectReconcile: { count: 1, statuses: ['pending'] },
        executionDeadline: { count: 1, statuses: ['pending'] },
        missionVerify: { count: 1, statuses: ['pending'] },
        missionResume: { count: 0, statuses: [] },
      },
    },
  },
)

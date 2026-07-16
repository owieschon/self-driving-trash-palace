import type {
  Execution,
  GatewayCallback,
  GatewayCallbackNonce,
  GatewayCommand,
  MissionId,
  OperationId,
  OrganizationId,
  PlanActionId,
  PlanId,
  Sha256,
} from '@trash-palace/core'

export type JsonValue =
  boolean | null | number | string | JsonValue[] | { readonly [key: string]: JsonValue }

export type OutboxTopic =
  | 'gateway.dispatch'
  | 'gateway.effect.reconcile'
  | 'execution.deadline'
  | 'execution.identity-arrival'
  | 'mission.resume'
  | 'mission.verify'
  | 'operation.reconcile'

export interface OutboxMessage {
  readonly id: string
  readonly organizationId: OrganizationId
  readonly topic: OutboxTopic
  readonly deduplicationKey: string
  readonly payload: Readonly<Record<string, JsonValue>>
  readonly status: 'pending' | 'claimed' | 'dispatched' | 'cancelled'
  readonly availableAt: string
  readonly createdAt: string
  readonly claimedBy: string | null
  readonly claimExpiresAt: string | null
  readonly dispatchedAt: string | null
  readonly deliveryAttempts: number
  readonly lastErrorCode: string | null
}

export interface MissionLeaseRecord {
  readonly missionId: MissionId
  readonly organizationId: OrganizationId
  readonly ownerId: string
  readonly epoch: number
  readonly tokenFingerprint: Sha256
  readonly acquiredAt: string
  readonly expiresAt: string
  readonly renewedAt: string
  readonly releasedAt: string | null
}

export type { GatewayCommand }

export interface StoredGatewayCallback {
  readonly schemaVersion: GatewayCallback['schemaVersion']
  readonly id: GatewayCallback['id']
  readonly organizationId: GatewayCallback['organizationId']
  readonly missionId: GatewayCallback['missionId']
  readonly palaceId: GatewayCallback['palaceId']
  readonly commandId: GatewayCallback['commandId']
  readonly operationId: GatewayCallback['operationId']
  readonly status: GatewayCallback['status']
  readonly occurredAt: GatewayCallback['occurredAt']
  readonly nonce: GatewayCallback['nonce']
  readonly evidence: GatewayCallback['evidence']
  readonly verifierKeyId: string
  readonly verifierVersion: 1
  readonly verifiedPayloadDigest: Sha256
  readonly receivedAt: string
}

export type StoredGatewayCallbackNonce = GatewayCallbackNonce

export interface StoredExecution {
  readonly operationId: OperationId
  readonly execution: Execution
}

export interface CancellationRecord {
  readonly id: string
  readonly organizationId: OrganizationId
  readonly missionId: MissionId
  readonly requestedBy: string
  readonly reason: string
  readonly checkpoint:
    | 'before_operation'
    | 'unclaimed_operation'
    | 'claimed_or_committed'
    | 'gateway_dispatched'
    | 'durable_effect'
  readonly outcome:
    | 'cancelled_without_mutation'
    | 'cancelled_unclaimed_operations'
    | 'stopped_remaining_actions'
    | 'reconcile_dispatched_effect'
    | 'compensating_plan_required'
  readonly compensatingPlanRequired: boolean
  readonly requestedAt: string
}

export interface CompensatingPlanLink {
  readonly organizationId: OrganizationId
  readonly planId: PlanId
  readonly actionId: PlanActionId
  readonly compensatesOperationId: OperationId
  readonly createdAt: string
}

export interface PlanValidationRecord {
  readonly planId: PlanId
  readonly valid: boolean
  readonly checks: readonly {
    readonly type: 'capability' | 'conflict' | 'hard_invariant' | 'schema'
    readonly passed: boolean
    readonly message: string
  }[]
  readonly createdAt: string
}

export interface PlanSimulationRecord {
  readonly planId: PlanId
  readonly feasible: boolean
  readonly projectedBatteryUsePercentagePoints: number
  readonly results: readonly {
    readonly scenario: 'access' | 'energy' | 'timing' | 'transport_failure'
    readonly passed: boolean
    readonly evidence: string
  }[]
  readonly createdAt: string
}

export interface ReconciliationPoll {
  readonly organizationId: OrganizationId
  readonly operationId: OperationId
  readonly sequence: number
  readonly resolution: 'committed' | 'definitely_absent' | 'still_unknown' | 'failed'
  readonly occurredAt: string
}

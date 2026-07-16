import { createHash } from 'node:crypto'

import { z } from 'zod'

import {
  AttemptIdSchema,
  DeviceIdSchema,
  EvidenceIdSchema,
  GatewayCallbackIdSchema,
  GatewayCommandIdSchema,
  IdentityTagIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OperationIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PlanIdSchema,
  ReceiptIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  Sha256Schema,
  ToolCallIdSchema,
  VerificationIdSchema,
} from './identifiers.js'
import { ToolNameSchema } from './tool-names.js'
import {
  IdentityTelemetryKeyIdSchema,
  IdentityTelemetryPrincipalIdSchema,
  IdentityTelemetryProviderEventIdSchema,
} from './identity-telemetry.js'

const EvidenceBaseShape = {
  id: EvidenceIdSchema,
  organizationId: OrganizationIdSchema,
  missionId: MissionIdSchema,
  palaceId: PalaceIdSchema,
  observedAt: IsoDateTimeSchema,
} as const

export const IdentityArrivalEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    type: z.literal('identity_arrival'),
    identityTagId: IdentityTagIdSchema,
    verified: z.boolean(),
  })
  .strict()

export const DeviceCommandEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    type: z.literal('device_command'),
    deviceId: DeviceIdSchema,
    command: z.enum(['unlock', 'locked_desired_state', 'set_temperature', 'set_lighting']),
    causedByEvidenceId: EvidenceIdSchema.nullable(),
  })
  .strict()

export const TemperatureEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    type: z.literal('temperature_observation'),
    deviceId: DeviceIdSchema,
    celsius: z.number().min(-50).max(80),
  })
  .strict()

export const LightingEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    type: z.literal('lighting_observation'),
    deviceId: DeviceIdSchema,
    intensityPercent: z.number().int().min(0).max(100),
    active: z.boolean(),
  })
  .strict()

export const LockEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    type: z.literal('lock_observation'),
    deviceId: DeviceIdSchema,
    desiredState: z.enum(['locked', 'unlocked']),
  })
  .strict()

export const BatteryProjectionEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    type: z.literal('battery_projection'),
    projectedUsePercentagePoints: z.number().min(0).max(100),
  })
  .strict()

export const RoutineStateEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    type: z.literal('routine_state'),
    routineId: RoutineIdSchema,
    routineVersionId: RoutineVersionIdSchema,
    active: z.boolean(),
    planId: PlanIdSchema.nullable(),
    planHash: Sha256Schema.nullable(),
  })
  .strict()

export const TenantAccessAuditEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    type: z.literal('tenant_access_audit'),
    attemptedOrganizationId: OrganizationIdSchema,
    allowed: z.boolean(),
    operationId: OperationIdSchema.nullable(),
  })
  .strict()

export const OperationTransportEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    type: z.literal('operation_transport'),
    operationId: OperationIdSchema,
    attemptId: AttemptIdSchema,
    toolCallId: ToolCallIdSchema,
    transport: z.literal('worker'),
    status: z.literal('unknown'),
    operationCommitted: z.literal(true),
    errorCode: z.literal('APPLICATION_RESPONSE_LOST'),
  })
  .strict()

export const ToolInvocationReconciledOutcomeSchema = z.enum([
  'still_unknown',
  'committed',
  'definitely_absent',
])

export const ToolInvocationDurableObservationSchema = z.enum([
  'expired_claim_without_terminal_result',
  'completed_result_observed',
  'durable_absence_observed',
])

const ToolInvocationReconciliationObservationShape = {
  organizationId: OrganizationIdSchema,
  missionId: MissionIdSchema,
  toolCallId: ToolCallIdSchema,
  toolName: ToolNameSchema,
  invocationBindingHash: Sha256Schema,
  abandonedClaimGeneration: z.number().int().positive(),
  claimExpiredAt: IsoDateTimeSchema,
  source: z.literal('tool_invocation_ledger'),
  observer: z.literal('application_code'),
  durableObservation: ToolInvocationDurableObservationSchema,
  reconciledOutcome: ToolInvocationReconciledOutcomeSchema,
  observedResultHash: Sha256Schema.nullable(),
  observedAttemptId: AttemptIdSchema.nullable(),
  observedAt: IsoDateTimeSchema,
} as const

export const ToolInvocationReconciliationObservationSchema = z
  .object({
    schemaVersion: z.literal('tool-invocation-reconciliation-observation@1'),
    ...ToolInvocationReconciliationObservationShape,
  })
  .strict()
  .superRefine(assertToolInvocationReconciliationSemantics)

export const ToolInvocationReconciliationEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    type: z.literal('tool_invocation_reconciliation'),
    toolCallId: ToolCallIdSchema,
    toolName: ToolNameSchema,
    invocationBindingHash: Sha256Schema,
    abandonedClaimGeneration: z.number().int().positive(),
    claimExpiredAt: IsoDateTimeSchema,
    source: z.literal('tool_invocation_ledger'),
    observer: z.literal('application_code'),
    durableObservation: ToolInvocationDurableObservationSchema,
    reconciledOutcome: ToolInvocationReconciledOutcomeSchema,
    observedResultHash: Sha256Schema.nullable(),
    observedAttemptId: AttemptIdSchema.nullable(),
    observationHash: Sha256Schema,
  })
  .strict()
  .superRefine((evidence, context) => {
    const observation = {
      schemaVersion: 'tool-invocation-reconciliation-observation@1' as const,
      organizationId: evidence.organizationId,
      missionId: evidence.missionId,
      toolCallId: evidence.toolCallId,
      toolName: evidence.toolName,
      invocationBindingHash: evidence.invocationBindingHash,
      abandonedClaimGeneration: evidence.abandonedClaimGeneration,
      claimExpiredAt: evidence.claimExpiredAt,
      source: evidence.source,
      observer: evidence.observer,
      durableObservation: evidence.durableObservation,
      reconciledOutcome: evidence.reconciledOutcome,
      observedResultHash: evidence.observedResultHash,
      observedAttemptId: evidence.observedAttemptId,
      observedAt: evidence.observedAt,
    }
    assertToolInvocationReconciliationSemantics(observation, context)
    if (evidence.observationHash !== hashToolInvocationReconciliationObservation(observation)) {
      context.addIssue({
        code: 'custom',
        path: ['observationHash'],
        message: 'Tool invocation reconciliation observation hash does not match its payload',
      })
    }
  })

export const GatewayDeliveryEvidenceSchema = z
  .object({
    ...EvidenceBaseShape,
    type: z.literal('gateway_delivery'),
    gatewayCommandId: GatewayCommandIdSchema,
    operationId: OperationIdSchema,
    status: z.enum(['completed', 'failed']),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
      .nullable(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const failed = evidence.status === 'failed'
    if (failed !== (evidence.code !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['code'],
        message: 'Failed gateway delivery requires a code; completed delivery carries none',
      })
    }
  })

export const EvidenceSchema = z.discriminatedUnion('type', [
  IdentityArrivalEvidenceSchema,
  DeviceCommandEvidenceSchema,
  TemperatureEvidenceSchema,
  LightingEvidenceSchema,
  LockEvidenceSchema,
  BatteryProjectionEvidenceSchema,
  RoutineStateEvidenceSchema,
  TenantAccessAuditEvidenceSchema,
  OperationTransportEvidenceSchema,
  GatewayDeliveryEvidenceSchema,
  ToolInvocationReconciliationEvidenceSchema,
])

export const GatewayAuthorityEvidenceSchema = z.discriminatedUnion('type', [
  DeviceCommandEvidenceSchema,
  TemperatureEvidenceSchema,
  LightingEvidenceSchema,
  LockEvidenceSchema,
  GatewayDeliveryEvidenceSchema,
])

export const ApplicationAuthorityEvidenceSchema = z.discriminatedUnion('type', [
  BatteryProjectionEvidenceSchema,
  RoutineStateEvidenceSchema,
  TenantAccessAuditEvidenceSchema,
  OperationTransportEvidenceSchema,
  ToolInvocationReconciliationEvidenceSchema,
])

export type ToolInvocationReconciliationObservation = z.infer<
  typeof ToolInvocationReconciliationObservationSchema
>

export function computeToolInvocationReconciliationObservationHash(
  input: z.input<typeof ToolInvocationReconciliationObservationSchema>,
): z.infer<typeof Sha256Schema> {
  const observation = ToolInvocationReconciliationObservationSchema.parse(input)
  return hashToolInvocationReconciliationObservation(observation)
}

function hashToolInvocationReconciliationObservation(
  observation: z.infer<typeof ToolInvocationReconciliationObservationSchema>,
): z.infer<typeof Sha256Schema> {
  return Sha256Schema.parse(
    createHash('sha256').update(canonicalEvidenceJson(observation)).digest('hex'),
  )
}

function assertToolInvocationReconciliationSemantics(
  observation: Readonly<{
    durableObservation: z.infer<typeof ToolInvocationDurableObservationSchema>
    reconciledOutcome: z.infer<typeof ToolInvocationReconciledOutcomeSchema>
    observedResultHash: z.infer<typeof Sha256Schema> | null
    claimExpiredAt: string
    observedAt: string
  }>,
  context: z.RefinementCtx,
): void {
  const expectedObservation = {
    still_unknown: 'expired_claim_without_terminal_result',
    committed: 'completed_result_observed',
    definitely_absent: 'durable_absence_observed',
  } as const
  if (observation.durableObservation !== expectedObservation[observation.reconciledOutcome]) {
    context.addIssue({
      code: 'custom',
      path: ['durableObservation'],
      message: 'Durable observation does not support the reconciled outcome',
    })
  }
  const requiresResultHash = observation.reconciledOutcome === 'committed'
  if (requiresResultHash !== (observation.observedResultHash !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['observedResultHash'],
      message: 'Only a committed reconciliation carries an observed result hash',
    })
  }
  if (Date.parse(observation.claimExpiredAt) > Date.parse(observation.observedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['claimExpiredAt'],
      message: 'An abandoned claim must expire before reconciliation observes it',
    })
  }
}

function canonicalEvidenceJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalEvidenceJson(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalEvidenceJson(entry)}`)
      .join(',')}}`
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}`)
}

const EvidenceAuthorityReceiptBaseShape = {
  id: ReceiptIdSchema,
  evidenceId: EvidenceIdSchema,
  organizationId: OrganizationIdSchema,
  missionId: MissionIdSchema,
  palaceId: PalaceIdSchema,
  verifiedAt: IsoDateTimeSchema,
} as const

export const IdentityTelemetryAuthorityReceiptSchema = z
  .object({
    ...EvidenceAuthorityReceiptBaseShape,
    schemaVersion: z
      .literal('evidence-authority-receipt@1')
      .default('evidence-authority-receipt@1'),
    authority: z.literal('identity_telemetry'),
    providerEventId: IdentityTelemetryProviderEventIdSchema,
    identityTagId: IdentityTagIdSchema,
    authenticityVerified: z.literal(true),
    tenantBindingVerified: z.literal(true),
  })
  .strict()

export const IdentityTelemetryAuthorityReceiptV2Schema = z
  .object({
    ...EvidenceAuthorityReceiptBaseShape,
    schemaVersion: z.literal('evidence-authority-receipt@2'),
    authority: z.literal('identity_telemetry'),
    providerEventId: IdentityTelemetryProviderEventIdSchema,
    identityTagId: IdentityTagIdSchema,
    principalId: IdentityTelemetryPrincipalIdSchema,
    keyId: IdentityTelemetryKeyIdSchema,
    keyVersion: z.number().int().positive(),
    verifiedPayloadHash: Sha256Schema,
    verifierVersion: z.literal(1),
    authenticityVerified: z.literal(true),
    tenantBindingVerified: z.literal(true),
    purposeVerified: z.literal(true),
  })
  .strict()

export const AnyIdentityTelemetryAuthorityReceiptSchema = z.union([
  IdentityTelemetryAuthorityReceiptSchema,
  IdentityTelemetryAuthorityReceiptV2Schema,
])

export const GatewayCallbackAuthorityReceiptSchema = z
  .object({
    ...EvidenceAuthorityReceiptBaseShape,
    schemaVersion: z
      .literal('evidence-authority-receipt@1')
      .default('evidence-authority-receipt@1'),
    authority: z.literal('gateway_callback'),
    callbackId: GatewayCallbackIdSchema,
    commandId: GatewayCommandIdSchema,
    verifiedPayloadHash: Sha256Schema,
    signatureVerified: z.literal(true),
    commandBindingVerified: z.literal(true),
  })
  .strict()

export const ApplicationAuthorityReceiptSchema = z
  .object({
    ...EvidenceAuthorityReceiptBaseShape,
    schemaVersion: z
      .literal('evidence-authority-receipt@1')
      .default('evidence-authority-receipt@1'),
    authority: z.literal('application'),
    producer: z.literal('application_code'),
    ruleId: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
      .max(120),
    ruleVersion: z.number().int().positive(),
    inputEvidenceIds: z.array(EvidenceIdSchema),
    derivationVerified: z.literal(true),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (new Set(receipt.inputEvidenceIds).size !== receipt.inputEvidenceIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['inputEvidenceIds'],
        message: 'Application evidence input IDs must be unique',
      })
    }
    if (receipt.inputEvidenceIds.includes(receipt.evidenceId)) {
      context.addIssue({
        code: 'custom',
        path: ['inputEvidenceIds'],
        message: 'Application evidence cannot cite itself as an input',
      })
    }
  })

export const EvidenceAuthorityReceiptSchema = z.union([
  AnyIdentityTelemetryAuthorityReceiptSchema,
  GatewayCallbackAuthorityReceiptSchema,
  ApplicationAuthorityReceiptSchema,
])

const PersistedEvidenceRecordBaseShape = {
  schemaVersion: z.literal('persisted-evidence@1').default('persisted-evidence@1'),
  persistedAt: IsoDateTimeSchema,
} as const

const PersistedEvidenceRecordStructuralSchema = z.union([
  z
    .object({
      ...PersistedEvidenceRecordBaseShape,
      evidence: IdentityArrivalEvidenceSchema,
      authorityReceipt: AnyIdentityTelemetryAuthorityReceiptSchema,
    })
    .strict(),
  z
    .object({
      ...PersistedEvidenceRecordBaseShape,
      evidence: GatewayAuthorityEvidenceSchema,
      authorityReceipt: GatewayCallbackAuthorityReceiptSchema,
    })
    .strict(),
  z
    .object({
      ...PersistedEvidenceRecordBaseShape,
      evidence: ApplicationAuthorityEvidenceSchema,
      authorityReceipt: ApplicationAuthorityReceiptSchema,
    })
    .strict(),
])

export const PersistedEvidenceRecordSchema = PersistedEvidenceRecordStructuralSchema.superRefine(
  ({ evidence, authorityReceipt, persistedAt }, context) => {
    for (const field of ['organizationId', 'missionId', 'palaceId'] as const) {
      if (authorityReceipt[field] !== evidence[field]) {
        context.addIssue({
          code: 'custom',
          path: ['authorityReceipt', field],
          message: `Evidence authority receipt ${field} must match its evidence`,
        })
      }
    }
    if (authorityReceipt.evidenceId !== evidence.id) {
      context.addIssue({
        code: 'custom',
        path: ['authorityReceipt', 'evidenceId'],
        message: 'Evidence authority receipt must bind the evidence ID',
      })
    }
    if (Date.parse(authorityReceipt.verifiedAt) > Date.parse(persistedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['persistedAt'],
        message: 'Evidence cannot be persisted before its authority was verified',
      })
    }
    if (
      authorityReceipt.authority === 'identity_telemetry' &&
      evidence.type === 'identity_arrival' &&
      authorityReceipt.identityTagId !== evidence.identityTagId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['authorityReceipt', 'identityTagId'],
        message: 'Identity telemetry receipt must bind the observed identity tag',
      })
    }
    if (
      authorityReceipt.authority === 'gateway_callback' &&
      evidence.type === 'gateway_delivery' &&
      authorityReceipt.commandId !== evidence.gatewayCommandId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['authorityReceipt', 'commandId'],
        message: 'Gateway receipt command must match gateway delivery evidence',
      })
    }
    if (
      authorityReceipt.authority === 'application' &&
      evidence.type === 'operation_transport' &&
      (authorityReceipt.ruleId !== 'operation.application_response_lost' ||
        authorityReceipt.ruleVersion !== 1 ||
        authorityReceipt.inputEvidenceIds.length !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['authorityReceipt'],
        message:
          'Application response-loss evidence requires the exact transport rule without invented inputs',
      })
    }
  },
)

export type GatewayAuthorityEvidence = z.infer<typeof GatewayAuthorityEvidenceSchema>
export type ApplicationAuthorityEvidence = z.infer<typeof ApplicationAuthorityEvidenceSchema>
export type IdentityTelemetryAuthorityReceipt = z.infer<
  typeof AnyIdentityTelemetryAuthorityReceiptSchema
>
export type GatewayCallbackAuthorityReceipt = z.infer<typeof GatewayCallbackAuthorityReceiptSchema>
export type ApplicationAuthorityReceipt = z.infer<typeof ApplicationAuthorityReceiptSchema>
export type EvidenceAuthorityReceipt = z.infer<typeof EvidenceAuthorityReceiptSchema>
export type PersistedEvidenceRecord = z.output<typeof PersistedEvidenceRecordSchema>

const PredicateBaseShape = {
  id: z.string().regex(/^[a-z][a-z0-9_-]{2,119}$/),
} as const

export const VerificationPredicateSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...PredicateBaseShape,
      type: z.literal('no_unlock_for_unverified_identity'),
      unverifiedArrivalEvidenceId: EvidenceIdSchema,
    })
    .strict(),
  z
    .object({
      ...PredicateBaseShape,
      type: z.literal('active_routine_count'),
      planId: PlanIdSchema,
      expected: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...PredicateBaseShape,
      type: z.literal('routine_inactive'),
      routineId: RoutineIdSchema,
    })
    .strict(),
  z
    .object({
      ...PredicateBaseShape,
      type: z.literal('routine_matches_plan'),
      routineId: RoutineIdSchema,
      planId: PlanIdSchema,
      planHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      ...PredicateBaseShape,
      type: z.literal('temperature_at_least_by'),
      minimumCelsius: z.number().min(-50).max(80),
      deadline: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      ...PredicateBaseShape,
      type: z.literal('lighting_after_arrival_within'),
      arrivalEvidenceId: EvidenceIdSchema,
      maximumDelaySeconds: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...PredicateBaseShape,
      type: z.literal('unlock_after_arrival_within'),
      arrivalEvidenceId: EvidenceIdSchema,
      maximumDelaySeconds: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...PredicateBaseShape,
      type: z.literal('lock_after_unlock_elapsed'),
      expectedSeconds: z.number().int().positive(),
      toleranceSeconds: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...PredicateBaseShape,
      type: z.literal('battery_projection_at_most'),
      maximumPercentagePoints: z.number().min(0).max(100),
    })
    .strict(),
  z
    .object({
      ...PredicateBaseShape,
      type: z.literal('no_cross_tenant_access'),
      organizationId: OrganizationIdSchema,
    })
    .strict(),
])

export const VerificationAssertionSchema = z
  .object({
    predicate: VerificationPredicateSchema,
    passed: z.boolean(),
    evidenceIds: z.array(EvidenceIdSchema).min(1),
    message: z.string().min(1).max(500),
  })
  .strict()

export const VerificationSchema = z
  .object({
    id: VerificationIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    source: z.literal('application_code'),
    status: z.enum(['passed', 'failed']),
    planHash: Sha256Schema,
    assertions: z.array(VerificationAssertionSchema).min(1),
    completedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((verification, ctx) => {
    const allPassed = verification.assertions.every((assertion) => assertion.passed)
    if ((verification.status === 'passed') !== allPassed) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Verification passes only when every deterministic assertion passes',
      })
    }
    const ids = verification.assertions.map((assertion) => assertion.predicate.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['assertions'],
        message: 'Verification predicate IDs must be unique',
      })
    }
  })

export type Evidence = z.infer<typeof EvidenceSchema>
export type VerificationPredicate = z.infer<typeof VerificationPredicateSchema>
export type VerificationAssertion = z.infer<typeof VerificationAssertionSchema>
export type Verification = z.infer<typeof VerificationSchema>

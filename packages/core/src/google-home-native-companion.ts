import { z } from 'zod'

import { CapabilityKindSchema } from './entities.js'
import { GatewayCommandSchema, canonicalGatewayJson } from './gateway.js'
import {
  ApprovalIdSchema,
  CapabilityIdSchema,
  DeviceIdSchema,
  GatewayCommandIdSchema,
  IsoDateTimeSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  Sha256Schema,
} from './identifiers.js'

// These are Trash Palace safety limits, not Google Home platform quotas.
export const GOOGLE_HOME_MAX_COMMAND_TTL_MILLISECONDS = 5 * 60 * 1_000
export const GOOGLE_HOME_MAX_BINDING_LEASE_MILLISECONDS = 5 * 60 * 1_000
export const GOOGLE_HOME_MAX_UNLOCK_CONFIRMATION_MILLISECONDS = 2 * 60 * 1_000
export const GOOGLE_HOME_MAX_DERIVED_DATA_RETENTION_MILLISECONDS = 10 * 24 * 60 * 60 * 1_000

// Native implementations must reproduce this wire profile byte-for-byte before exchanging keys.
export const GOOGLE_HOME_SIGNATURE_WIRE_PROFILE = {
  algorithm: 'ed25519',
  signatureEncoding: 'base64url_without_padding',
  signatureBytes: 64,
  signatureCharacters: 86,
  payloadEncoding: 'utf8',
  canonicalJson: 'rfc8785_jcs_ascii_schema_subset',
  fieldSeparator: '\n',
  trailingNewline: false,
} as const

export const GoogleHomeDerivedSourceClassificationSchema = z.literal(
  'google_home_derived_restricted',
)

export type GoogleHomeDerivedSourceClassification = z.infer<
  typeof GoogleHomeDerivedSourceClassificationSchema
>

export const GoogleHomeDerivedSourceHandlingContractSchema = z
  .object({
    schemaVersion: z.literal('google-home-source-handling@1'),
    classification: GoogleHomeDerivedSourceClassificationSchema,
    allowedPurposes: z.tuple([
      z.literal('logical_binding_authorization'),
      z.literal('sanitized_operation_reconciliation'),
    ]),
    forbiddenDestinations: z.tuple([
      z.literal('caretaker_model_context'),
      z.literal('analytics'),
      z.literal('mcp'),
      z.literal('logs'),
    ]),
    downstreamEnforcement: z.literal('blocked_not_integrated'),
  })
  .strict()

export type GoogleHomeDerivedSourceHandlingContract = z.infer<
  typeof GoogleHomeDerivedSourceHandlingContractSchema
>

export function getGoogleHomeDerivedSourceHandlingContract(): GoogleHomeDerivedSourceHandlingContract {
  return GoogleHomeDerivedSourceHandlingContractSchema.parse({
    schemaVersion: 'google-home-source-handling@1',
    classification: 'google_home_derived_restricted',
    allowedPurposes: ['logical_binding_authorization', 'sanitized_operation_reconciliation'],
    forbiddenDestinations: ['caretaker_model_context', 'analytics', 'mcp', 'logs'],
    downstreamEnforcement: 'blocked_not_integrated',
  })
}

function millisecondsBetween(start: string, end: string): number {
  return Date.parse(end) - Date.parse(start)
}

function addBoundedIntervalIssue(input: {
  readonly context: z.core.$RefinementCtx
  readonly start: string
  readonly end: string
  readonly maximumMilliseconds: number
  readonly path: readonly PropertyKey[]
  readonly message: string
}): void {
  const duration = millisecondsBetween(input.start, input.end)
  if (duration <= 0 || duration > input.maximumMilliseconds) {
    input.context.addIssue({
      code: 'custom',
      path: [...input.path],
      message: input.message,
    })
  }
}

export const GoogleHomeBindingIdSchema = z
  .string()
  .regex(/^ghb_[a-z0-9][a-z0-9_-]{7,63}$/)
  .brand<'GoogleHomeBindingId'>()

export const GoogleHomeConfirmationIdSchema = z
  .string()
  .regex(/^ghc_[a-z0-9][a-z0-9_-]{7,63}$/)
  .brand<'GoogleHomeConfirmationId'>()

export const GoogleHomeReceiptIdSchema = z
  .string()
  .regex(/^ghr_[a-z0-9][a-z0-9_-]{7,63}$/)
  .brand<'GoogleHomeReceiptId'>()

export const GoogleHomeSignatureHeaderSchema = z
  .object({
    version: z.literal('v1'),
    algorithm: z.literal('ed25519'),
    keyId: z.string().regex(/^ghk_[A-Za-z0-9_-]{8,64}$/),
    signedAt: IsoDateTimeSchema,
  })
  .strict()

export const GoogleHomeSignatureSchema = z
  .object({
    ...GoogleHomeSignatureHeaderSchema.shape,
    // Ed25519 signatures are exactly 64 bytes. Unpadded base64url is therefore 86 characters,
    // with the final sextet restricted to the four values whose unused low bits are zero.
    value: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
  })
  .strict()

export type GoogleHomeSignatureHeader = z.infer<typeof GoogleHomeSignatureHeaderSchema>
export type GoogleHomeSignature = z.infer<typeof GoogleHomeSignatureSchema>

function googleHomeSignaturePayload(
  domain: string,
  payload: unknown,
  rawHeader: GoogleHomeSignatureHeader,
): string {
  const header = GoogleHomeSignatureHeaderSchema.parse(rawHeader)
  return [
    domain,
    header.version,
    header.algorithm,
    header.keyId,
    header.signedAt,
    canonicalGatewayJson(payload),
  ].join('\n')
}

const GoogleHomeLogicalBindingPayloadStructuralSchema = z
  .object({
    schemaVersion: z.literal('google-home-logical-binding@1'),
    provider: z.literal('google_home'),
    dataClass: z.literal('app_owned_logical_binding'),
    sourceClassification: GoogleHomeDerivedSourceClassificationSchema,
    bindingId: GoogleHomeBindingIdSchema,
    organizationId: OrganizationIdSchema,
    palaceId: PalaceIdSchema,
    logicalDeviceId: DeviceIdSchema,
    capabilityId: CapabilityIdSchema,
    capabilityKind: CapabilityKindSchema,
    consentStatus: z.enum(['active', 'revoked']),
    consentVerifiedAt: IsoDateTimeSchema,
    bindingVerifiedAt: IsoDateTimeSchema,
    validUntil: IsoDateTimeSchema,
    recordedAt: IsoDateTimeSchema,
    deleteAfter: IsoDateTimeSchema,
  })
  .strict()

export const GoogleHomeLogicalBindingPayloadSchema =
  GoogleHomeLogicalBindingPayloadStructuralSchema.superRefine((binding, context) => {
    addBoundedIntervalIssue({
      context,
      start: binding.bindingVerifiedAt,
      end: binding.validUntil,
      maximumMilliseconds: GOOGLE_HOME_MAX_BINDING_LEASE_MILLISECONDS,
      path: ['validUntil'],
      message: 'A Google Home logical binding lease must be positive and at most five minutes',
    })
    addBoundedIntervalIssue({
      context,
      start: binding.recordedAt,
      end: binding.deleteAfter,
      maximumMilliseconds: GOOGLE_HOME_MAX_DERIVED_DATA_RETENTION_MILLISECONDS,
      path: ['deleteAfter'],
      message: 'Google Home-derived binding data must be deleted within ten days',
    })
    if (Date.parse(binding.consentVerifiedAt) > Date.parse(binding.bindingVerifiedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['consentVerifiedAt'],
        message: 'Consent must be verified no later than the logical binding',
      })
    }
    if (Date.parse(binding.recordedAt) < Date.parse(binding.bindingVerifiedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['recordedAt'],
        message: 'A logical binding cannot be recorded before it is verified',
      })
    }
  })

export const SignedGoogleHomeLogicalBindingSchema = z
  .object({
    binding: GoogleHomeLogicalBindingPayloadSchema,
    signature: GoogleHomeSignatureSchema,
  })
  .strict()
  .superRefine(({ binding, signature }, context) => {
    if (
      Date.parse(signature.signedAt) < Date.parse(binding.recordedAt) ||
      Date.parse(signature.signedAt) >= Date.parse(binding.validUntil)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['signature', 'signedAt'],
        message: 'A logical binding signature must be created during the binding lease',
      })
    }
  })

export type GoogleHomeBindingId = z.infer<typeof GoogleHomeBindingIdSchema>
export type GoogleHomeConfirmationId = z.infer<typeof GoogleHomeConfirmationIdSchema>
export type GoogleHomeReceiptId = z.infer<typeof GoogleHomeReceiptIdSchema>
export type GoogleHomeLogicalBindingPayload = z.infer<typeof GoogleHomeLogicalBindingPayloadSchema>
export type SignedGoogleHomeLogicalBinding = z.infer<typeof SignedGoogleHomeLogicalBindingSchema>

export function googleHomeLogicalBindingSignaturePayload(
  rawBinding: GoogleHomeLogicalBindingPayload,
  header: GoogleHomeSignatureHeader,
): string {
  const binding = GoogleHomeLogicalBindingPayloadSchema.parse(rawBinding)
  return googleHomeSignaturePayload('google-home-logical-binding:v1', binding, header)
}

const GoogleHomeExactPlanAuthorizationSchema = z
  .object({
    mode: z.literal('approved_plan'),
    approvalId: ApprovalIdSchema,
    planHash: Sha256Schema,
  })
  .strict()

const GoogleHomeFreshMobileAuthorizationSchema = z
  .object({
    mode: z.literal('fresh_mobile_confirmation'),
    approvalId: ApprovalIdSchema,
    planHash: Sha256Schema,
    confirmation: z
      .object({
        id: GoogleHomeConfirmationIdSchema,
        method: z.enum(['device_credential', 'user_pin']),
        confirmedAt: IsoDateTimeSchema,
        expiresAt: IsoDateTimeSchema,
      })
      .strict()
      .superRefine((confirmation, context) => {
        addBoundedIntervalIssue({
          context,
          start: confirmation.confirmedAt,
          end: confirmation.expiresAt,
          maximumMilliseconds: GOOGLE_HOME_MAX_UNLOCK_CONFIRMATION_MILLISECONDS,
          path: ['expiresAt'],
          message: 'A mobile unlock confirmation must expire within two minutes',
        })
      }),
  })
  .strict()

export const GoogleHomeCommandAuthorizationSchema = z.discriminatedUnion('mode', [
  GoogleHomeExactPlanAuthorizationSchema,
  GoogleHomeFreshMobileAuthorizationSchema,
])

const GoogleHomeCommandSigningPayloadShape = {
  schemaVersion: z.literal('google-home-command-envelope@1'),
  provider: z.literal('google_home'),
  transport: z.literal('native_companion'),
  dataClass: z.literal('logical_slot_command'),
  bindingId: GoogleHomeBindingIdSchema,
  organizationId: OrganizationIdSchema,
  palaceId: PalaceIdSchema,
  logicalDeviceId: DeviceIdSchema,
  capabilityId: CapabilityIdSchema,
  idempotencyKey: GatewayCommandIdSchema,
  command: GatewayCommandSchema,
  authorization: GoogleHomeCommandAuthorizationSchema,
  issuedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
} as const

const GoogleHomeCommandSigningPayloadStructuralSchema = z
  .object(GoogleHomeCommandSigningPayloadShape)
  .strict()

type GoogleHomeCommandSigningPayloadStructural = z.infer<
  typeof GoogleHomeCommandSigningPayloadStructuralSchema
>

function refineGoogleHomeCommandSigningPayload(
  envelope: GoogleHomeCommandSigningPayloadStructural,
  context: z.core.$RefinementCtx,
): void {
  addBoundedIntervalIssue({
    context,
    start: envelope.issuedAt,
    end: envelope.expiresAt,
    maximumMilliseconds: GOOGLE_HOME_MAX_COMMAND_TTL_MILLISECONDS,
    path: ['expiresAt'],
    message: 'A Google Home command envelope must expire within five minutes',
  })
  if (envelope.organizationId !== envelope.command.organizationId) {
    context.addIssue({
      code: 'custom',
      path: ['organizationId'],
      message: 'Command envelope organization must match the gateway command',
    })
  }
  if (envelope.palaceId !== envelope.command.palaceId) {
    context.addIssue({
      code: 'custom',
      path: ['palaceId'],
      message: 'Command envelope palace must match the gateway command',
    })
  }
  if (envelope.logicalDeviceId !== envelope.command.payload.deviceId) {
    context.addIssue({
      code: 'custom',
      path: ['logicalDeviceId'],
      message: 'Command envelope logical device must match the gateway command',
    })
  }
  if (envelope.idempotencyKey !== envelope.command.id) {
    context.addIssue({
      code: 'custom',
      path: ['idempotencyKey'],
      message: 'Command envelope idempotency key must be the stable gateway command ID',
    })
  }
  if (envelope.command.kind === 'unlock') {
    if (envelope.authorization.mode !== 'fresh_mobile_confirmation') {
      context.addIssue({
        code: 'custom',
        path: ['authorization'],
        message: 'Unlock requires a fresh secured-mobile confirmation and cannot be autonomous',
      })
      return
    }
    if (
      Date.parse(envelope.authorization.confirmation.confirmedAt) > Date.parse(envelope.issuedAt) ||
      Date.parse(envelope.authorization.confirmation.expiresAt) < Date.parse(envelope.expiresAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['authorization', 'confirmation'],
        message: 'The mobile confirmation must cover the complete unlock envelope lifetime',
      })
    }
  } else if (envelope.authorization.mode !== 'approved_plan') {
    context.addIssue({
      code: 'custom',
      path: ['authorization'],
      message: 'Non-unlock commands use the exact approved-plan authority',
    })
  }
}

export const GoogleHomeCommandSigningPayloadSchema =
  GoogleHomeCommandSigningPayloadStructuralSchema.superRefine(refineGoogleHomeCommandSigningPayload)

export const GoogleHomeCommandEnvelopeSchema = z
  .object({
    ...GoogleHomeCommandSigningPayloadShape,
    signature: GoogleHomeSignatureSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    refineGoogleHomeCommandSigningPayload(envelope, context)
    if (
      Date.parse(envelope.signature.signedAt) < Date.parse(envelope.issuedAt) ||
      Date.parse(envelope.signature.signedAt) >= Date.parse(envelope.expiresAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['signature', 'signedAt'],
        message: 'Command envelope signature must be created during the envelope lifetime',
      })
    }
  })

export type GoogleHomeCommandAuthorization = z.infer<typeof GoogleHomeCommandAuthorizationSchema>
export type GoogleHomeCommandSigningPayload = z.infer<typeof GoogleHomeCommandSigningPayloadSchema>
export type GoogleHomeCommandEnvelope = z.infer<typeof GoogleHomeCommandEnvelopeSchema>

export function googleHomeCommandEnvelopeSignaturePayload(
  rawEnvelope: GoogleHomeCommandSigningPayload,
  header: GoogleHomeSignatureHeader,
): string {
  const envelope = GoogleHomeCommandSigningPayloadSchema.parse(rawEnvelope)
  return googleHomeSignaturePayload('google-home-command-envelope:v1', envelope, header)
}

export function expectedGoogleHomeCapabilityKind(
  command: GoogleHomeCommandEnvelope['command'],
): z.infer<typeof CapabilityKindSchema> {
  switch (command.kind) {
    case 'set_lighting':
      return 'pathway_lighting'
    case 'set_temperature':
      return 'temperature_target'
    case 'locked_desired_state':
    case 'unlock':
      return 'lock_desired_state'
  }
}

const GoogleHomeNativeSafetyFactsBaseShape = {
  schemaVersion: z.literal('google-home-native-safety-facts@1'),
  dataClass: z.literal('transient_boolean_safety_facts'),
  bindingId: GoogleHomeBindingIdSchema,
  organizationId: OrganizationIdSchema,
  commandId: GatewayCommandIdSchema,
  checkedAt: IsoDateTimeSchema,
  consent: z.enum(['active', 'revoked', 'unknown']),
  localBinding: z.enum(['matched', 'mismatch', 'unknown']),
  commandSupport: z.enum(['supported', 'unsupported', 'unknown']),
  nativeSafetyChecks: z.enum(['passed', 'failed', 'unknown']),
} as const

const GoogleHomeThermostatSafetyFactsSchema = z
  .object({
    targetCelsius: z.number().min(5).max(35),
    configuredMinimumCelsius: z.number().min(5).max(35),
    configuredMaximumCelsius: z.number().min(5).max(35),
  })
  .strict()

const GoogleHomeEnergySafetyFactsSchema = z
  .object({
    projectedWattHours: z.number().nonnegative(),
    availableWattHours: z.number().nonnegative(),
    requiredReserveWattHours: z.number().nonnegative(),
  })
  .strict()

export const GoogleHomeNativeSafetyFactsSchema = z.discriminatedUnion('commandKind', [
  z
    .object({
      ...GoogleHomeNativeSafetyFactsBaseShape,
      commandKind: z.literal('set_temperature'),
      thermostat: GoogleHomeThermostatSafetyFactsSchema,
      energy: GoogleHomeEnergySafetyFactsSchema,
    })
    .strict(),
  z
    .object({
      ...GoogleHomeNativeSafetyFactsBaseShape,
      commandKind: z.literal('set_lighting'),
      thermostat: z.literal('not_applicable'),
      energy: GoogleHomeEnergySafetyFactsSchema,
    })
    .strict(),
  z
    .object({
      ...GoogleHomeNativeSafetyFactsBaseShape,
      commandKind: z.enum(['locked_desired_state', 'unlock']),
      thermostat: z.literal('not_applicable'),
      energy: z.literal('not_applicable'),
    })
    .strict(),
])

export type GoogleHomeNativeSafetyFacts = z.infer<typeof GoogleHomeNativeSafetyFactsSchema>

export const GoogleHomeDispatchContractSchema = z
  .object({
    bindingLease: SignedGoogleHomeLogicalBindingSchema,
    envelope: GoogleHomeCommandEnvelopeSchema,
  })
  .strict()
  .superRefine(({ bindingLease, envelope }, context) => {
    const binding = bindingLease.binding
    for (const field of [
      'bindingId',
      'organizationId',
      'palaceId',
      'logicalDeviceId',
      'capabilityId',
    ] as const) {
      if (binding[field] !== envelope[field]) {
        context.addIssue({
          code: 'custom',
          path: ['envelope', field],
          message: `Command envelope ${field} must match its logical binding`,
        })
      }
    }
    if (binding.capabilityKind !== expectedGoogleHomeCapabilityKind(envelope.command)) {
      context.addIssue({
        code: 'custom',
        path: ['bindingLease', 'binding', 'capabilityKind'],
        message: 'Logical binding capability does not authorize this command kind',
      })
    }
  })

export type GoogleHomeDispatchContract = z.infer<typeof GoogleHomeDispatchContractSchema>

const GoogleHomeSanitizedReceiptBaseShape = {
  schemaVersion: z.literal('google-home-sanitized-receipt@1'),
  provider: z.literal('google_home'),
  dataClass: z.literal('sanitized_outcome_only'),
  sourceClassification: GoogleHomeDerivedSourceClassificationSchema,
  id: GoogleHomeReceiptIdSchema,
  bindingId: GoogleHomeBindingIdSchema,
  organizationId: OrganizationIdSchema,
  palaceId: PalaceIdSchema,
  logicalDeviceId: DeviceIdSchema,
  capabilityId: CapabilityIdSchema,
  commandId: GatewayCommandIdSchema,
  idempotencyKey: GatewayCommandIdSchema,
  occurredAt: IsoDateTimeSchema,
  firstRecordedAt: IsoDateTimeSchema,
  recordedAt: IsoDateTimeSchema,
  deleteAfter: IsoDateTimeSchema,
} as const

const GoogleHomeSanitizedReceiptPayloadStructuralSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...GoogleHomeSanitizedReceiptBaseShape,
      status: z.literal('completed'),
      outcome: z.literal('requested_state_confirmed'),
      code: z.null(),
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({
      ...GoogleHomeSanitizedReceiptBaseShape,
      status: z.enum(['rejected', 'failed', 'unknown']),
      outcome: z.literal('not_confirmed'),
      code: z.enum([
        'BINDING_STALE',
        'CONSENT_REVOKED',
        'ENVELOPE_EXPIRED',
        'MOBILE_CONFIRMATION_REQUIRED',
        'PROVIDER_REJECTED',
        'PROVIDER_UNAVAILABLE',
        'UNSUPPORTED_COMMAND',
        'UNKNOWN_OUTCOME',
      ]),
      retryable: z.boolean(),
    })
    .strict(),
])

export const GoogleHomeSanitizedReceiptPayloadSchema =
  GoogleHomeSanitizedReceiptPayloadStructuralSchema.superRefine((receipt, context) => {
    if (Date.parse(receipt.occurredAt) > Date.parse(receipt.firstRecordedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['firstRecordedAt'],
        message: 'The first receipt cannot be recorded before its outcome occurs',
      })
    }
    if (Date.parse(receipt.firstRecordedAt) > Date.parse(receipt.recordedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['recordedAt'],
        message: 'A later receipt record cannot precede the first retained receipt',
      })
    }
    addBoundedIntervalIssue({
      context,
      start: receipt.firstRecordedAt,
      end: receipt.deleteAfter,
      maximumMilliseconds: GOOGLE_HOME_MAX_DERIVED_DATA_RETENTION_MILLISECONDS,
      path: ['deleteAfter'],
      message: 'Google Home-derived receipt data must be deleted within ten days',
    })
  })

export const SignedGoogleHomeSanitizedReceiptSchema = z
  .object({
    receipt: GoogleHomeSanitizedReceiptPayloadSchema,
    signature: GoogleHomeSignatureSchema,
  })
  .strict()
  .superRefine(({ receipt, signature }, context) => {
    if (
      Date.parse(signature.signedAt) < Date.parse(receipt.recordedAt) ||
      Date.parse(signature.signedAt) >= Date.parse(receipt.deleteAfter)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['signature', 'signedAt'],
        message: 'A sanitized receipt must be signed during its retention lifetime',
      })
    }
  })

export type GoogleHomeSanitizedReceiptPayload = z.infer<
  typeof GoogleHomeSanitizedReceiptPayloadSchema
>
export type SignedGoogleHomeSanitizedReceipt = z.infer<
  typeof SignedGoogleHomeSanitizedReceiptSchema
>

export function googleHomeReceiptSignaturePayload(
  rawReceipt: GoogleHomeSanitizedReceiptPayload,
  header: GoogleHomeSignatureHeader,
): string {
  const receipt = GoogleHomeSanitizedReceiptPayloadSchema.parse(rawReceipt)
  return googleHomeSignaturePayload('google-home-sanitized-receipt:v1', receipt, header)
}

export const GoogleHomeEnvelopeReceiptPairSchema = z
  .object({
    envelope: GoogleHomeCommandEnvelopeSchema,
    signedReceipt: SignedGoogleHomeSanitizedReceiptSchema,
  })
  .strict()
  .superRefine(({ envelope, signedReceipt }, context) => {
    const receipt = signedReceipt.receipt
    const expected = {
      bindingId: envelope.bindingId,
      organizationId: envelope.organizationId,
      palaceId: envelope.palaceId,
      logicalDeviceId: envelope.logicalDeviceId,
      capabilityId: envelope.capabilityId,
      commandId: envelope.command.id,
      idempotencyKey: envelope.idempotencyKey,
    } as const
    for (const field of Object.keys(expected) as (keyof typeof expected)[]) {
      if (receipt[field] !== expected[field]) {
        context.addIssue({
          code: 'custom',
          path: ['signedReceipt', 'receipt', field],
          message: `Sanitized receipt ${field} must match its command envelope`,
        })
      }
    }
    if (Date.parse(receipt.occurredAt) < Date.parse(envelope.issuedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['signedReceipt', 'receipt', 'occurredAt'],
        message: 'A native companion receipt cannot predate its command envelope',
      })
    }
    if (
      receipt.status === 'completed' &&
      Date.parse(receipt.occurredAt) > Date.parse(envelope.expiresAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['signedReceipt', 'receipt', 'occurredAt'],
        message: 'A native companion cannot execute a command after its envelope expires',
      })
    }
  })

export const GoogleHomeDataBoundaryProjectionSchema = z
  .object({
    schemaVersion: z.literal('google-home-data-boundary@1'),
    providerRuntimeOwner: z.literal('android_or_ios_native_companion'),
    backendDataClass: z.literal('logical_bindings_commands_and_sanitized_receipts_only'),
    forbiddenSinks: z.tuple([
      z.literal('caretaker_model_context'),
      z.literal('analytics'),
      z.literal('mcp'),
      z.literal('logs'),
    ]),
    mcpSurface: z.literal('existing_provider_neutral_tools_only'),
    simulatorIsCiDefault: z.literal(true),
    maximumDerivedRetentionDays: z.literal(10),
    sourceClassification: GoogleHomeDerivedSourceClassificationSchema,
    downstreamClassificationEnforcement: z.literal('blocked_not_integrated'),
  })
  .strict()

export type GoogleHomeDataBoundaryProjection = z.infer<
  typeof GoogleHomeDataBoundaryProjectionSchema
>

export function getGoogleHomeDataBoundaryProjection(): GoogleHomeDataBoundaryProjection {
  return GoogleHomeDataBoundaryProjectionSchema.parse({
    schemaVersion: 'google-home-data-boundary@1',
    providerRuntimeOwner: 'android_or_ios_native_companion',
    backendDataClass: 'logical_bindings_commands_and_sanitized_receipts_only',
    forbiddenSinks: ['caretaker_model_context', 'analytics', 'mcp', 'logs'],
    mcpSurface: 'existing_provider_neutral_tools_only',
    simulatorIsCiDefault: true,
    maximumDerivedRetentionDays: 10,
    sourceClassification: 'google_home_derived_restricted',
    downstreamClassificationEnforcement: 'blocked_not_integrated',
  })
}

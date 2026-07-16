import { createHash } from 'node:crypto'

import { z } from 'zod'

import { GatewayAuthorityEvidenceSchema } from './evidence.js'
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
  Sha256Schema,
} from './identifiers.js'

export type GatewayJsonValue =
  boolean | null | number | string | GatewayJsonValue[] | { [key: string]: GatewayJsonValue }

function assertGatewayJsonValue(value: unknown, path = '$'): GatewayJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Gateway canonical JSON rejects non-finite numbers at ${path}`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => assertGatewayJsonValue(child, `${path}[${index}]`))
  }
  if (typeof value === 'object') {
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Gateway canonical JSON requires plain objects at ${path}`)
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        assertGatewayJsonValue(child, `${path}.${key}`),
      ]),
    )
  }
  throw new TypeError(`Gateway canonical JSON rejects ${typeof value} at ${path}`)
}

function canonicalize(value: GatewayJsonValue): GatewayJsonValue {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

export function canonicalGatewayJson(value: unknown): string {
  return JSON.stringify(canonicalize(assertGatewayJsonValue(value)))
}

export const SetTemperaturePayloadSchema = z
  .object({
    deviceId: DeviceIdSchema,
    targetCelsius: z.number().min(5).max(35),
    completeAt: IsoDateTimeSchema,
    causedByEvidenceId: EvidenceIdSchema.nullable().default(null),
  })
  .strict()

export const SetLightingPayloadSchema = z
  .object({
    deviceId: DeviceIdSchema,
    intensityPercent: z.number().int().min(0).max(100),
    durationSeconds: z.number().int().positive().max(86_400),
    causedByEvidenceId: EvidenceIdSchema,
  })
  .strict()

export const UnlockPayloadSchema = z
  .object({
    deviceId: DeviceIdSchema,
    identityTagId: IdentityTagIdSchema,
    durationSeconds: z.number().int().positive().max(300),
    causedByEvidenceId: EvidenceIdSchema,
  })
  .strict()

export const LockedDesiredStatePayloadSchema = z
  .object({
    deviceId: DeviceIdSchema,
    causedByEvidenceId: EvidenceIdSchema,
  })
  .strict()

export const GatewayCommandInstructionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set_temperature'), payload: SetTemperaturePayloadSchema }).strict(),
  z.object({ kind: z.literal('set_lighting'), payload: SetLightingPayloadSchema }).strict(),
  z.object({ kind: z.literal('unlock'), payload: UnlockPayloadSchema }).strict(),
  z
    .object({ kind: z.literal('locked_desired_state'), payload: LockedDesiredStatePayloadSchema })
    .strict(),
])

export type GatewayCommandInstruction = z.output<typeof GatewayCommandInstructionSchema>

export const GatewayCommandLogicalKeySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
    'Gateway command logical keys use lowercase canonical segments',
  )

export type GatewayCommandLogicalKey = z.infer<typeof GatewayCommandLogicalKeySchema>

export function deriveGatewayCommandId(
  operationId: z.infer<typeof OperationIdSchema>,
  logicalKey: GatewayCommandLogicalKey,
): z.infer<typeof GatewayCommandIdSchema> {
  const parsedOperationId = OperationIdSchema.parse(operationId)
  const parsedLogicalKey = GatewayCommandLogicalKeySchema.parse(logicalKey)
  const preimage = [
    'gateway-command:v2',
    `${parsedOperationId.length}:${parsedOperationId}`,
    `${parsedLogicalKey.length}:${parsedLogicalKey}`,
  ].join('\n')
  const digest = createHash('sha256').update(preimage).digest('hex')
  return GatewayCommandIdSchema.parse(`gcmd_${digest}`)
}

const GatewayCommandBaseShape = {
  schemaVersion: z.literal('gateway-command@2').default('gateway-command@2'),
  id: GatewayCommandIdSchema,
  organizationId: OrganizationIdSchema,
  missionId: MissionIdSchema,
  palaceId: PalaceIdSchema,
  operationId: OperationIdSchema,
  logicalKey: GatewayCommandLogicalKeySchema,
  payloadHash: Sha256Schema,
  createdAt: IsoDateTimeSchema,
} as const

const GatewayCommandInputBaseShape = {
  schemaVersion: z.literal('gateway-command@2').default('gateway-command@2'),
  organizationId: OrganizationIdSchema,
  missionId: MissionIdSchema,
  palaceId: PalaceIdSchema,
  operationId: OperationIdSchema,
  logicalKey: GatewayCommandLogicalKeySchema,
  createdAt: IsoDateTimeSchema,
} as const

const GatewayCommandWithoutHashSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...GatewayCommandInputBaseShape,
      kind: z.literal('set_temperature'),
      payload: SetTemperaturePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...GatewayCommandInputBaseShape,
      kind: z.literal('set_lighting'),
      payload: SetLightingPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...GatewayCommandInputBaseShape,
      kind: z.literal('unlock'),
      payload: UnlockPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...GatewayCommandInputBaseShape,
      kind: z.literal('locked_desired_state'),
      payload: LockedDesiredStatePayloadSchema,
    })
    .strict(),
])

const GatewayCommandStructuralSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...GatewayCommandBaseShape,
      kind: z.literal('set_temperature'),
      payload: SetTemperaturePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...GatewayCommandBaseShape,
      kind: z.literal('set_lighting'),
      payload: SetLightingPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...GatewayCommandBaseShape,
      kind: z.literal('unlock'),
      payload: UnlockPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...GatewayCommandBaseShape,
      kind: z.literal('locked_desired_state'),
      payload: LockedDesiredStatePayloadSchema,
    })
    .strict(),
])

export function computeGatewayPayloadHash(input: {
  readonly kind: string
  readonly payload: unknown
}): z.infer<typeof Sha256Schema> {
  const serialized = canonicalGatewayJson({
    kind: input.kind,
    payload: input.payload,
  })
  return Sha256Schema.parse(createHash('sha256').update(serialized).digest('hex'))
}

export const GatewayCommandSchema = GatewayCommandStructuralSchema.superRefine(
  (command, context) => {
    if (command.id !== deriveGatewayCommandId(command.operationId, command.logicalKey)) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'Gateway command ID must derive from its operation and logical key',
      })
    }
    if (command.payloadHash !== computeGatewayPayloadHash(command)) {
      context.addIssue({
        code: 'custom',
        path: ['payloadHash'],
        message: 'Gateway command payload hash does not match kind and payload',
      })
    }
  },
)

export type GatewayCommand = z.output<typeof GatewayCommandSchema>
export type GatewayCommandInput = z.input<typeof GatewayCommandWithoutHashSchema>

export function createGatewayCommand(input: GatewayCommandInput): GatewayCommand {
  const parsed = GatewayCommandWithoutHashSchema.parse(input)
  return GatewayCommandSchema.parse({
    ...parsed,
    id: deriveGatewayCommandId(parsed.operationId, parsed.logicalKey),
    payloadHash: computeGatewayPayloadHash(parsed),
  })
}

export const GatewayAcknowledgementIdSchema = z.string().regex(/^gack_[a-z0-9][a-z0-9_-]{7,63}$/)

export type GatewayAcknowledgementId = z.infer<typeof GatewayAcknowledgementIdSchema>

export const GatewayDispatchResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('accepted'),
      acknowledgementId: GatewayAcknowledgementIdSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('unknown'),
      retryable: z.literal(true),
      reason: z.enum(['timeout', 'lost_ack']),
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      retryable: z.boolean(),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
      message: z.string().min(1).max(500),
    })
    .strict(),
])

export type GatewayDispatchResult = z.infer<typeof GatewayDispatchResultSchema>

const GatewayDispatchStateBaseShape = {
  commandId: GatewayCommandIdSchema,
  generation: z.number().int().positive(),
  updatedAt: IsoDateTimeSchema,
} as const

export const GatewayDispatchStateSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...GatewayDispatchStateBaseShape,
      status: z.literal('pending'),
      attemptId: z.null(),
    })
    .strict(),
  z
    .object({
      ...GatewayDispatchStateBaseShape,
      status: z.literal('dispatching'),
      attemptId: AttemptIdSchema,
    })
    .strict(),
  z
    .object({
      ...GatewayDispatchStateBaseShape,
      status: z.literal('accepted'),
      attemptId: AttemptIdSchema,
      acknowledgementId: GatewayAcknowledgementIdSchema,
    })
    .strict(),
  z
    .object({
      ...GatewayDispatchStateBaseShape,
      status: z.literal('unknown'),
      attemptId: AttemptIdSchema,
      retryable: z.literal(true),
      reason: z.enum(['timeout', 'lost_ack']),
    })
    .strict(),
  z
    .object({
      ...GatewayDispatchStateBaseShape,
      status: z.literal('failed'),
      attemptId: AttemptIdSchema,
      retryable: z.boolean(),
      error: z
        .object({
          code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
          message: z.string().min(1).max(500),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...GatewayDispatchStateBaseShape,
      status: z.literal('cancelled'),
      attemptId: z.null(),
      reason: z.literal('mission_cancelled_before_dispatch'),
      cancelledAt: IsoDateTimeSchema,
    })
    .strict(),
])

export type GatewayDispatchState = z.infer<typeof GatewayDispatchStateSchema>

export const GatewayCallbackNonceSchema = z.string().regex(/^gwn_[A-Za-z0-9_-]{24,96}$/)

export type GatewayCallbackNonce = z.infer<typeof GatewayCallbackNonceSchema>

export const GatewayCallbackStatusSchema = z.enum([
  'acknowledged',
  'executing',
  'completed',
  'failed',
])

export type GatewayCallbackStatus = z.infer<typeof GatewayCallbackStatusSchema>

export const GatewayCallbackEvidenceSchema = GatewayAuthorityEvidenceSchema

export type GatewayCallbackEvidence = z.infer<typeof GatewayCallbackEvidenceSchema>

export const GatewayCallbackStatusTransitionSchema = z.enum([
  'advance',
  'replay',
  'reject_regression',
  'reject_terminal_contradiction',
])

export type GatewayCallbackStatusTransition = z.infer<typeof GatewayCallbackStatusTransitionSchema>

const CALLBACK_STATUS_RANK: Readonly<Record<GatewayCallbackStatus, number>> = {
  acknowledged: 0,
  executing: 1,
  completed: 2,
  failed: 2,
}

const GatewayEffectStateBaseShape = {
  commandId: GatewayCommandIdSchema,
  updatedAt: IsoDateTimeSchema,
} as const

const GatewayEffectStateStructuralSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...GatewayEffectStateBaseShape,
      status: z.literal('pending'),
      callbackId: z.null(),
      evidenceIds: z.array(EvidenceIdSchema).length(0),
    })
    .strict(),
  z
    .object({
      ...GatewayEffectStateBaseShape,
      status: z.enum(['acknowledged', 'executing']),
      callbackId: GatewayCallbackIdSchema,
      evidenceIds: z.array(EvidenceIdSchema).length(0),
    })
    .strict(),
  z
    .object({
      ...GatewayEffectStateBaseShape,
      status: z.literal('cancellation_requested'),
      callbackId: GatewayCallbackIdSchema.nullable(),
      evidenceIds: z.array(EvidenceIdSchema).length(0),
      requestedAt: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      ...GatewayEffectStateBaseShape,
      status: z.literal('completed'),
      callbackId: GatewayCallbackIdSchema,
      evidenceIds: z.array(EvidenceIdSchema).length(3),
    })
    .strict(),
  z
    .object({
      ...GatewayEffectStateBaseShape,
      status: z.literal('failed'),
      callbackId: GatewayCallbackIdSchema,
      evidenceIds: z.array(EvidenceIdSchema).length(1),
    })
    .strict(),
])

export const GatewayEffectStateSchema = GatewayEffectStateStructuralSchema.superRefine(
  (state, context) => {
    if (new Set(state.evidenceIds).size !== state.evidenceIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceIds'],
        message: 'Gateway effect evidence IDs must be unique',
      })
    }
    if (
      state.status === 'cancellation_requested' &&
      Date.parse(state.requestedAt) > Date.parse(state.updatedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requestedAt'],
        message: 'Gateway effect cancellation cannot be requested after its update time',
      })
    }
  },
)

export type GatewayEffectState = z.infer<typeof GatewayEffectStateSchema>

export function classifyGatewayCallbackStatusTransition(
  current: GatewayCallbackStatus | null,
  incoming: GatewayCallbackStatus,
): GatewayCallbackStatusTransition {
  const parsedCurrent = current === null ? null : GatewayCallbackStatusSchema.parse(current)
  const parsedIncoming = GatewayCallbackStatusSchema.parse(incoming)
  if (parsedCurrent === null) return 'advance'
  if (parsedCurrent === parsedIncoming) return 'replay'

  const currentTerminal = parsedCurrent === 'completed' || parsedCurrent === 'failed'
  const incomingTerminal = parsedIncoming === 'completed' || parsedIncoming === 'failed'
  if (currentTerminal && incomingTerminal) return 'reject_terminal_contradiction'
  if (CALLBACK_STATUS_RANK[parsedIncoming] < CALLBACK_STATUS_RANK[parsedCurrent]) {
    return 'reject_regression'
  }
  return currentTerminal ? 'reject_regression' : 'advance'
}

export const GatewayCallbackSchema = z
  .object({
    schemaVersion: z.literal('gateway-callback@1').default('gateway-callback@1'),
    id: GatewayCallbackIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    palaceId: PalaceIdSchema,
    commandId: GatewayCommandIdSchema,
    operationId: OperationIdSchema,
    status: GatewayCallbackStatusSchema,
    occurredAt: IsoDateTimeSchema,
    nonce: GatewayCallbackNonceSchema,
    evidence: z.array(GatewayCallbackEvidenceSchema),
  })
  .strict()
  .superRefine((callback, context) => {
    for (const [index, evidence] of callback.evidence.entries()) {
      if (
        evidence.organizationId !== callback.organizationId ||
        evidence.missionId !== callback.missionId ||
        evidence.palaceId !== callback.palaceId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', index],
          message: 'Gateway callback evidence must match callback tenant, mission, and palace',
        })
      }
    }

    const terminal = callback.status === 'completed' || callback.status === 'failed'
    const deliveryEvidence = callback.evidence.filter(
      (evidence) => evidence.type === 'gateway_delivery',
    )
    if (terminal && deliveryEvidence.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'A terminal gateway callback requires exactly one delivery evidence record',
      })
    }
    if (!terminal && deliveryEvidence.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'Only terminal gateway callbacks carry delivery evidence',
      })
    }
    if (!terminal && callback.evidence.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'Nonterminal gateway callbacks cannot carry effect evidence',
      })
    }
    if (callback.status === 'failed' && callback.evidence.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'A failed gateway callback carries only its delivery failure evidence',
      })
    }
    for (const [index, evidence] of deliveryEvidence.entries()) {
      if (
        evidence.gatewayCommandId !== callback.commandId ||
        evidence.operationId !== callback.operationId ||
        evidence.status !== callback.status
      ) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', index],
          message: 'Gateway delivery evidence must match callback command, operation, and status',
        })
      }
    }
  })

export type GatewayCallback = z.output<typeof GatewayCallbackSchema>

export const GatewayCallbackBindingSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    palaceId: PalaceIdSchema,
    operationId: OperationIdSchema,
    commandId: GatewayCommandIdSchema,
  })
  .strict()

export type GatewayCallbackBinding = z.infer<typeof GatewayCallbackBindingSchema>

export function gatewayCallbackBindingForCommand(command: GatewayCommand): GatewayCallbackBinding {
  const parsed = GatewayCommandSchema.parse(command)
  return GatewayCallbackBindingSchema.parse({
    organizationId: parsed.organizationId,
    missionId: parsed.missionId,
    palaceId: parsed.palaceId,
    operationId: parsed.operationId,
    commandId: parsed.id,
  })
}

export const GatewayCommandCallbackPairSchema = z
  .object({
    command: GatewayCommandSchema,
    callback: GatewayCallbackSchema,
  })
  .strict()
  .superRefine(({ command, callback }, context) => {
    const expectedBinding = gatewayCallbackBindingForCommand(command)
    for (const field of [
      'organizationId',
      'missionId',
      'palaceId',
      'operationId',
      'commandId',
    ] as const) {
      if (callback[field] !== expectedBinding[field]) {
        context.addIssue({
          code: 'custom',
          path: ['callback', field],
          message: `Gateway callback ${field} does not match its command`,
        })
      }
    }

    const commandEvidence = callback.evidence.filter(
      (evidence) => evidence.type === 'device_command',
    )
    const observationEvidence = callback.evidence.filter(
      (evidence) =>
        evidence.type === 'temperature_observation' ||
        evidence.type === 'lighting_observation' ||
        evidence.type === 'lock_observation',
    )
    if (
      callback.status === 'completed' &&
      (commandEvidence.length !== 1 || observationEvidence.length !== 1)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['callback', 'evidence'],
        message:
          'A completed callback requires one matching device command and one command-specific observation',
      })
    }

    for (const [index, evidence] of callback.evidence.entries()) {
      if (evidence.type === 'gateway_delivery') continue
      if (evidence.deviceId !== command.payload.deviceId) {
        context.addIssue({
          code: 'custom',
          path: ['callback', 'evidence', index, 'deviceId'],
          message: 'Gateway callback device evidence must target the command device',
        })
      }

      if (evidence.type === 'device_command') {
        const expectedCause = command.payload.causedByEvidenceId
        if (evidence.command !== command.kind || evidence.causedByEvidenceId !== expectedCause) {
          context.addIssue({
            code: 'custom',
            path: ['callback', 'evidence', index],
            message: 'Gateway command evidence must match the command kind and causal evidence',
          })
        }
        continue
      }

      const expectedObservationType =
        command.kind === 'set_temperature'
          ? 'temperature_observation'
          : command.kind === 'set_lighting'
            ? 'lighting_observation'
            : 'lock_observation'
      if (evidence.type !== expectedObservationType) {
        context.addIssue({
          code: 'custom',
          path: ['callback', 'evidence', index, 'type'],
          message: 'Gateway observation type must match the command kind',
        })
      }
      if (
        evidence.type === 'lock_observation' &&
        evidence.desiredState !== (command.kind === 'unlock' ? 'unlocked' : 'locked')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['callback', 'evidence', index, 'desiredState'],
          message: 'Lock observation state must match the requested command state',
        })
      }
    }
  })

export type GatewayCommandCallbackPair = z.output<typeof GatewayCommandCallbackPairSchema>

export function validateGatewayCommandCallbackBinding(
  command: GatewayCommand,
  callback: GatewayCallback,
): GatewayCommandCallbackPair {
  return GatewayCommandCallbackPairSchema.parse({ command, callback })
}

export const GatewaySignatureMetadataSchema = z
  .object({
    version: z.literal('v1'),
    algorithm: z.literal('hmac-sha256'),
    keyId: z.string().regex(/^gwk_[A-Za-z0-9_-]{8,64}$/),
    timestamp: IsoDateTimeSchema,
    nonce: GatewayCallbackNonceSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export const SignedGatewayCallbackSchema = z
  .object({
    callback: GatewayCallbackSchema,
    signature: GatewaySignatureMetadataSchema,
  })
  .strict()

export type GatewaySignatureMetadata = z.infer<typeof GatewaySignatureMetadataSchema>
export type SignedGatewayCallback = z.infer<typeof SignedGatewayCallbackSchema>

export function computeGatewayCallbackPayloadHash(
  callback: GatewayCallback,
): z.infer<typeof Sha256Schema> {
  const parsed = GatewayCallbackSchema.parse(callback)
  return Sha256Schema.parse(createHash('sha256').update(canonicalGatewayJson(parsed)).digest('hex'))
}

export function gatewayCallbackSignaturePayload(
  callback: GatewayCallback,
  keyId: GatewaySignatureMetadata['keyId'],
  timestamp: GatewaySignatureMetadata['timestamp'],
): string {
  const parsedCallback = GatewayCallbackSchema.parse(callback)
  const parsedKeyId = GatewaySignatureMetadataSchema.shape.keyId.parse(keyId)
  const parsedTimestamp = IsoDateTimeSchema.parse(timestamp)
  return [
    'gateway-callback:v1',
    parsedKeyId,
    parsedTimestamp,
    parsedCallback.nonce,
    canonicalGatewayJson(parsedCallback),
  ].join('\n')
}

export const CallbackDedupeInputSchema = z
  .object({
    callbackId: GatewayCallbackIdSchema,
    organizationId: OrganizationIdSchema,
    nonce: GatewayCallbackNonceSchema,
    payloadHash: Sha256Schema,
  })
  .strict()

export type CallbackDedupeInput = z.infer<typeof CallbackDedupeInputSchema>

export function callbackDedupeInput(callback: GatewayCallback): CallbackDedupeInput {
  const parsed = GatewayCallbackSchema.parse(callback)
  return CallbackDedupeInputSchema.parse({
    callbackId: parsed.id,
    organizationId: parsed.organizationId,
    nonce: parsed.nonce,
    payloadHash: computeGatewayCallbackPayloadHash(parsed),
  })
}

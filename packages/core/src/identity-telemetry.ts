import { createHash } from 'node:crypto'

import { z } from 'zod'

import {
  EvidenceIdSchema,
  IdentityTagIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  ReceiptIdSchema,
  Sha256Schema,
} from './identifiers.js'

export const IdentityTelemetryProviderEventIdSchema = z.string().regex(/^idt_[A-Za-z0-9_-]{8,96}$/)

export const IdentityTelemetryNonceSchema = z.string().regex(/^itn_[A-Za-z0-9_-]{16,96}$/)

export const IdentityTelemetryPrincipalIdSchema = z.string().regex(/^itp_[A-Za-z0-9_-]{8,64}$/)

export const IdentityTelemetryKeyIdSchema = z.string().regex(/^itk_[A-Za-z0-9_-]{8,64}$/)

export const IdentityTelemetryPurposeSchema = z.literal('identity_telemetry_ingress')

export const IdentityTelemetryEventSchema = z
  .object({
    schemaVersion: z.literal('identity-telemetry-event@1'),
    providerEventId: IdentityTelemetryProviderEventIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    palaceId: PalaceIdSchema,
    identityTagId: IdentityTagIdSchema,
    observedAt: IsoDateTimeSchema,
    nonce: IdentityTelemetryNonceSchema,
  })
  .strict()

export const IdentityTelemetrySignatureSchema = z
  .object({
    version: z.literal('v1'),
    algorithm: z.literal('hmac-sha256'),
    keyId: IdentityTelemetryKeyIdSchema,
    timestamp: IsoDateTimeSchema,
    nonce: IdentityTelemetryNonceSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export const SignedIdentityTelemetrySchema = z
  .object({
    event: IdentityTelemetryEventSchema,
    signature: IdentityTelemetrySignatureSchema,
  })
  .strict()

export const IdentityTelemetryPrincipalSchema = z
  .object({
    principalId: IdentityTelemetryPrincipalIdSchema,
    organizationId: OrganizationIdSchema,
    palaceId: PalaceIdSchema,
    purpose: IdentityTelemetryPurposeSchema,
    keyId: IdentityTelemetryKeyIdSchema,
    keyVersion: z.number().int().positive(),
    validFrom: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    revokedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((principal, context) => {
    if (Date.parse(principal.expiresAt) <= Date.parse(principal.validFrom)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Identity telemetry key expiry must follow its activation',
      })
    }
    if (
      principal.revokedAt !== null &&
      Date.parse(principal.revokedAt) < Date.parse(principal.validFrom)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['revokedAt'],
        message: 'Identity telemetry key revocation cannot predate activation',
      })
    }
  })

export const VerifiedIdentityTelemetrySchema = z
  .object({
    event: IdentityTelemetryEventSchema,
    principal: IdentityTelemetryPrincipalSchema,
    signatureTimestamp: IsoDateTimeSchema,
    verifiedPayloadHash: Sha256Schema,
    verifierVersion: z.literal(1),
  })
  .strict()

type IdentityJsonValue =
  boolean | null | number | string | IdentityJsonValue[] | { [key: string]: IdentityJsonValue }

function asCanonicalJson(value: unknown, path = '$'): IdentityJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Identity telemetry canonical JSON rejects non-finite numbers at ${path}`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => asCanonicalJson(child, `${path}[${index}]`))
  }
  if (typeof value === 'object') {
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Identity telemetry canonical JSON requires plain objects at ${path}`)
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, asCanonicalJson(child, `${path}.${key}`)]),
    )
  }
  throw new TypeError(`Identity telemetry canonical JSON rejects ${typeof value} at ${path}`)
}

function canonicalize(value: IdentityJsonValue): IdentityJsonValue {
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

export function canonicalIdentityTelemetryJson(value: unknown): string {
  return JSON.stringify(canonicalize(asCanonicalJson(value)))
}

export function identityTelemetrySignaturePayload(input: {
  readonly event: IdentityTelemetryEvent
  readonly keyId: IdentityTelemetryKeyId
  readonly timestamp: string
}): string {
  const event = IdentityTelemetryEventSchema.parse(input.event)
  const keyId = IdentityTelemetryKeyIdSchema.parse(input.keyId)
  const timestamp = IsoDateTimeSchema.parse(input.timestamp)
  return [
    'identity-telemetry:v1',
    keyId,
    timestamp,
    event.nonce,
    canonicalIdentityTelemetryJson(event),
  ].join('\n')
}

export function computeIdentityTelemetryPayloadHash(
  input: IdentityTelemetryEvent,
): z.infer<typeof Sha256Schema> {
  const event = IdentityTelemetryEventSchema.parse(input)
  return Sha256Schema.parse(
    createHash('sha256').update(canonicalIdentityTelemetryJson(event)).digest('hex'),
  )
}

function deriveIdentityTelemetryId(
  kind: 'evidence' | 'receipt',
  event: IdentityTelemetryEvent,
): string {
  const parsed = IdentityTelemetryEventSchema.parse(event)
  return createHash('sha256')
    .update(
      [`identity-telemetry-${kind}:v1`, parsed.organizationId, parsed.providerEventId].join('\n'),
    )
    .digest('hex')
}

export function deriveIdentityTelemetryEvidenceId(event: IdentityTelemetryEvent) {
  return EvidenceIdSchema.parse(`evd_${deriveIdentityTelemetryId('evidence', event)}`)
}

export function deriveIdentityTelemetryReceiptId(event: IdentityTelemetryEvent) {
  return ReceiptIdSchema.parse(`rcp_${deriveIdentityTelemetryId('receipt', event)}`)
}

export type IdentityTelemetryProviderEventId = z.infer<
  typeof IdentityTelemetryProviderEventIdSchema
>
export type IdentityTelemetryNonce = z.infer<typeof IdentityTelemetryNonceSchema>
export type IdentityTelemetryPrincipalId = z.infer<typeof IdentityTelemetryPrincipalIdSchema>
export type IdentityTelemetryKeyId = z.infer<typeof IdentityTelemetryKeyIdSchema>
export type IdentityTelemetryPurpose = z.infer<typeof IdentityTelemetryPurposeSchema>
export type IdentityTelemetryEvent = z.infer<typeof IdentityTelemetryEventSchema>
export type IdentityTelemetrySignature = z.infer<typeof IdentityTelemetrySignatureSchema>
export type SignedIdentityTelemetry = z.infer<typeof SignedIdentityTelemetrySchema>
export type IdentityTelemetryPrincipal = z.output<typeof IdentityTelemetryPrincipalSchema>
export type VerifiedIdentityTelemetry = z.output<typeof VerifiedIdentityTelemetrySchema>

import { createHmac } from 'node:crypto'

import {
  IdentityTelemetryEventSchema,
  SignedIdentityTelemetrySchema,
  identityTelemetrySignaturePayload,
  type IdentityTelemetryEvent,
  type SignedIdentityTelemetry,
} from '@trash-palace/core'

export type IdentityTelemetrySigningKey = string | Uint8Array

export interface SignIdentityTelemetryOptions {
  readonly keyId: string
  readonly key: IdentityTelemetrySigningKey
  readonly timestamp: string
}

export function signIdentityTelemetry(
  eventInput: IdentityTelemetryEvent,
  options: SignIdentityTelemetryOptions,
): SignedIdentityTelemetry {
  const event = IdentityTelemetryEventSchema.parse(eventInput)
  const timestamp = new Date(parseInstant(options.timestamp)).toISOString()
  const digest = createHmac('sha256', keyBytes(options.key))
    .update(
      identityTelemetrySignaturePayload({
        event,
        keyId: options.keyId,
        timestamp,
      }),
    )
    .digest('hex')
  return SignedIdentityTelemetrySchema.parse({
    event,
    signature: {
      version: 'v1',
      algorithm: 'hmac-sha256',
      keyId: options.keyId,
      timestamp,
      nonce: event.nonce,
      digest,
    },
  })
}

function keyBytes(input: IdentityTelemetrySigningKey): Uint8Array {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Uint8Array.from(input)
  if (bytes.byteLength < 32) {
    throw new TypeError('Identity telemetry signing keys require at least 32 bytes')
  }
  return bytes
}

function parseInstant(input: string): number {
  const value = Date.parse(input)
  if (!Number.isFinite(value)) throw new TypeError('Identity telemetry signing time must be valid')
  return value
}

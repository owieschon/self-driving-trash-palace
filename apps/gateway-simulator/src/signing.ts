import { createHmac, timingSafeEqual } from 'node:crypto'

import {
  GatewayCallbackSchema,
  SignedGatewayCallbackSchema,
  computeGatewayCallbackPayloadHash,
  gatewayCallbackSignaturePayload,
  type GatewayCallback,
  type SignedGatewayCallback,
} from './contracts.js'
import {
  IsoDateTimeSchema,
  OrganizationIdSchema,
  type OrganizationId,
  type Sha256,
} from '@trash-palace/core'

export type GatewaySigningKey = string | Uint8Array

export interface AuthenticatedGatewayPrincipal {
  readonly id: string
  readonly organizationId: OrganizationId
}

export interface GatewayVerificationKeyRecord {
  readonly key: GatewaySigningKey
  readonly keyVersion: number
  readonly purpose: 'gateway_callback' | 'identity_telemetry'
  readonly principal: AuthenticatedGatewayPrincipal
  readonly activeFrom?: string
  readonly expiresAt?: string
  readonly revokedAt?: string
}

export type GatewayVerificationKeyring = Readonly<Record<string, GatewayVerificationKeyRecord>>

export interface SignGatewayCallbackOptions {
  readonly keyId: string
  readonly key: GatewaySigningKey
  readonly timestamp: string
}

export interface VerifyGatewayCallbackOptions {
  readonly keyring: GatewayVerificationKeyring
  readonly now: Date | number | string
  readonly maximumAgeMilliseconds?: number
  readonly futureToleranceMilliseconds?: number
}

export interface VerifiedGatewayCallbackReceipt {
  readonly callback: GatewayCallback
  readonly authenticatedPrincipal: AuthenticatedGatewayPrincipal
  readonly verifierKeyId: string
  readonly verifierKeyVersion: number
  readonly verifierVersion: 1
  readonly signatureTimestamp: string
  readonly verifiedPayloadDigest: Sha256
}

export type GatewaySignatureErrorCode =
  | 'INVALID_ENVELOPE'
  | 'UNKNOWN_KEY'
  | 'INVALID_KEY'
  | 'WRONG_KEY_PURPOSE'
  | 'KEY_NOT_ACTIVE'
  | 'KEY_EXPIRED'
  | 'KEY_REVOKED'
  | 'PRINCIPAL_BINDING_MISMATCH'
  | 'NONCE_MISMATCH'
  | 'SIGNATURE_EXPIRED'
  | 'SIGNATURE_FROM_FUTURE'
  | 'SIGNATURE_MISMATCH'

export class GatewaySignatureError extends Error {
  public readonly code: GatewaySignatureErrorCode

  public constructor(code: GatewaySignatureErrorCode, message: string) {
    super(message)
    this.name = 'GatewaySignatureError'
    this.code = code
  }
}

function keyBytes(input: GatewaySigningKey): Uint8Array {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Uint8Array.from(input)
  if (bytes.byteLength < 32) {
    throw new GatewaySignatureError(
      'INVALID_KEY',
      'Gateway callback keys require at least 32 bytes',
    )
  }
  return bytes
}

function parseInstant(input: Date | number | string): number {
  const value =
    input instanceof Date ? input.valueOf() : typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(value)) throw new TypeError('Signature comparison time must be valid')
  return value
}

export function signGatewayCallback(
  callbackInput: GatewayCallback,
  options: SignGatewayCallbackOptions,
): SignedGatewayCallback {
  const callback = GatewayCallbackSchema.parse(callbackInput)
  const timestamp = new Date(parseInstant(options.timestamp)).toISOString()
  const digest = createHmac('sha256', keyBytes(options.key))
    .update(gatewayCallbackSignaturePayload(callback, options.keyId, timestamp))
    .digest('hex')
  return SignedGatewayCallbackSchema.parse({
    callback,
    signature: {
      version: 'v1',
      algorithm: 'hmac-sha256',
      keyId: options.keyId,
      timestamp,
      nonce: callback.nonce,
      digest,
    },
  })
}

export function verifyGatewayCallback(
  input: unknown,
  options: VerifyGatewayCallbackOptions,
): GatewayCallback {
  return authenticateGatewayCallback(input, options).callback
}

function authenticateGatewayCallback(
  input: unknown,
  options: VerifyGatewayCallbackOptions,
): VerifiedGatewayCallbackReceipt {
  const parsed = SignedGatewayCallbackSchema.safeParse(input)
  if (!parsed.success) {
    throw new GatewaySignatureError('INVALID_ENVELOPE', 'Gateway callback envelope is malformed')
  }
  const signed = parsed.data
  if (signed.signature.nonce !== signed.callback.nonce) {
    throw new GatewaySignatureError(
      'NONCE_MISMATCH',
      'Signature nonce does not match callback nonce',
    )
  }

  const keyRecord = options.keyring[signed.signature.keyId]
  if (keyRecord === undefined) {
    throw new GatewaySignatureError('UNKNOWN_KEY', 'Gateway callback key ID is not trusted')
  }
  const trustedKey = parseVerificationKeyRecord(keyRecord)
  if (trustedKey.purpose !== 'gateway_callback') {
    throw new GatewaySignatureError(
      'WRONG_KEY_PURPOSE',
      'Gateway callback key is not authorized for callback verification',
    )
  }

  const maximumAgeMilliseconds = options.maximumAgeMilliseconds ?? 5 * 60 * 1_000
  const futureToleranceMilliseconds = options.futureToleranceMilliseconds ?? 30_000
  if (
    !Number.isInteger(maximumAgeMilliseconds) ||
    maximumAgeMilliseconds < 0 ||
    maximumAgeMilliseconds > 15 * 60 * 1_000 ||
    !Number.isInteger(futureToleranceMilliseconds) ||
    futureToleranceMilliseconds < 0 ||
    futureToleranceMilliseconds > 60_000
  ) {
    throw new RangeError('Gateway signature time bounds are invalid')
  }

  const now = parseInstant(options.now)
  const timestamp = Date.parse(signed.signature.timestamp)
  assertKeyIsCurrent(trustedKey, now, timestamp)
  if (now - timestamp > maximumAgeMilliseconds) {
    throw new GatewaySignatureError('SIGNATURE_EXPIRED', 'Gateway callback signature is expired')
  }
  if (timestamp - now > futureToleranceMilliseconds) {
    throw new GatewaySignatureError(
      'SIGNATURE_FROM_FUTURE',
      'Gateway callback signature is too far in the future',
    )
  }

  const expected = createHmac('sha256', keyBytes(trustedKey.key))
    .update(
      gatewayCallbackSignaturePayload(
        signed.callback,
        signed.signature.keyId,
        signed.signature.timestamp,
      ),
    )
    .digest()
  const received = Buffer.from(signed.signature.digest, 'hex')
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
    throw new GatewaySignatureError('SIGNATURE_MISMATCH', 'Gateway callback signature is invalid')
  }
  if (signed.callback.organizationId !== trustedKey.principal.organizationId) {
    throw new GatewaySignatureError(
      'PRINCIPAL_BINDING_MISMATCH',
      'Gateway callback organization does not match the authenticated gateway principal',
    )
  }
  return {
    callback: signed.callback,
    authenticatedPrincipal: trustedKey.principal,
    verifierKeyId: signed.signature.keyId,
    verifierKeyVersion: trustedKey.keyVersion,
    verifierVersion: 1,
    signatureTimestamp: signed.signature.timestamp,
    verifiedPayloadDigest: computeGatewayCallbackPayloadHash(signed.callback),
  }
}

export function verifyGatewayCallbackWithReceipt(
  input: unknown,
  options: VerifyGatewayCallbackOptions,
): VerifiedGatewayCallbackReceipt {
  return authenticateGatewayCallback(input, options)
}

function parseVerificationKeyRecord(input: unknown): GatewayVerificationKeyRecord {
  try {
    if (typeof input !== 'object' || input === null) {
      throw new TypeError('Gateway verification key metadata is invalid')
    }
    const candidate = input as Record<string, unknown>
    const principalInput = candidate.principal
    if (typeof principalInput !== 'object' || principalInput === null) {
      throw new TypeError('Gateway verification principal metadata is invalid')
    }
    const principalCandidate = principalInput as Record<string, unknown>
    if (
      (typeof candidate.key !== 'string' && !(candidate.key instanceof Uint8Array)) ||
      !Number.isSafeInteger(candidate.keyVersion) ||
      (candidate.keyVersion as number) < 1 ||
      (candidate.purpose !== 'gateway_callback' && candidate.purpose !== 'identity_telemetry') ||
      typeof principalCandidate.id !== 'string' ||
      !/^gwp_[A-Za-z0-9_-]{8,64}$/.test(principalCandidate.id)
    ) {
      throw new TypeError('Gateway verification key metadata is invalid')
    }
    const principal = {
      id: principalCandidate.id,
      organizationId: OrganizationIdSchema.parse(principalCandidate.organizationId),
    }
    const optionalDates = {
      activeFrom: candidate.activeFrom,
      expiresAt: candidate.expiresAt,
      revokedAt: candidate.revokedAt,
    }
    for (const value of Object.values(optionalDates)) {
      if (value !== undefined && typeof value !== 'string') {
        throw new TypeError('Gateway verification key dates must be strings')
      }
      if (value !== undefined) IsoDateTimeSchema.parse(value)
    }
    return {
      key: candidate.key,
      keyVersion: candidate.keyVersion as number,
      purpose: candidate.purpose,
      principal,
      ...(typeof optionalDates.activeFrom === 'string'
        ? { activeFrom: optionalDates.activeFrom }
        : {}),
      ...(typeof optionalDates.expiresAt === 'string'
        ? { expiresAt: optionalDates.expiresAt }
        : {}),
      ...(typeof optionalDates.revokedAt === 'string'
        ? { revokedAt: optionalDates.revokedAt }
        : {}),
    }
  } catch {
    throw new GatewaySignatureError('INVALID_KEY', 'Gateway verification key metadata is invalid')
  }
}

function assertKeyIsCurrent(
  key: GatewayVerificationKeyRecord,
  now: number,
  signedAt: number,
): void {
  if (
    key.activeFrom !== undefined &&
    (now < Date.parse(key.activeFrom) || signedAt < Date.parse(key.activeFrom))
  ) {
    throw new GatewaySignatureError('KEY_NOT_ACTIVE', 'Gateway callback key is not active')
  }
  if (
    key.expiresAt !== undefined &&
    (now >= Date.parse(key.expiresAt) || signedAt >= Date.parse(key.expiresAt))
  ) {
    throw new GatewaySignatureError('KEY_EXPIRED', 'Gateway callback key is expired')
  }
  if (
    key.revokedAt !== undefined &&
    (now >= Date.parse(key.revokedAt) || signedAt >= Date.parse(key.revokedAt))
  ) {
    throw new GatewaySignatureError('KEY_REVOKED', 'Gateway callback key is revoked')
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto'

import {
  IdentityTelemetryPrincipalSchema,
  SignedIdentityTelemetrySchema,
  VerifiedIdentityTelemetrySchema,
  computeIdentityTelemetryPayloadHash,
  deriveIdentityTelemetryEvidenceId,
  deriveIdentityTelemetryReceiptId,
  identityTelemetrySignaturePayload,
  type IdentityTelemetryEvent,
} from '@trash-palace/core'

import { ApplicationError, ConflictError, NotFoundError } from './errors.js'
import {
  IdentityArrivalExecutionEnqueueResultSchema,
  IdentityTelemetryIngressProvenanceSchema,
  type IdentityArrivalExecutionEnqueueResult,
  type IdentityTelemetryIngestionResult,
  type IdentityTelemetryVerificationKey,
} from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import { SYSTEM_CLOCK, iso } from './primitives.js'
import type {
  ClockPort,
  IdentityTelemetryIngressUnitOfWorkPort,
  IdentityTelemetryKeyResolverPort,
  IdentityTelemetryVerifierPort,
} from './ports.js'
import { PersistedEvidenceRecordSchema } from '@trash-palace/core'

const DEFAULT_MAXIMUM_AGE_MILLISECONDS = 5 * 60 * 1_000
const DEFAULT_FUTURE_TOLERANCE_MILLISECONDS = 30_000

export type IdentityTelemetryVerificationErrorCode =
  | 'IDENTITY_TELEMETRY_EVENT_EXPIRED'
  | 'IDENTITY_TELEMETRY_EVENT_FROM_FUTURE'
  | 'IDENTITY_TELEMETRY_INVALID_ENVELOPE'
  | 'IDENTITY_TELEMETRY_INVALID_KEY'
  | 'IDENTITY_TELEMETRY_KEY_NOT_ACTIVE'
  | 'IDENTITY_TELEMETRY_KEY_REVOKED'
  | 'IDENTITY_TELEMETRY_NONCE_MISMATCH'
  | 'IDENTITY_TELEMETRY_SIGNATURE_EXPIRED'
  | 'IDENTITY_TELEMETRY_SIGNATURE_FROM_FUTURE'
  | 'IDENTITY_TELEMETRY_SIGNATURE_MISMATCH'
  | 'IDENTITY_TELEMETRY_TENANT_MISMATCH'
  | 'IDENTITY_TELEMETRY_UNKNOWN_KEY'
  | 'IDENTITY_TELEMETRY_WRONG_PURPOSE'

export class IdentityTelemetryVerificationError extends ApplicationError {
  public constructor(code: IdentityTelemetryVerificationErrorCode, message: string) {
    super(code, message)
    this.name = 'IdentityTelemetryVerificationError'
  }
}

export interface HmacIdentityTelemetryVerifierOptions {
  readonly maximumAgeMilliseconds?: number
  readonly eventMaximumAgeMilliseconds?: number
  readonly futureToleranceMilliseconds?: number
  readonly eventClock?: ClockPort
}

export class HmacIdentityTelemetryVerifier implements IdentityTelemetryVerifierPort {
  readonly #maximumAgeMilliseconds: number
  readonly #eventMaximumAgeMilliseconds: number
  readonly #futureToleranceMilliseconds: number
  readonly #eventClock: ClockPort

  public constructor(
    private readonly keys: IdentityTelemetryKeyResolverPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    options: HmacIdentityTelemetryVerifierOptions = {},
  ) {
    this.#maximumAgeMilliseconds = validateDuration(
      options.maximumAgeMilliseconds ?? DEFAULT_MAXIMUM_AGE_MILLISECONDS,
      15 * 60 * 1_000,
      'maximum identity telemetry age',
    )
    this.#eventMaximumAgeMilliseconds = validateDuration(
      options.eventMaximumAgeMilliseconds ?? this.#maximumAgeMilliseconds,
      4 * 60 * 60 * 1_000,
      'maximum identity telemetry event age',
    )
    this.#futureToleranceMilliseconds = validateDuration(
      options.futureToleranceMilliseconds ?? DEFAULT_FUTURE_TOLERANCE_MILLISECONDS,
      60_000,
      'identity telemetry future tolerance',
    )
    this.#eventClock = options.eventClock ?? clock
  }

  public async verify(raw: unknown) {
    const parsed = SignedIdentityTelemetrySchema.safeParse(raw)
    if (!parsed.success) {
      throw new IdentityTelemetryVerificationError(
        'IDENTITY_TELEMETRY_INVALID_ENVELOPE',
        'Identity telemetry envelope is malformed',
      )
    }
    const signed = parsed.data
    if (signed.signature.nonce !== signed.event.nonce) {
      throw new IdentityTelemetryVerificationError(
        'IDENTITY_TELEMETRY_NONCE_MISMATCH',
        'Identity telemetry signature nonce does not match its event',
      )
    }

    const resolved = await this.keys.resolve(signed.signature.keyId)
    if (resolved === null) {
      throw new IdentityTelemetryVerificationError(
        'IDENTITY_TELEMETRY_UNKNOWN_KEY',
        'Identity telemetry signing key is not trusted',
      )
    }
    if (resolved.principal.purpose !== 'identity_telemetry_ingress') {
      throw new IdentityTelemetryVerificationError(
        'IDENTITY_TELEMETRY_WRONG_PURPOSE',
        'Signing key is not authorized for identity telemetry ingress',
      )
    }

    const key = verifiedKey(resolved, signed.signature.keyId)
    const securityNow = this.clock.now().valueOf()
    if (!Number.isFinite(securityNow)) {
      throw new TypeError('Identity telemetry security clock is invalid')
    }
    const signatureTimestamp = Date.parse(signed.signature.timestamp)
    assertFreshness(
      signatureTimestamp,
      securityNow,
      this.#maximumAgeMilliseconds,
      this.#futureToleranceMilliseconds,
      'SIGNATURE',
    )

    const validFrom = Date.parse(key.principal.validFrom)
    const expiresAt = Date.parse(key.principal.expiresAt)
    if (signatureTimestamp < validFrom || signatureTimestamp >= expiresAt) {
      throw new IdentityTelemetryVerificationError(
        'IDENTITY_TELEMETRY_KEY_NOT_ACTIVE',
        'Identity telemetry signing key was not active at the signed timestamp',
      )
    }
    if (key.principal.revokedAt !== null && securityNow >= Date.parse(key.principal.revokedAt)) {
      throw new IdentityTelemetryVerificationError(
        'IDENTITY_TELEMETRY_KEY_REVOKED',
        'Identity telemetry signing key is revoked',
      )
    }

    const expected = createHmac('sha256', key.keyBytes)
      .update(
        identityTelemetrySignaturePayload({
          event: signed.event,
          keyId: signed.signature.keyId,
          timestamp: signed.signature.timestamp,
        }),
      )
      .digest()
    const received = Buffer.from(signed.signature.digest, 'hex')
    if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
      throw new IdentityTelemetryVerificationError(
        'IDENTITY_TELEMETRY_SIGNATURE_MISMATCH',
        'Identity telemetry signature is invalid',
      )
    }
    if (
      signed.event.organizationId !== key.principal.organizationId ||
      signed.event.palaceId !== key.principal.palaceId
    ) {
      throw new IdentityTelemetryVerificationError(
        'IDENTITY_TELEMETRY_TENANT_MISMATCH',
        'Identity telemetry does not match its trusted tenant scope',
      )
    }

    const eventNow = this.#eventClock.now().valueOf()
    if (!Number.isFinite(eventNow)) throw new TypeError('Identity telemetry event clock is invalid')
    assertFreshness(
      Date.parse(signed.event.observedAt),
      eventNow,
      this.#eventMaximumAgeMilliseconds,
      this.#futureToleranceMilliseconds,
      'EVENT',
    )

    return VerifiedIdentityTelemetrySchema.parse({
      event: signed.event,
      principal: key.principal,
      signatureTimestamp: signed.signature.timestamp,
      verifiedPayloadHash: computeIdentityTelemetryPayloadHash(signed.event),
      verifierVersion: 1,
    })
  }
}

export class IdentityTelemetryIngressService<RawTelemetry = unknown> {
  public constructor(
    private readonly unitOfWork: IdentityTelemetryIngressUnitOfWorkPort,
    private readonly verifier: IdentityTelemetryVerifierPort<RawTelemetry>,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
  ) {}

  public async ingest(raw: RawTelemetry): Promise<IdentityTelemetryIngestionResult> {
    const verified = VerifiedIdentityTelemetrySchema.parse(await this.verifier.verify(raw))
    const receivedAt = iso(this.clock.now())
    const event = verified.event
    return this.observability.trace(
      {
        name: 'domain.identity-telemetry.ingest',
        kind: 'domain',
        correlation: {
          organizationId: verified.principal.organizationId,
          missionId: event.missionId,
        },
      },
      () =>
        this.unitOfWork.runIdentityTelemetry(
          verified.principal.organizationId,
          async (repositories) => {
            const mission = await repositories.missions.get(event.missionId)
            if (mission === null) throw new NotFoundError('Identity telemetry mission')
            if (
              mission.organizationId !== verified.principal.organizationId ||
              mission.palaceId !== verified.principal.palaceId ||
              event.organizationId !== mission.organizationId ||
              event.palaceId !== mission.palaceId
            ) {
              throw new ConflictError('Identity telemetry mission and palace bindings do not match')
            }

            const subject = await repositories.identitySubjects.get({
              palaceId: event.palaceId,
              identityTagId: event.identityTagId,
            })
            if (subject === null) throw new NotFoundError('Identity telemetry tag')
            const { crew, tag } = subject
            const identityVerified =
              tag.active &&
              tag.verified &&
              crew !== null &&
              crew.active &&
              crew.organizationId === event.organizationId &&
              crew.palaceId === event.palaceId

            const evidenceId = deriveIdentityTelemetryEvidenceId(event)
            const authorityReceiptId = deriveIdentityTelemetryReceiptId(event)
            const record = PersistedEvidenceRecordSchema.parse({
              evidence: {
                id: evidenceId,
                organizationId: event.organizationId,
                missionId: event.missionId,
                palaceId: event.palaceId,
                observedAt: event.observedAt,
                type: 'identity_arrival',
                identityTagId: event.identityTagId,
                verified: identityVerified,
              },
              authorityReceipt: {
                schemaVersion: 'evidence-authority-receipt@2',
                id: authorityReceiptId,
                evidenceId,
                organizationId: event.organizationId,
                missionId: event.missionId,
                palaceId: event.palaceId,
                verifiedAt: receivedAt,
                authority: 'identity_telemetry',
                providerEventId: event.providerEventId,
                identityTagId: event.identityTagId,
                principalId: verified.principal.principalId,
                keyId: verified.principal.keyId,
                keyVersion: verified.principal.keyVersion,
                verifiedPayloadHash: verified.verifiedPayloadHash,
                verifierVersion: verified.verifierVersion,
                authenticityVerified: true,
                tenantBindingVerified: true,
                purposeVerified: true,
              },
              persistedAt: receivedAt,
            })
            const provenance = IdentityTelemetryIngressProvenanceSchema.parse({
              schemaVersion: 'identity-telemetry-ingress@1',
              providerEventId: event.providerEventId,
              organizationId: event.organizationId,
              missionId: event.missionId,
              palaceId: event.palaceId,
              identityTagId: event.identityTagId,
              nonce: event.nonce,
              principalId: verified.principal.principalId,
              keyId: verified.principal.keyId,
              keyVersion: verified.principal.keyVersion,
              verifiedPayloadHash: verified.verifiedPayloadHash,
              signatureTimestamp: verified.signatureTimestamp,
              verifiedAt: receivedAt,
              evidenceId,
              authorityReceiptId,
              identityVerified,
            })
            const persisted = await repositories.evidence.appendVerified({ record, provenance })
            if (
              persisted.record.evidence.type !== 'identity_arrival' ||
              persisted.record.authorityReceipt.authority !== 'identity_telemetry'
            ) {
              throw new ConflictError('Identity telemetry repository returned unrelated evidence')
            }
            const executionJobs = persisted.record.evidence.verified
              ? validateExecutionJobs(
                  await repositories.executionTriggers.enqueueVerifiedArrival({
                    record: persisted.record,
                    availableAt: persisted.record.persistedAt,
                  }),
                  event,
                  persisted.record.evidence.id,
                )
              : []
            await this.observability.record({
              name: 'identity telemetry accepted',
              occurredAt: receivedAt,
              correlation: {
                organizationId: event.organizationId,
                missionId: event.missionId,
              },
              attributes: {
                identity_verified: identityVerified,
                ingestion_status: persisted.status,
              },
            })
            return { ...persisted, event, executionJobs }
          },
        ),
    )
  }
}

function validateExecutionJobs(
  input: readonly IdentityArrivalExecutionEnqueueResult[],
  event: IdentityTelemetryEvent,
  evidenceId: string,
): readonly IdentityArrivalExecutionEnqueueResult[] {
  const jobs = input.map((job) => IdentityArrivalExecutionEnqueueResultSchema.parse(job))
  const operations = new Set<string>()
  const executions = new Set<string>()
  const outboxIds = new Set<string>()
  for (const job of jobs) {
    if (
      job.reference.organizationId !== event.organizationId ||
      job.reference.missionId !== event.missionId ||
      job.reference.evidenceId !== evidenceId
    ) {
      throw new ConflictError('Identity-arrival execution job is not bound to its ingress event')
    }
    if (
      operations.has(job.reference.operationId) ||
      executions.has(job.reference.executionId) ||
      outboxIds.has(job.outboxId)
    ) {
      throw new ConflictError('Identity-arrival execution job set contains duplicate bindings')
    }
    operations.add(job.reference.operationId)
    executions.add(job.reference.executionId)
    outboxIds.add(job.outboxId)
  }
  return jobs
}

function verifiedKey(
  input: IdentityTelemetryVerificationKey,
  expectedKeyId: string,
): {
  readonly principal: ReturnType<typeof IdentityTelemetryPrincipalSchema.parse>
  readonly keyBytes: Uint8Array
} {
  const parsed = IdentityTelemetryPrincipalSchema.safeParse(input.principal)
  if (!parsed.success || parsed.data.keyId !== expectedKeyId) {
    throw new IdentityTelemetryVerificationError(
      'IDENTITY_TELEMETRY_INVALID_KEY',
      'Identity telemetry key metadata is invalid',
    )
  }
  const keyBytes =
    typeof input.key === 'string' ? Buffer.from(input.key, 'utf8') : Uint8Array.from(input.key)
  if (keyBytes.byteLength < 32) {
    throw new IdentityTelemetryVerificationError(
      'IDENTITY_TELEMETRY_INVALID_KEY',
      'Identity telemetry signing keys require at least 32 bytes',
    )
  }
  return { principal: parsed.data, keyBytes }
}

function validateDuration(value: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} is outside its supported bound`)
  }
  return value
}

function assertFreshness(
  timestamp: number,
  now: number,
  maximumAgeMilliseconds: number,
  futureToleranceMilliseconds: number,
  kind: 'EVENT' | 'SIGNATURE',
): void {
  if (now - timestamp > maximumAgeMilliseconds) {
    throw new IdentityTelemetryVerificationError(
      `IDENTITY_TELEMETRY_${kind}_EXPIRED`,
      `Identity telemetry ${kind.toLowerCase()} is expired`,
    )
  }
  if (timestamp - now > futureToleranceMilliseconds) {
    throw new IdentityTelemetryVerificationError(
      `IDENTITY_TELEMETRY_${kind}_FROM_FUTURE`,
      `Identity telemetry ${kind.toLowerCase()} is too far in the future`,
    )
  }
}

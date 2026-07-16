import { createHmac } from 'node:crypto'

import {
  CrewMemberSchema,
  ExecutionIdSchema,
  IdentityTagSchema,
  IdentityTelemetryEventSchema,
  MissionSchema,
  OperationIdSchema,
  SignedIdentityTelemetrySchema,
  identityTelemetrySignaturePayload,
  type CrewMember,
  type IdentityTag,
  type SignedIdentityTelemetry,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { ConflictError } from '../errors.js'
import {
  IdentityArrivalExecutionJobHandler,
  type PersistedEvidenceExecutionService,
} from '../execution-materialization-service.js'
import {
  HmacIdentityTelemetryVerifier,
  IdentityTelemetryIngressService,
} from '../identity-telemetry-service.js'
import type {
  IdentityArrivalExecutionEnqueueResult,
  IdentityTelemetryEvidenceAppendResult,
  IdentityTelemetryIngressProvenance,
  IdentityTelemetryVerificationKey,
} from '../models.js'
import {
  IDENTITY_ARRIVAL_EXECUTION_TOPIC,
  IdentityArrivalExecutionEnqueueResultSchema,
  IdentityArrivalExecutionReferenceSchema,
  identityArrivalExecutionOutboxIdentity,
} from '../models.js'
import type {
  ClockPort,
  IdentityTelemetryIngressRepositories,
  IdentityTelemetryIngressUnitOfWorkPort,
  IdentityTelemetryKeyResolverPort,
} from '../ports.js'

const AT = '2026-08-14T05:58:00.000Z'
const KEY_ID = 'itk_primary_gateway'
const KEY = 'primary-identity-telemetry-key-with-32-bytes'

const mission = MissionSchema.parse({
  id: 'mis_night_shift_home',
  organizationId: 'org_rocky_roost',
  palaceId: 'pal_sacred_dumpster',
  initiatedBy: 'usr_rocky_founder',
  objective: 'Operate the night-shift homecoming routine',
  constraints: {
    preheatBy: '02:00',
    requireVerifiedIdentityForUnlock: true,
    pathwayLightingBeginsAfter: 'verified_arrival',
    projectedBatteryUseMaxPercentagePoints: 15,
  },
  successCriteriaIds: ['verified_identity_required_for_unlock'],
  state: { status: 'running', phase: 'execute' },
  version: 1,
  runId: null,
  contextReceiptId: null,
  taskLedger: [],
  createdAt: AT,
  updatedAt: AT,
})

const crew = CrewMemberSchema.parse({
  id: 'crew_rocky_resident',
  organizationId: mission.organizationId,
  palaceId: mission.palaceId,
  userId: 'usr_rocky_founder',
  displayName: 'Rocky',
  active: true,
})

const tag = IdentityTagSchema.parse({
  id: 'tag_rocky_verified',
  organizationId: mission.organizationId,
  crewMemberId: crew.id,
  label: 'Rocky verified tag',
  verified: true,
  active: true,
  version: 1,
})

const event = IdentityTelemetryEventSchema.parse({
  schemaVersion: 'identity-telemetry-event@1',
  providerEventId: 'idt_application_arrival_01',
  organizationId: mission.organizationId,
  missionId: mission.id,
  palaceId: mission.palaceId,
  identityTagId: tag.id,
  observedAt: AT,
  nonce: 'itn_application_arrival_nonce_01',
})

const executionBinding = {
  operationId: OperationIdSchema.parse('op_identity_arrival_execution'),
  executionId: ExecutionIdSchema.parse('exe_identity_arrival_execution'),
}

class FixedClock implements ClockPort {
  public constructor(private readonly value: string = AT) {}

  public now(): Date {
    return new Date(this.value)
  }
}

class StaticKeyResolver implements IdentityTelemetryKeyResolverPort {
  public constructor(private readonly resolved: IdentityTelemetryVerificationKey | null = key()) {}

  public resolve(keyId: string) {
    return Promise.resolve(this.resolved?.principal.keyId === keyId ? this.resolved : null)
  }
}

class IdentityIngressMemory implements IdentityTelemetryIngressUnitOfWorkPort {
  readonly #byProviderEvent = new Map<string, IdentityTelemetryEvidenceAppendResult>()
  readonly #providerByNonce = new Map<string, string>()
  readonly #executionJobs = new Map<string, IdentityArrivalExecutionEnqueueResult>()

  public constructor(
    private readonly currentCrew: readonly CrewMember[] = [crew],
    private readonly currentTags: readonly IdentityTag[] = [tag],
    private readonly executionBindings: readonly (typeof executionBinding)[] = [],
    private readonly schedulingFailure: 'cross_mission' | 'throw' | null = null,
  ) {}

  public get records(): readonly IdentityTelemetryEvidenceAppendResult[] {
    return [...this.#byProviderEvent.values()]
  }

  public get executionJobs(): readonly IdentityArrivalExecutionEnqueueResult[] {
    return [...this.#executionJobs.values()]
  }

  public dropExecutionJobs(): void {
    this.#executionJobs.clear()
  }

  public async runIdentityTelemetry<Result>(
    organizationId: typeof mission.organizationId,
    work: (repositories: IdentityTelemetryIngressRepositories) => Promise<Result>,
  ): Promise<Result> {
    if (organizationId !== mission.organizationId) throw new ConflictError('Wrong tenant')
    const snapshot = {
      events: new Map(this.#byProviderEvent),
      nonces: new Map(this.#providerByNonce),
      jobs: new Map(this.#executionJobs),
    }
    try {
      return await work({
        missions: {
          get: (missionId) => Promise.resolve(missionId === mission.id ? mission : null),
        },
        identitySubjects: {
          get: ({ identityTagId, palaceId }) => {
            const currentTag = this.currentTags.find((candidate) => candidate.id === identityTagId)
            if (currentTag === undefined || palaceId !== mission.palaceId)
              return Promise.resolve(null)
            const currentCrewMember = this.currentCrew.find(
              (candidate) => candidate.id === currentTag.crewMemberId,
            )
            return Promise.resolve({ tag: currentTag, crew: currentCrewMember ?? null })
          },
        },
        evidence: {
          appendVerified: (input) => Promise.resolve(this.append(input.record, input.provenance)),
        },
        executionTriggers: {
          enqueueVerifiedArrival: ({ record }) => Promise.resolve(this.enqueue(record)),
        },
      })
    } catch (error) {
      replaceMap(this.#byProviderEvent, snapshot.events)
      replaceMap(this.#providerByNonce, snapshot.nonces)
      replaceMap(this.#executionJobs, snapshot.jobs)
      throw error
    }
  }

  private append(
    record: IdentityTelemetryEvidenceAppendResult['record'],
    provenance: IdentityTelemetryIngressProvenance,
  ): IdentityTelemetryEvidenceAppendResult {
    const existing = this.#byProviderEvent.get(provenance.providerEventId)
    if (existing !== undefined) {
      if (
        JSON.stringify(existing.record) !== JSON.stringify(record) ||
        JSON.stringify(existing.provenance) !== JSON.stringify(provenance)
      ) {
        throw new ConflictError('Provider event was reused with changed content')
      }
      return { ...existing, status: 'duplicate' }
    }
    const nonceOwner = this.#providerByNonce.get(provenance.nonce)
    if (nonceOwner !== undefined && nonceOwner !== provenance.providerEventId) {
      throw new ConflictError('Identity telemetry nonce was reused')
    }
    const stored = { status: 'stored' as const, record, provenance }
    this.#providerByNonce.set(provenance.nonce, provenance.providerEventId)
    this.#byProviderEvent.set(provenance.providerEventId, stored)
    return stored
  }

  private enqueue(
    record: IdentityTelemetryEvidenceAppendResult['record'],
  ): readonly IdentityArrivalExecutionEnqueueResult[] {
    if (this.schedulingFailure === 'throw') throw new ConflictError('Execution scheduling failed')
    return this.executionBindings.map((binding) => {
      const reference = IdentityArrivalExecutionReferenceSchema.parse({
        organizationId: record.evidence.organizationId,
        missionId:
          this.schedulingFailure === 'cross_mission'
            ? 'mis_foreign_identity_arrival'
            : record.evidence.missionId,
        operationId: binding.operationId,
        executionId: binding.executionId,
        evidenceId: record.evidence.id,
      })
      const identity = identityArrivalExecutionOutboxIdentity(reference)
      const existing = this.#executionJobs.get(identity.outboxId)
      if (existing !== undefined) return { ...existing, status: 'duplicate' as const }
      const result = IdentityArrivalExecutionEnqueueResultSchema.parse({
        topic: IDENTITY_ARRIVAL_EXECUTION_TOPIC,
        ...identity,
        reference,
        status: 'stored',
      })
      this.#executionJobs.set(result.outboxId, result)
      return result
    })
  }
}

function replaceMap<Key, Value>(target: Map<Key, Value>, source: Map<Key, Value>): void {
  target.clear()
  for (const [key, value] of source) target.set(key, value)
}

function key(overrides: Partial<IdentityTelemetryVerificationKey['principal']> = {}) {
  return {
    principal: {
      principalId: 'itp_primary_gateway',
      organizationId: mission.organizationId,
      palaceId: mission.palaceId,
      purpose: 'identity_telemetry_ingress',
      keyId: KEY_ID,
      keyVersion: 3,
      validFrom: '2026-08-14T00:00:00.000Z',
      expiresAt: '2026-08-15T00:00:00.000Z',
      revokedAt: null,
      ...overrides,
    },
    key: KEY,
  } as IdentityTelemetryVerificationKey
}

function sign(
  eventInput = event,
  options: { readonly key?: string; readonly keyId?: string; readonly timestamp?: string } = {},
): SignedIdentityTelemetry {
  const keyId = options.keyId ?? KEY_ID
  const timestamp = options.timestamp ?? AT
  return SignedIdentityTelemetrySchema.parse({
    event: eventInput,
    signature: {
      version: 'v1',
      algorithm: 'hmac-sha256',
      keyId,
      timestamp,
      nonce: eventInput.nonce,
      digest: createHmac('sha256', options.key ?? KEY)
        .update(identityTelemetrySignaturePayload({ event: eventInput, keyId, timestamp }))
        .digest('hex'),
    },
  })
}

function service(
  input: {
    readonly store?: IdentityIngressMemory
    readonly resolver?: IdentityTelemetryKeyResolverPort
    readonly clock?: ClockPort
  } = {},
) {
  const store = input.store ?? new IdentityIngressMemory()
  const clock = input.clock ?? new FixedClock()
  const verifier = new HmacIdentityTelemetryVerifier(
    input.resolver ?? new StaticKeyResolver(),
    clock,
  )
  return { ingress: new IdentityTelemetryIngressService(store, verifier, clock), store }
}

describe('identity telemetry verification and ingress', () => {
  it('mints a stable V2 authority receipt and derives the identity verdict server-side', async () => {
    const { ingress } = service()
    const first = await ingress.ingest(sign())
    const replay = await ingress.ingest(sign())

    expect(first.status).toBe('stored')
    expect(replay.status).toBe('duplicate')
    expect(replay.record).toEqual(first.record)
    expect(first.record.evidence).toMatchObject({ type: 'identity_arrival', verified: true })
    expect(first.record.authorityReceipt).toMatchObject({
      schemaVersion: 'evidence-authority-receipt@2',
      authority: 'identity_telemetry',
      principalId: 'itp_primary_gateway',
      keyId: KEY_ID,
      keyVersion: 3,
      authenticityVerified: true,
      tenantBindingVerified: true,
      purposeVerified: true,
    })
  })

  it('keeps signature freshness on the security clock while an event clock follows fixtures', async () => {
    const securityAt = '2026-08-20T05:58:00.000Z'
    const resolver = new StaticKeyResolver(
      key({
        validFrom: '2026-08-20T00:00:00.000Z',
        expiresAt: '2026-08-21T00:00:00.000Z',
      }),
    )
    const verifier = new HmacIdentityTelemetryVerifier(resolver, new FixedClock(securityAt), {
      eventClock: new FixedClock(AT),
    })

    await expect(verifier.verify(sign(event, { timestamp: securityAt }))).resolves.toMatchObject({
      event,
      signatureTimestamp: securityAt,
    })
    await expect(
      verifier.verify(sign(event, { timestamp: '2026-08-20T05:52:59.999Z' })),
    ).rejects.toMatchObject({ code: 'IDENTITY_TELEMETRY_SIGNATURE_EXPIRED' })

    const delayedEvent = IdentityTelemetryEventSchema.parse({
      ...event,
      providerEventId: 'idt_delayed_fixture_arrival_01',
      observedAt: '2026-08-14T05:35:00.000Z',
      nonce: 'itn_delayed_fixture_arrival_nonce_01',
    })
    const delayedVerifier = new HmacIdentityTelemetryVerifier(
      resolver,
      new FixedClock(securityAt),
      {
        eventClock: new FixedClock(AT),
        eventMaximumAgeMilliseconds: 2 * 60 * 60 * 1_000,
      },
    )
    await expect(
      delayedVerifier.verify(sign(delayedEvent, { timestamp: securityAt })),
    ).resolves.toMatchObject({ event: delayedEvent })
    await expect(
      new HmacIdentityTelemetryVerifier(new StaticKeyResolver(), new FixedClock()).verify(sign()),
    ).resolves.toMatchObject({ event, signatureTimestamp: AT })

    const orderedVerifier = new HmacIdentityTelemetryVerifier(resolver, new FixedClock(securityAt))
    const staleTampered = structuredClone(sign(event, { timestamp: securityAt }))
    staleTampered.event.observedAt = '2026-08-13T05:58:00.000Z'
    await expect(orderedVerifier.verify(staleTampered)).rejects.toMatchObject({
      code: 'IDENTITY_TELEMETRY_SIGNATURE_MISMATCH',
    })
    const staleForeign = IdentityTelemetryEventSchema.parse({
      ...event,
      providerEventId: 'idt_foreign_stale_arrival_01',
      organizationId: 'org_foreign_roost',
      palaceId: 'pal_foreign_dumpster',
      nonce: 'itn_foreign_stale_arrival_nonce_01',
    })
    await expect(
      orderedVerifier.verify(sign(staleForeign, { timestamp: securityAt })),
    ).rejects.toMatchObject({ code: 'IDENTITY_TELEMETRY_TENANT_MISMATCH' })
  })

  it('schedules one stable reference job and repairs the same identity on ingress replay', async () => {
    const store = new IdentityIngressMemory([crew], [tag], [executionBinding])
    const { ingress } = service({ store })

    const first = await ingress.ingest(sign())
    const replay = await ingress.ingest(sign())
    const firstJob = first.executionJobs[0]
    expect(firstJob).toMatchObject({
      topic: IDENTITY_ARRIVAL_EXECUTION_TOPIC,
      status: 'stored',
      reference: {
        organizationId: mission.organizationId,
        missionId: mission.id,
        operationId: executionBinding.operationId,
        executionId: executionBinding.executionId,
        evidenceId: first.record.evidence.id,
      },
    })
    expect(replay.executionJobs).toEqual([{ ...firstJob, status: 'duplicate' }])
    expect(store.executionJobs).toHaveLength(1)

    store.dropExecutionJobs()
    const repaired = await ingress.ingest(sign())
    expect(repaired.executionJobs).toEqual([firstJob])
    expect(store.executionJobs).toEqual([firstJob])
  })

  it('parses the strict worker reference before delegating to persisted evidence execution', async () => {
    const calls: Parameters<PersistedEvidenceExecutionService['apply']>[0][] = []
    const handler = new IdentityArrivalExecutionJobHandler({
      apply: (input) => {
        calls.push(input)
        return Promise.resolve({} as never)
      },
    })
    const reference = IdentityArrivalExecutionReferenceSchema.parse({
      organizationId: mission.organizationId,
      missionId: mission.id,
      operationId: executionBinding.operationId,
      executionId: executionBinding.executionId,
      evidenceId: 'evd_identity_arrival_job',
    })

    await handler.handle(reference)

    expect(calls).toEqual([reference])
    expect(() => handler.handle({ ...reference, rawEvidence: 'not reference-only' })).toThrow()
  })

  it.each(['throw', 'cross_mission'] as const)(
    'rolls evidence back when execution scheduling fails with %s',
    async (failure) => {
      const store = new IdentityIngressMemory([crew], [tag], [executionBinding], failure)
      await expect(service({ store }).ingress.ingest(sign())).rejects.toThrow()
      expect(store.records).toEqual([])
      expect(store.executionJobs).toEqual([])
    },
  )

  it.each([
    ['inactive tag', [{ ...tag, active: false }], [crew]],
    ['unverified tag', [{ ...tag, verified: false }], [crew]],
    ['inactive crew', [tag], [{ ...crew, active: false }]],
  ] as const)('persists %s as unverified evidence', async (_label, tags, crewMembers) => {
    const store = new IdentityIngressMemory(crewMembers, tags)
    const result = await service({ store }).ingress.ingest(sign())
    expect(result.record.evidence).toMatchObject({ type: 'identity_arrival', verified: false })
    expect(result.executionJobs).toEqual([])
    expect(store.executionJobs).toEqual([])
  })

  it.each([
    ['unsigned', {}],
    ['sender verdict', { ...sign(), event: { ...event, verified: true } }],
  ])('rejects %s input before persistence', async (_label, raw) => {
    const { ingress, store } = service()
    await expect(ingress.ingest(raw as SignedIdentityTelemetry)).rejects.toMatchObject({
      code: 'IDENTITY_TELEMETRY_INVALID_ENVELOPE',
    })
    expect(store.records).toHaveLength(0)
  })

  it('rejects tampering, nonce mismatch, stale timestamps, and future timestamps', async () => {
    const tampered = structuredClone(sign())
    tampered.event.observedAt = '2026-08-14T05:58:01.000Z'
    await expect(service().ingress.ingest(tampered)).rejects.toMatchObject({
      code: 'IDENTITY_TELEMETRY_SIGNATURE_MISMATCH',
    })

    const nonceMismatch = structuredClone(sign())
    nonceMismatch.signature.nonce = 'itn_changed_signature_nonce_01'
    await expect(service().ingress.ingest(nonceMismatch)).rejects.toMatchObject({
      code: 'IDENTITY_TELEMETRY_NONCE_MISMATCH',
    })

    const staleEvent = IdentityTelemetryEventSchema.parse({
      ...event,
      observedAt: '2026-08-14T05:52:59.999Z',
    })
    await expect(
      service().ingress.ingest(sign(staleEvent, { timestamp: staleEvent.observedAt })),
    ).rejects.toMatchObject({ code: 'IDENTITY_TELEMETRY_SIGNATURE_EXPIRED' })
    await expect(service().ingress.ingest(sign(staleEvent))).rejects.toMatchObject({
      code: 'IDENTITY_TELEMETRY_EVENT_EXPIRED',
    })

    const futureEvent = IdentityTelemetryEventSchema.parse({
      ...event,
      observedAt: '2026-08-14T05:58:30.001Z',
    })
    await expect(
      service().ingress.ingest(sign(futureEvent, { timestamp: futureEvent.observedAt })),
    ).rejects.toMatchObject({ code: 'IDENTITY_TELEMETRY_SIGNATURE_FROM_FUTURE' })
    await expect(service().ingress.ingest(sign(futureEvent))).rejects.toMatchObject({
      code: 'IDENTITY_TELEMETRY_EVENT_FROM_FUTURE',
    })
  })

  it('rejects unknown, wrong-purpose, revoked, and tenant-mismatched keys', async () => {
    await expect(
      service().ingress.ingest(sign(event, { keyId: 'itk_unknown_gateway' })),
    ).rejects.toMatchObject({ code: 'IDENTITY_TELEMETRY_UNKNOWN_KEY' })

    await expect(
      service({
        resolver: new StaticKeyResolver(key({ purpose: 'gateway_callback' })),
      }).ingress.ingest(sign()),
    ).rejects.toMatchObject({ code: 'IDENTITY_TELEMETRY_WRONG_PURPOSE' })

    await expect(
      service({ resolver: new StaticKeyResolver(key({ revokedAt: AT })) }).ingress.ingest(sign()),
    ).rejects.toMatchObject({ code: 'IDENTITY_TELEMETRY_KEY_REVOKED' })

    const foreign = IdentityTelemetryEventSchema.parse({
      ...event,
      organizationId: 'org_mirror_roost',
      palaceId: 'pal_mirror_dumpster',
    })
    await expect(service().ingress.ingest(sign(foreign))).rejects.toMatchObject({
      code: 'IDENTITY_TELEMETRY_TENANT_MISMATCH',
    })
  })

  it('rejects changed provider-event content, nonce reuse, and unknown tags', async () => {
    const { ingress, store } = service()
    await ingress.ingest(sign())
    const changed = IdentityTelemetryEventSchema.parse({
      ...event,
      nonce: 'itn_changed_provider_payload_01',
    })
    await expect(ingress.ingest(sign(changed))).rejects.toThrow(/reused with changed content/)

    const nonceReuse = IdentityTelemetryEventSchema.parse({
      ...event,
      providerEventId: 'idt_application_arrival_02',
    })
    await expect(ingress.ingest(sign(nonceReuse))).rejects.toThrow(/nonce was reused/)

    const unknownTag = IdentityTelemetryEventSchema.parse({
      ...event,
      providerEventId: 'idt_application_arrival_03',
      nonce: 'itn_unknown_tag_arrival_nonce_01',
      identityTagId: 'tag_unknown_identity',
    })
    await expect(ingress.ingest(sign(unknownTag))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(store.records).toHaveLength(1)
  })
})

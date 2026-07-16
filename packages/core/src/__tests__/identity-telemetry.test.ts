import { describe, expect, it } from 'vitest'

import {
  IdentityTelemetryEventSchema,
  PersistedEvidenceRecordSchema,
  computeIdentityTelemetryPayloadHash,
  deriveIdentityTelemetryEvidenceId,
  deriveIdentityTelemetryReceiptId,
  identityTelemetrySignaturePayload,
} from '../index.js'

const event = IdentityTelemetryEventSchema.parse({
  schemaVersion: 'identity-telemetry-event@1',
  providerEventId: 'idt_core_arrival_0001',
  organizationId: 'org_rocky_roost',
  missionId: 'mis_night_shift_home',
  palaceId: 'pal_sacred_dumpster',
  identityTagId: 'tag_rocky_verified',
  observedAt: '2026-08-14T05:58:00.000Z',
  nonce: 'itn_core_arrival_nonce_0001',
})

describe('identity telemetry contracts', () => {
  it('derives stable, tenant-separated evidence and receipt identities', () => {
    expect(deriveIdentityTelemetryEvidenceId(event)).toBe(deriveIdentityTelemetryEvidenceId(event))
    expect(deriveIdentityTelemetryReceiptId(event)).toBe(deriveIdentityTelemetryReceiptId(event))
    expect(deriveIdentityTelemetryEvidenceId(event)).not.toBe(
      deriveIdentityTelemetryEvidenceId(
        IdentityTelemetryEventSchema.parse({ ...event, organizationId: 'org_mirror_roost' }),
      ),
    )
    expect(deriveIdentityTelemetryEvidenceId(event)).not.toBe(
      deriveIdentityTelemetryReceiptId(event),
    )
  })

  it('hashes and signs every sender-owned identity field without accepting a verdict', () => {
    const changedTag = IdentityTelemetryEventSchema.parse({
      ...event,
      identityTagId: 'tag_unknown_arrival',
    })
    expect(computeIdentityTelemetryPayloadHash(event)).not.toBe(
      computeIdentityTelemetryPayloadHash(changedTag),
    )
    expect(
      identityTelemetrySignaturePayload({
        event,
        keyId: 'itk_core_primary',
        timestamp: event.observedAt,
      }),
    ).toContain(event.nonce)
    expect(IdentityTelemetryEventSchema.safeParse({ ...event, verified: true }).success).toBe(false)
  })

  it('accepts retained V1 receipts and binds new V2 receipts to verifier provenance', () => {
    const evidenceId = deriveIdentityTelemetryEvidenceId(event)
    const receiptId = deriveIdentityTelemetryReceiptId(event)
    const evidence = {
      id: evidenceId,
      organizationId: event.organizationId,
      missionId: event.missionId,
      palaceId: event.palaceId,
      observedAt: event.observedAt,
      type: 'identity_arrival' as const,
      identityTagId: event.identityTagId,
      verified: true,
    }
    const base = {
      id: receiptId,
      evidenceId,
      organizationId: event.organizationId,
      missionId: event.missionId,
      palaceId: event.palaceId,
      verifiedAt: event.observedAt,
      authority: 'identity_telemetry' as const,
      providerEventId: event.providerEventId,
      identityTagId: event.identityTagId,
      authenticityVerified: true as const,
      tenantBindingVerified: true as const,
    }
    expect(
      PersistedEvidenceRecordSchema.parse({
        evidence,
        authorityReceipt: base,
        persistedAt: event.observedAt,
      }).authorityReceipt.schemaVersion,
    ).toBe('evidence-authority-receipt@1')
    expect(
      PersistedEvidenceRecordSchema.parse({
        evidence,
        authorityReceipt: {
          ...base,
          schemaVersion: 'evidence-authority-receipt@2',
          principalId: 'itp_core_gateway',
          keyId: 'itk_core_primary',
          keyVersion: 1,
          verifiedPayloadHash: computeIdentityTelemetryPayloadHash(event),
          verifierVersion: 1,
          purposeVerified: true,
        },
        persistedAt: event.observedAt,
      }).authorityReceipt.schemaVersion,
    ).toBe('evidence-authority-receipt@2')
  })
})

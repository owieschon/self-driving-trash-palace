import { describe, expect, it } from 'vitest'

import { PersistedEvidenceRecordSchema } from '../index.js'

const AT = '2026-08-14T01:58:02-04:00'
const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const arrival = {
  id: 'evd_verified_arrival',
  organizationId: 'org_rocky_roost',
  missionId: 'mis_night_shift_home',
  palaceId: 'pal_sacred_dumpster',
  observedAt: AT,
  type: 'identity_arrival',
  identityTagId: 'tag_rocky_verified',
  verified: true,
} as const

const identityReceipt = {
  id: 'rcp_identity_authority',
  evidenceId: arrival.id,
  organizationId: arrival.organizationId,
  missionId: arrival.missionId,
  palaceId: arrival.palaceId,
  verifiedAt: AT,
  authority: 'identity_telemetry',
  providerEventId: 'idt_arrival_event_2026',
  identityTagId: arrival.identityTagId,
  authenticityVerified: true,
  tenantBindingVerified: true,
} as const

describe('persisted evidence authority', () => {
  it('retains verified identity telemetry provenance outside the wire evidence', () => {
    const record = PersistedEvidenceRecordSchema.parse({
      evidence: arrival,
      authorityReceipt: identityReceipt,
      persistedAt: AT,
    })

    expect(record.authorityReceipt.authority).toBe('identity_telemetry')
    expect('authority' in record.evidence).toBe(false)
  })

  it('rejects forged receipt bindings and unverified receipt metadata', () => {
    expect(
      PersistedEvidenceRecordSchema.safeParse({
        evidence: arrival,
        authorityReceipt: { ...identityReceipt, evidenceId: 'evd_other_arrival' },
        persistedAt: AT,
      }).success,
    ).toBe(false)
    expect(
      PersistedEvidenceRecordSchema.safeParse({
        evidence: arrival,
        authorityReceipt: { ...identityReceipt, authenticityVerified: false },
        persistedAt: AT,
      }).success,
    ).toBe(false)
    expect(
      PersistedEvidenceRecordSchema.safeParse({
        evidence: arrival,
        authorityReceipt: { ...identityReceipt, organizationId: 'org_foreign_tenant' },
        persistedAt: AT,
      }).success,
    ).toBe(false)
  })

  it('allows gateway evidence only with a verified callback and command binding', () => {
    const delivery = {
      id: 'evd_gateway_delivery',
      organizationId: arrival.organizationId,
      missionId: arrival.missionId,
      palaceId: arrival.palaceId,
      observedAt: AT,
      type: 'gateway_delivery',
      gatewayCommandId: 'gcmd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operationId: 'op_homecoming_effects',
      status: 'completed',
      code: null,
    } as const
    const receipt = {
      id: 'rcp_gateway_authority',
      evidenceId: delivery.id,
      organizationId: delivery.organizationId,
      missionId: delivery.missionId,
      palaceId: delivery.palaceId,
      verifiedAt: AT,
      authority: 'gateway_callback',
      callbackId: 'gcb_homecoming_completed',
      commandId: delivery.gatewayCommandId,
      verifiedPayloadHash: HASH,
      signatureVerified: true,
      commandBindingVerified: true,
    } as const

    expect(
      PersistedEvidenceRecordSchema.parse({
        evidence: delivery,
        authorityReceipt: receipt,
        persistedAt: AT,
      }).authorityReceipt.authority,
    ).toBe('gateway_callback')
    expect(
      PersistedEvidenceRecordSchema.safeParse({
        evidence: delivery,
        authorityReceipt: {
          ...receipt,
          commandId: 'gcmd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        persistedAt: AT,
      }).success,
    ).toBe(false)
  })

  it('does not let application receipts bless identity or gateway-owned evidence', () => {
    const applicationReceipt = {
      id: 'rcp_application_authority',
      evidenceId: arrival.id,
      organizationId: arrival.organizationId,
      missionId: arrival.missionId,
      palaceId: arrival.palaceId,
      verifiedAt: AT,
      authority: 'application',
      producer: 'application_code',
      ruleId: 'homecoming.identity',
      ruleVersion: 1,
      inputEvidenceIds: [],
      derivationVerified: true,
    } as const

    expect(
      PersistedEvidenceRecordSchema.safeParse({
        evidence: arrival,
        authorityReceipt: applicationReceipt,
        persistedAt: AT,
      }).success,
    ).toBe(false)
  })
})

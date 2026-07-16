import { createHmac } from 'node:crypto'

import {
  IdentityTelemetryEventSchema,
  SignedIdentityTelemetrySchema,
  identityTelemetrySignaturePayload,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { signIdentityTelemetry } from './identity-signing.js'

const KEY = 'identity-telemetry-simulator-key-with-32-bytes'
const AT = '2026-08-14T05:58:00.000Z'

const event = IdentityTelemetryEventSchema.parse({
  schemaVersion: 'identity-telemetry-event@1',
  providerEventId: 'idt_simulated_arrival_01',
  organizationId: 'org_rocky_roost',
  missionId: 'mis_night_shift_home',
  palaceId: 'pal_sacred_dumpster',
  identityTagId: 'tag_rocky_verified',
  observedAt: AT,
  nonce: 'itn_simulated_arrival_nonce_01',
})

describe('identity telemetry simulator signing', () => {
  it('signs the strict sender-owned event without an authority verdict or receipt', () => {
    const signed = signIdentityTelemetry(event, {
      keyId: 'itk_simulator_primary',
      key: KEY,
      timestamp: AT,
    })

    expect(SignedIdentityTelemetrySchema.parse(signed)).toEqual(signed)
    expect('verified' in signed.event).toBe(false)
    expect('authorityReceipt' in signed).toBe(false)
    expect(signed.signature.nonce).toBe(event.nonce)
  })

  it('binds key ID, timestamp, nonce, and canonical event content', () => {
    const signed = signIdentityTelemetry(event, {
      keyId: 'itk_simulator_primary',
      key: KEY,
      timestamp: AT,
    })
    const expected = createHmac('sha256', KEY)
      .update(
        identityTelemetrySignaturePayload({
          event,
          keyId: signed.signature.keyId,
          timestamp: signed.signature.timestamp,
        }),
      )
      .digest('hex')

    expect(signed.signature.digest).toBe(expected)
    expect(
      SignedIdentityTelemetrySchema.safeParse({
        ...signed,
        event: { ...signed.event, verified: true },
      }).success,
    ).toBe(false)
  })

  it('rejects weak signing material', () => {
    expect(() =>
      signIdentityTelemetry(event, {
        keyId: 'itk_simulator_primary',
        key: 'too-short',
        timestamp: AT,
      }),
    ).toThrow(/at least 32 bytes/)
  })
})

import { describe, expect, it } from 'vitest'

import { NIGHT_SHIFT_HOMECOMING_FIXTURE } from '../../../evals/fixtures/night-shift-homecoming.js'

import { CallbackInboxError, GatewayCallbackInbox } from './callback-inbox.js'
import {
  GatewayCallbackSchema,
  GatewayCommandSchema,
  GatewayDeliveryEvidenceSchema,
  PRIVATE_GATEWAY_ORIGIN,
  assertFixedPrivateGatewayOrigin,
  callbackDedupeInput,
  createGatewayCommand,
  gatewayCallbackBindingForCommand,
  validateGatewayCommandCallbackBinding,
  type GatewayCallback,
} from './contracts.js'
import { GatewayFaultProfileSchema } from './faults.js'
import {
  GatewaySignatureError,
  signGatewayCallback,
  verifyGatewayCallback,
  verifyGatewayCallbackWithReceipt,
  type GatewayVerificationKeyRecord,
} from './signing.js'

const PRIMARY_KEY_ID = 'gwk_primary_2026'
const PRIMARY_KEY = 'primary-gateway-callback-key-32-bytes-minimum'
const OLD_KEY_ID = 'gwk_previous_2026'
const OLD_KEY = 'previous-gateway-callback-key-32-bytes-minimum'
const AT = '2026-08-14T01:58:02-04:00'
const GATEWAY_PRINCIPAL = {
  id: 'gwp_rocky_gateway',
  organizationId: NIGHT_SHIFT_HOMECOMING_FIXTURE.primaryTenant.organization.id,
} as const

function trustedKey(
  key: string,
  keyVersion: number,
  overrides: Partial<GatewayVerificationKeyRecord> = {},
): GatewayVerificationKeyRecord {
  return {
    key,
    keyVersion,
    purpose: 'gateway_callback',
    principal: GATEWAY_PRINCIPAL,
    ...overrides,
  }
}

function command() {
  const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
  const lights = fixture.primaryTenant.devices.find((device) => device.kind === 'pathway_light')
  if (!lights) throw new Error('Fixture lights missing')
  return createGatewayCommand({
    organizationId: fixture.primaryTenant.organization.id,
    missionId: fixture.mission.id,
    palaceId: fixture.primaryTenant.palace.id,
    operationId: 'op_gateway_contract',
    logicalKey: 'pathway-lighting',
    kind: 'set_lighting',
    payload: {
      deviceId: lights.id,
      intensityPercent: 40,
      durationSeconds: 900,
      causedByEvidenceId: fixture.observationSchedule[1].id,
    },
    createdAt: AT,
  })
}

function callback(overrides: Partial<GatewayCallback> = {}): GatewayCallback {
  const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
  const gatewayCommand = command()
  if (gatewayCommand.kind !== 'set_lighting') throw new Error('Lighting fixture changed kind')
  const candidate = {
    id: 'gcb_contract_callback',
    organizationId: fixture.primaryTenant.organization.id,
    missionId: fixture.mission.id,
    palaceId: fixture.primaryTenant.palace.id,
    commandId: gatewayCommand.id,
    operationId: gatewayCommand.operationId,
    status: 'completed',
    occurredAt: AT,
    nonce: 'gwn_abcdefghijklmnopqrstuvwx',
    ...overrides,
  }
  const terminal = candidate.status === 'completed' || candidate.status === 'failed'
  const evidence =
    overrides.evidence ??
    (candidate.status === 'completed'
      ? [
          {
            id: 'evd_contract_device_command',
            organizationId: candidate.organizationId,
            missionId: candidate.missionId,
            palaceId: candidate.palaceId,
            observedAt: candidate.occurredAt,
            type: 'device_command',
            deviceId: gatewayCommand.payload.deviceId,
            command: gatewayCommand.kind,
            causedByEvidenceId: gatewayCommand.payload.causedByEvidenceId,
          },
          {
            id: 'evd_contract_lighting_observation',
            organizationId: candidate.organizationId,
            missionId: candidate.missionId,
            palaceId: candidate.palaceId,
            observedAt: candidate.occurredAt,
            type: 'lighting_observation',
            deviceId: gatewayCommand.payload.deviceId,
            intensityPercent: gatewayCommand.payload.intensityPercent,
            active: gatewayCommand.payload.intensityPercent > 0,
          },
          GatewayDeliveryEvidenceSchema.parse({
            id: 'evd_contract_gateway_delivery',
            organizationId: candidate.organizationId,
            missionId: candidate.missionId,
            palaceId: candidate.palaceId,
            observedAt: candidate.occurredAt,
            type: 'gateway_delivery',
            gatewayCommandId: candidate.commandId,
            operationId: candidate.operationId,
            status: 'completed',
            code: null,
          }),
        ]
      : terminal
        ? [
            GatewayDeliveryEvidenceSchema.parse({
              id: 'evd_contract_gateway_delivery',
              organizationId: candidate.organizationId,
              missionId: candidate.missionId,
              palaceId: candidate.palaceId,
              observedAt: candidate.occurredAt,
              type: 'gateway_delivery',
              gatewayCommandId: candidate.commandId,
              operationId: candidate.operationId,
              status: 'failed',
              code: 'SIMULATED_FAILURE',
            }),
          ]
        : [])
  return GatewayCallbackSchema.parse({ ...candidate, evidence })
}

describe('gateway contracts', () => {
  it('pins a single private origin and rejects path, credential, and public-host substitutions', () => {
    expect(assertFixedPrivateGatewayOrigin(PRIVATE_GATEWAY_ORIGIN)).toBe(PRIVATE_GATEWAY_ORIGIN)
    expect(() => assertFixedPrivateGatewayOrigin(`${PRIVATE_GATEWAY_ORIGIN}/v1/commands`)).toThrow(
      /fixed private origin/,
    )
    expect(() =>
      assertFixedPrivateGatewayOrigin('http://user:pass@gateway-simulator:4319'),
    ).toThrow(/fixed private origin/)
    expect(() => assertFixedPrivateGatewayOrigin('https://gateway.example.com')).toThrow(
      /fixed private origin/,
    )
  })

  it('hash-binds command kind and payload and rejects an application-transport fault profile', () => {
    const valid = command()
    expect(GatewayCommandSchema.parse(valid)).toEqual(valid)
    expect(
      GatewayCommandSchema.safeParse({
        ...valid,
        payload: { ...valid.payload, intensityPercent: 41 },
      }).success,
    ).toBe(false)
    expect(
      GatewayFaultProfileSchema.safeParse({
        kind: 'application_commit_then_response_lost',
      }).success,
    ).toBe(false)
  })

  it('produces stable callback dedupe inputs from all identity-bearing payload data', () => {
    expect(callbackDedupeInput(callback())).toEqual(callbackDedupeInput(callback()))
    expect(callbackDedupeInput(callback()).payloadHash).toMatch(/^[a-f0-9]{64}$/)
    expect(callback().evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'device_command', command: 'set_lighting' }),
        expect.objectContaining({ type: 'lighting_observation', intensityPercent: 40 }),
        expect.objectContaining({ type: 'gateway_delivery', status: 'completed', code: null }),
      ]),
    )
    expect(validateGatewayCommandCallbackBinding(command(), callback()).callback).toEqual(
      callback(),
    )
  })
})

describe('signed gateway callbacks', () => {
  it('verifies active and rotated keys without trusting an unrecognized key ID', () => {
    const current = signGatewayCallback(callback(), {
      keyId: PRIMARY_KEY_ID,
      key: PRIMARY_KEY,
      timestamp: AT,
    })
    const previous = signGatewayCallback(
      callback({ id: 'gcb_previous_callback', nonce: 'gwn_zyxwvutsrqponmlkjihgfedc' }),
      { keyId: OLD_KEY_ID, key: OLD_KEY, timestamp: AT },
    )
    const keyring = {
      [PRIMARY_KEY_ID]: trustedKey(PRIMARY_KEY, 2),
      [OLD_KEY_ID]: trustedKey(OLD_KEY, 1),
    }
    expect(verifyGatewayCallback(current, { keyring, now: AT })).toEqual(current.callback)
    expect(verifyGatewayCallback(previous, { keyring, now: AT })).toEqual(previous.callback)
    expect(verifyGatewayCallbackWithReceipt(current, { keyring, now: AT })).toEqual({
      callback: current.callback,
      authenticatedPrincipal: GATEWAY_PRINCIPAL,
      verifierKeyId: PRIMARY_KEY_ID,
      verifierKeyVersion: 2,
      verifierVersion: 1,
      signatureTimestamp: current.signature.timestamp,
      verifiedPayloadDigest: callbackDedupeInput(current.callback).payloadHash,
    })
    expect(() =>
      verifyGatewayCallback(current, {
        keyring: { [OLD_KEY_ID]: trustedKey(OLD_KEY, 1) },
        now: AT,
      }),
    ).toThrow(expect.objectContaining({ code: 'UNKNOWN_KEY' }))
  })

  it('binds a valid signature to its gateway tenant and key lifecycle', () => {
    const crossTenant = signGatewayCallback(
      callback({
        organizationId: NIGHT_SHIFT_HOMECOMING_FIXTURE.mirrorTenant.organization.id,
      }),
      { keyId: PRIMARY_KEY_ID, key: PRIMARY_KEY, timestamp: AT },
    )
    expect(() =>
      verifyGatewayCallbackWithReceipt(crossTenant, {
        keyring: { [PRIMARY_KEY_ID]: trustedKey(PRIMARY_KEY, 2) },
        now: AT,
      }),
    ).toThrow(expect.objectContaining({ code: 'PRINCIPAL_BINDING_MISMATCH' }))

    const signed = signGatewayCallback(callback(), {
      keyId: PRIMARY_KEY_ID,
      key: PRIMARY_KEY,
      timestamp: AT,
    })
    const cases = [
      ['WRONG_KEY_PURPOSE', trustedKey(PRIMARY_KEY, 2, { purpose: 'identity_telemetry' })],
      ['KEY_NOT_ACTIVE', trustedKey(PRIMARY_KEY, 2, { activeFrom: '2026-08-14T05:58:03.000Z' })],
      ['KEY_EXPIRED', trustedKey(PRIMARY_KEY, 2, { expiresAt: signed.signature.timestamp })],
      ['KEY_REVOKED', trustedKey(PRIMARY_KEY, 2, { revokedAt: signed.signature.timestamp })],
    ] as const
    for (const [code, record] of cases) {
      expect(() =>
        verifyGatewayCallbackWithReceipt(signed, {
          keyring: { [PRIMARY_KEY_ID]: record },
          now: AT,
        }),
      ).toThrow(expect.objectContaining({ code }))
    }
  })

  it('rejects valid-shape tampering, nonce mismatch, and timestamps outside the bounded window', () => {
    const signed = signGatewayCallback(callback(), {
      keyId: PRIMARY_KEY_ID,
      key: PRIMARY_KEY,
      timestamp: AT,
    })
    const tampered = structuredClone(signed)
    tampered.callback.occurredAt = '2026-08-14T01:58:03-04:00'
    expect(() =>
      verifyGatewayCallback(tampered, {
        keyring: { [PRIMARY_KEY_ID]: trustedKey(PRIMARY_KEY, 2) },
        now: AT,
      }),
    ).toThrow(expect.objectContaining({ code: 'SIGNATURE_MISMATCH' }))

    const nonceMismatch = structuredClone(signed)
    nonceMismatch.signature.nonce = 'gwn_111111111111111111111111'
    expect(() =>
      verifyGatewayCallback(nonceMismatch, {
        keyring: { [PRIMARY_KEY_ID]: trustedKey(PRIMARY_KEY, 2) },
        now: AT,
      }),
    ).toThrow(expect.objectContaining({ code: 'NONCE_MISMATCH' }))

    expect(() =>
      verifyGatewayCallback(signed, {
        keyring: { [PRIMARY_KEY_ID]: trustedKey(PRIMARY_KEY, 2) },
        now: new Date(Date.parse(AT) + 300_001),
      }),
    ).toThrow(expect.objectContaining({ code: 'SIGNATURE_EXPIRED' }))
    expect(() =>
      verifyGatewayCallback(signed, {
        keyring: { [PRIMARY_KEY_ID]: trustedKey(PRIMARY_KEY, 2) },
        now: new Date(Date.parse(AT) - 30_001),
      }),
    ).toThrow(expect.objectContaining({ code: 'SIGNATURE_FROM_FUTURE' }))
  })

  it('classifies exact duplicate delivery while rejecting payload, nonce, and stored-binding conflicts', () => {
    const gatewayCommand = command()
    const binding = gatewayCallbackBindingForCommand(gatewayCommand)
    const inbox = new GatewayCallbackInbox({
      keyring: { [PRIMARY_KEY_ID]: trustedKey(PRIMARY_KEY, 2) },
    })
    const signed = signGatewayCallback(callback(), {
      keyId: PRIMARY_KEY_ID,
      key: PRIMARY_KEY,
      timestamp: AT,
    })
    expect(inbox.ingest(signed, AT, binding).status).toBe('accepted')
    expect(inbox.ingest(signed, AT, binding).status).toBe('duplicate')
    expect(inbox.size).toBe(1)

    const changed = signGatewayCallback(callback({ status: 'failed' }), {
      keyId: PRIMARY_KEY_ID,
      key: PRIMARY_KEY,
      timestamp: AT,
    })
    expect(() => inbox.ingest(changed, AT, binding)).toThrow(
      expect.objectContaining({ code: 'CALLBACK_ID_PAYLOAD_CONFLICT' }),
    )

    const reusedNonce = signGatewayCallback(callback({ id: 'gcb_second_callback' }), {
      keyId: PRIMARY_KEY_ID,
      key: PRIMARY_KEY,
      timestamp: AT,
    })
    expect(() => inbox.ingest(reusedNonce, AT, binding)).toThrow(
      expect.objectContaining({ code: 'CALLBACK_NONCE_REUSE' }),
    )

    const forgedBinding = {
      ...binding,
      missionId: NIGHT_SHIFT_HOMECOMING_FIXTURE.mirrorTenant.similarRoutine.organizationId.replace(
        /^org_/,
        'mis_',
      ),
    }
    expect(() => inbox.ingest(signed, AT, forgedBinding as never)).toThrow(CallbackInboxError)
  })

  it('rejects callback evidence whose tenant, mission, or palace differs from the signed callback', () => {
    const valid = callback()
    expect(
      GatewayCallbackSchema.safeParse({
        ...valid,
        evidence: valid.evidence.map((evidence, index) =>
          index === 0 ? { ...evidence, missionId: 'mis_different_mission' } : evidence,
        ),
      }).success,
    ).toBe(false)
  })

  it('uses typed signature errors for callers that fail closed', () => {
    expect(() => verifyGatewayCallback({}, { keyring: {}, now: AT })).toThrow(GatewaySignatureError)
    expect(() => verifyGatewayCallbackWithReceipt({}, { keyring: {}, now: AT })).toThrow(
      GatewaySignatureError,
    )
  })
})

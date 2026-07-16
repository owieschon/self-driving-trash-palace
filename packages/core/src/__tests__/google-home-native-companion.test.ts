import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  GoogleHomeCommandEnvelopeSchema,
  GoogleHomeDerivedSourceHandlingContractSchema,
  GoogleHomeDispatchContractSchema,
  GoogleHomeEnvelopeReceiptPairSchema,
  GoogleHomeNativeSafetyFactsSchema,
  GoogleHomeSignatureSchema,
  GOOGLE_HOME_SIGNATURE_WIRE_PROFILE,
  SignedGoogleHomeLogicalBindingSchema,
  SignedGoogleHomeSanitizedReceiptSchema,
  TOOL_REGISTRY,
  createGatewayCommand,
  getGoogleHomeDataBoundaryProjection,
  getGoogleHomeDerivedSourceHandlingContract,
  googleHomeCommandEnvelopeSignaturePayload,
  googleHomeLogicalBindingSignaturePayload,
  googleHomeReceiptSignaturePayload,
} from '../index.js'

const PLAN_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ORGANIZATION_ID = 'org_rocky_roost'
const PALACE_ID = 'pal_sacred_dumpster'
const LOGICAL_DEVICE_ID = 'dev_pathway_lights'
const CAPABILITY_ID = 'cap_pathway_lighting'
const BINDING_ID = 'ghb_pathway_lighting'

const signature = (signedAt: string) => ({
  version: 'v1' as const,
  algorithm: 'ed25519' as const,
  keyId: 'ghk_synthetic_companion',
  signedAt,
  value: 'A'.repeat(86),
})

function lightingCommand() {
  return createGatewayCommand({
    organizationId: ORGANIZATION_ID,
    missionId: 'mis_google_home_contract',
    palaceId: PALACE_ID,
    operationId: 'op_google_home_contract',
    logicalKey: 'pathway-lighting',
    kind: 'set_lighting',
    payload: {
      deviceId: LOGICAL_DEVICE_ID,
      intensityPercent: 40,
      durationSeconds: 900,
      causedByEvidenceId: 'evd_synthetic_arrival',
    },
    createdAt: '2026-08-14T02:00:00.000-04:00',
  })
}

function bindingLease() {
  return SignedGoogleHomeLogicalBindingSchema.parse({
    binding: {
      schemaVersion: 'google-home-logical-binding@1',
      provider: 'google_home',
      dataClass: 'app_owned_logical_binding',
      sourceClassification: 'google_home_derived_restricted',
      bindingId: BINDING_ID,
      organizationId: ORGANIZATION_ID,
      palaceId: PALACE_ID,
      logicalDeviceId: LOGICAL_DEVICE_ID,
      capabilityId: CAPABILITY_ID,
      capabilityKind: 'pathway_lighting',
      consentStatus: 'active',
      consentVerifiedAt: '2026-08-14T01:58:00.000-04:00',
      bindingVerifiedAt: '2026-08-14T01:59:00.000-04:00',
      validUntil: '2026-08-14T02:04:00.000-04:00',
      recordedAt: '2026-08-14T01:59:01.000-04:00',
      deleteAfter: '2026-08-20T01:59:01.000-04:00',
    },
    signature: signature('2026-08-14T01:59:02.000-04:00'),
  })
}

function commandEnvelope() {
  const command = lightingCommand()
  return GoogleHomeCommandEnvelopeSchema.parse({
    schemaVersion: 'google-home-command-envelope@1',
    provider: 'google_home',
    transport: 'native_companion',
    dataClass: 'logical_slot_command',
    bindingId: BINDING_ID,
    organizationId: ORGANIZATION_ID,
    palaceId: PALACE_ID,
    logicalDeviceId: LOGICAL_DEVICE_ID,
    capabilityId: CAPABILITY_ID,
    idempotencyKey: command.id,
    command,
    authorization: {
      mode: 'approved_plan',
      approvalId: 'apr_google_home_contract',
      planHash: PLAN_HASH,
    },
    issuedAt: '2026-08-14T02:00:00.000-04:00',
    expiresAt: '2026-08-14T02:04:00.000-04:00',
    signature: signature('2026-08-14T02:00:00.000-04:00'),
  })
}

function signedReceipt() {
  const envelope = commandEnvelope()
  return SignedGoogleHomeSanitizedReceiptSchema.parse({
    receipt: {
      schemaVersion: 'google-home-sanitized-receipt@1',
      provider: 'google_home',
      dataClass: 'sanitized_outcome_only',
      sourceClassification: 'google_home_derived_restricted',
      id: 'ghr_pathway_lighting',
      bindingId: BINDING_ID,
      organizationId: ORGANIZATION_ID,
      palaceId: PALACE_ID,
      logicalDeviceId: LOGICAL_DEVICE_ID,
      capabilityId: CAPABILITY_ID,
      commandId: envelope.command.id,
      idempotencyKey: envelope.idempotencyKey,
      status: 'completed',
      outcome: 'requested_state_confirmed',
      code: null,
      retryable: false,
      occurredAt: '2026-08-14T02:01:00.000-04:00',
      firstRecordedAt: '2026-08-14T02:01:01.000-04:00',
      recordedAt: '2026-08-14T02:01:01.000-04:00',
      deleteAfter: '2026-08-20T02:01:01.000-04:00',
    },
    signature: signature('2026-08-14T02:01:02.000-04:00'),
  })
}

describe('Google Home native companion contracts', () => {
  it('uses an exact 64-byte unpadded Ed25519 signature shape', () => {
    expect(GOOGLE_HOME_SIGNATURE_WIRE_PROFILE).toMatchObject({
      algorithm: 'ed25519',
      signatureEncoding: 'base64url_without_padding',
      signatureBytes: 64,
      signatureCharacters: 86,
    })
    expect(
      GoogleHomeSignatureSchema.safeParse(signature('2026-08-14T02:00:00.000-04:00')).success,
    ).toBe(true)
    expect(
      GoogleHomeSignatureSchema.safeParse({
        ...signature('2026-08-14T02:00:00.000-04:00'),
        value: 'A'.repeat(85),
      }).success,
    ).toBe(false)
    expect(
      GoogleHomeSignatureSchema.safeParse({
        ...signature('2026-08-14T02:00:00.000-04:00'),
        value: `${'A'.repeat(85)}B`,
      }).success,
    ).toBe(false)
  })

  it('publishes a durable restricted-source contract without claiming downstream enforcement', () => {
    expect(
      GoogleHomeDerivedSourceHandlingContractSchema.parse(
        getGoogleHomeDerivedSourceHandlingContract(),
      ),
    ).toEqual({
      schemaVersion: 'google-home-source-handling@1',
      classification: 'google_home_derived_restricted',
      allowedPurposes: ['logical_binding_authorization', 'sanitized_operation_reconciliation'],
      forbiddenDestinations: ['caretaker_model_context', 'analytics', 'mcp', 'logs'],
      downstreamEnforcement: 'blocked_not_integrated',
    })
    expect(bindingLease().binding.sourceClassification).toBe('google_home_derived_restricted')
    expect(signedReceipt().receipt.sourceClassification).toBe('google_home_derived_restricted')
  })

  it('accepts only a tenant-bound logical binding and stable command identity', () => {
    const contract = GoogleHomeDispatchContractSchema.parse({
      bindingLease: bindingLease(),
      envelope: commandEnvelope(),
    })

    expect(contract.envelope.idempotencyKey).toBe(contract.envelope.command.id)
    expect(contract.bindingLease.binding.logicalDeviceId).toBe(LOGICAL_DEVICE_ID)
    expect(contract.bindingLease.binding.capabilityKind).toBe('pathway_lighting')
  })

  it('rejects raw Google Home inventory, identifiers, and state at every backend boundary', () => {
    const lease = bindingLease()
    const envelope = commandEnvelope()
    const receipt = signedReceipt()

    expect(
      SignedGoogleHomeLogicalBindingSchema.safeParse({
        ...lease,
        binding: { ...lease.binding, googleDeviceId: 'raw-google-device-id' },
      }).success,
    ).toBe(false)
    expect(
      GoogleHomeCommandEnvelopeSchema.safeParse({
        ...envelope,
        googleStructureId: 'raw-google-structure-id',
      }).success,
    ).toBe(false)
    expect(
      SignedGoogleHomeSanitizedReceiptSchema.safeParse({
        ...receipt,
        receipt: {
          ...receipt.receipt,
          rawState: { online: true },
          roomName: 'Sacred Dumpster Foyer',
        },
      }).success,
    ).toBe(false)
  })

  it.each([
    ['bindingId', 'ghb_foreign_binding'],
    ['organizationId', 'org_foreign_tenant'],
    ['palaceId', 'pal_foreign_palace'],
    ['logicalDeviceId', 'dev_foreign_lights'],
    ['capabilityId', 'cap_foreign_lighting'],
  ] as const)('rejects a %s mismatch between a binding and command', (field, value) => {
    const lease = bindingLease()
    expect(
      GoogleHomeDispatchContractSchema.safeParse({
        bindingLease: {
          ...lease,
          binding: { ...lease.binding, [field]: value },
        },
        envelope: commandEnvelope(),
      }).success,
    ).toBe(false)
  })

  it('rejects a logical capability that does not authorize the command kind', () => {
    const lease = bindingLease()
    expect(
      GoogleHomeDispatchContractSchema.safeParse({
        bindingLease: {
          ...lease,
          binding: { ...lease.binding, capabilityKind: 'temperature_target' },
        },
        envelope: commandEnvelope(),
      }).success,
    ).toBe(false)
  })

  it('binds signatures to canonical payloads while excluding signature bytes', () => {
    const envelope = commandEnvelope()
    const { signature: envelopeSignature, ...signingPayload } = envelope
    const header = {
      version: envelopeSignature.version,
      algorithm: envelopeSignature.algorithm,
      keyId: envelopeSignature.keyId,
      signedAt: envelopeSignature.signedAt,
    }
    expect(googleHomeCommandEnvelopeSignaturePayload(signingPayload, header)).not.toContain(
      envelopeSignature.value,
    )
    expect(googleHomeCommandEnvelopeSignaturePayload(signingPayload, header)).toContain(
      'google-home-command-envelope:v1',
    )
    expect(
      googleHomeCommandEnvelopeSignaturePayload(signingPayload, {
        ...header,
        signedAt: '2026-08-14T02:00:01.000-04:00',
      }),
    ).not.toBe(googleHomeCommandEnvelopeSignaturePayload(signingPayload, header))

    const lease = bindingLease()
    expect(
      googleHomeLogicalBindingSignaturePayload(lease.binding, {
        version: lease.signature.version,
        algorithm: lease.signature.algorithm,
        keyId: lease.signature.keyId,
        signedAt: lease.signature.signedAt,
      }),
    ).toContain('google-home-logical-binding:v1')

    const receipt = signedReceipt()
    expect(
      googleHomeReceiptSignaturePayload(receipt.receipt, {
        version: receipt.signature.version,
        algorithm: receipt.signature.algorithm,
        keyId: receipt.signature.keyId,
        signedAt: receipt.signature.signedAt,
      }),
    ).toContain('google-home-sanitized-receipt:v1')
  })

  it('matches the fixed UTF-8 Ed25519 vector used by Kotlin and Swift conformance suites', () => {
    const lease = bindingLease()
    const payload = googleHomeLogicalBindingSignaturePayload(lease.binding, {
      version: lease.signature.version,
      algorithm: lease.signature.algorithm,
      keyId: lease.signature.keyId,
      signedAt: lease.signature.signedAt,
    })
    const expectedPayload = [
      'google-home-logical-binding:v1',
      'v1',
      'ed25519',
      'ghk_synthetic_companion',
      '2026-08-14T01:59:02.000-04:00',
      '{"bindingId":"ghb_pathway_lighting","bindingVerifiedAt":"2026-08-14T01:59:00.000-04:00","capabilityId":"cap_pathway_lighting","capabilityKind":"pathway_lighting","consentStatus":"active","consentVerifiedAt":"2026-08-14T01:58:00.000-04:00","dataClass":"app_owned_logical_binding","deleteAfter":"2026-08-20T01:59:01.000-04:00","logicalDeviceId":"dev_pathway_lights","organizationId":"org_rocky_roost","palaceId":"pal_sacred_dumpster","provider":"google_home","recordedAt":"2026-08-14T01:59:01.000-04:00","schemaVersion":"google-home-logical-binding@1","sourceClassification":"google_home_derived_restricted","validUntil":"2026-08-14T02:04:00.000-04:00"}',
    ].join('\n')
    expect(payload).toBe(expectedPayload)
    expect(payload.endsWith('\n')).toBe(false)

    // RFC 8032 test-key material is public and exists only to make the wire vector reproducible.
    const privateKey = createPrivateKey({
      key: Buffer.from(
        '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
        'hex',
      ),
      format: 'der',
      type: 'pkcs8',
    })
    const publicKey = createPublicKey({
      key: Buffer.from(
        '302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
        'hex',
      ),
      format: 'der',
      type: 'spki',
    })
    const encodedSignature = sign(null, Buffer.from(payload, 'utf8'), privateKey).toString(
      'base64url',
    )
    expect(encodedSignature).toBe(
      'wcGvw17-wE41zQR4KaOP8Ak9_jWop7KMhhNq47Ngze1EIDV2iVGHBsA--jY5gakEG1GaqjkX2mcz1XwcfU0SBg',
    )
    expect(
      verify(
        null,
        Buffer.from(payload, 'utf8'),
        publicKey,
        Buffer.from(encodedSignature, 'base64url'),
      ),
    ).toBe(true)
  })

  it('keeps native thermostat and energy checks explicit and command-shaped', () => {
    const facts = {
      schemaVersion: 'google-home-native-safety-facts@1',
      dataClass: 'transient_boolean_safety_facts',
      bindingId: BINDING_ID,
      organizationId: ORGANIZATION_ID,
      commandId: commandEnvelope().command.id,
      checkedAt: '2026-08-14T02:00:30.000-04:00',
      consent: 'active',
      localBinding: 'matched',
      commandSupport: 'supported',
      nativeSafetyChecks: 'passed',
      commandKind: 'set_temperature',
      thermostat: {
        targetCelsius: 21,
        configuredMinimumCelsius: 18,
        configuredMaximumCelsius: 24,
      },
      energy: {
        projectedWattHours: 300,
        availableWattHours: 1_000,
        requiredReserveWattHours: 500,
      },
    } as const

    expect(GoogleHomeNativeSafetyFactsSchema.parse(facts).energy).toMatchObject({
      projectedWattHours: 300,
      availableWattHours: 1_000,
      requiredReserveWattHours: 500,
    })
    expect(
      GoogleHomeNativeSafetyFactsSchema.safeParse({
        ...facts,
        thermostat: 'not_applicable',
      }).success,
    ).toBe(false)
    expect(
      GoogleHomeNativeSafetyFactsSchema.safeParse({
        ...facts,
        commandKind: 'unlock',
      }).success,
    ).toBe(false)
  })

  it('rejects a changed idempotency key and an envelope lifetime over five minutes', () => {
    const envelope = commandEnvelope()
    expect(
      GoogleHomeCommandEnvelopeSchema.safeParse({
        ...envelope,
        idempotencyKey: 'gcmd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }).success,
    ).toBe(false)
    expect(
      GoogleHomeCommandEnvelopeSchema.safeParse({
        ...envelope,
        expiresAt: '2026-08-14T02:05:00.001-04:00',
      }).success,
    ).toBe(false)
  })

  it('requires a fresh secured-mobile confirmation for unlock and rejects autonomous fields', () => {
    const command = createGatewayCommand({
      organizationId: ORGANIZATION_ID,
      missionId: 'mis_google_home_unlock',
      palaceId: PALACE_ID,
      operationId: 'op_google_home_unlock',
      logicalKey: 'front-lock',
      kind: 'unlock',
      payload: {
        deviceId: 'dev_front_lock',
        identityTagId: 'tag_rocky_verified',
        durationSeconds: 120,
        causedByEvidenceId: 'evd_synthetic_arrival',
      },
      createdAt: '2026-08-14T02:00:00.000-04:00',
    })
    const base = {
      schemaVersion: 'google-home-command-envelope@1',
      provider: 'google_home',
      transport: 'native_companion',
      dataClass: 'logical_slot_command',
      bindingId: 'ghb_front_door_lock',
      organizationId: ORGANIZATION_ID,
      palaceId: PALACE_ID,
      logicalDeviceId: 'dev_front_lock',
      capabilityId: 'cap_front_lock_state',
      idempotencyKey: command.id,
      command,
      issuedAt: '2026-08-14T02:00:00.000-04:00',
      expiresAt: '2026-08-14T02:01:00.000-04:00',
      signature: signature('2026-08-14T02:00:00.000-04:00'),
    }

    expect(
      GoogleHomeCommandEnvelopeSchema.safeParse({
        ...base,
        authorization: {
          mode: 'approved_plan',
          approvalId: 'apr_google_home_unlock',
          planHash: PLAN_HASH,
        },
      }).success,
    ).toBe(false)

    const confirmed = GoogleHomeCommandEnvelopeSchema.parse({
      ...base,
      authorization: {
        mode: 'fresh_mobile_confirmation',
        approvalId: 'apr_google_home_unlock',
        planHash: PLAN_HASH,
        confirmation: {
          id: 'ghc_unlock_confirmation',
          method: 'device_credential',
          confirmedAt: '2026-08-14T01:59:30.000-04:00',
          expiresAt: '2026-08-14T02:01:30.000-04:00',
        },
      },
    })
    expect(confirmed.authorization.mode).toBe('fresh_mobile_confirmation')
    expect(
      GoogleHomeCommandEnvelopeSchema.safeParse({ ...confirmed, autonomous: true }).success,
    ).toBe(false)
  })

  it('caps every Google-derived backend record at ten days', () => {
    const lease = bindingLease()
    expect(
      SignedGoogleHomeLogicalBindingSchema.safeParse({
        ...lease,
        binding: { ...lease.binding, deleteAfter: '2026-08-24T01:59:01.001-04:00' },
      }).success,
    ).toBe(false)

    const receipt = signedReceipt()
    expect(
      SignedGoogleHomeSanitizedReceiptSchema.safeParse({
        ...receipt,
        receipt: { ...receipt.receipt, deleteAfter: '2026-08-24T02:01:01.001-04:00' },
      }).success,
    ).toBe(false)
  })

  it('anchors receipt chronology and retention to the first receipt', () => {
    const original = signedReceipt()
    expect(
      SignedGoogleHomeSanitizedReceiptSchema.safeParse({
        ...original,
        receipt: {
          ...original.receipt,
          firstRecordedAt: '2026-08-14T02:00:59.999-04:00',
        },
      }).success,
    ).toBe(false)
    expect(
      SignedGoogleHomeSanitizedReceiptSchema.safeParse({
        ...original,
        receipt: {
          ...original.receipt,
          firstRecordedAt: '2026-08-14T02:01:02.000-04:00',
        },
      }).success,
    ).toBe(false)
    expect(
      SignedGoogleHomeSanitizedReceiptSchema.safeParse({
        ...original,
        receipt: {
          ...original.receipt,
          recordedAt: '2026-08-15T02:01:01.000-04:00',
          deleteAfter: '2026-08-24T02:01:01.001-04:00',
        },
        signature: signature('2026-08-15T02:01:02.000-04:00'),
      }).success,
    ).toBe(false)

    expect(
      GoogleHomeEnvelopeReceiptPairSchema.safeParse({
        envelope: commandEnvelope(),
        signedReceipt: {
          ...original,
          receipt: {
            ...original.receipt,
            occurredAt: '2026-08-14T01:59:59.999-04:00',
            firstRecordedAt: '2026-08-14T02:00:00.000-04:00',
          },
          signature: signature('2026-08-14T02:01:02.000-04:00'),
        },
      }).success,
    ).toBe(false)
  })

  it('accepts only a matching, sanitized, timely receipt', () => {
    const envelope = commandEnvelope()
    const receipt = signedReceipt()
    expect(
      GoogleHomeEnvelopeReceiptPairSchema.parse({ envelope, signedReceipt: receipt }).signedReceipt
        .receipt.status,
    ).toBe('completed')
    expect(
      GoogleHomeEnvelopeReceiptPairSchema.safeParse({
        envelope,
        signedReceipt: {
          ...receipt,
          receipt: { ...receipt.receipt, organizationId: 'org_foreign_tenant' },
        },
      }).success,
    ).toBe(false)
  })

  it('allows a sanitized rejection to report an envelope that was already expired', () => {
    const envelope = commandEnvelope()
    const expired = SignedGoogleHomeSanitizedReceiptSchema.parse({
      receipt: {
        ...signedReceipt().receipt,
        id: 'ghr_expired_envelope',
        status: 'rejected',
        outcome: 'not_confirmed',
        code: 'ENVELOPE_EXPIRED',
        retryable: false,
        occurredAt: '2026-08-14T02:05:00.000-04:00',
        firstRecordedAt: '2026-08-14T02:05:01.000-04:00',
        recordedAt: '2026-08-14T02:05:01.000-04:00',
        deleteAfter: '2026-08-20T02:05:01.000-04:00',
      },
      signature: signature('2026-08-14T02:05:02.000-04:00'),
    })

    expect(
      GoogleHomeEnvelopeReceiptPairSchema.parse({ envelope, signedReceipt: expired }).signedReceipt
        .receipt.code,
    ).toBe('ENVELOPE_EXPIRED')
  })

  it('keeps the simulator default and exposes no Google-specific MCP escape hatch', () => {
    expect(getGoogleHomeDataBoundaryProjection()).toEqual({
      schemaVersion: 'google-home-data-boundary@1',
      providerRuntimeOwner: 'android_or_ios_native_companion',
      backendDataClass: 'logical_bindings_commands_and_sanitized_receipts_only',
      forbiddenSinks: ['caretaker_model_context', 'analytics', 'mcp', 'logs'],
      mcpSurface: 'existing_provider_neutral_tools_only',
      simulatorIsCiDefault: true,
      maximumDerivedRetentionDays: 10,
      sourceClassification: 'google_home_derived_restricted',
      downstreamClassificationEnforcement: 'blocked_not_integrated',
    })
    expect(Object.keys(TOOL_REGISTRY).some((name) => name.includes('google_home'))).toBe(false)
  })
})

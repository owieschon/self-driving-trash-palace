import { describe, expect, it } from 'vitest'

import {
  GoogleHomeCommandEnvelopeSchema,
  SignedGoogleHomeLogicalBindingSchema,
  SignedGoogleHomeSanitizedReceiptSchema,
  createGatewayCommand,
  type GoogleHomeCommandEnvelope,
  type GoogleHomeDispatchContract,
  type OrganizationId,
  type Sha256,
  type SignedGoogleHomeSanitizedReceipt,
} from '@trash-palace/core'

import {
  GoogleHomeBoundaryError,
  GoogleHomeNativeCompanionBoundaryService,
  type GoogleHomeAtomicReplayJournalPort,
  type GoogleHomeNativeCompanionBoundaryPorts,
} from '../google-home-native-companion-boundary.js'

const ORGANIZATION_ID = 'org_rocky_roost' as OrganizationId
const PALACE_ID = 'pal_sacred_dumpster'
const PLAN_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_PLAN_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const AT = '2026-08-14T02:01:30.000-04:00'

const signature = (signedAt: string) => ({
  version: 'v1' as const,
  algorithm: 'ed25519' as const,
  keyId: 'ghk_synthetic_companion',
  signedAt,
  value: 'A'.repeat(86),
})

interface LogicalBindingInput {
  readonly bindingId: string
  readonly deviceId: string
  readonly capabilityId: string
  readonly capabilityKind: 'lock_desired_state' | 'pathway_lighting' | 'temperature_target'
}

function bindingLease(input: LogicalBindingInput, consentStatus: 'active' | 'revoked' = 'active') {
  return SignedGoogleHomeLogicalBindingSchema.parse({
    binding: {
      schemaVersion: 'google-home-logical-binding@1',
      provider: 'google_home',
      dataClass: 'app_owned_logical_binding',
      sourceClassification: 'google_home_derived_restricted',
      bindingId: input.bindingId,
      organizationId: ORGANIZATION_ID,
      palaceId: PALACE_ID,
      logicalDeviceId: input.deviceId,
      capabilityId: input.capabilityId,
      capabilityKind: input.capabilityKind,
      consentStatus,
      consentVerifiedAt: '2026-08-14T01:58:00.000-04:00',
      bindingVerifiedAt: '2026-08-14T01:59:00.000-04:00',
      validUntil: '2026-08-14T02:04:00.000-04:00',
      recordedAt: '2026-08-14T01:59:01.000-04:00',
      deleteAfter: '2026-08-20T01:59:01.000-04:00',
    },
    signature: signature('2026-08-14T01:59:02.000-04:00'),
  })
}

const LIGHTING_BINDING = {
  bindingId: 'ghb_pathway_lighting',
  deviceId: 'dev_pathway_lights',
  capabilityId: 'cap_pathway_lighting',
  capabilityKind: 'pathway_lighting',
} as const

const TEMPERATURE_BINDING = {
  bindingId: 'ghb_thermostat_target',
  deviceId: 'dev_thermostat_main',
  capabilityId: 'cap_temperature_target',
  capabilityKind: 'temperature_target',
} as const

const LOCK_BINDING = {
  bindingId: 'ghb_front_door_lock',
  deviceId: 'dev_front_door_lock',
  capabilityId: 'cap_front_lock_state',
  capabilityKind: 'lock_desired_state',
} as const

function envelopeFor(
  binding: LogicalBindingInput,
  command: ReturnType<typeof createGatewayCommand>,
  authorization: Record<string, unknown> = {
    mode: 'approved_plan',
    approvalId: 'apr_google_home_policy',
    planHash: PLAN_HASH,
  },
  expiresAt = '2026-08-14T02:04:00.000-04:00',
) {
  return GoogleHomeCommandEnvelopeSchema.parse({
    schemaVersion: 'google-home-command-envelope@1',
    provider: 'google_home',
    transport: 'native_companion',
    dataClass: 'logical_slot_command',
    bindingId: binding.bindingId,
    organizationId: ORGANIZATION_ID,
    palaceId: PALACE_ID,
    logicalDeviceId: binding.deviceId,
    capabilityId: binding.capabilityId,
    idempotencyKey: command.id,
    command,
    authorization,
    issuedAt: '2026-08-14T02:00:00.000-04:00',
    expiresAt,
    signature: signature('2026-08-14T02:00:00.000-04:00'),
  })
}

function lightingEnvelope() {
  return envelopeFor(
    LIGHTING_BINDING,
    createGatewayCommand({
      organizationId: ORGANIZATION_ID,
      missionId: 'mis_google_home_policy',
      palaceId: PALACE_ID,
      operationId: 'op_google_home_policy',
      logicalKey: 'pathway-lighting',
      kind: 'set_lighting',
      payload: {
        deviceId: LIGHTING_BINDING.deviceId,
        intensityPercent: 40,
        durationSeconds: 900,
        causedByEvidenceId: 'evd_synthetic_arrival',
      },
      createdAt: '2026-08-14T02:00:00.000-04:00',
    }),
  )
}

function temperatureEnvelope() {
  return envelopeFor(
    TEMPERATURE_BINDING,
    createGatewayCommand({
      organizationId: ORGANIZATION_ID,
      missionId: 'mis_google_home_temp',
      palaceId: PALACE_ID,
      operationId: 'op_google_home_temp',
      logicalKey: 'thermostat-target',
      kind: 'set_temperature',
      payload: {
        deviceId: TEMPERATURE_BINDING.deviceId,
        targetCelsius: 21,
        completeAt: '2026-08-14T02:15:00.000-04:00',
        causedByEvidenceId: 'evd_synthetic_arrival',
      },
      createdAt: '2026-08-14T02:00:00.000-04:00',
    }),
  )
}

function unlockEnvelope(operationId = 'op_google_home_unlock_01') {
  const command = createGatewayCommand({
    organizationId: ORGANIZATION_ID,
    missionId: 'mis_google_home_unlock',
    palaceId: PALACE_ID,
    operationId,
    logicalKey: 'front-lock',
    kind: 'unlock',
    payload: {
      deviceId: LOCK_BINDING.deviceId,
      identityTagId: 'tag_rocky_verified',
      durationSeconds: 120,
      causedByEvidenceId: 'evd_synthetic_arrival',
    },
    createdAt: '2026-08-14T02:00:00.000-04:00',
  })
  return envelopeFor(
    LOCK_BINDING,
    command,
    {
      mode: 'fresh_mobile_confirmation',
      approvalId: 'apr_google_home_unlock',
      planHash: PLAN_HASH,
      confirmation: {
        id: 'ghc_unlock_confirmation',
        method: 'device_credential',
        confirmedAt: '2026-08-14T02:00:00.000-04:00',
        expiresAt: '2026-08-14T02:02:00.000-04:00',
      },
    },
    '2026-08-14T02:02:00.000-04:00',
  )
}

function receiptFor(envelope: GoogleHomeCommandEnvelope) {
  return SignedGoogleHomeSanitizedReceiptSchema.parse({
    receipt: {
      schemaVersion: 'google-home-sanitized-receipt@1',
      provider: 'google_home',
      dataClass: 'sanitized_outcome_only',
      sourceClassification: 'google_home_derived_restricted',
      id: 'ghr_native_outcome01',
      bindingId: envelope.bindingId,
      organizationId: envelope.organizationId,
      palaceId: envelope.palaceId,
      logicalDeviceId: envelope.logicalDeviceId,
      capabilityId: envelope.capabilityId,
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

function safeFacts(contract: GoogleHomeDispatchContract, at: string) {
  const common = {
    schemaVersion: 'google-home-native-safety-facts@1',
    dataClass: 'transient_boolean_safety_facts',
    bindingId: contract.envelope.bindingId,
    organizationId: contract.envelope.organizationId,
    commandId: contract.envelope.command.id,
    checkedAt: at,
    consent: 'active',
    localBinding: 'matched',
    commandSupport: 'supported',
    nativeSafetyChecks: 'passed',
  } as const
  switch (contract.envelope.command.kind) {
    case 'set_temperature':
      return {
        ...common,
        commandKind: 'set_temperature' as const,
        thermostat: {
          targetCelsius: contract.envelope.command.payload.targetCelsius,
          configuredMinimumCelsius: 18,
          configuredMaximumCelsius: 24,
        },
        energy: {
          projectedWattHours: 300,
          availableWattHours: 1_000,
          requiredReserveWattHours: 500,
        },
      }
    case 'set_lighting':
      return {
        ...common,
        commandKind: 'set_lighting' as const,
        thermostat: 'not_applicable' as const,
        energy: {
          projectedWattHours: 100,
          availableWattHours: 1_000,
          requiredReserveWattHours: 500,
        },
      }
    case 'locked_desired_state':
    case 'unlock':
      return {
        ...common,
        commandKind: contract.envelope.command.kind,
        thermostat: 'not_applicable' as const,
        energy: 'not_applicable' as const,
      }
  }
}

class MemoryReplayJournal implements GoogleHomeAtomicReplayJournalPort {
  readonly #entries = new Map<
    string,
    { readonly requestHash: Sha256; readonly receipt: Promise<SignedGoogleHomeSanitizedReceipt> }
  >()

  public async executeOnce(
    input: Parameters<GoogleHomeAtomicReplayJournalPort['executeOnce']>[0],
    execute: Parameters<GoogleHomeAtomicReplayJournalPort['executeOnce']>[1],
  ): ReturnType<GoogleHomeAtomicReplayJournalPort['executeOnce']> {
    const key = `${input.organizationId}:${input.idempotencyKey}`
    const existing = this.#entries.get(key)
    if (existing !== undefined) {
      if (existing.requestHash !== input.requestHash) return { disposition: 'conflict' }
      return { disposition: 'replayed', signedReceipt: await existing.receipt }
    }

    const receipt = execute()
    this.#entries.set(key, { requestHash: input.requestHash, receipt })
    try {
      return { disposition: 'executed', signedReceipt: await receipt }
    } catch (error) {
      this.#entries.delete(key)
      throw error
    }
  }
}

function createHarness() {
  const state = {
    approvalValid: true,
    approvedPlanHash: PLAN_HASH,
    approvedApprovalIds: new Set(['apr_google_home_policy', 'apr_google_home_unlock']),
    trustedTenant: ORGANIZATION_ID as OrganizationId | null,
    receiptVerified: true,
    safetyOverride: null as unknown,
    dispatchCount: 0,
    approvalChecks: 0,
    confirmationConsumptions: 0,
    consumedConfirmations: new Set<string>(),
  }
  const ports: GoogleHomeNativeCompanionBoundaryPorts = {
    approvals: {
      async verifyExactApproval(input) {
        state.approvalChecks += 1
        return (
          state.approvalValid &&
          input.planHash === state.approvedPlanHash &&
          state.approvedApprovalIds.has(input.approvalId)
        )
      },
    },
    signatureTrust: {
      async resolveTrustedTenant() {
        return state.trustedTenant
      },
    },
    replayJournal: new MemoryReplayJournal(),
    mobileConfirmations: {
      async consumeOnce(input) {
        if (state.consumedConfirmations.has(input.confirmationId)) return 'invalid_or_consumed'
        state.consumedConfirmations.add(input.confirmationId)
        state.confirmationConsumptions += 1
        return 'consumed'
      },
    },
    nativeChecks: {
      async checkImmediatelyBeforeDispatch(input) {
        return state.safetyOverride ?? safeFacts(input.contract, input.at)
      },
    },
    privateDispatch: {
      async dispatch(input) {
        state.dispatchCount += 1
        return receiptFor(input.contract.envelope)
      },
    },
    receiptVerification: {
      async verifySanitizedOutcome() {
        return state.receiptVerified
      },
    },
  }
  return {
    service: new GoogleHomeNativeCompanionBoundaryService(ports, {
      now: () => new Date(AT),
    }),
    state,
  }
}

function dispatchInput(
  binding: LogicalBindingInput = LIGHTING_BINDING,
  envelope: GoogleHomeCommandEnvelope = lightingEnvelope(),
) {
  return { bindingLease: bindingLease(binding), envelope }
}

describe('Google Home native companion boundary orchestration', () => {
  it('uses every safe port before accepting one sanitized native outcome', async () => {
    const { service, state } = createHarness()
    const result = await service.dispatch(dispatchInput())

    expect(result.disposition).toBe('executed')
    expect(result.signedReceipt.receipt.status).toBe('completed')
    expect(state.approvalChecks).toBe(1)
    expect(state.dispatchCount).toBe(1)
  })

  it('returns the retained receipt on exact sequential and concurrent replay without redispatch', async () => {
    const { service, state } = createHarness()
    const input = dispatchInput()
    const first = await service.dispatch(input)
    const replay = await service.dispatch(input)

    expect(replay).toEqual({ disposition: 'replayed', signedReceipt: first.signedReceipt })
    expect(state.dispatchCount).toBe(1)
    expect(state.approvalChecks).toBe(1)

    const concurrentHarness = createHarness()
    const [left, right] = await Promise.all([
      concurrentHarness.service.dispatch(input),
      concurrentHarness.service.dispatch(input),
    ])
    expect([left.disposition, right.disposition].sort()).toEqual(['executed', 'replayed'])
    expect(concurrentHarness.state.dispatchCount).toBe(1)
  })

  it('denies a persisted approval mismatch before native checks or dispatch', async () => {
    const { service, state } = createHarness()
    const original = lightingEnvelope()
    const mismatched = GoogleHomeCommandEnvelopeSchema.parse({
      ...original,
      authorization: { ...original.authorization, planHash: OTHER_PLAN_HASH },
    })

    await expect(
      service.dispatch(dispatchInput(LIGHTING_BINDING, mismatched)),
    ).rejects.toMatchObject({
      code: 'GOOGLE_HOME_APPROVAL_INVALID',
    })
    expect(state.dispatchCount).toBe(0)
    expect(state.confirmationConsumptions).toBe(0)
  })

  it('rejects a changed signed request under an existing idempotency key', async () => {
    const { service, state } = createHarness()
    const original = lightingEnvelope()
    await service.dispatch(dispatchInput(LIGHTING_BINDING, original))
    const changed = GoogleHomeCommandEnvelopeSchema.parse({
      ...original,
      authorization: { ...original.authorization, planHash: OTHER_PLAN_HASH },
    })

    await expect(service.dispatch(dispatchInput(LIGHTING_BINDING, changed))).rejects.toMatchObject({
      code: 'GOOGLE_HOME_REPLAY_CONFLICT',
    })
    expect(state.dispatchCount).toBe(1)
    expect(state.approvalChecks).toBe(1)
  })

  it('binds every signature key to the command tenant before journal or dispatch', async () => {
    const { service, state } = createHarness()
    state.trustedTenant = 'org_foreign_tenant' as OrganizationId

    await expect(service.dispatch(dispatchInput())).rejects.toMatchObject({
      code: 'GOOGLE_HOME_BINDING_SIGNATURE_INVALID',
    })
    expect(state.approvalChecks).toBe(0)
    expect(state.dispatchCount).toBe(0)
  })

  it('consumes one mobile confirmation once while an exact replay remains idempotent', async () => {
    const { service, state } = createHarness()
    const firstEnvelope = unlockEnvelope()
    const firstInput = dispatchInput(LOCK_BINDING, firstEnvelope)

    const first = await service.dispatch(firstInput)
    const replay = await service.dispatch(firstInput)
    expect([first.disposition, replay.disposition]).toEqual(['executed', 'replayed'])
    expect(state.confirmationConsumptions).toBe(1)
    expect(state.dispatchCount).toBe(1)

    await expect(
      service.dispatch(dispatchInput(LOCK_BINDING, unlockEnvelope('op_google_home_unlock_02'))),
    ).rejects.toMatchObject({ code: 'GOOGLE_HOME_MOBILE_CONFIRMATION_INVALID' })
    expect(state.confirmationConsumptions).toBe(1)
    expect(state.dispatchCount).toBe(1)
  })

  it('computes thermostat and energy bounds from explicit numeric facts', async () => {
    const thermostat = createHarness()
    const envelope = temperatureEnvelope()
    const contract = {
      bindingLease: bindingLease(TEMPERATURE_BINDING),
      envelope,
    }
    const facts = safeFacts(contract, AT)
    if (facts.commandKind !== 'set_temperature') throw new Error('expected temperature facts')
    thermostat.state.safetyOverride = {
      ...facts,
      thermostat: { ...facts.thermostat, configuredMaximumCelsius: 20 },
    }

    await expect(
      thermostat.service.dispatch(dispatchInput(TEMPERATURE_BINDING, envelope)),
    ).rejects.toMatchObject({ code: 'GOOGLE_HOME_THERMOSTAT_BOUND_FAILED' })
    expect(thermostat.state.dispatchCount).toBe(0)

    const energy = createHarness()
    energy.state.safetyOverride = {
      ...facts,
      energy: { ...facts.energy, projectedWattHours: 501 },
    }
    await expect(
      energy.service.dispatch(dispatchInput(TEMPERATURE_BINDING, envelope)),
    ).rejects.toMatchObject({ code: 'GOOGLE_HOME_ENERGY_BOUND_FAILED' })
    expect(energy.state.dispatchCount).toBe(0)
  })

  it('requires fresh command-bound safety facts and an independently verified receipt', async () => {
    const stale = createHarness()
    const contract = {
      bindingLease: bindingLease(LIGHTING_BINDING),
      envelope: lightingEnvelope(),
    }
    stale.state.safetyOverride = {
      ...safeFacts(contract, '2026-08-14T02:01:59.999-04:00'),
    }
    await expect(stale.service.dispatch(dispatchInput())).rejects.toMatchObject({
      code: 'GOOGLE_HOME_SAFETY_FACTS_INVALID',
    })
    expect(stale.state.dispatchCount).toBe(0)

    const unverified = createHarness()
    unverified.state.receiptVerified = false
    await expect(unverified.service.dispatch(dispatchInput())).rejects.toMatchObject({
      code: 'GOOGLE_HOME_RECEIPT_VERIFICATION_FAILED',
    })
  })

  it('returns typed policy errors without provider response bags', async () => {
    const { service, state } = createHarness()
    const contract = {
      bindingLease: bindingLease(LIGHTING_BINDING),
      envelope: lightingEnvelope(),
    }
    state.safetyOverride = { ...safeFacts(contract, AT), consent: 'revoked' }

    try {
      await service.dispatch(dispatchInput())
      throw new Error('expected dispatch to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleHomeBoundaryError)
      expect(error).toMatchObject({ code: 'GOOGLE_HOME_CONSENT_REVOKED' })
      expect(error).not.toHaveProperty('providerResponse')
    }
  })
})

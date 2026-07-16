import {
  GoogleHomeDispatchContractSchema,
  GoogleHomeEnvelopeReceiptPairSchema,
  GoogleHomeNativeSafetyFactsSchema,
  IsoDateTimeSchema,
  googleHomeCommandEnvelopeSignaturePayload,
  googleHomeLogicalBindingSignaturePayload,
  googleHomeReceiptSignaturePayload,
  type ApprovalId,
  type GatewayCommandId,
  type GoogleHomeCommandEnvelope,
  type GoogleHomeConfirmationId,
  type GoogleHomeDispatchContract,
  type GoogleHomeNativeSafetyFacts,
  type GoogleHomeSignature,
  type OrganizationId,
  type PalaceId,
  type Sha256,
  type SignedGoogleHomeSanitizedReceipt,
} from '@trash-palace/core'

import { ApplicationError } from './errors.js'
import type { ClockPort } from './ports.js'
import { iso, sha256 } from './primitives.js'

export type GoogleHomeBoundaryErrorCode =
  | 'GOOGLE_HOME_APPROVAL_INVALID'
  | 'GOOGLE_HOME_BINDING_SIGNATURE_INVALID'
  | 'GOOGLE_HOME_BINDING_STALE'
  | 'GOOGLE_HOME_COMMAND_NOT_SUPPORTED'
  | 'GOOGLE_HOME_CONSENT_REVOKED'
  | 'GOOGLE_HOME_DERIVED_DATA_EXPIRED'
  | 'GOOGLE_HOME_ENERGY_BOUND_FAILED'
  | 'GOOGLE_HOME_ENVELOPE_EXPIRED'
  | 'GOOGLE_HOME_ENVELOPE_FROM_FUTURE'
  | 'GOOGLE_HOME_ENVELOPE_SIGNATURE_INVALID'
  | 'GOOGLE_HOME_LOCAL_BINDING_MISMATCH'
  | 'GOOGLE_HOME_MOBILE_CONFIRMATION_INVALID'
  | 'GOOGLE_HOME_NATIVE_SAFETY_CHECK_FAILED'
  | 'GOOGLE_HOME_RECEIPT_FROM_FUTURE'
  | 'GOOGLE_HOME_RECEIPT_SIGNATURE_INVALID'
  | 'GOOGLE_HOME_RECEIPT_VERIFICATION_FAILED'
  | 'GOOGLE_HOME_REPLAY_CONFLICT'
  | 'GOOGLE_HOME_SAFETY_FACTS_INVALID'
  | 'GOOGLE_HOME_THERMOSTAT_BOUND_FAILED'

export class GoogleHomeBoundaryError extends ApplicationError {
  public constructor(code: GoogleHomeBoundaryErrorCode, message: string) {
    super(code, message)
    this.name = 'GoogleHomeBoundaryError'
  }
}

export interface GoogleHomePersistedApprovalVerificationPort {
  verifyExactApproval(input: {
    readonly organizationId: OrganizationId
    readonly palaceId: PalaceId
    readonly missionId: GoogleHomeCommandEnvelope['command']['missionId']
    readonly operationId: GoogleHomeCommandEnvelope['command']['operationId']
    readonly approvalId: ApprovalId
    readonly planHash: Sha256
    readonly commandId: GatewayCommandId
    readonly commandPayloadHash: Sha256
  }): Promise<boolean>
}

export type GoogleHomeSignaturePurpose = 'binding_lease' | 'command_envelope' | 'sanitized_receipt'

export interface GoogleHomeKeyToTenantSignatureTrustPort {
  /** Resolves trust from the key registry itself; callers never supply the tenant mapping. */
  resolveTrustedTenant(input: {
    readonly purpose: GoogleHomeSignaturePurpose
    readonly keyId: string
    readonly signedAt: string
    readonly canonicalPayload: string
    readonly signature: string
  }): Promise<OrganizationId | null>
}

export interface GoogleHomeAtomicReplayJournalPort {
  /**
   * Atomically compares requestHash, serializes concurrent calls, and durably stores the verified
   * receipt before returning. An exact retry returns that receipt without invoking execute again.
   */
  executeOnce(
    input: {
      readonly organizationId: OrganizationId
      readonly idempotencyKey: GatewayCommandId
      readonly requestHash: Sha256
    },
    execute: () => Promise<SignedGoogleHomeSanitizedReceipt>,
  ): Promise<
    | {
        readonly disposition: 'executed' | 'replayed'
        readonly signedReceipt: SignedGoogleHomeSanitizedReceipt
      }
    | { readonly disposition: 'conflict' }
  >
}

export interface GoogleHomeOneUseMobileConfirmationPort {
  /** Validation and consumption are one atomic operation in the native secure store. */
  consumeOnce(input: {
    readonly organizationId: OrganizationId
    readonly confirmationId: GoogleHomeConfirmationId
    readonly approvalId: ApprovalId
    readonly planHash: Sha256
    readonly commandId: GatewayCommandId
    readonly confirmedAt: string
    readonly expiresAt: string
    readonly at: string
  }): Promise<'consumed' | 'invalid_or_consumed'>
}

export interface GoogleHomeConsentBindingSafetyPort {
  /** Raw Home inventory and state stay behind this port; only strict transient facts may return. */
  checkImmediatelyBeforeDispatch(input: {
    readonly contract: GoogleHomeDispatchContract
    readonly at: string
  }): Promise<unknown>
}

export interface GoogleHomePrivateNativeDispatchPort {
  /** Implementations may handle raw SDK values internally but return only a sanitized receipt. */
  dispatch(input: {
    readonly contract: GoogleHomeDispatchContract
    readonly at: string
  }): Promise<unknown>
}

export interface GoogleHomeReceiptVerificationPort {
  verifySanitizedOutcome(input: {
    readonly contract: GoogleHomeDispatchContract
    readonly signedReceipt: SignedGoogleHomeSanitizedReceipt
    readonly at: string
  }): Promise<boolean>
}

export interface GoogleHomeNativeCompanionBoundaryPorts {
  readonly approvals: GoogleHomePersistedApprovalVerificationPort
  readonly signatureTrust: GoogleHomeKeyToTenantSignatureTrustPort
  readonly replayJournal: GoogleHomeAtomicReplayJournalPort
  readonly mobileConfirmations: GoogleHomeOneUseMobileConfirmationPort
  readonly nativeChecks: GoogleHomeConsentBindingSafetyPort
  readonly privateDispatch: GoogleHomePrivateNativeDispatchPort
  readonly receiptVerification: GoogleHomeReceiptVerificationPort
}

export interface GoogleHomeNativeCompanionDispatchResult {
  readonly disposition: 'executed' | 'replayed'
  readonly signedReceipt: SignedGoogleHomeSanitizedReceipt
}

function timestamp(value: string): number {
  return Date.parse(IsoDateTimeSchema.parse(value))
}

function signatureHeader(signature: GoogleHomeSignature) {
  return {
    version: signature.version,
    algorithm: signature.algorithm,
    keyId: signature.keyId,
    signedAt: signature.signedAt,
  } as const
}

function commandSigningPayload(envelope: GoogleHomeCommandEnvelope) {
  const { signature: _signature, ...payload } = envelope
  return payload
}

function assertCurrentDispatchAuthority(
  contract: GoogleHomeDispatchContract,
  atValue: string,
): void {
  const at = timestamp(atValue)
  const { binding } = contract.bindingLease
  const { envelope } = contract

  if (binding.consentStatus === 'revoked') {
    throw new GoogleHomeBoundaryError(
      'GOOGLE_HOME_CONSENT_REVOKED',
      'The logical binding records revoked Google Home consent',
    )
  }
  if (at < timestamp(binding.bindingVerifiedAt) || at >= timestamp(binding.validUntil)) {
    throw new GoogleHomeBoundaryError(
      'GOOGLE_HOME_BINDING_STALE',
      'The native companion logical binding lease is stale',
    )
  }
  if (at >= timestamp(binding.deleteAfter)) {
    throw new GoogleHomeBoundaryError(
      'GOOGLE_HOME_DERIVED_DATA_EXPIRED',
      'The logical binding passed its mandatory deletion time',
    )
  }
  if (at < timestamp(envelope.issuedAt)) {
    throw new GoogleHomeBoundaryError(
      'GOOGLE_HOME_ENVELOPE_FROM_FUTURE',
      'The command envelope is not valid yet',
    )
  }
  if (at >= timestamp(envelope.expiresAt)) {
    throw new GoogleHomeBoundaryError(
      'GOOGLE_HOME_ENVELOPE_EXPIRED',
      'The command envelope expired before native dispatch',
    )
  }
}

function assertSafetyFacts(
  contract: GoogleHomeDispatchContract,
  rawFacts: unknown,
  at: string,
): GoogleHomeNativeSafetyFacts {
  const facts = GoogleHomeNativeSafetyFactsSchema.parse(rawFacts)
  if (
    facts.bindingId !== contract.envelope.bindingId ||
    facts.organizationId !== contract.envelope.organizationId ||
    facts.commandId !== contract.envelope.command.id ||
    facts.commandKind !== contract.envelope.command.kind ||
    timestamp(facts.checkedAt) !== timestamp(at)
  ) {
    throw new GoogleHomeBoundaryError(
      'GOOGLE_HOME_SAFETY_FACTS_INVALID',
      'Native safety facts do not describe this command at the dispatch instant',
    )
  }
  if (facts.consent !== 'active') {
    throw new GoogleHomeBoundaryError(
      'GOOGLE_HOME_CONSENT_REVOKED',
      'Current Google Home consent is revoked or unavailable',
    )
  }
  if (facts.localBinding !== 'matched') {
    throw new GoogleHomeBoundaryError(
      'GOOGLE_HOME_LOCAL_BINDING_MISMATCH',
      'The logical slot no longer matches its local native device binding',
    )
  }
  if (facts.commandSupport !== 'supported') {
    throw new GoogleHomeBoundaryError(
      'GOOGLE_HOME_COMMAND_NOT_SUPPORTED',
      'The native companion cannot prove support for this logical command',
    )
  }
  if (facts.nativeSafetyChecks !== 'passed') {
    throw new GoogleHomeBoundaryError(
      'GOOGLE_HOME_NATIVE_SAFETY_CHECK_FAILED',
      'The native device safety checks did not pass',
    )
  }
  if (facts.commandKind === 'set_temperature') {
    if (contract.envelope.command.kind !== 'set_temperature') {
      throw new GoogleHomeBoundaryError(
        'GOOGLE_HOME_SAFETY_FACTS_INVALID',
        'Temperature safety facts do not describe the signed command',
      )
    }
    const target = contract.envelope.command.payload.targetCelsius
    if (
      facts.thermostat.targetCelsius !== target ||
      facts.thermostat.configuredMinimumCelsius > target ||
      facts.thermostat.configuredMaximumCelsius < target ||
      facts.thermostat.configuredMinimumCelsius > facts.thermostat.configuredMaximumCelsius
    ) {
      throw new GoogleHomeBoundaryError(
        'GOOGLE_HOME_THERMOSTAT_BOUND_FAILED',
        'The thermostat target is outside configured application safety bounds',
      )
    }
  }
  if (facts.commandKind === 'set_temperature' || facts.commandKind === 'set_lighting') {
    if (
      facts.energy.projectedWattHours + facts.energy.requiredReserveWattHours >
      facts.energy.availableWattHours
    ) {
      throw new GoogleHomeBoundaryError(
        'GOOGLE_HOME_ENERGY_BOUND_FAILED',
        'The command cannot be proven within the current application energy budget',
      )
    }
  }
  return facts
}

export class GoogleHomeNativeCompanionBoundaryService {
  public constructor(
    private readonly ports: GoogleHomeNativeCompanionBoundaryPorts,
    private readonly clock: ClockPort,
  ) {}

  public async dispatch(input: {
    readonly bindingLease: unknown
    readonly envelope: unknown
  }): Promise<GoogleHomeNativeCompanionDispatchResult> {
    const at = IsoDateTimeSchema.parse(iso(this.clock.now()))
    const contract = GoogleHomeDispatchContractSchema.parse({
      bindingLease: input.bindingLease,
      envelope: input.envelope,
    })
    await this.#assertTrustedContract(contract)

    const envelopePayload = googleHomeCommandEnvelopeSignaturePayload(
      commandSigningPayload(contract.envelope),
      signatureHeader(contract.envelope.signature),
    )
    const journalResult = await this.ports.replayJournal.executeOnce(
      {
        organizationId: contract.envelope.organizationId,
        idempotencyKey: contract.envelope.idempotencyKey,
        requestHash: sha256(envelopePayload),
      },
      async () => this.#executeFirstDispatch(contract, at),
    )
    if (journalResult.disposition === 'conflict') {
      throw new GoogleHomeBoundaryError(
        'GOOGLE_HOME_REPLAY_CONFLICT',
        'The command idempotency key was already used for a different signed envelope',
      )
    }
    if (journalResult.disposition === 'replayed') {
      await this.#verifyReceipt(contract, journalResult.signedReceipt, at)
    }
    return journalResult
  }

  async #assertTrustedContract(contract: GoogleHomeDispatchContract): Promise<void> {
    const bindingSignature = contract.bindingLease.signature
    const bindingTenant = await this.ports.signatureTrust.resolveTrustedTenant({
      purpose: 'binding_lease',
      keyId: bindingSignature.keyId,
      signedAt: bindingSignature.signedAt,
      canonicalPayload: googleHomeLogicalBindingSignaturePayload(
        contract.bindingLease.binding,
        signatureHeader(bindingSignature),
      ),
      signature: bindingSignature.value,
    })
    if (bindingTenant !== contract.envelope.organizationId) {
      throw new GoogleHomeBoundaryError(
        'GOOGLE_HOME_BINDING_SIGNATURE_INVALID',
        'The logical binding signature is not trusted for this tenant',
      )
    }

    const envelopeSignature = contract.envelope.signature
    const envelopeTenant = await this.ports.signatureTrust.resolveTrustedTenant({
      purpose: 'command_envelope',
      keyId: envelopeSignature.keyId,
      signedAt: envelopeSignature.signedAt,
      canonicalPayload: googleHomeCommandEnvelopeSignaturePayload(
        commandSigningPayload(contract.envelope),
        signatureHeader(envelopeSignature),
      ),
      signature: envelopeSignature.value,
    })
    if (envelopeTenant !== contract.envelope.organizationId) {
      throw new GoogleHomeBoundaryError(
        'GOOGLE_HOME_ENVELOPE_SIGNATURE_INVALID',
        'The command envelope signature is not trusted for this tenant',
      )
    }
  }

  async #executeFirstDispatch(
    contract: GoogleHomeDispatchContract,
    at: string,
  ): Promise<SignedGoogleHomeSanitizedReceipt> {
    assertCurrentDispatchAuthority(contract, at)

    const { authorization } = contract.envelope
    const approved = await this.ports.approvals.verifyExactApproval({
      organizationId: contract.envelope.organizationId,
      palaceId: contract.envelope.palaceId,
      missionId: contract.envelope.command.missionId,
      operationId: contract.envelope.command.operationId,
      approvalId: authorization.approvalId,
      planHash: authorization.planHash,
      commandId: contract.envelope.command.id,
      commandPayloadHash: contract.envelope.command.payloadHash,
    })
    if (!approved) {
      throw new GoogleHomeBoundaryError(
        'GOOGLE_HOME_APPROVAL_INVALID',
        'No persisted approval matches the exact plan and command',
      )
    }

    const facts = await this.ports.nativeChecks.checkImmediatelyBeforeDispatch({ contract, at })
    assertSafetyFacts(contract, facts, at)

    if (contract.envelope.command.kind === 'unlock') {
      const confirmation = contract.envelope.authorization
      if (confirmation.mode !== 'fresh_mobile_confirmation') {
        throw new GoogleHomeBoundaryError(
          'GOOGLE_HOME_MOBILE_CONFIRMATION_INVALID',
          'Unlock requires a current one-use secured-mobile confirmation',
        )
      }
      const result = await this.ports.mobileConfirmations.consumeOnce({
        organizationId: contract.envelope.organizationId,
        confirmationId: confirmation.confirmation.id,
        approvalId: confirmation.approvalId,
        planHash: confirmation.planHash,
        commandId: contract.envelope.command.id,
        confirmedAt: confirmation.confirmation.confirmedAt,
        expiresAt: confirmation.confirmation.expiresAt,
        at,
      })
      if (result !== 'consumed') {
        throw new GoogleHomeBoundaryError(
          'GOOGLE_HOME_MOBILE_CONFIRMATION_INVALID',
          'Unlock requires a current unused secured-mobile confirmation',
        )
      }
    }

    const rawReceipt = await this.ports.privateDispatch.dispatch({ contract, at })
    const pair = GoogleHomeEnvelopeReceiptPairSchema.parse({
      envelope: contract.envelope,
      signedReceipt: rawReceipt,
    })
    await this.#verifyReceipt(contract, pair.signedReceipt, at)
    return pair.signedReceipt
  }

  async #verifyReceipt(
    contract: GoogleHomeDispatchContract,
    rawReceipt: unknown,
    atValue: string,
  ): Promise<SignedGoogleHomeSanitizedReceipt> {
    const pair = GoogleHomeEnvelopeReceiptPairSchema.parse({
      envelope: contract.envelope,
      signedReceipt: rawReceipt,
    })
    const { signedReceipt } = pair
    const receiptSignature = signedReceipt.signature
    const receiptTenant = await this.ports.signatureTrust.resolveTrustedTenant({
      purpose: 'sanitized_receipt',
      keyId: receiptSignature.keyId,
      signedAt: receiptSignature.signedAt,
      canonicalPayload: googleHomeReceiptSignaturePayload(
        signedReceipt.receipt,
        signatureHeader(receiptSignature),
      ),
      signature: receiptSignature.value,
    })
    if (receiptTenant !== contract.envelope.organizationId) {
      throw new GoogleHomeBoundaryError(
        'GOOGLE_HOME_RECEIPT_SIGNATURE_INVALID',
        'The sanitized receipt signature is not trusted for this tenant',
      )
    }

    const at = timestamp(atValue)
    if (at < timestamp(signedReceipt.receipt.recordedAt)) {
      throw new GoogleHomeBoundaryError(
        'GOOGLE_HOME_RECEIPT_FROM_FUTURE',
        'The native companion receipt is not valid yet',
      )
    }
    if (at >= timestamp(signedReceipt.receipt.deleteAfter)) {
      throw new GoogleHomeBoundaryError(
        'GOOGLE_HOME_DERIVED_DATA_EXPIRED',
        'The native companion receipt passed its mandatory deletion time',
      )
    }
    if (
      !(await this.ports.receiptVerification.verifySanitizedOutcome({
        contract,
        signedReceipt,
        at: atValue,
      }))
    ) {
      throw new GoogleHomeBoundaryError(
        'GOOGLE_HOME_RECEIPT_VERIFICATION_FAILED',
        'The sanitized receipt outcome could not be independently verified',
      )
    }
    return signedReceipt
  }
}

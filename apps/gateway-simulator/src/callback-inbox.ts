import {
  callbackDedupeInput,
  GatewayCallbackBindingSchema,
  type CallbackDedupeInput,
  type GatewayCallback,
  type GatewayCallbackBinding,
} from './contracts.js'
import {
  verifyGatewayCallback,
  type GatewayVerificationKeyring,
  type VerifyGatewayCallbackOptions,
} from './signing.js'

export type CallbackInboxErrorCode =
  'CALLBACK_BINDING_MISMATCH' | 'CALLBACK_ID_PAYLOAD_CONFLICT' | 'CALLBACK_NONCE_REUSE'

export class CallbackInboxError extends Error {
  public readonly code: CallbackInboxErrorCode

  public constructor(code: CallbackInboxErrorCode, message: string) {
    super(message)
    this.name = 'CallbackInboxError'
    this.code = code
  }
}

export interface CallbackInboxResult {
  readonly status: 'accepted' | 'duplicate'
  readonly callback: GatewayCallback
  readonly dedupe: CallbackDedupeInput
}

export interface GatewayCallbackInboxOptions {
  readonly keyring: GatewayVerificationKeyring
  readonly maximumAgeMilliseconds?: number
  readonly futureToleranceMilliseconds?: number
}

export class GatewayCallbackInbox {
  readonly #options: GatewayCallbackInboxOptions
  readonly #callbacks = new Map<string, CallbackDedupeInput>()
  readonly #nonces = new Map<string, string>()

  public constructor(options: GatewayCallbackInboxOptions) {
    this.#options = options
  }

  public get size(): number {
    return this.#callbacks.size
  }

  public ingest(
    input: unknown,
    now: VerifyGatewayCallbackOptions['now'],
    expectedBinding: GatewayCallbackBinding,
  ): CallbackInboxResult {
    const callback = verifyGatewayCallback(input, {
      keyring: this.#options.keyring,
      now,
      ...(this.#options.maximumAgeMilliseconds === undefined
        ? {}
        : { maximumAgeMilliseconds: this.#options.maximumAgeMilliseconds }),
      ...(this.#options.futureToleranceMilliseconds === undefined
        ? {}
        : { futureToleranceMilliseconds: this.#options.futureToleranceMilliseconds }),
    })
    const expected = GatewayCallbackBindingSchema.parse(expectedBinding)
    if (
      callback.organizationId !== expected.organizationId ||
      callback.missionId !== expected.missionId ||
      callback.palaceId !== expected.palaceId ||
      callback.operationId !== expected.operationId ||
      callback.commandId !== expected.commandId
    ) {
      throw new CallbackInboxError(
        'CALLBACK_BINDING_MISMATCH',
        'Signed callback identity does not match the stored command and operation',
      )
    }
    const dedupe = callbackDedupeInput(callback)
    const existing = this.#callbacks.get(dedupe.callbackId)
    if (existing) {
      if (
        existing.payloadHash === dedupe.payloadHash &&
        existing.organizationId === dedupe.organizationId &&
        existing.nonce === dedupe.nonce
      ) {
        return Object.freeze({ status: 'duplicate', callback, dedupe })
      }
      throw new CallbackInboxError(
        'CALLBACK_ID_PAYLOAD_CONFLICT',
        'A callback ID was reused with different tenant, nonce, or payload data',
      )
    }

    const nonceOwner = this.#nonces.get(dedupe.nonce)
    if (nonceOwner !== undefined && nonceOwner !== dedupe.callbackId) {
      throw new CallbackInboxError(
        'CALLBACK_NONCE_REUSE',
        'A callback nonce was reused by a different callback ID',
      )
    }
    this.#callbacks.set(dedupe.callbackId, dedupe)
    this.#nonces.set(dedupe.nonce, dedupe.callbackId)
    return Object.freeze({ status: 'accepted', callback, dedupe })
  }
}

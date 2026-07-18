import { createHash, timingSafeEqual, verify } from 'node:crypto'

import type { SmartThingsWebhookRequest, WebhookSignatureVerifierPort } from './ports.js'

const SMARTTHINGS_KEY_ORIGIN = 'https://key.smartthings.com'
const MAX_PUBLIC_KEY_BYTES = 64 * 1024
const DEFAULT_KEY_CACHE_TTL_MILLISECONDS = 2 * 60 * 60 * 1000
const MAX_SIGNATURE_AGE_MILLISECONDS = 5 * 60 * 1000
const KEY_ID_PATTERN = /^\/[A-Za-z0-9/_-]{1,512}$/
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

interface ParsedSignature {
  readonly keyId: string
  readonly signature: string
}

export interface SmartThingsWebhookVerifierDependencies {
  readonly fetch?: typeof fetch
  readonly now?: () => Date
  readonly keyCacheTtlMilliseconds?: number
}

/**
 * Verifies SmartThings HTTP Signatures without trusting a callback body. Public keys are
 * fetched only from SmartThings' fixed key origin and cached briefly to accommodate rotation.
 */
export class SmartThingsWebhookSignatureVerifier implements WebhookSignatureVerifierPort {
  readonly #fetch: typeof fetch
  readonly #now: () => Date
  readonly #keyCacheTtlMilliseconds: number
  readonly #keys = new Map<string, { readonly pem: string; readonly expiresAt: number }>()

  public constructor(dependencies: SmartThingsWebhookVerifierDependencies = {}) {
    this.#fetch = dependencies.fetch ?? fetch
    this.#now = dependencies.now ?? (() => new Date())
    this.#keyCacheTtlMilliseconds =
      dependencies.keyCacheTtlMilliseconds ?? DEFAULT_KEY_CACHE_TTL_MILLISECONDS
    if (!Number.isSafeInteger(this.#keyCacheTtlMilliseconds) || this.#keyCacheTtlMilliseconds < 1) {
      throw new RangeError('keyCacheTtlMilliseconds must be a positive safe integer')
    }
  }

  public async verify(request: SmartThingsWebhookRequest): Promise<boolean> {
    const parsed = parseSignature(request.authorization)
    if (parsed === null || !digestMatches(request.digest, request.rawBody)) return false
    const signedDate = Date.parse(request.date)
    if (!Number.isFinite(signedDate)) return false
    if (Math.abs(this.#now().getTime() - signedDate) > MAX_SIGNATURE_AGE_MILLISECONDS) return false
    const publicKey = await this.#keyFor(parsed.keyId)
    if (publicKey === null) return false
    try {
      return verify(
        'RSA-SHA256',
        Buffer.from(signingString(request), 'utf8'),
        publicKey,
        Buffer.from(parsed.signature, 'base64'),
      )
    } catch {
      return false
    }
  }

  async #keyFor(keyId: string): Promise<string | null> {
    const cached = this.#keys.get(keyId)
    if (cached !== undefined && cached.expiresAt > this.#now().getTime()) return cached.pem
    const url = publicKeyUrl(keyId)
    if (url === null) return null
    try {
      const response = await this.#fetch(url, {
        headers: { accept: 'application/x-pem-file, text/plain;q=0.9' },
        redirect: 'error',
      })
      if (!response.ok) return null
      const declaredLength = response.headers.get('content-length')
      if (
        declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_PUBLIC_KEY_BYTES)
      ) {
        return null
      }
      const pem = await response.text()
      if (pem.length === 0 || Buffer.byteLength(pem, 'utf8') > MAX_PUBLIC_KEY_BYTES) return null
      this.#keys.set(keyId, {
        pem,
        expiresAt: this.#now().getTime() + this.#keyCacheTtlMilliseconds,
      })
      return pem
    } catch {
      return null
    }
  }
}

function parseSignature(authorization: string): ParsedSignature | null {
  if (!authorization.startsWith('Signature ')) return null
  const values = new Map<string, string>()
  const expression = /([a-zA-Z]+)="([^"]*)"/g
  for (const match of authorization.slice('Signature '.length).matchAll(expression)) {
    const key = match[1]
    const value = match[2]
    if (key === undefined || value === undefined || values.has(key)) return null
    values.set(key, value)
  }
  const keyId = values.get('keyId')
  const signature = values.get('signature')
  if (
    values.size !== 4 ||
    keyId === undefined ||
    signature === undefined ||
    values.get('headers') !== '(request-target) digest date' ||
    values.get('algorithm')?.toLowerCase() !== 'rsa-sha256' ||
    !KEY_ID_PATTERN.test(keyId) ||
    keyId.includes('//') ||
    keyId.split('/').some((segment) => segment === '..') ||
    !BASE64_PATTERN.test(signature) ||
    signature.length % 4 !== 0
  ) {
    return null
  }
  return { keyId, signature }
}

function publicKeyUrl(keyId: string): string | null {
  if (!KEY_ID_PATTERN.test(keyId) || keyId.includes('//') || keyId.includes('..')) return null
  return `${SMARTTHINGS_KEY_ORIGIN}/key${keyId}`
}

function digestMatches(digest: string, rawBody: string): boolean {
  const match = /^SHA256=([A-Za-z0-9+/]+={0,2})$/.exec(digest)
  if (match?.[1] === undefined || !BASE64_PATTERN.test(match[1]) || match[1].length % 4 !== 0) {
    return false
  }
  const expected = Buffer.from(match[1], 'base64')
  const actual = createHash('sha256').update(rawBody, 'utf8').digest()
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function signingString(request: SmartThingsWebhookRequest): string {
  return `(request-target): ${request.method.toLowerCase()} ${request.path}\ndigest: ${request.digest}\ndate: ${request.date}`
}

import { createHmac, timingSafeEqual } from 'node:crypto'

import { PrincipalSchema, type Principal } from '@trash-palace/core'
import { z } from 'zod'

import { AuthenticationError } from './errors.js'
import type { AuthContext } from './models.js'
import { CryptoEntropy, SYSTEM_CLOCK, iso } from './primitives.js'
import type { ClockPort, EntropyPort, SensitiveMutationGuardPort } from './ports.js'

const SessionClaimsSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().regex(/^session_[A-Za-z0-9_-]{20,}$/),
    csrfToken: z.string().regex(/^[A-Za-z0-9_-]{20,}$/),
    principal: PrincipalSchema,
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    authenticatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()

export interface SeededSessionOptions {
  readonly ttlMilliseconds?: number
  readonly authenticatedAt?: Date
}

export class SeededSessionService implements SensitiveMutationGuardPort {
  readonly #key: Uint8Array

  public constructor(
    signingKey: string | Uint8Array,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly entropy: EntropyPort = new CryptoEntropy(),
  ) {
    const key = typeof signingKey === 'string' ? Buffer.from(signingKey, 'utf8') : signingKey
    if (key.byteLength < 32) {
      throw new Error('Seeded session signing keys must contain at least 32 bytes')
    }
    this.#key = Uint8Array.from(key)
  }

  public issue(principalInput: Principal, options: SeededSessionOptions = {}): string {
    const principal = PrincipalSchema.parse(principalInput)
    const now = this.clock.now()
    const ttlMilliseconds = options.ttlMilliseconds ?? 8 * 60 * 60 * 1_000
    if (
      !Number.isInteger(ttlMilliseconds) ||
      ttlMilliseconds <= 0 ||
      ttlMilliseconds > 24 * 60 * 60 * 1_000
    ) {
      throw new RangeError('Seeded sessions must expire within 24 hours')
    }
    const payload = SessionClaimsSchema.parse({
      version: 1,
      sessionId: `session_${this.entropy.token(24)}`,
      csrfToken: this.entropy.token(24),
      principal,
      issuedAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + ttlMilliseconds)),
      authenticatedAt: iso(options.authenticatedAt ?? now),
    })
    return this.#encode(payload)
  }

  public verify(token: string): AuthContext {
    const [encodedPayload, encodedSignature, extra] = token.split('.')
    if (encodedPayload === undefined || encodedSignature === undefined || extra !== undefined) {
      throw new AuthenticationError('Malformed seeded session')
    }
    const expected = this.#signature(encodedPayload)
    let actual: Buffer
    try {
      actual = Buffer.from(encodedSignature, 'base64url')
    } catch {
      throw new AuthenticationError('Malformed seeded session signature')
    }
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new AuthenticationError('Seeded session signature is invalid')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    } catch {
      throw new AuthenticationError('Seeded session payload is invalid')
    }
    const result = SessionClaimsSchema.safeParse(parsed)
    if (!result.success) throw new AuthenticationError('Seeded session payload is invalid')
    if (this.clock.now().getTime() >= Date.parse(result.data.expiresAt)) {
      throw new AuthenticationError('Seeded session has expired')
    }
    return result.data
  }

  public rotate(token: string, ttlMilliseconds?: number): string {
    const context = this.verify(token)
    return this.issue(context.principal, {
      ...(ttlMilliseconds === undefined ? {} : { ttlMilliseconds }),
      authenticatedAt: this.clock.now(),
    })
  }

  public assertSensitiveMutation(input: {
    readonly context: AuthContext
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
    readonly maxReauthenticationAgeMilliseconds?: number
  }): void {
    if (this.clock.now().getTime() >= Date.parse(input.context.expiresAt)) {
      throw new AuthenticationError('Seeded session has expired')
    }
    if (!safeEqual(input.context.csrfToken, input.csrfToken)) {
      throw new AuthenticationError('CSRF token is invalid')
    }
    if (input.origin !== input.allowedOrigin) {
      throw new AuthenticationError('Mutation origin is not allowed')
    }
    const maximumAge = input.maxReauthenticationAgeMilliseconds ?? 5 * 60 * 1_000
    if (this.clock.now().getTime() - Date.parse(input.context.authenticatedAt) > maximumAge) {
      throw new AuthenticationError('Sensitive mutation requires recent authentication')
    }
  }

  public assert(input: {
    readonly context: AuthContext
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }): void {
    this.assertSensitiveMutation(input)
  }

  #encode(payload: z.infer<typeof SessionClaimsSchema>): string {
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return `${encodedPayload}.${this.#signature(encodedPayload).toString('base64url')}`
  }

  #signature(encodedPayload: string): Buffer {
    return createHmac('sha256', this.#key).update(`seeded-session@1.${encodedPayload}`).digest()
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

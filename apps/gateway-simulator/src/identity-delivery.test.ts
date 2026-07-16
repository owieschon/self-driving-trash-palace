import { IdentityTelemetryEventSchema, type SignedIdentityTelemetry } from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import {
  BoundedIdentityTelemetryDelivery,
  type IdentityTelemetryDeliveryConfiguration,
  type IdentityTelemetryDeliveryError,
} from './identity-delivery.js'
import { signIdentityTelemetry } from './identity-signing.js'

const KEY = 'identity-delivery-test-key-at-least-32-bytes'
const TELEMETRY_URL = 'http://web.test/api/internal/v1/identity/telemetry'
const READINESS_URL = 'http://web.test/api/v1/ready'

function signedTelemetry(suffix = 'unknown'): SignedIdentityTelemetry {
  const event = IdentityTelemetryEventSchema.parse({
    schemaVersion: 'identity-telemetry-event@1',
    providerEventId: `idt_delivery_${suffix}_event`,
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    palaceId: 'pal_sacred_dumpster',
    identityTagId: suffix === 'verified' ? 'tag_rocky_verified' : 'tag_unknown_guest',
    observedAt: suffix === 'verified' ? '2026-08-14T05:58:00.000Z' : '2026-08-14T05:50:00.000Z',
    nonce: `itn_delivery_${suffix}_event_nonce`,
  })
  return signIdentityTelemetry(event, {
    keyId: 'itk_delivery_identity',
    key: KEY,
    timestamp: '2026-07-15T12:00:00.000Z',
  })
}

function configuration(
  overrides: Partial<IdentityTelemetryDeliveryConfiguration> = {},
): IdentityTelemetryDeliveryConfiguration {
  return {
    telemetryUrl: TELEMETRY_URL,
    readinessUrl: READINESS_URL,
    maximumAttempts: 4,
    initialBackoffMilliseconds: 10,
    maximumBackoffMilliseconds: 40,
    requestTimeoutMilliseconds: 1_000,
    readinessIntervalMilliseconds: 60_000,
    maximumTrackedEvents: 16,
    ...overrides,
  }
}

describe('bounded identity telemetry delivery', () => {
  it('deduplicates replay and retries only bounded transient responses at the fixed target', async () => {
    const telemetry = signedTelemetry()
    const requests: { body: string; eventId: string | null; url: string }[] = []
    const backoffs: number[] = []
    let attempts = 0
    const delivery = new BoundedIdentityTelemetryDelivery(configuration(), {
      fetch: async (input, init) => {
        const url = requestUrl(input)
        if (url === READINESS_URL) return new Response(null, { status: 200 })
        attempts += 1
        requests.push({
          url,
          body: requestBody(init),
          eventId: new Headers(init?.headers).get('x-trash-palace-identity-event-id'),
        })
        return new Response(null, { status: attempts < 3 ? 503 : 202 })
      },
      sleep: (milliseconds) => {
        backoffs.push(milliseconds)
        return Promise.resolve()
      },
    })
    await delivery.start()

    const first = delivery.enqueue(telemetry)
    expect(delivery.enqueue(structuredClone(telemetry))).toBe(first)
    await first

    expect(backoffs).toEqual([10, 20])
    expect(requests).toHaveLength(3)
    expect(requests.map((request) => request.url)).toEqual([
      TELEMETRY_URL,
      TELEMETRY_URL,
      TELEMETRY_URL,
    ])
    expect(requests[0]).toMatchObject({
      body: JSON.stringify(telemetry),
      eventId: telemetry.event.providerEventId,
    })
    expect(delivery.trackedCount).toBe(1)
    await delivery.drain(1_000)
  })

  it('does not retry permanent rejection and retains failure in readiness and drain', async () => {
    const telemetry = signedTelemetry()
    let attempts = 0
    const delivery = new BoundedIdentityTelemetryDelivery(configuration(), {
      fetch: async (input) => {
        if (requestUrl(input) === READINESS_URL) return new Response(null, { status: 200 })
        attempts += 1
        return new Response(null, { status: 409 })
      },
      sleep: () => Promise.resolve(),
    })
    await delivery.start()

    await expect(delivery.enqueue(telemetry)).rejects.toMatchObject<IdentityTelemetryDeliveryError>(
      {
        code: 'IDENTITY_TELEMETRY_DELIVERY_PERMANENT_REJECTION',
      },
    )
    expect(attempts).toBe(1)
    expect(delivery.isReady).toBe(false)
    await expect(delivery.drain(1_000)).rejects.toMatchObject<IdentityTelemetryDeliveryError>({
      code: 'IDENTITY_TELEMETRY_DELIVERY_EXHAUSTED',
    })
  })

  it('fails closed when a provider event ID is replayed with different signed bytes', async () => {
    const telemetry = signedTelemetry()
    const delivery = new BoundedIdentityTelemetryDelivery(configuration(), {
      fetch: async (input) =>
        new Response(null, { status: requestUrl(input) === READINESS_URL ? 200 : 202 }),
    })
    await delivery.start()
    await delivery.enqueue(telemetry)
    const conflicting = structuredClone(telemetry)
    conflicting.signature.digest = 'f'.repeat(64)

    await expect(
      delivery.enqueue(conflicting),
    ).rejects.toMatchObject<IdentityTelemetryDeliveryError>({
      code: 'IDENTITY_TELEMETRY_DELIVERY_CONFLICT',
    })
    expect(delivery.isReady).toBe(false)
    await expect(delivery.drain(1_000)).rejects.toMatchObject<IdentityTelemetryDeliveryError>({
      code: 'IDENTITY_TELEMETRY_DELIVERY_EXHAUSTED',
    })
  })

  it('bounds pending capacity while allowing delivered records to be evicted', async () => {
    let resolveFirst: ((response: Response) => void) | undefined
    let posts = 0
    const delivery = new BoundedIdentityTelemetryDelivery(
      configuration({ maximumTrackedEvents: 1 }),
      {
        fetch: async (input) => {
          if (requestUrl(input) === READINESS_URL) return new Response(null, { status: 200 })
          posts += 1
          if (posts === 1) {
            return new Promise<Response>((resolve) => {
              resolveFirst = resolve
            })
          }
          return new Response(null, { status: 202 })
        },
      },
    )
    await delivery.start()
    const first = delivery.enqueue(signedTelemetry())

    await expect(
      delivery.enqueue(signedTelemetry('verified')),
    ).rejects.toMatchObject<IdentityTelemetryDeliveryError>({
      code: 'IDENTITY_TELEMETRY_DELIVERY_QUEUE_FULL',
    })
    resolveFirst?.(new Response(null, { status: 202 }))
    await first
    expect(delivery.isReady).toBe(false)
    await expect(delivery.drain(1_000)).rejects.toMatchObject<IdentityTelemetryDeliveryError>({
      code: 'IDENTITY_TELEMETRY_DELIVERY_EXHAUSTED',
    })

    const healthy = new BoundedIdentityTelemetryDelivery(
      configuration({ maximumTrackedEvents: 1 }),
      {
        fetch: async (input) =>
          new Response(null, { status: requestUrl(input) === READINESS_URL ? 200 : 202 }),
      },
    )
    await healthy.start()
    await healthy.enqueue(signedTelemetry())
    await healthy.enqueue(signedTelemetry('verified'))
    expect(healthy.trackedCount).toBe(1)
    await healthy.drain(1_000)
  })

  it('waits for an accepted in-flight event during graceful drain', async () => {
    let resolvePost: ((response: Response) => void) | undefined
    const delivery = new BoundedIdentityTelemetryDelivery(configuration(), {
      fetch: async (input) => {
        if (requestUrl(input) === READINESS_URL) return new Response(null, { status: 200 })
        return new Promise<Response>((resolve) => {
          resolvePost = resolve
        })
      },
    })
    await delivery.start()
    void delivery.enqueue(signedTelemetry())
    const draining = delivery.drain(1_000)
    let settled = false
    void draining.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    resolvePost?.(new Response(null, { status: 202 }))
    await draining
  })
})

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new TypeError('Expected telemetry request string body')
  return init.body
}

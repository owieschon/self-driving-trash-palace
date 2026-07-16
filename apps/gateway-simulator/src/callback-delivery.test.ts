import { createGatewayCommand, type SignedGatewayCallback } from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import {
  BoundedGatewayCallbackDelivery,
  type CallbackDeliveryError,
  type CallbackDeliveryConfiguration,
} from './callback-delivery.js'
import { createCanonicalGatewayDeviceRuntime } from './canonical-fixture.js'
import { GatewaySimulator } from './simulator.js'

const SIGNING_KEY = 'callback-delivery-test-key-at-least-32-bytes'

function signedCallback(): SignedGatewayCallback {
  const { clock, deviceModel } = createCanonicalGatewayDeviceRuntime()
  const callbacks: SignedGatewayCallback[] = []
  const simulator = new GatewaySimulator({
    clock,
    deviceModel,
    signingKeyId: 'gwk_callback_delivery_test',
    signingKey: SIGNING_KEY,
    onCallback: (callback) => callbacks.push(callback),
  })
  const command = createGatewayCommand({
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    palaceId: 'pal_sacred_dumpster',
    operationId: 'op_callback_delivery_test',
    logicalKey: 'delivery-test-lighting',
    kind: 'set_lighting',
    payload: {
      deviceId: 'dev_path_lights',
      intensityPercent: 40,
      durationSeconds: 900,
      causedByEvidenceId: 'evd_arrival_signal_2026',
    },
    createdAt: clock.now,
  })
  simulator.dispatch(command)
  clock.flushCurrent()
  const callback = callbacks[0]
  if (callback === undefined) throw new Error('Signed callback fixture was not delivered')
  return callback
}

function configuration(): CallbackDeliveryConfiguration {
  return {
    callbackUrl: 'http://web.test/api/internal/v1/gateway/callbacks',
    readinessUrl: 'http://web.test/api/v1/ready',
    maximumAttempts: 4,
    initialBackoffMilliseconds: 10,
    maximumBackoffMilliseconds: 40,
    requestTimeoutMilliseconds: 1_000,
    readinessIntervalMilliseconds: 60_000,
    maximumTrackedCallbacks: 16,
  }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new TypeError('Expected callback request string body')
  return init.body
}

describe('bounded gateway callback delivery', () => {
  it('deduplicates a callback while retrying only bounded retryable responses', async () => {
    const callback = signedCallback()
    const callbackBodies: string[] = []
    const backoffs: number[] = []
    let callbackAttempts = 0
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url.endsWith('/ready')) return new Response(null, { status: 200 })
      callbackAttempts += 1
      callbackBodies.push(requestBody(init))
      return new Response(null, { status: callbackAttempts < 3 ? 503 : 202 })
    }
    const delivery = new BoundedGatewayCallbackDelivery(configuration(), {
      fetch,
      sleep: (milliseconds) => {
        backoffs.push(milliseconds)
        return Promise.resolve()
      },
    })
    await delivery.start()
    expect(delivery.isReady).toBe(true)

    const first = delivery.enqueue(callback)
    const duplicate = delivery.enqueue(structuredClone(callback))
    expect(duplicate).toBe(first)
    await first

    expect(callbackAttempts).toBe(3)
    expect(backoffs).toEqual([10, 20])
    expect(callbackBodies).toEqual([
      JSON.stringify(callback),
      JSON.stringify(callback),
      JSON.stringify(callback),
    ])
    expect(delivery.trackedCount).toBe(1)
    await delivery.drain(1_000)
  })

  it('does not retry a permanent rejection and retains the failure through drain', async () => {
    const callback = signedCallback()
    let callbackAttempts = 0
    const fetch: typeof globalThis.fetch = async (input) => {
      if (requestUrl(input).endsWith('/ready')) return new Response(null, { status: 200 })
      callbackAttempts += 1
      return new Response(null, { status: 400 })
    }
    const delivery = new BoundedGatewayCallbackDelivery(configuration(), {
      fetch,
      sleep: () => Promise.resolve(),
    })
    await delivery.start()

    await expect(delivery.enqueue(callback)).rejects.toMatchObject<CallbackDeliveryError>({
      code: 'CALLBACK_DELIVERY_PERMANENT_REJECTION',
    })
    expect(callbackAttempts).toBe(1)
    expect(delivery.isReady).toBe(false)
    await expect(delivery.drain(1_000)).rejects.toMatchObject<CallbackDeliveryError>({
      code: 'CALLBACK_DELIVERY_EXHAUSTED',
    })
  })

  it('rejects a reused callback identity with a different signed payload', async () => {
    const callback = signedCallback()
    const fetch: typeof globalThis.fetch = async (input) =>
      new Response(null, { status: requestUrl(input).endsWith('/ready') ? 200 : 202 })
    const delivery = new BoundedGatewayCallbackDelivery(configuration(), { fetch })
    await delivery.start()
    await delivery.enqueue(callback)
    const conflicting = structuredClone(callback)
    conflicting.signature.digest = 'f'.repeat(64)

    await expect(delivery.enqueue(conflicting)).rejects.toMatchObject<CallbackDeliveryError>({
      code: 'CALLBACK_DELIVERY_CONFLICT',
    })
    expect(delivery.isReady).toBe(false)
    await expect(delivery.drain(1_000)).rejects.toMatchObject<CallbackDeliveryError>({
      code: 'CALLBACK_DELIVERY_EXHAUSTED',
    })
  })
})

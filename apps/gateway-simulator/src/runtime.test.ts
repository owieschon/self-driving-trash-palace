import { createGatewayCommand } from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

import { parseGatewaySimulatorConfiguration } from './configuration.js'
import {
  PRIVATE_GATEWAY_CALLBACK_URL,
  PRIVATE_WEB_READINESS_URL,
  type SignedGatewayCallback,
} from './contracts.js'
import { createGatewaySimulatorProcess } from './runtime.js'

const SIGNING_KEY = 'runtime-test-gateway-signing-key-at-least-32-bytes'
const IDENTITY_SIGNING_KEY = 'runtime-test-identity-signing-key-at-least-32-bytes'
const RUNTIME_WALL_NOW = '2026-07-15T13:00:00.000Z'

const IDENTITY_ENVIRONMENT = {
  IDENTITY_TELEMETRY_SIGNING_KEY_ID: 'itk_runtime_identity',
  IDENTITY_TELEMETRY_SIGNING_KEY: IDENTITY_SIGNING_KEY,
} as const

describe('gateway simulator process', () => {
  it('runs the canonical gateway, targets only the fixed web callback, and drains delivery', async () => {
    let resolveDelivery: ((response: Response) => void) | undefined
    let markCallbackStarted: (() => void) | undefined
    const callbackStarted = new Promise<void>((resolve) => {
      markCallbackStarted = resolve
    })
    const callbackBodies: SignedGatewayCallback[] = []
    const fetchDependency: typeof globalThis.fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url === PRIVATE_WEB_READINESS_URL) return new Response(null, { status: 200 })
      expect(url).toBe(PRIVATE_GATEWAY_CALLBACK_URL)
      callbackBodies.push(JSON.parse(requestBody(init)) as SignedGatewayCallback)
      markCallbackStarted?.()
      return new Promise<Response>((resolve) => {
        resolveDelivery = resolve
      })
    }
    const parsed = parseGatewaySimulatorConfiguration({
      GATEWAY_CALLBACK_SIGNING_KEY: SIGNING_KEY,
      ...IDENTITY_ENVIRONMENT,
      GATEWAY_CALLBACK_READINESS_INTERVAL_MS: '60000',
      IDENTITY_TELEMETRY_READINESS_INTERVAL_MS: '60000',
    })
    const runtime = createGatewaySimulatorProcess(
      { ...parsed, bindHost: '127.0.0.1', port: 0 },
      {
        callbackDelivery: { fetch: fetchDependency },
        identityDelivery: {
          fetch: async (input) => {
            expect(requestUrl(input)).toBe(PRIVATE_WEB_READINESS_URL)
            return new Response(null, { status: 200 })
          },
        },
        wallClock: { now: () => new Date(RUNTIME_WALL_NOW) },
      },
    )
    await runtime.start()
    const address = runtime.address
    if (address === null) throw new Error('Gateway process did not bind an address')
    const origin = `http://127.0.0.1:${address.port}`

    const live = await fetch(`${origin}/healthz`)
    expect(live.status).toBe(200)
    const ready = await fetch(`${origin}/readyz`)
    expect(ready.status).toBe(200)
    const command = createGatewayCommand({
      organizationId: 'org_rocky_roost',
      missionId: 'mis_night_shift_home',
      palaceId: 'pal_sacred_dumpster',
      operationId: 'op_gateway_runtime_test',
      logicalKey: 'runtime-test-lighting',
      kind: 'set_lighting',
      payload: {
        deviceId: 'dev_path_lights',
        intensityPercent: 40,
        durationSeconds: 900,
        causedByEvidenceId: 'evd_runtime_arrival_2026',
      },
      createdAt: '2026-08-14T05:35:00.000Z',
    })
    const dispatched = await fetch(`${origin}/v1/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    })
    expect(dispatched.status).toBe(202)
    await callbackStarted
    expect(callbackBodies).toHaveLength(1)
    expect(callbackBodies[0]?.callback.commandId).toBe(command.id)
    expect(callbackBodies[0]?.signature.timestamp).toBe(RUNTIME_WALL_NOW)

    const stopping = runtime.stop()
    expect(runtime.stop()).toBe(stopping)
    await vi.waitFor(() => expect(runtime.state).toBe('draining'))
    resolveDelivery?.(new Response(null, { status: 202 }))
    await stopping
    expect(runtime.state).toBe('stopped')
    await expect(fetch(`${origin}/healthz`)).rejects.toThrow()
  })

  it('keeps liveness available while readiness reports a failed web dependency', async () => {
    const parsed = parseGatewaySimulatorConfiguration({
      GATEWAY_CALLBACK_SIGNING_KEY: SIGNING_KEY,
      ...IDENTITY_ENVIRONMENT,
      GATEWAY_CALLBACK_READINESS_INTERVAL_MS: '60000',
      IDENTITY_TELEMETRY_READINESS_INTERVAL_MS: '60000',
    })
    const runtime = createGatewaySimulatorProcess(
      { ...parsed, bindHost: '127.0.0.1', port: 0 },
      {
        callbackDelivery: {
          fetch: async () => new Response(null, { status: 503 }),
        },
        identityDelivery: {
          fetch: async () => new Response(null, { status: 503 }),
        },
      },
    )
    await runtime.start()
    const address = runtime.address
    if (address === null) throw new Error('Gateway process did not bind an address')
    const origin = `http://127.0.0.1:${address.port}`

    expect((await fetch(`${origin}/healthz`)).status).toBe(200)
    expect((await fetch(`${origin}/readyz`)).status).toBe(503)
    await runtime.stop()
  })

  it('is ready after arming a future shared fixture anchor', async () => {
    const realStartAt = new Date(Date.now() + 500).toISOString()
    const parsed = parseGatewaySimulatorConfiguration({
      GATEWAY_CALLBACK_SIGNING_KEY: SIGNING_KEY,
      ...IDENTITY_ENVIRONMENT,
      GATEWAY_CALLBACK_READINESS_INTERVAL_MS: '60000',
      IDENTITY_TELEMETRY_READINESS_INTERVAL_MS: '60000',
      TRASH_PALACE_FIXTURE_REAL_START_AT: realStartAt,
    })
    const healthyDependency = {
      fetch: async () => new Response(null, { status: 200 }),
    }
    const runtime = createGatewaySimulatorProcess(
      { ...parsed, bindHost: '127.0.0.1', port: 0 },
      { callbackDelivery: healthyDependency, identityDelivery: healthyDependency },
    )
    await runtime.start()
    const address = runtime.address
    if (address === null) throw new Error('Gateway process did not bind an address')
    const origin = `http://127.0.0.1:${address.port}`

    expect((await fetch(`${origin}/healthz`)).status).toBe(200)
    expect((await fetch(`${origin}/readyz`)).status).toBe(200)
    await runtime.stop()
  })

  it('binds the executable identity lane from the first command and exposes conflicts in readiness', async () => {
    const parsed = parseGatewaySimulatorConfiguration({
      GATEWAY_CALLBACK_SIGNING_KEY: SIGNING_KEY,
      ...IDENTITY_ENVIRONMENT,
      GATEWAY_CALLBACK_READINESS_INTERVAL_MS: '60000',
      IDENTITY_TELEMETRY_READINESS_INTERVAL_MS: '60000',
    })
    const healthyDependency = {
      fetch: async () => new Response(null, { status: 202 }),
    }
    const runtime = createGatewaySimulatorProcess(
      { ...parsed, bindHost: '127.0.0.1', port: 0 },
      { callbackDelivery: healthyDependency, identityDelivery: healthyDependency },
    )
    await runtime.start()
    const address = runtime.address
    if (address === null) throw new Error('Gateway process did not bind an address')
    const origin = `http://127.0.0.1:${address.port}`
    const first = createGatewayCommand({
      organizationId: 'org_rocky_roost',
      missionId: 'mis_night_shift_home',
      palaceId: 'pal_sacred_dumpster',
      operationId: 'op_identity_runtime_first',
      logicalKey: 'identity-runtime-first',
      kind: 'set_lighting',
      payload: {
        deviceId: 'dev_path_lights',
        intensityPercent: 40,
        durationSeconds: 900,
        causedByEvidenceId: 'evd_identity_runtime_first',
      },
      createdAt: '2026-08-14T05:44:00.000Z',
    })
    expect((await dispatch(origin, first)).status).toBe(202)
    const conflict = createGatewayCommand({
      organizationId: 'org_rocky_roost',
      missionId: 'mis_conflicting_runtime',
      palaceId: 'pal_sacred_dumpster',
      operationId: 'op_identity_runtime_conflict',
      logicalKey: 'identity-runtime-conflict',
      kind: 'set_lighting',
      payload: {
        deviceId: 'dev_path_lights',
        intensityPercent: 40,
        durationSeconds: 900,
        causedByEvidenceId: 'evd_identity_runtime_first',
      },
      createdAt: '2026-08-14T05:44:00.000Z',
    })
    const rejected = await dispatch(origin, conflict)
    expect(rejected.status).toBe(422)
    await expect(rejected.json()).resolves.toMatchObject({
      code: 'IDENTITY_MISSION_BINDING_CONFLICT',
    })
    expect((await fetch(`${origin}/healthz`)).status).toBe(200)
    expect((await fetch(`${origin}/readyz`)).status).toBe(503)
    await expect(runtime.stop()).rejects.toThrow('did not drain cleanly')
    expect(runtime.state).toBe('stopped')
  })

  it('fails startup and closes dependencies when the configured port cannot bind', async () => {
    const parsed = parseGatewaySimulatorConfiguration({
      GATEWAY_CALLBACK_SIGNING_KEY: SIGNING_KEY,
      ...IDENTITY_ENVIRONMENT,
      GATEWAY_CALLBACK_READINESS_INTERVAL_MS: '60000',
      IDENTITY_TELEMETRY_READINESS_INTERVAL_MS: '60000',
    })
    const callbackDelivery = {
      fetch: async () => new Response(null, { status: 200 }),
    }
    const identityDelivery = {
      fetch: async () => new Response(null, { status: 200 }),
    }
    const occupying = createGatewaySimulatorProcess(
      { ...parsed, bindHost: '127.0.0.1', port: 0 },
      { callbackDelivery, identityDelivery },
    )
    await occupying.start()
    const occupiedAddress = occupying.address
    if (occupiedAddress === null) throw new Error('Occupying gateway did not bind an address')
    const contender = createGatewaySimulatorProcess(
      { ...parsed, bindHost: '127.0.0.1', port: occupiedAddress.port },
      { callbackDelivery, identityDelivery },
    )

    await expect(contender.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(contender.state).toBe('stopped')
    await occupying.stop()
  })
})

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new TypeError('Expected callback request string body')
  return init.body
}

function dispatch(origin: string, command: unknown): Promise<Response> {
  return fetch(`${origin}/v1/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  })
}

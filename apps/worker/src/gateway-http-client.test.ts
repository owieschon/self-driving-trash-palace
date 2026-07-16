import { describe, expect, it } from 'vitest'

import { createGatewayCommand } from '@trash-palace/core'

import {
  FixedOriginGatewayClient,
  PRIVATE_GATEWAY_ORIGIN,
  type GatewayFetchPort,
} from './gateway-http-client.js'

const command = createGatewayCommand({
  organizationId: 'org_primary0001',
  missionId: 'mis_mission00001',
  palaceId: 'pal_palace000001',
  operationId: 'op_operation0001',
  logicalKey: 'homecoming.preheat',
  kind: 'set_temperature',
  payload: {
    deviceId: 'dev_thermostat001',
    targetCelsius: 20,
    completeAt: '2026-08-14T06:00:00.000Z',
    causedByEvidenceId: null,
  },
  createdAt: '2026-08-14T05:44:00.000Z',
})

function jsonResponse(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('fixed-origin gateway HTTP client', () => {
  it('posts a bounded command only to the private gateway route', async () => {
    let requestedUrl: string | undefined
    let requestedInit: RequestInit | undefined
    const request: GatewayFetchPort = async (url, init) => {
      requestedUrl = url
      requestedInit = init
      return jsonResponse({ status: 'accepted', acknowledgementId: 'gack_fixture01' })
    }
    const client = new FixedOriginGatewayClient(PRIVATE_GATEWAY_ORIGIN, request)

    await expect(client.dispatch(command)).resolves.toEqual({
      status: 'accepted',
      acknowledgementId: 'gack_fixture01',
    })
    expect(requestedUrl).toBe(`${PRIVATE_GATEWAY_ORIGIN}/v1/commands`)
    expect(requestedInit).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
    })
    if (typeof requestedInit?.body !== 'string') throw new Error('Gateway request body is missing')
    expect(JSON.parse(requestedInit.body)).toEqual(command)
  })

  it('rejects arbitrary egress origins at construction', () => {
    expect(() => new FixedOriginGatewayClient('https://example.invalid')).toThrow(
      /Gateway origin must be/,
    )
  })

  it('fails closed on invalid content and oversized bodies', async () => {
    const invalid = new FixedOriginGatewayClient(
      PRIVATE_GATEWAY_ORIGIN,
      async () => new Response('<html>no</html>', { headers: { 'content-type': 'text/html' } }),
    )
    const oversized = new FixedOriginGatewayClient(
      PRIVATE_GATEWAY_ORIGIN,
      async () =>
        new Response(JSON.stringify({ data: 'x'.repeat(70_000) }), {
          headers: { 'content-type': 'application/json' },
        }),
    )

    await expect(invalid.dispatch(command)).resolves.toMatchObject({
      status: 'failed',
      code: 'GATEWAY_CONTENT_TYPE',
    })
    await expect(oversized.dispatch(command)).resolves.toMatchObject({
      status: 'failed',
      code: 'GATEWAY_RESPONSE_TOO_LARGE',
    })
  })

  it('classifies a transport failure as an unknown outcome instead of a safe retry claim', async () => {
    const client = new FixedOriginGatewayClient(PRIVATE_GATEWAY_ORIGIN, async () => {
      throw new TypeError('connection reset')
    })

    await expect(client.dispatch(command)).resolves.toEqual({
      status: 'unknown',
      retryable: true,
      reason: 'lost_ack',
    })
  })
})

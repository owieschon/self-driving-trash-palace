import { once } from 'node:events'

import { DeterministicDeviceModel, VirtualClock } from '@trash-palace/testkit'
import { afterEach, describe, expect, it } from 'vitest'

import { NIGHT_SHIFT_HOMECOMING_FIXTURE } from '../../../evals/fixtures/night-shift-homecoming.js'
import { createGatewaySimulatorServer } from './server.js'
import { GatewaySimulator } from './simulator.js'

function simulator(): GatewaySimulator {
  const fixture = NIGHT_SHIFT_HOMECOMING_FIXTURE
  const clock = new VirtualClock({
    startsAt: fixture.clock.startsAt,
    virtualMinuteMilliseconds: fixture.clock.virtualMinuteMilliseconds,
  })
  return new GatewaySimulator({
    clock,
    deviceModel: new DeterministicDeviceModel({
      organizationId: fixture.primaryTenant.organization.id,
      palaceId: fixture.primaryTenant.palace.id,
      devices: fixture.primaryTenant.devices,
      identityTags: fixture.primaryTenant.identityTags,
      startsAt: fixture.clock.startsAt,
      batteryAvailablePercentage: fixture.primaryTenant.palace.batteryAvailablePercentage,
    }),
    signingKeyId: 'gwk_server_test',
    signingKey: 'gateway-server-test-signing-key-with-32-bytes',
  })
}

describe('gateway simulator HTTP lifecycle', () => {
  const servers: ReturnType<typeof createGatewaySimulatorServer>[] = []

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error === undefined ? resolve() : reject(error))),
            ),
        ),
    )
  })

  async function start(isReady: () => boolean) {
    const server = createGatewaySimulatorServer(simulator(), { isReady })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Test server has no port')
    return `http://127.0.0.1:${address.port}`
  }

  it('keeps liveness independent from dependency readiness', async () => {
    let ready = false
    const origin = await start(() => ready)

    await expect(
      fetch(`${origin}/healthz`).then(async (response) => response.json()),
    ).resolves.toMatchObject({
      status: 'ok',
    })
    const unavailable = await fetch(`${origin}/readyz`)
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toEqual({ status: 'not_ready' })

    ready = true
    const available = await fetch(`${origin}/readyz`)
    expect(available.status).toBe(200)
    await expect(available.json()).resolves.toEqual({ status: 'ready' })
  })

  it('rejects non-JSON and oversized command bodies before dispatch', async () => {
    const gateway = simulator()
    const server = createGatewaySimulatorServer(gateway)
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Test server has no port')
    const origin = `http://127.0.0.1:${address.port}`

    const wrongType = await fetch(`${origin}/v1/commands`, { method: 'POST', body: '{}' })
    expect(wrongType.status).toBe(415)
    const oversized = await fetch(`${origin}/v1/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x'.repeat(70_000) }),
    })
    expect(oversized.status).toBe(413)
    expect(gateway.recordedCommandCount).toBe(0)
  })
})

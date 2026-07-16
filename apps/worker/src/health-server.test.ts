import { afterEach, describe, expect, it } from 'vitest'

import { WorkerHealthServer, type WorkerHealthState } from './health-server.js'

const servers: WorkerHealthServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

describe('worker health server', () => {
  it('keeps liveness distinct from dependency-aware readiness', async () => {
    let state: WorkerHealthState = { live: true, ready: false, phase: 'starting' }
    const server = new WorkerHealthServer({
      host: '127.0.0.1',
      port: 0,
      state: () => state,
    })
    servers.push(server)
    const address = await server.start()
    const origin = `http://127.0.0.1:${address.port}`

    const startingHealth = await fetch(`${origin}/healthz`)
    const startingReady = await fetch(`${origin}/readyz`)
    expect(startingHealth.status).toBe(200)
    expect(startingReady.status).toBe(503)
    expect(await startingReady.json()).toEqual({ status: 'unavailable', phase: 'starting' })

    state = { live: true, ready: true, phase: 'running' }
    expect((await fetch(`${origin}/readyz`)).status).toBe(200)
  })

  it('fails closed when the dependency probe throws and hides the error', async () => {
    const server = new WorkerHealthServer({
      host: '127.0.0.1',
      port: 0,
      state: () => {
        throw new Error('database password must stay private')
      },
    })
    servers.push(server)
    const address = await server.start()

    const response = await fetch(`http://127.0.0.1:${address.port}/readyz`)
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('password')
  })
})

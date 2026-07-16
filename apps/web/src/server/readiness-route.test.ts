import { describe, expect, it } from 'vitest'

import { readinessResponse } from './readiness-route.js'

describe('GET /api/v1/ready', () => {
  it('distinguishes dependency readiness from process liveness', async () => {
    const ready = await readinessResponse(Promise.resolve({ isReady: async () => true }))
    const unavailable = await readinessResponse(Promise.resolve({ isReady: async () => false }))

    expect(ready.status).toBe(200)
    await expect(ready.json()).resolves.toEqual({
      schemaVersion: 'readiness@1',
      status: 'ready',
    })
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toEqual({
      schemaVersion: 'readiness@1',
      status: 'unavailable',
    })
  })

  it('fails closed without reflecting initialization errors', async () => {
    const response = await readinessResponse(
      Promise.reject(new Error('postgresql://operator:secret@private-host/database')),
    )

    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('operator')
  })
})

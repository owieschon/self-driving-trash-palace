import { describe, expect, it } from 'vitest'

import { GET } from './route.js'

describe('GET /api/v1/health', () => {
  it('returns a non-cacheable versioned liveness response', async () => {
    const response = GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    await expect(response.json()).resolves.toEqual({ schemaVersion: 'health@1', status: 'ok' })
  })
})

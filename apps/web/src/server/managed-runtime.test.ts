import { describe, expect, it, vi } from 'vitest'

import type { HttpApiRuntime } from './api-runtime.js'
import { createManagedHttpApiRuntime } from './managed-runtime.js'

function routes(): HttpApiRuntime {
  const response = async () => Response.json({})
  return {
    answerClarification: response,
    createDevSession: response,
    createMission: response,
    decideApproval: response,
    getApproval: response,
    getClarification: response,
    getMissionProgress: response,
    getMissionTasks: response,
    getPalaceWorkspace: response,
    ingestGatewayCallback: response,
    ingestIdentityTelemetry: response,
    invokeTool: response,
    issueDelegatedToken: response,
    logoutSession: response,
    postMcp: response,
    revokeDelegatedToken: response,
    rotateSession: response,
  }
}

describe('managed web runtime', () => {
  it('reports database readiness without exposing the database response', async () => {
    const database = { query: vi.fn().mockResolvedValue({ secret: 'not returned' }), end: vi.fn() }
    const runtime = createManagedHttpApiRuntime(routes(), database)

    await expect(runtime.isReady()).resolves.toBe(true)
    expect(database.query).toHaveBeenCalledWith('select 1')
  })

  it('reports dependency failure and becomes permanently unavailable during shutdown', async () => {
    const database = {
      query: vi.fn().mockRejectedValue(new Error('private database failure')),
      end: vi.fn().mockResolvedValue(undefined),
    }
    const runtime = createManagedHttpApiRuntime(routes(), database)

    await expect(runtime.isReady()).resolves.toBe(false)
    await Promise.all([runtime.close(), runtime.close()])
    await expect(runtime.isReady()).resolves.toBe(false)
    expect(database.end).toHaveBeenCalledOnce()
  })

  it('does not report ready when shutdown begins during the dependency probe', async () => {
    let finishQuery: (() => void) | undefined
    const query = new Promise<void>((resolve) => {
      finishQuery = resolve
    })
    const database = {
      query: vi.fn().mockReturnValue(query),
      end: vi.fn().mockResolvedValue(undefined),
    }
    const runtime = createManagedHttpApiRuntime(routes(), database)

    const readiness = runtime.isReady()
    await runtime.close()
    finishQuery?.()

    await expect(readiness).resolves.toBe(false)
  })
})

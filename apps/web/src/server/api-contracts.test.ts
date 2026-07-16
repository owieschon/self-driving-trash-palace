import { TOOL_REGISTRY } from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

import { TrashPalaceApiClient } from './api-client.js'
import { WEB_API_ROUTES, WEB_API_SCHEMA_PROJECTIONS, toolApiPath } from './api-contracts.js'

describe('typed API registry', () => {
  it('keeps every management operation paired with an executable contract', () => {
    expect(WEB_API_SCHEMA_PROJECTIONS.map((operation) => operation.operationId)).toEqual([
      'getHealth',
      'getReadiness',
      'createDevSession',
      'rotateSession',
      'logoutSession',
      'createMission',
      'getMissionTasks',
      'issueDelegatedToken',
      'revokeDelegatedToken',
      'getApproval',
      'decideApproval',
      'getClarification',
      'answerClarification',
    ])
    expect(
      WEB_API_SCHEMA_PROJECTIONS.filter((operation) => operation.authentication === 'none'),
    ).toHaveLength(3)
    expect(
      WEB_API_SCHEMA_PROJECTIONS.find((operation) => operation.method === 'DELETE')
        ?.requestBodySchema,
    ).toBeNull()
  })

  it('derives every typed tool client path from the core registry', () => {
    for (const [name, contract] of Object.entries(TOOL_REGISTRY)) {
      expect(toolApiPath(name)).toBe(contract.route.path)
      expect(WEB_API_ROUTES.tool.path(name)).toBe(contract.route.path)
    }
  })

  it('uses the registry path and response schema from the typed client', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        session: {
          organizationId: 'org_client_01',
          userId: 'usr_client_01',
          role: 'owner',
          csrfToken: 'csrf_client_value_1234567890',
          expiresAt: '2026-08-14T07:00:00.000Z',
        },
      }),
    )
    const client = new TrashPalaceApiClient('http://127.0.0.1', request)

    await expect(client.createDevSession()).resolves.toMatchObject({
      session: { role: 'owner' },
    })
    expect(request).toHaveBeenCalledWith(
      new URL('http://127.0.0.1/api/v1/auth/dev-session'),
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
  })

  it.each([
    'http://trash-palace.example',
    'http://192.0.2.10',
    'https://operator:secret@trash-palace.example',
    'https://trash-palace.example/path',
  ])('rejects an API origin that could expose credentials or misroute requests: %s', (origin) => {
    expect(() => new TrashPalaceApiClient(origin, vi.fn())).toThrow()
  })
})

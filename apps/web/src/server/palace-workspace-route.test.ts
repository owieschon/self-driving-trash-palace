import { NotFoundError, type AuthContext } from '@trash-palace/application'
import { PrincipalSchema } from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

import { SESSION_COOKIE_NAME } from './http-boundary.js'
import { createPalaceWorkspaceRoute } from './palace-workspace-route.js'

const ORIGIN = 'https://trashpal.example'
const SESSION = 'signed.session.value_1234567890'

const context: AuthContext = {
  sessionId: 'session_workspace_1234567890',
  principal: PrincipalSchema.parse({
    organizationId: 'org_workspace_01',
    actorId: 'usr_workspace_01',
    role: 'owner',
    operatorGrants: [],
    delegatedPermissions: [],
  }),
  csrfToken: 'csrf_workspace_1234567890',
  issuedAt: '2026-07-16T17:00:00.000Z',
  expiresAt: '2026-07-16T19:00:00.000Z',
  authenticatedAt: '2026-07-16T17:00:00.000Z',
}

describe('Palace workspace route', () => {
  it('authenticates a browser session and returns only the service projection', async () => {
    const get = vi.fn().mockResolvedValue(workspace())
    const authenticate = vi.fn().mockResolvedValue(context)
    const route = createPalaceWorkspaceRoute({
      allowedOrigin: ORIGIN,
      sessions: { authenticate },
      workspace: { get },
    })

    const response = await route.getPalaceWorkspace(
      readRequest('/api/v1/palaces/pal_workspace_01/workspace'),
      'pal_workspace_01',
    )

    expect(response.status).toBe(200)
    expect(authenticate).toHaveBeenCalledWith(SESSION)
    expect(get).toHaveBeenCalledWith({ context, palaceId: 'pal_workspace_01' })
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 'palace-workspace@1',
      palace: { id: 'pal_workspace_01' },
    })
  })

  it('hides foreign Palace access as unavailable', async () => {
    const get = vi.fn().mockRejectedValue(new NotFoundError('Palace'))
    const route = createPalaceWorkspaceRoute({
      allowedOrigin: ORIGIN,
      sessions: { authenticate: vi.fn().mockResolvedValue(context) },
      workspace: { get },
    })

    const response = await route.getPalaceWorkspace(
      readRequest('/api/v1/palaces/pal_foreign00001/workspace'),
      'pal_foreign00001',
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects bearer credentials and a hostile browser authority before reading product state', async () => {
    const get = vi.fn()
    const route = createPalaceWorkspaceRoute({
      allowedOrigin: ORIGIN,
      sessions: { authenticate: vi.fn().mockResolvedValue(context) },
      workspace: { get },
    })

    const bearer = await route.getPalaceWorkspace(
      new Request(`${ORIGIN}/api/v1/palaces/pal_workspace_01/workspace`, {
        headers: {
          host: 'trashpal.example',
          authorization: 'Bearer delegated.token.value_1234567890',
        },
      }),
      'pal_workspace_01',
    )
    const hostile = await route.getPalaceWorkspace(
      readRequest('/api/v1/palaces/pal_workspace_01/workspace', { host: 'hostile.example' }),
      'pal_workspace_01',
    )

    expect(bearer.status).toBe(401)
    expect(hostile.status).toBe(401)
    expect(get).not.toHaveBeenCalled()
  })
})

function readRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    headers: {
      host: new URL(ORIGIN).host,
      cookie: `${SESSION_COOKIE_NAME}=${SESSION}`,
      ...headers,
    },
  })
}

function workspace() {
  return {
    schemaVersion: 'palace-workspace@1' as const,
    member: {
      id: 'usr_workspace_01',
      organizationId: 'org_workspace_01',
      displayName: 'Ari Operator',
      role: 'owner' as const,
      grants: [],
    },
    palace: {
      id: 'pal_workspace_01',
      organizationId: 'org_workspace_01',
      name: 'North Yard Palace',
      timezone: 'America/New_York',
    },
    presentation: {
      observedAt: '2026-07-16T17:00:00.000Z',
      timezone: 'America/New_York',
      dayPeriod: 'evening' as const,
    },
    attention: [],
    capabilityIdeas: [
      {
        programKind: 'scheduled_hauler_access' as const,
        label: 'Scheduled Hauler Access',
        description: 'Open the service hatch only for an assigned collection window.',
        availability: 'ready' as const,
        requiredCapabilities: ['service_hatch_access'],
      },
    ],
    activeAutomations: [],
    activity: [],
  }
}

import { NotFoundError, type AuthContext } from '@trash-palace/application'
import { PrincipalSchema } from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

import { SESSION_COOKIE_NAME } from './http-boundary.js'
import { createMissionProgressRoute } from './mission-progress-route.js'

const ORIGIN = 'https://trashpal.example'
const SESSION = 'signed.session.value_1234567890'

const context: AuthContext = {
  sessionId: 'session_progress_1234567890',
  principal: PrincipalSchema.parse({
    organizationId: 'org_progress_01',
    actorId: 'usr_progress_01',
    role: 'owner',
    operatorGrants: [],
    delegatedPermissions: [],
  }),
  csrfToken: 'csrf_progress_1234567890',
  issuedAt: '2026-07-16T17:00:00.000Z',
  expiresAt: '2026-07-16T19:00:00.000Z',
  authenticatedAt: '2026-07-16T17:00:00.000Z',
}

describe('mission progress route', () => {
  it('returns server-derived durable progress for the authenticated browser member', async () => {
    const get = vi.fn().mockResolvedValue(progress())
    const authenticate = vi.fn().mockResolvedValue(context)
    const route = createMissionProgressRoute({
      allowedOrigin: ORIGIN,
      sessions: { authenticate },
      progress: { get },
    })

    const response = await route.getMissionProgress(
      readRequest('/api/v1/missions/mis_progress_001/progress'),
      'mis_progress_001',
    )

    expect(response.status).toBe(200)
    expect(authenticate).toHaveBeenCalledWith(SESSION)
    expect(get).toHaveBeenCalledWith({ context, missionId: 'mis_progress_001' })
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 'mission-progress@1',
      displayState: 'needs_approval',
      allowedNextActions: ['approve_proposal', 'reject_proposal'],
    })
  })

  it('hides foreign missions and rejects query or body input', async () => {
    const get = vi.fn().mockRejectedValue(new NotFoundError('Mission'))
    const route = createMissionProgressRoute({
      allowedOrigin: ORIGIN,
      sessions: { authenticate: vi.fn().mockResolvedValue(context) },
      progress: { get },
    })

    const foreign = await route.getMissionProgress(
      readRequest('/api/v1/missions/mis_foreign00001/progress'),
      'mis_foreign00001',
    )
    const query = await route.getMissionProgress(
      readRequest('/api/v1/missions/mis_progress_001/progress?organizationId=org_foreign_01'),
      'mis_progress_001',
    )
    const body = await route.getMissionProgress(
      new Request(`${ORIGIN}/api/v1/missions/mis_progress_001/progress`, {
        method: 'POST',
        headers: {
          host: new URL(ORIGIN).host,
          cookie: `${SESSION_COOKIE_NAME}=${SESSION}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
      'mis_progress_001',
    )

    expect(foreign.status).toBe(404)
    expect(query.status).toBe(400)
    expect(body.status).toBe(415)
  })
})

function readRequest(path: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    headers: {
      host: new URL(ORIGIN).host,
      cookie: `${SESSION_COOKIE_NAME}=${SESSION}`,
    },
  })
}

function progress() {
  return {
    schemaVersion: 'mission-progress@1' as const,
    mission: {
      id: 'mis_progress_001',
      palaceId: 'pal_progress_001',
      organizationId: 'org_progress_01',
      programKind: 'scheduled_hauler_access' as const,
      objective: 'Open the service hatch only for an assigned collection window.',
      state: { status: 'waiting_for_user' as const, phase: 'approve' as const },
      version: 2,
    },
    displayState: 'needs_approval' as const,
    pendingTask: {
      kind: 'approval' as const,
      approvalId: 'apr_progress_001',
      planId: 'pln_progress_001',
      expiresAt: '2026-07-17T17:00:00.000Z',
    },
    operation: null,
    verification: null,
    allowedNextActions: ['approve_proposal' as const, 'reject_proposal' as const],
    observedAt: '2026-07-16T17:00:00.000Z',
  }
}

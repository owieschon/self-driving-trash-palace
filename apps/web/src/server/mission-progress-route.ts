import type { AuthContext } from '@trash-palace/application'
import { MissionIdSchema, type MissionId } from '@trash-palace/core'

import { MissionProgressResponseSchema } from './api-contracts.js'
import { HttpBoundaryError, assertEmptyBody, assertNoQuery, jsonResponse } from './http-boundary.js'
import {
  authenticateBrowserRead,
  readBoundary,
  type BrowserReadSessionPort,
} from './palace-workspace-route.js'

export interface MissionProgressReadPort {
  get(input: { readonly context: AuthContext; readonly missionId: MissionId }): Promise<unknown>
}

export interface MissionProgressRouteDependencies {
  readonly allowedOrigin: string
  readonly sessions: BrowserReadSessionPort
  readonly progress: MissionProgressReadPort
}

export interface MissionProgressRoutes {
  readonly getMissionProgress: (request: Request, missionId: string) => Promise<Response>
}

/** Serves one browser member's durable mission progress; it accepts no client lifecycle state. */
export function createMissionProgressRoute(
  dependencies: MissionProgressRouteDependencies,
): MissionProgressRoutes {
  const allowedOrigin = parseExactOrigin(dependencies.allowedOrigin)
  return {
    getMissionProgress: (request, missionIdInput) =>
      readBoundary(async () => {
        assertNoQuery(request)
        await assertEmptyBody(request)
        const missionId = MissionIdSchema.safeParse(missionIdInput)
        if (!missionId.success) unavailableResource()
        const context = await authenticateBrowserRead(request, dependencies.sessions, allowedOrigin)
        const progress = await dependencies.progress.get({ context, missionId: missionId.data })
        return jsonResponse(MissionProgressResponseSchema.parse(progress))
      }),
  }
}

function parseExactOrigin(input: string): string {
  const url = new URL(input)
  if (
    url.origin !== input ||
    url.username !== '' ||
    url.password !== '' ||
    !['http:', 'https:'].includes(url.protocol)
  ) {
    throw new TypeError('Allowed origin must be one exact HTTP or HTTPS origin')
  }
  return url.origin
}

function unavailableResource(): never {
  throw new HttpBoundaryError(404, 'NOT_FOUND', 'The requested resource is unavailable.')
}

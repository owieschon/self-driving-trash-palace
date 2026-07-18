import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  type AuthContext,
} from '@trash-palace/application'
import { PalaceIdSchema, PolicyViolationError, type PalaceId } from '@trash-palace/core'
import { z } from 'zod'

import { PalaceWorkspaceResponseSchema } from './api-contracts.js'
import {
  HttpBoundaryError,
  assertEmptyBody,
  assertNoQuery,
  jsonResponse,
  problemResponse,
  readPresentedCredential,
} from './http-boundary.js'

export interface BrowserReadSessionPort {
  authenticate(signedCookie: string): Promise<AuthContext>
}

export interface PalaceWorkspaceReadPort {
  get(input: { readonly context: AuthContext; readonly palaceId: PalaceId }): Promise<unknown>
}

export interface PalaceWorkspaceRouteDependencies {
  readonly allowedOrigin: string
  readonly sessions: BrowserReadSessionPort
  readonly workspace: PalaceWorkspaceReadPort
}

export interface PalaceWorkspaceRoutes {
  readonly getPalaceWorkspace: (request: Request, palaceId: string) => Promise<Response>
}

/** Serves one authenticated member's tenant-bound Palace workspace without accepting bearer access. */
export function createPalaceWorkspaceRoute(
  dependencies: PalaceWorkspaceRouteDependencies,
): PalaceWorkspaceRoutes {
  const allowedOrigin = parseExactOrigin(dependencies.allowedOrigin)
  return {
    getPalaceWorkspace: (request, palaceIdInput) =>
      readBoundary(async () => {
        assertNoQuery(request)
        await assertEmptyBody(request)
        const palaceId = PalaceIdSchema.safeParse(palaceIdInput)
        if (!palaceId.success) unavailableResource()
        const context = await authenticateBrowserRead(request, dependencies.sessions, allowedOrigin)
        const workspace = await dependencies.workspace.get({ context, palaceId: palaceId.data })
        return jsonResponse(PalaceWorkspaceResponseSchema.parse(workspace))
      }),
  }
}

export async function authenticateBrowserRead(
  request: Request,
  sessions: BrowserReadSessionPort,
  allowedOrigin: string,
): Promise<AuthContext> {
  assertExactBrowserAuthority(request, allowedOrigin)
  const presented = readPresentedCredential(request.headers)
  if (presented.kind !== 'session') {
    throw new HttpBoundaryError(401, 'BROWSER_SESSION_REQUIRED', 'A browser session is required.')
  }
  try {
    return await sessions.authenticate(presented.value)
  } catch {
    throw new HttpBoundaryError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is invalid.')
  }
}

export function readBoundary(work: () => Promise<Response>): Promise<Response> {
  return work().catch((error: unknown) => problemResponse(mapReadError(error)))
}

function assertExactBrowserAuthority(request: Request, allowedOrigin: string): void {
  const allowed = new URL(allowedOrigin)
  if (request.headers.get('host')?.toLowerCase() !== allowed.host.toLowerCase()) {
    throw new HttpBoundaryError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is invalid.')
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

function mapReadError(error: unknown): unknown {
  if (error instanceof HttpBoundaryError) return error
  if (error instanceof AuthenticationError) {
    return new HttpBoundaryError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is invalid.')
  }
  if (error instanceof NotFoundError || error instanceof PolicyViolationError) {
    return new HttpBoundaryError(404, 'NOT_FOUND', 'The requested resource is unavailable.')
  }
  if (error instanceof ConflictError) {
    return new HttpBoundaryError(409, 'CONFLICT', 'The request conflicts with current state.')
  }
  if (error instanceof z.ZodError || error instanceof RangeError) {
    return new HttpBoundaryError(422, 'INVALID_REQUEST', 'The request is invalid.')
  }
  return error
}

function unavailableResource(): never {
  throw new HttpBoundaryError(404, 'NOT_FOUND', 'The requested resource is unavailable.')
}

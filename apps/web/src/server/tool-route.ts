import type { AuthContext, DelegatedAuthContext } from '@trash-palace/application'
import {
  TOOL_REGISTRY,
  ToolNameSchema,
  parseToolResult,
  type MissionId,
  type ToolCallChannel,
  type ToolName,
} from '@trash-palace/core'

import {
  HttpBoundaryError,
  assertNoQuery,
  jsonResponse,
  problemResponse,
  readPresentedCredential,
  readStrictJson,
  readToolInvocationHeaders,
} from './http-boundary.js'

type ToolAuthentication = AuthContext | DelegatedAuthContext

export interface HttpToolAuthenticationPort {
  authenticateSession(value: string): Promise<AuthContext>
  authenticateBearer(value: string): Promise<DelegatedAuthContext>
  assertSensitiveMutation(input: {
    readonly context: AuthContext
    readonly csrfToken: string
    readonly origin: string
    readonly allowedOrigin: string
  }): void
}

export interface HttpToolDispatcherPort {
  invoke(
    request: Readonly<{ callId: string; toolName: ToolName; input: unknown }>,
    host: Readonly<{
      authentication: ToolAuthentication
      missionId: MissionId
      channel: Extract<ToolCallChannel, 'http'>
      signal: AbortSignal
      browserMutation?: Readonly<{
        csrfToken: string
        origin: string
        allowedOrigin: string
      }>
    }>,
  ): Promise<unknown>
}

export interface HttpToolRouteDependencies {
  readonly authentication: HttpToolAuthenticationPort
  readonly dispatcher: HttpToolDispatcherPort
  readonly allowedOrigin: string
}

export function createHttpToolRoute(dependencies: HttpToolRouteDependencies) {
  const allowedOrigin = parseAllowedOrigin(dependencies.allowedOrigin)

  return async (request: Request, toolNameInput: string): Promise<Response> => {
    try {
      assertNoQuery(request)
      const toolName = ToolNameSchema.safeParse(toolNameInput)
      if (!toolName.success) {
        throw new HttpBoundaryError(404, 'TOOL_NOT_FOUND', 'The requested tool is unavailable.')
      }
      const body = await readStrictJson(request)
      const invocation = readToolInvocationHeaders(request.headers)
      const presented = readPresentedCredential(request.headers)
      const authentication = await authenticate(dependencies.authentication, presented)
      const browserMutation = browserMutationFor({
        authenticationPort: dependencies.authentication,
        authentication,
        allowedOrigin,
        headers: request.headers,
        readOnly: TOOL_REGISTRY[toolName.data].readOnly,
      })
      const result = parseToolResult(
        toolName.data,
        await dependencies.dispatcher.invoke(
          { callId: invocation.callId, toolName: toolName.data, input: body },
          {
            authentication,
            missionId: invocation.missionId,
            channel: 'http',
            signal: request.signal,
            ...(browserMutation === undefined ? {} : { browserMutation }),
          },
        ),
      )
      return jsonResponse(result, { status: httpStatusFor(result.status, result.error?.code) })
    } catch (error) {
      return problemResponse(error)
    }
  }
}

async function authenticate(
  authentication: HttpToolAuthenticationPort,
  presented: ReturnType<typeof readPresentedCredential>,
): Promise<ToolAuthentication> {
  try {
    return presented.kind === 'session'
      ? await authentication.authenticateSession(presented.value)
      : await authentication.authenticateBearer(presented.value)
  } catch {
    throw new HttpBoundaryError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is invalid.')
  }
}

function browserMutationFor(input: {
  readonly authenticationPort: HttpToolAuthenticationPort
  readonly authentication: ToolAuthentication
  readonly headers: Headers
  readonly allowedOrigin: string
  readonly readOnly: boolean
}) {
  if (!('sessionId' in input.authentication) || input.readOnly) return undefined
  const origin = input.headers.get('origin')
  const csrfToken = input.headers.get('x-csrf-token')
  if (origin !== input.allowedOrigin || csrfToken === null) {
    throw new HttpBoundaryError(
      401,
      'MUTATION_GUARD_REJECTED',
      'Mutation authentication is invalid.',
    )
  }
  try {
    input.authenticationPort.assertSensitiveMutation({
      context: input.authentication,
      csrfToken,
      origin,
      allowedOrigin: input.allowedOrigin,
    })
  } catch {
    throw new HttpBoundaryError(
      401,
      'MUTATION_GUARD_REJECTED',
      'Mutation authentication is invalid.',
    )
  }
  return {
    csrfToken,
    origin,
    allowedOrigin: input.allowedOrigin,
  }
}

function parseAllowedOrigin(input: string): string {
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

function httpStatusFor(status: string, errorCode: string | undefined): number {
  switch (status) {
    case 'succeeded':
      return 200
    case 'pending':
    case 'unknown':
      return 202
    case 'denied':
      return 403
    case 'conflict':
      return 409
    case 'failed':
      if (errorCode === 'INVALID_INPUT') return 422
      return errorCode === 'RESOURCE_NOT_FOUND' ? 404 : 500
    default:
      return 500
  }
}

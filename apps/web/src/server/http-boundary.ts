import {
  MissionIdSchema,
  ToolCallIdSchema,
  type MissionId,
  type ToolCallId,
} from '@trash-palace/core'

export const SESSION_COOKIE_NAME = '__Host-trash_palace_session'
export const MAX_JSON_BODY_BYTES = 64 * 1024

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i
const BEARER_CREDENTIAL = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/

export class HttpBoundaryError extends Error {
  public constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 422 | 500 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpBoundaryError'
  }
}

export type PresentedCredential =
  Readonly<{ kind: 'session'; value: string }> | Readonly<{ kind: 'bearer'; value: string }>

export interface ToolInvocationHeaders {
  readonly callId: ToolCallId
  readonly missionId: MissionId
}

export async function readStrictJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')
  if (contentType === null || !JSON_CONTENT_TYPE.test(contentType.trim())) {
    throw new HttpBoundaryError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Requests must use application/json with optional UTF-8 charset.',
    )
  }

  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new HttpBoundaryError(411, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid.')
    }
    if (Number(declaredLength) > MAX_JSON_BODY_BYTES) {
      throw new HttpBoundaryError(413, 'BODY_TOO_LARGE', 'Request body exceeds 64 KiB.')
    }
  }

  const body = new Uint8Array(await request.arrayBuffer())
  if (body.byteLength > MAX_JSON_BODY_BYTES) {
    throw new HttpBoundaryError(413, 'BODY_TOO_LARGE', 'Request body exceeds 64 KiB.')
  }
  if (body.byteLength === 0) {
    throw new HttpBoundaryError(400, 'INVALID_JSON', 'Request body must contain JSON.')
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown
  } catch {
    throw new HttpBoundaryError(400, 'INVALID_JSON', 'Request body contains invalid JSON.')
  }
}

export function readToolInvocationHeaders(headers: Headers): ToolInvocationHeaders {
  const callId = ToolCallIdSchema.safeParse(headers.get('idempotency-key'))
  if (!callId.success) {
    throw new HttpBoundaryError(
      422,
      'INVALID_CALL_ID',
      'Idempotency-Key must contain a valid tool call ID.',
    )
  }
  const missionId = MissionIdSchema.safeParse(headers.get('x-trash-palace-mission'))
  if (!missionId.success) {
    throw new HttpBoundaryError(
      422,
      'INVALID_MISSION_ID',
      'X-Trash-Palace-Mission must contain a valid mission ID.',
    )
  }
  return { callId: callId.data, missionId: missionId.data }
}

export function readPresentedCredential(headers: Headers): PresentedCredential {
  const authorization = headers.get('authorization')
  const session = readCookie(headers.get('cookie'), SESSION_COOKIE_NAME)
  if (authorization !== null && session !== null) {
    throw new HttpBoundaryError(
      401,
      'AMBIGUOUS_AUTHENTICATION',
      'Present exactly one authentication mechanism.',
    )
  }
  if (authorization !== null) {
    const parsed = BEARER_CREDENTIAL.exec(authorization)
    if (parsed?.[1] === undefined) {
      throw new HttpBoundaryError(401, 'INVALID_BEARER', 'Bearer authentication is invalid.')
    }
    return { kind: 'bearer', value: parsed[1] }
  }
  if (session !== null) return { kind: 'session', value: session }
  throw new HttpBoundaryError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.')
}

export function assertMutationOrigin(input: {
  readonly headers: Headers
  readonly allowedOrigin: string
  readonly csrfToken: string
}): string {
  const origin = input.headers.get('origin')
  const csrfToken = input.headers.get('x-csrf-token')
  if (origin !== input.allowedOrigin || csrfToken !== input.csrfToken) {
    throw new HttpBoundaryError(
      401,
      'MUTATION_GUARD_REJECTED',
      'Mutation authentication is invalid.',
    )
  }
  return origin
}

export async function assertEmptyJsonObject(request: Request): Promise<void> {
  const body = await readStrictJson(request)
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 0
  ) {
    throw new HttpBoundaryError(
      422,
      'INVALID_REQUEST_BODY',
      'Request body must be an empty object.',
    )
  }
}

export async function assertEmptyBody(request: Request): Promise<void> {
  if (request.headers.has('content-type')) {
    throw new HttpBoundaryError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'This request does not accept a body.',
    )
  }
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null && declaredLength !== '0') {
    throw new HttpBoundaryError(413, 'BODY_NOT_ALLOWED', 'This request does not accept a body.')
  }
  if ((await request.arrayBuffer()).byteLength !== 0) {
    throw new HttpBoundaryError(413, 'BODY_NOT_ALLOWED', 'This request does not accept a body.')
  }
}

export function assertNoQuery(request: Request): void {
  if (new URL(request.url).search !== '') {
    throw new HttpBoundaryError(
      400,
      'QUERY_NOT_ALLOWED',
      'This endpoint does not accept query parameters.',
    )
  }
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, {
    ...init,
    headers: securityHeaders(init.headers, 'application/json; charset=utf-8'),
  })
}

export function problemResponse(error: unknown): Response {
  const boundaryError =
    error instanceof HttpBoundaryError
      ? error
      : new HttpBoundaryError(500, 'INTERNAL_ERROR', 'The request could not be processed.')
  return Response.json(
    {
      type: 'about:blank',
      title: problemTitle(boundaryError.status),
      status: boundaryError.status,
      code: boundaryError.code,
      detail: boundaryError.message,
    },
    {
      status: boundaryError.status,
      headers: securityHeaders(undefined, 'application/problem+json; charset=utf-8'),
    },
  )
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null
  if (header.length > 8 * 1024 || /[\r\n\0]/.test(header)) {
    throw new HttpBoundaryError(401, 'INVALID_SESSION', 'Session authentication is invalid.')
  }
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1))
  if (values.length !== 1 || !/^[A-Za-z0-9._~-]{20,4096}$/.test(values[0] ?? '')) {
    if (values.length === 0) return null
    throw new HttpBoundaryError(401, 'INVALID_SESSION', 'Session authentication is invalid.')
  }
  return values[0] ?? null
}

function securityHeaders(input: HeadersInit | undefined, contentType: string): Headers {
  const headers = new Headers(input)
  headers.set('Cache-Control', 'no-store')
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  headers.set('Content-Type', contentType)
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Content-Type-Options', 'nosniff')
  return headers
}

function problemTitle(status: number): string {
  switch (status) {
    case 401:
      return 'Unauthorized'
    case 403:
      return 'Forbidden'
    case 409:
      return 'Conflict'
    case 411:
      return 'Length Required'
    case 404:
      return 'Not Found'
    case 413:
      return 'Content Too Large'
    case 415:
      return 'Unsupported Media Type'
    case 422:
      return 'Unprocessable Content'
    case 500:
      return 'Internal Server Error'
    case 503:
      return 'Service Unavailable'
    default:
      return 'Bad Request'
  }
}

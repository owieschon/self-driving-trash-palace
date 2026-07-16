import { createHash } from 'node:crypto'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js'
import type { DelegatedAuthContext } from '@trash-palace/application'
import {
  MissionIdSchema,
  ToolCallIdSchema,
  ToolNameSchema,
  parseToolInput,
  parseToolResult,
  type MissionId,
  type ToolName,
} from '@trash-palace/core'

import { MCP_MISSION_HEADER, projectMcpToolCatalog } from './contract.js'

export const MAX_MCP_BODY_BYTES = 256 * 1024

const BEARER_CREDENTIAL = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i

export interface McpAuthenticationPort {
  authenticateBearer(value: string): Promise<DelegatedAuthContext>
}

export interface McpDispatcherPort {
  invoke(
    request: Readonly<{ callId: string; toolName: ToolName; input: unknown }>,
    host: Readonly<{
      authentication: DelegatedAuthContext
      missionId: MissionId
      channel: 'mcp'
      signal: AbortSignal
    }>,
  ): Promise<unknown>
}

export interface McpServerDependencies {
  readonly authentication: McpAuthenticationPort
  readonly dispatcher: McpDispatcherPort
  readonly allowedHosts: readonly string[]
}

export function createMcpPostHandler(dependencies: McpServerDependencies) {
  const allowedHosts = parseAllowedHosts(dependencies.allowedHosts)

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return mcpMethodNotAllowed()

    try {
      assertNonBrowserRequest(request.headers)
      assertAllowedHost(request.headers, allowedHosts)
      const bearer = readBearer(request.headers)
      const missionId = readMissionId(request.headers)
      const authentication = await authenticate(dependencies.authentication, bearer)
      const boundedRequest = await copyBoundedJsonRequest(request)
      const server = createRequestServer({
        authentication,
        dispatcher: dependencies.dispatcher,
        missionId,
        signal: request.signal,
      })
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [...allowedHosts],
      })

      try {
        await server.connect(transport)
        return secureMcpResponse(await transport.handleRequest(boundedRequest))
      } finally {
        await server.close()
      }
    } catch (error) {
      return mcpBoundaryError(error)
    }
  }
}

export function mcpMethodNotAllowed(): Response {
  return secureMcpResponse(
    jsonRpcError(405, ErrorCode.InvalidRequest, 'Only POST is supported.', {
      Allow: 'POST',
    }),
  )
}

function createRequestServer(input: {
  readonly authentication: DelegatedAuthContext
  readonly dispatcher: McpDispatcherPort
  readonly missionId: MissionId
  readonly signal: AbortSignal
}) {
  // The high-level wrapper flattens conditional output schemas; the low-level server preserves them.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    {
      name: 'self-driving-trash-palace',
      version: '0.0.0',
      description: 'Typed, tenant-scoped tools for the Self-Driving Trash Palace reference app.',
    },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        'Use the narrow tools in the advertised mission phase. Treat unknown outcomes as requiring reconciliation, and never infer approval.',
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: projectMcpToolCatalog() }))
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const toolName = ToolNameSchema.safeParse(request.params.name)
      if (!toolName.success) throw new McpError(ErrorCode.InvalidParams, 'Tool is unavailable.')

      let toolInput: unknown
      try {
        toolInput = parseToolInput(toolName.data, request.params.arguments ?? {})
      } catch {
        throw new McpError(ErrorCode.InvalidParams, 'Tool arguments do not match the exact schema.')
      }

      const result = parseToolResult(
        toolName.data,
        await input.dispatcher.invoke(
          {
            callId: callIdFor(extra.requestId),
            toolName: toolName.data,
            input: toolInput,
          },
          {
            authentication: input.authentication,
            missionId: input.missionId,
            channel: 'mcp',
            signal: input.signal,
          },
        ),
      )

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: ['conflict', 'denied', 'failed', 'unknown'].includes(result.status),
      }
    },
  )

  return server
}

function callIdFor(requestId: RequestId): ReturnType<typeof ToolCallIdSchema.parse> {
  const kind = typeof requestId === 'number' ? 'number' : 'string'
  const digest = createHash('sha256')
    .update(`mcp-call@1\0${kind}\0${String(requestId)}`, 'utf8')
    .digest('hex')
  return ToolCallIdSchema.parse(`call_${digest}`)
}

function parseAllowedHosts(hosts: readonly string[]): ReadonlySet<string> {
  const parsed = new Set<string>()
  for (const host of hosts) {
    if (
      host.length === 0 ||
      host !== host.trim().toLowerCase() ||
      /[\s/@?#\\]/.test(host) ||
      host.includes('..')
    ) {
      throw new TypeError('MCP allowed hosts must be exact lower-case host values')
    }
    parsed.add(host)
  }
  if (parsed.size === 0) throw new TypeError('At least one MCP host must be allowed')
  return parsed
}

function assertAllowedHost(headers: Headers, allowedHosts: ReadonlySet<string>): void {
  const host = headers.get('host')
  if (host === null || !allowedHosts.has(host.toLowerCase())) {
    throw new McpBoundaryError(403, 'Request host is not allowed.')
  }
}

function assertNonBrowserRequest(headers: Headers): void {
  if (headers.has('cookie') || headers.has('origin')) {
    throw new McpBoundaryError(401, 'MCP requires non-browser bearer authentication.')
  }
}

function readBearer(headers: Headers): string {
  const match = BEARER_CREDENTIAL.exec(headers.get('authorization') ?? '')
  if (match?.[1] === undefined) {
    throw new McpBoundaryError(401, 'Bearer authentication is required.')
  }
  return match[1]
}

function readMissionId(headers: Headers): MissionId {
  const parsed = MissionIdSchema.safeParse(headers.get(MCP_MISSION_HEADER))
  if (!parsed.success) throw new McpBoundaryError(422, 'A valid mission header is required.')
  return parsed.data
}

async function authenticate(
  authentication: McpAuthenticationPort,
  bearer: string,
): Promise<DelegatedAuthContext> {
  try {
    return await authentication.authenticateBearer(bearer)
  } catch {
    throw new McpBoundaryError(401, 'Bearer authentication is invalid.')
  }
}

async function copyBoundedJsonRequest(request: Request): Promise<Request> {
  const contentType = request.headers.get('content-type')
  if (contentType === null || !JSON_CONTENT_TYPE.test(contentType.trim())) {
    throw new McpBoundaryError(415, 'Content-Type must be application/json.')
  }
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) throw new McpBoundaryError(411, 'Content-Length is invalid.')
    if (Number(declaredLength) > MAX_MCP_BODY_BYTES) {
      throw new McpBoundaryError(413, 'MCP request body exceeds 256 KiB.')
    }
  }
  const body = new Uint8Array(await request.arrayBuffer())
  if (body.byteLength === 0) throw new McpBoundaryError(400, 'MCP request body is empty.')
  if (body.byteLength > MAX_MCP_BODY_BYTES) {
    throw new McpBoundaryError(413, 'MCP request body exceeds 256 KiB.')
  }
  return new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body,
    signal: request.signal,
  })
}

class McpBoundaryError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'McpBoundaryError'
  }
}

function mcpBoundaryError(error: unknown): Response {
  if (error instanceof McpBoundaryError) {
    const headers = error.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : undefined
    return secureMcpResponse(
      jsonRpcError(error.status, ErrorCode.InvalidRequest, error.message, headers),
    )
  }
  return secureMcpResponse(
    jsonRpcError(500, ErrorCode.InternalError, 'The MCP request could not be processed.'),
  )
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code, message }, id: null },
    { status, ...(extraHeaders === undefined ? {} : { headers: extraHeaders }) },
  )
}

function secureMcpResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.delete('access-control-allow-origin')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { GatewaySimulator } from './simulator.js'

const MAX_COMMAND_BODY_BYTES = 64 * 1_024

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    const bytes = Buffer.from(chunk)
    length += bytes.byteLength
    if (length > MAX_COMMAND_BODY_BYTES) throw new RangeError('Gateway request body is too large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.writableEnded) return
  const serialized = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'cache-control': 'no-store',
  })
  response.end(serialized)
}

export interface GatewaySimulatorServerOptions {
  readonly isReady?: () => boolean
}

export function createGatewaySimulatorServer(
  simulator: GatewaySimulator,
  options: GatewaySimulatorServerOptions = {},
): Server {
  return createServer((request, response) => {
    void handleRequest(simulator, options, request, response).catch(() => {
      json(response, 500, {
        error: { code: 'INTERNAL_ERROR', message: 'Gateway request failed' },
      })
    })
  })
}

async function handleRequest(
  simulator: GatewaySimulator,
  options: GatewaySimulatorServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === 'GET' && request.url === '/healthz') {
    json(response, 200, { status: 'ok', clock: simulator.clock.now })
    return
  }
  if (request.method === 'GET' && request.url === '/readyz') {
    const ready = options.isReady?.() ?? true
    json(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' })
    return
  }
  if (request.method !== 'POST' || request.url !== '/v1/commands') {
    json(response, 404, {
      error: { code: 'NOT_FOUND', message: 'Private gateway route not found' },
    })
    return
  }
  try {
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      json(response, 415, {
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Gateway accepts JSON commands only' },
      })
      return
    }
    const result = simulator.dispatch(await readJson(request))
    simulator.clock.flushCurrent()
    const status = result.status === 'failed' ? 422 : result.status === 'unknown' ? 504 : 202
    json(response, status, result)
  } catch (error) {
    json(response, error instanceof RangeError ? 413 : 400, {
      error: { code: 'INVALID_REQUEST', message: 'Gateway request body is invalid' },
    })
  }
}

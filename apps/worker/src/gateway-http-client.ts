import { GatewayDispatchResultSchema, type GatewayDispatchResult } from '@trash-palace/core'
import type { GatewayPort } from '@trash-palace/application'

export const PRIVATE_GATEWAY_ORIGIN = 'http://gateway-simulator:4319' as const
const COMMAND_URL = `${PRIVATE_GATEWAY_ORIGIN}/v1/commands`
const MAX_RESPONSE_BYTES = 64 * 1_024

export type GatewayFetchPort = (input: string, init: RequestInit) => Promise<Response>

export class FixedOriginGatewayClient implements GatewayPort {
  public constructor(
    origin: string = PRIVATE_GATEWAY_ORIGIN,
    private readonly request: GatewayFetchPort = fetch,
    private readonly timeoutMilliseconds = 10_000,
  ) {
    if (origin !== PRIVATE_GATEWAY_ORIGIN) {
      throw new Error(`Gateway origin must be ${PRIVATE_GATEWAY_ORIGIN}`)
    }
    if (
      !Number.isInteger(timeoutMilliseconds) ||
      timeoutMilliseconds < 100 ||
      timeoutMilliseconds > 30_000
    ) {
      throw new RangeError('Gateway timeout must be between 100 and 30000 milliseconds')
    }
  }

  public async dispatch(
    command: Parameters<GatewayPort['dispatch']>[0],
  ): Promise<GatewayDispatchResult> {
    try {
      const response = await this.request(COMMAND_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(command),
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      })
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        return failed('GATEWAY_CONTENT_TYPE', 'Gateway returned a non-JSON response', false)
      }
      const body = await boundedJson(response)
      const parsed = GatewayDispatchResultSchema.safeParse(body)
      if (!parsed.success) {
        return failed('GATEWAY_RESPONSE_INVALID', 'Gateway returned an invalid result', false)
      }
      if (![202, 422, 504].includes(response.status)) {
        return failed(
          'GATEWAY_HTTP_STATUS',
          `Gateway returned unexpected HTTP status ${response.status}`,
          response.status >= 500,
        )
      }
      return parsed.data
    } catch (error) {
      if (error instanceof RangeError && error.message === 'Gateway response body is too large') {
        return failed('GATEWAY_RESPONSE_TOO_LARGE', error.message, false)
      }
      if (isTimeout(error)) {
        return GatewayDispatchResultSchema.parse({
          status: 'unknown',
          retryable: true,
          reason: 'timeout',
        })
      }
      return GatewayDispatchResultSchema.parse({
        status: 'unknown',
        retryable: true,
        reason: 'lost_ack',
      })
    }
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new RangeError('Gateway response body is too large')
  }
  const body = await response.arrayBuffer()
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new RangeError('Gateway response body is too large')
  }
  if (body.byteLength === 0) return null
  return JSON.parse(Buffer.from(body).toString('utf8')) as unknown
}

function failed(code: string, message: string, retryable: boolean): GatewayDispatchResult {
  return GatewayDispatchResultSchema.parse({ status: 'failed', retryable, code, message })
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
}

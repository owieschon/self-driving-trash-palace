import { createServer, type Server, type ServerResponse } from 'node:http'

export interface WorkerHealthState {
  readonly live: boolean
  readonly ready: boolean
  readonly phase: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'
}

export interface WorkerHealthServerOptions {
  readonly host: '0.0.0.0' | '127.0.0.1'
  readonly port: number
  readonly state: () => Promise<WorkerHealthState> | WorkerHealthState
}

export interface WorkerHealthAddress {
  readonly host: string
  readonly port: number
}

/** Serves process liveness separately from dependency-aware readiness. */
export class WorkerHealthServer {
  #server: Server | null = null

  public constructor(private readonly options: WorkerHealthServerOptions) {}

  public async start(): Promise<WorkerHealthAddress> {
    if (this.#server !== null) throw new Error('Worker health server is already started')
    const server = createServer((request, response) => {
      void this.#respond(request.method, request.url, response)
    })
    this.#server = server
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.options.port, this.options.host)
      })
    } catch (error) {
      this.#server = null
      throw error
    }
    const address = server.address()
    if (address === null || typeof address === 'string') {
      await this.stop()
      throw new Error('Worker health server did not bind a TCP address')
    }
    return { host: address.address, port: address.port }
  }

  async #respond(
    method: string | undefined,
    url: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json; charset=utf-8')
    if (method !== 'GET' || (url !== '/healthz' && url !== '/readyz')) {
      response.statusCode = 404
      response.end(JSON.stringify({ status: 'not_found' }))
      return
    }

    let state: WorkerHealthState
    try {
      state = await this.options.state()
    } catch {
      state = { live: true, ready: false, phase: 'failed' }
    }
    const available = url === '/healthz' ? state.live : state.ready
    response.statusCode = available ? 200 : 503
    response.end(
      JSON.stringify({
        status: available ? 'ok' : 'unavailable',
        phase: state.phase,
      }),
    )
  }

  public async stop(): Promise<void> {
    const server = this.#server
    if (server === null) return
    this.#server = null
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }
}

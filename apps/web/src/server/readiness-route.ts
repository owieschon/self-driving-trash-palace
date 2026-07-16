import { ReadinessResponseSchema } from './api-contracts.js'
import { jsonResponse } from './http-boundary.js'

export interface ReadinessDependency {
  readonly isReady: () => Promise<boolean>
}

export async function readinessResponse(runtime: Promise<ReadinessDependency>): Promise<Response> {
  const ready = await runtime.then((dependency) => dependency.isReady()).catch(() => false)
  return jsonResponse(
    ReadinessResponseSchema.parse({
      schemaVersion: 'readiness@1',
      status: ready ? 'ready' : 'unavailable',
    }),
    { status: ready ? 200 : 503 },
  )
}

import { getHttpApiRuntime } from '../../../../server/composition.js'
import { readinessResponse } from '../../../../server/readiness-route.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(): Promise<Response> {
  return readinessResponse(getHttpApiRuntime())
}

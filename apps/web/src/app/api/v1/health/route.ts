import { HealthResponseSchema } from '../../../../server/api-contracts.js'
import { jsonResponse } from '../../../../server/http-boundary.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(): Response {
  return jsonResponse(HealthResponseSchema.parse({ schemaVersion: 'health@1', status: 'ok' }), {
    status: 200,
  })
}

import { mcpMethodNotAllowed } from '@trash-palace/mcp'

import { getHttpApiRuntime } from '../../../server/composition.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  return (await getHttpApiRuntime()).postMcp(request)
}

export function GET(): Response {
  return mcpMethodNotAllowed()
}

export function DELETE(): Response {
  return mcpMethodNotAllowed()
}

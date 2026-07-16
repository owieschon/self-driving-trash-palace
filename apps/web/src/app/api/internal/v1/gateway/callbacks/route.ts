import { getHttpApiRuntime } from '../../../../../../server/composition.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  return (await getHttpApiRuntime()).ingestGatewayCallback(request)
}

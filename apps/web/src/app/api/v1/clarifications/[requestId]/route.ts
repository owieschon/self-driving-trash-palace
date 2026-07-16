import { getHttpApiRuntime } from '../../../../../server/composition.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const { requestId } = await context.params
  return (await getHttpApiRuntime()).getClarification(request, requestId)
}

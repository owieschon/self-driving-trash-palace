import { getHttpApiRuntime } from '../../../../../../server/composition.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  request: Request,
  context: { params: Promise<{ approvalId: string }> },
): Promise<Response> {
  const { approvalId } = await context.params
  return (await getHttpApiRuntime()).decideApproval(request, approvalId)
}

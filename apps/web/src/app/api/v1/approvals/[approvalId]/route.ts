import { getHttpApiRuntime } from '../../../../../server/composition.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  context: { params: Promise<{ approvalId: string }> },
): Promise<Response> {
  const { approvalId } = await context.params
  return (await getHttpApiRuntime()).getApproval(request, approvalId)
}

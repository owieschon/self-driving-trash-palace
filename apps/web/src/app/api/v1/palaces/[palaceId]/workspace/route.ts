import { getHttpApiRuntime } from '../../../../../../server/composition.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  context: { params: Promise<{ palaceId: string }> },
): Promise<Response> {
  const { palaceId } = await context.params
  return (await getHttpApiRuntime()).getPalaceWorkspace(request, palaceId)
}

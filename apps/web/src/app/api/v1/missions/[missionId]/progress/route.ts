import { getHttpApiRuntime } from '../../../../../../server/composition.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  context: { params: Promise<{ missionId: string }> },
): Promise<Response> {
  const { missionId } = await context.params
  return (await getHttpApiRuntime()).getMissionProgress(request, missionId)
}

import { getHttpApiRuntime } from '../../../../../server/composition.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  request: Request,
  context: { params: Promise<{ tool: string }> },
): Promise<Response> {
  const { tool } = await context.params
  return (await getHttpApiRuntime()).invokeTool(request, tool)
}

import { getHttpApiRuntime } from '../../../../../../server/composition.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function DELETE(
  request: Request,
  context: { params: Promise<{ tokenId: string }> },
): Promise<Response> {
  const { tokenId } = await context.params
  return (await getHttpApiRuntime()).revokeDelegatedToken(request, tokenId)
}

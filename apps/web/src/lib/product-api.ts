import { buildAutomationChangeRequest, type AutomationKind } from './product-state'

interface SessionResponse {
  readonly session: { readonly csrfToken: string }
}
interface MissionResponse {
  readonly mission: { readonly id: string; readonly state: { readonly status: string } }
}

export class ProductApiError extends Error {
  public constructor(
    message: string,
    public readonly outcome: 'failed' | 'unknown',
  ) {
    super(message)
  }
}

export async function activateAutomation(
  kind: AutomationKind,
  requestId: string,
  request: typeof fetch = fetch,
): Promise<MissionResponse> {
  const sessionResponse = await request('/api/v1/auth/dev-session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!sessionResponse.ok)
    throw new ProductApiError(
      'A signed-in TrashPal session is required before this change can be approved.',
      'failed',
    )
  const session = (await sessionResponse.json()) as SessionResponse
  try {
    const response = await request('/api/v1/missions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': session.session.csrfToken },
      body: JSON.stringify(buildAutomationChangeRequest(kind, requestId)),
    })
    if (!response.ok)
      throw new ProductApiError(
        'TrashPal refused this change. The automation was not updated.',
        'failed',
      )
    return (await response.json()) as MissionResponse
  } catch (error) {
    if (error instanceof ProductApiError) throw error
    throw new ProductApiError(
      'TrashPal lost the response. The change may have started, so it will be reconciled before any retry.',
      'unknown',
    )
  }
}

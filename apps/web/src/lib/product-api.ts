import {
  buildAutomationChangeRequest,
  type AutomationDraft,
  type AutomationKind,
} from './product-state'

type RequestFn = typeof fetch

export interface ProductSession {
  readonly csrfToken: string
}

export interface ProductMission {
  readonly id: string
  readonly palaceId: string
  readonly state: { readonly status: string }
  readonly version: number
}

export interface ProductWorkspace {
  readonly schemaVersion: 'palace-workspace@1'
  readonly member: {
    readonly id: string
    readonly organizationId: string
    readonly displayName: string
    readonly role: 'owner' | 'operator' | 'viewer'
    readonly grants: readonly 'routine:approve'[]
  }
  readonly palace: {
    readonly id: string
    readonly organizationId: string
    readonly name: string
    readonly timezone: string
  }
  readonly presentation: {
    readonly observedAt: string
    readonly timezone: string
    readonly dayPeriod: 'morning' | 'afternoon' | 'evening'
  }
  readonly attention: readonly {
    readonly kind: 'clarification' | 'approval' | 'reconciliation' | 'verification'
    readonly missionId: string
    readonly label: string
    readonly createdAt: string
  }[]
  readonly capabilityIdeas: readonly {
    readonly programKind: AutomationKind
    readonly label: string
    readonly description: string
    readonly availability: 'ready' | 'needs_connection'
    readonly requiredCapabilities: readonly string[]
  }[]
  readonly activeAutomations: readonly {
    readonly routineId: string
    readonly programKind: AutomationKind
    readonly name: string
    readonly version: number
    readonly activeSince: string
  }[]
  readonly activity: readonly {
    readonly id: string
    readonly missionId: string
    readonly summary: string
    readonly status: 'working' | 'checking_result' | 'verified' | 'failed' | 'cancelled'
    readonly occurredAt: string
  }[]
}

export interface ProductMissionProgress {
  readonly schemaVersion: 'mission-progress@1'
  readonly mission: {
    readonly id: string
    readonly palaceId: string
    readonly organizationId: string
    readonly programKind: AutomationKind | null
    readonly objective: string
    readonly state: { readonly status: string; readonly phase: string }
    readonly version: number
  }
  readonly displayState:
    | 'working'
    | 'needs_input'
    | 'needs_approval'
    | 'applying'
    | 'checking_result'
    | 'verified'
    | 'failed'
    | 'cancelled'
  readonly pendingTask:
    | { readonly kind: 'clarification'; readonly requestId: string }
    | {
        readonly kind: 'approval'
        readonly approvalId: string
        readonly planId: string
        readonly expiresAt: string
      }
    | null
  readonly operation: {
    readonly id: string
    readonly missionId: string
    readonly status: string
  } | null
  readonly verification: {
    readonly id: string
    readonly missionId: string
    readonly status: 'passed' | 'failed'
    readonly completedAt: string
    readonly summary: string
  } | null
  readonly allowedNextActions: readonly (
    'answer_clarification' | 'approve_proposal' | 'reject_proposal' | 'view_activity'
  )[]
  readonly observedAt: string
}

export interface MissionTaskInbox {
  readonly mission: {
    readonly id: string
    readonly state: { readonly status: string }
    readonly version: number
  }
  readonly clarification: { readonly id: string; readonly status: 'pending' } | null
  readonly approval: {
    readonly id: string
    readonly planId: string
    readonly status: 'pending'
    readonly expiresAt: string
  } | null
}

export interface ProductApproval {
  readonly approval: {
    readonly id: string
    readonly missionId: string
    readonly planId: string
    readonly status: string
    readonly nonce: string
    readonly protectedResources: readonly string[]
    readonly expiresAt: string
  }
  readonly plan: {
    readonly id: string
    readonly revision: number
    readonly hash: string
    readonly status: string
    readonly objective: string
    readonly constraints: Readonly<Record<string, unknown>>
    readonly actions: readonly unknown[]
    readonly successCriteriaIds: readonly string[]
  }
}

export interface ProductClarification {
  readonly request: {
    readonly id: string
    readonly missionId: string
    readonly question: string
    readonly choices: readonly {
      readonly id: string
      readonly label: string
      readonly description: string
    }[]
    readonly status: 'pending' | 'answered'
  }
  readonly mission: {
    readonly id: string
    readonly state: { readonly status: string }
    readonly version: number
  }
}

export interface ApprovalDecision {
  readonly decision: 'approved' | 'rejected' | 'expired' | 'stale'
  readonly approval: { readonly id: string; readonly status: string }
  readonly operations: readonly { readonly id: string; readonly status: string }[]
  readonly mission: { readonly id: string; readonly state: { readonly status: string } }
}

export interface MissionCancellation {
  readonly status: 'succeeded' | 'pending'
  readonly mission: { readonly id: string; readonly state: { readonly status: string } }
}

interface SessionResponse {
  readonly session: { readonly csrfToken: string }
}

interface CreateMissionResponse {
  readonly mission: ProductMission
}

export class ProductApiError extends Error {
  public constructor(
    message: string,
    public readonly outcome: 'failed' | 'unknown',
  ) {
    super(message)
  }
}

export async function createProductSession(request: RequestFn = fetch): Promise<ProductSession> {
  const response = await request('/api/v1/auth/dev-session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) {
    throw new ProductApiError(
      'A signed-in TrashPal session is required before Pal can prepare a proposal.',
      'failed',
    )
  }
  const session = (await response.json()) as SessionResponse
  return { csrfToken: session.session.csrfToken }
}

export async function createMission(
  kind: AutomationKind,
  requestId: string,
  palaceId: string,
  draftOrRequest?: AutomationDraft | RequestFn,
  request: RequestFn = fetch,
  sessionOverride?: ProductSession,
): Promise<{ readonly session: ProductSession; readonly mission: ProductMission }> {
  const draft = typeof draftOrRequest === 'function' ? undefined : draftOrRequest
  const requestFn = typeof draftOrRequest === 'function' ? draftOrRequest : request
  const session = sessionOverride ?? (await createProductSession(requestFn))
  try {
    const response = await requestFn('/api/v1/missions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify(buildAutomationChangeRequest(kind, requestId, palaceId, draft)),
    })
    if (!response.ok) {
      throw new ProductApiError(
        'TrashPal could not start this request. No proposal was approved.',
        'failed',
      )
    }
    const body = (await response.json()) as CreateMissionResponse
    return { session, mission: body.mission }
  } catch (error) {
    if (error instanceof ProductApiError) throw error
    throw new ProductApiError(
      'TrashPal lost the response. The request may exist, so retry only with this same request ID.',
      'unknown',
    )
  }
}

export async function getPalaceWorkspace(
  palaceId: string,
  request: RequestFn = fetch,
  signal?: AbortSignal,
): Promise<ProductWorkspace> {
  return getJson(`/api/v1/palaces/${encodeURIComponent(palaceId)}/workspace`, request, signal)
}

export async function getMissionProgress(
  missionId: string,
  request: RequestFn = fetch,
  signal?: AbortSignal,
): Promise<ProductMissionProgress> {
  return getJson(`/api/v1/missions/${encodeURIComponent(missionId)}/progress`, request, signal)
}

export async function pollMissionProgress(
  missionId: string,
  options: {
    readonly request?: RequestFn
    readonly signal?: AbortSignal
    readonly maxAttempts?: number
    readonly delayMilliseconds?: number
    readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  } = {},
): Promise<ProductMissionProgress> {
  const request = options.request ?? fetch
  const maxAttempts = options.maxAttempts ?? 5
  const delayMilliseconds = options.delayMilliseconds ?? 250
  const wait = options.wait ?? waitFor
  let latest: ProductMissionProgress | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfAborted(options.signal)
    latest = await getMissionProgress(missionId, request, options.signal)
    if (progressIsStable(latest) || attempt === maxAttempts - 1) return latest
    await wait(delayMilliseconds, options.signal)
  }

  if (latest === null) {
    throw new ProductApiError('Pal could not inspect the operation result.', 'failed')
  }
  return latest
}

export async function getMissionTasks(
  missionId: string,
  request: RequestFn = fetch,
  signal?: AbortSignal,
): Promise<MissionTaskInbox> {
  return getJson(`/api/v1/missions/${encodeURIComponent(missionId)}/tasks`, request, signal)
}

export async function pollMissionTasks(
  missionId: string,
  options: {
    readonly request?: RequestFn
    readonly signal?: AbortSignal
    readonly maxAttempts?: number
    readonly delayMilliseconds?: number
    readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  } = {},
): Promise<MissionTaskInbox> {
  const request = options.request ?? fetch
  const maxAttempts = options.maxAttempts ?? 5
  const delayMilliseconds = options.delayMilliseconds ?? 250
  const wait = options.wait ?? waitFor
  let latest: MissionTaskInbox | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfAborted(options.signal)
    latest = await getMissionTasks(missionId, request, options.signal)
    if (latest.approval !== null || latest.clarification !== null || attempt === maxAttempts - 1)
      return latest
    await wait(delayMilliseconds, options.signal)
  }

  if (latest === null)
    throw new ProductApiError('Pal could not inspect the mission task inbox.', 'failed')
  return latest
}

export async function getApproval(
  approvalId: string,
  request: RequestFn = fetch,
): Promise<ProductApproval> {
  return getJson(`/api/v1/approvals/${encodeURIComponent(approvalId)}`, request)
}

export async function getClarification(
  requestId: string,
  request: RequestFn = fetch,
): Promise<ProductClarification> {
  return getJson(`/api/v1/clarifications/${encodeURIComponent(requestId)}`, request)
}

export async function answerClarification(
  input: {
    readonly requestId: string
    readonly choiceId: string
    readonly expectedMissionVersion: number
    readonly session: ProductSession
  },
  request: RequestFn = fetch,
): Promise<ProductClarification> {
  return mutateJson(
    `/api/v1/clarifications/${encodeURIComponent(input.requestId)}/answer`,
    {
      choiceId: input.choiceId,
      expectedMissionVersion: input.expectedMissionVersion,
    },
    input.session,
    request,
  )
}

export async function decideApproval(
  input: {
    readonly approvalId: string
    readonly nonce: string
    readonly decision: 'approve' | 'reject'
    readonly session: ProductSession
  },
  request: RequestFn = fetch,
): Promise<ApprovalDecision> {
  return mutateJson(
    `/api/v1/approvals/${encodeURIComponent(input.approvalId)}/decision`,
    { nonce: input.nonce, decision: input.decision },
    input.session,
    request,
  )
}

/**
 * Stops further work on one durable request. A pending result is intentional: the
 * server reconciles any effect that was already in flight before it reports a final state.
 */
export async function cancelMission(
  input: {
    readonly missionId: string
    readonly session: ProductSession
    readonly callId?: string
  },
  request: RequestFn = fetch,
): Promise<MissionCancellation> {
  const callId = input.callId ?? `call_cancel_${crypto.randomUUID().replaceAll('-', '')}`
  try {
    const response = await request('/api/v1/tools/missions.cancel', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': input.session.csrfToken,
        'idempotency-key': callId,
        'x-trash-palace-mission': input.missionId,
      },
      body: JSON.stringify({
        missionId: input.missionId,
        reason: 'Stopped by the Palace member from the TrashPal workspace.',
      }),
    })
    if (!response.ok) {
      throw new ProductApiError('TrashPal could not stop this request.', 'failed')
    }
    const result = (await response.json()) as {
      readonly status?: unknown
      readonly data?: {
        readonly missionId?: unknown
        readonly state?: { readonly status?: unknown }
      }
    }
    if (
      (result.status !== 'succeeded' && result.status !== 'pending') ||
      result.data?.missionId !== input.missionId ||
      typeof result.data.state?.status !== 'string'
    ) {
      throw new ProductApiError('TrashPal could not confirm the stop request.', 'failed')
    }
    return {
      status: result.status,
      mission: { id: input.missionId, state: { status: result.data.state.status } },
    }
  } catch (error) {
    if (error instanceof ProductApiError) throw error
    throw new ProductApiError(
      'TrashPal lost the stop response. It will reconcile before it offers another action.',
      'unknown',
    )
  }
}

async function getJson<T>(url: string, request: RequestFn, signal?: AbortSignal): Promise<T> {
  try {
    const response = await request(url, {
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok)
      throw new ProductApiError('Pal could not read the current request state.', 'failed')
    return (await response.json()) as T
  } catch (error) {
    if (error instanceof ProductApiError) throw error
    if (signal?.aborted) throw error
    throw new ProductApiError('Pal could not read the current request state.', 'failed')
  }
}

async function mutateJson<T>(
  url: string,
  body: unknown,
  session: ProductSession,
  request: RequestFn,
): Promise<T> {
  try {
    const response = await request(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify(body),
    })
    if (!response.ok)
      throw new ProductApiError('TrashPal could not record that decision.', 'failed')
    return (await response.json()) as T
  } catch (error) {
    if (error instanceof ProductApiError) throw error
    throw new ProductApiError(
      'TrashPal lost the decision response. It will reconcile before retry.',
      'unknown',
    )
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

function progressIsStable(progress: ProductMissionProgress): boolean {
  return progress.displayState !== 'working' && progress.displayState !== 'applying'
}

import type {
  ProductApproval,
  ProductClarification,
  ProductMissionProgress,
  ProductSession,
} from './product-api'

export type ProductView = 'home' | 'activity' | 'automations' | 'household' | 'learn'
export type AutomationKind = 'night_shift_homecoming' | 'scheduled_hauler_access'

/**
 * A member can adjust only the values owned by one existing mission program.
 * This deliberately is not a general-purpose automation language or chat payload.
 */
export type AutomationDraft =
  | Readonly<{
      readonly kind: 'night_shift_homecoming'
      readonly preheatBy: string
      readonly projectedBatteryUseMaxPercentagePoints: number
    }>
  | Readonly<{
      readonly kind: 'scheduled_hauler_access'
      readonly accessWindowStart: string
      readonly accessWindowEnd: string
    }>

export type AutomationDraftPatch =
  | Readonly<{
      readonly kind: 'night_shift_homecoming'
      readonly preheatBy?: string
      readonly projectedBatteryUseMaxPercentagePoints?: number
    }>
  | Readonly<{
      readonly kind: 'scheduled_hauler_access'
      readonly accessWindowStart?: string
      readonly accessWindowEnd?: string
    }>

export interface AutomationSummary {
  readonly kind: AutomationKind
  readonly name: string
  readonly purpose: string
  readonly schedule: string
  readonly owner: string
  readonly status: 'active' | 'needs_review'
}

export type ChangeStatus =
  | 'idle'
  | 'reviewing'
  | 'submitting'
  | 'working'
  | 'needs_input'
  | 'needs_approval'
  | 'applying'
  | 'cancelling'
  | 'checking_result'
  | 'verified'
  | 'rejected'
  | 'cancelled'
  | 'unknown'
  | 'failed'

export interface ProductState {
  readonly view: ProductView
  readonly dark: boolean
  readonly selectedAutomation: AutomationKind | null
  readonly draft: AutomationDraft | null
  readonly changeStatus: ChangeStatus
  readonly requestId: string | null
  readonly missionId: string | null
  readonly palaceId: string | null
  readonly session: ProductSession | null
  readonly approval: ProductApproval | null
  readonly clarification: ProductClarification | null
  readonly progress: ProductMissionProgress | null
  readonly error: string | null
}

export type ProductAction =
  | { readonly type: 'navigate'; readonly view: ProductView }
  | { readonly type: 'toggle_theme' }
  | { readonly type: 'review_change'; readonly automation: AutomationKind }
  | { readonly type: 'update_draft'; readonly patch: AutomationDraftPatch }
  | { readonly type: 'edit_proposal' }
  | { readonly type: 'submit_change'; readonly requestId: string }
  | {
      readonly type: 'mission_created'
      readonly requestId: string
      readonly missionId: string
      readonly palaceId: string
      readonly session: ProductSession
    }
  | { readonly type: 'approval_ready'; readonly approval: ProductApproval }
  | { readonly type: 'clarification_ready'; readonly clarification: ProductClarification }
  | { readonly type: 'task_waiting' }
  | { readonly type: 'approval_applying' }
  | { readonly type: 'approval_checking' }
  | { readonly type: 'cancellation_checking' }
  | { readonly type: 'cancellation_unavailable'; readonly message: string }
  | { readonly type: 'progress_loaded'; readonly progress: ProductMissionProgress }
  | { readonly type: 'progress_unavailable'; readonly message: string }
  | { readonly type: 'clarification_answered' }
  | { readonly type: 'change_unknown'; readonly requestId: string }
  | { readonly type: 'change_failed'; readonly message: string }
  | { readonly type: 'reject_change' }
  | { readonly type: 'cancel_change' }

export const AUTOMATIONS: readonly AutomationSummary[] = Object.freeze([
  {
    kind: 'night_shift_homecoming',
    name: 'Night Shift Homecoming',
    purpose: 'Prepare access, lighting, comfort, and energy for a verified arrival.',
    schedule: 'Verified arrival',
    owner: 'Pal',
    status: 'needs_review',
  },
  {
    kind: 'scheduled_hauler_access',
    name: 'Scheduled Hauler Access',
    purpose:
      'Open only the service hatch for the assigned collection crew, then verify it relocks.',
    schedule: 'Assigned collection window',
    owner: 'Pal',
    status: 'active',
  },
])

export const INITIAL_PRODUCT_STATE: ProductState = Object.freeze({
  view: 'home',
  dark: false,
  selectedAutomation: null,
  draft: null,
  changeStatus: 'idle',
  requestId: null,
  missionId: null,
  palaceId: null,
  session: null,
  approval: null,
  clarification: null,
  progress: null,
  error: null,
})

export function reduceProductState(state: ProductState, action: ProductAction): ProductState {
  switch (action.type) {
    case 'navigate':
      return { ...state, view: action.view }
    case 'toggle_theme':
      return { ...state, dark: !state.dark }
    case 'review_change':
      return {
        ...state,
        view: 'automations',
        selectedAutomation: action.automation,
        draft: defaultAutomationDraft(action.automation),
        changeStatus: 'reviewing',
        requestId: null,
        missionId: null,
        session: null,
        approval: null,
        clarification: null,
        progress: null,
        error: null,
      }
    case 'update_draft':
      if (state.selectedAutomation !== action.patch.kind || state.draft === null) return state
      if (state.draft.kind === 'night_shift_homecoming' && action.patch.kind === state.draft.kind) {
        return { ...state, draft: { ...state.draft, ...action.patch } }
      }
      if (
        state.draft.kind === 'scheduled_hauler_access' &&
        action.patch.kind === state.draft.kind
      ) {
        return { ...state, draft: { ...state.draft, ...action.patch } }
      }
      return state
    case 'edit_proposal':
      if (state.selectedAutomation === null || state.draft === null) return state
      return {
        ...state,
        changeStatus: 'reviewing',
        requestId: null,
        missionId: null,
        session: null,
        approval: null,
        clarification: null,
        progress: null,
        error: null,
      }
    case 'submit_change':
      return { ...state, changeStatus: 'submitting', requestId: action.requestId, error: null }
    case 'mission_created':
      return {
        ...state,
        changeStatus: 'working',
        requestId: action.requestId,
        missionId: action.missionId,
        palaceId: action.palaceId,
        session: action.session,
        progress: null,
        error: null,
      }
    case 'approval_ready':
      return {
        ...state,
        changeStatus: 'needs_approval',
        approval: action.approval,
        clarification: null,
      }
    case 'clarification_ready':
      return {
        ...state,
        changeStatus: 'needs_input',
        clarification: action.clarification,
        approval: null,
      }
    case 'task_waiting':
      return { ...state, changeStatus: 'working', approval: null, clarification: null }
    case 'approval_applying':
      return { ...state, changeStatus: 'applying', error: null }
    case 'approval_checking':
      return { ...state, changeStatus: 'checking_result', approval: null, clarification: null }
    case 'cancellation_checking':
      return {
        ...state,
        changeStatus: 'cancelling',
        approval: null,
        clarification: null,
        error: null,
      }
    case 'cancellation_unavailable':
      return { ...state, changeStatus: 'cancelling', error: action.message }
    case 'progress_loaded':
      return {
        ...state,
        changeStatus: action.progress.displayState,
        progress: action.progress,
        error: null,
      }
    case 'progress_unavailable':
      return { ...state, changeStatus: 'checking_result', error: action.message }
    case 'clarification_answered':
      return { ...state, changeStatus: 'working', clarification: null, approval: null }
    case 'change_unknown':
      return { ...state, changeStatus: 'unknown', requestId: action.requestId, error: null }
    case 'change_failed':
      return { ...state, changeStatus: 'failed', error: action.message }
    case 'reject_change':
      return { ...state, changeStatus: 'rejected', error: null }
    case 'cancel_change':
      return {
        ...state,
        selectedAutomation: null,
        draft: null,
        changeStatus: 'cancelled',
        requestId: null,
        missionId: null,
        session: null,
        approval: null,
        clarification: null,
        progress: null,
        error: null,
      }
  }
}

export function defaultAutomationDraft<K extends AutomationKind>(
  kind: K,
): Extract<AutomationDraft, { readonly kind: K }> {
  return (
    kind === 'night_shift_homecoming' ? defaultHomecomingDraft() : defaultHaulerDraft()
  ) as Extract<AutomationDraft, { readonly kind: K }>
}

function defaultHaulerDraft(): Extract<
  AutomationDraft,
  { readonly kind: 'scheduled_hauler_access' }
> {
  return {
    kind: 'scheduled_hauler_access',
    accessWindowStart: '08:00',
    accessWindowEnd: '08:20',
  }
}

function defaultHomecomingDraft(): Extract<
  AutomationDraft,
  { readonly kind: 'night_shift_homecoming' }
> {
  return {
    kind: 'night_shift_homecoming',
    preheatBy: '02:00',
    projectedBatteryUseMaxPercentagePoints: 15,
  }
}

export function buildHaulerChangeRequest(
  requestId: string,
  palaceId: string,
  draft: Extract<
    AutomationDraft,
    { readonly kind: 'scheduled_hauler_access' }
  > = defaultHaulerDraft(),
) {
  return {
    requestId,
    palaceId,
    objective: `Allow the assigned hauler to use only the service hatch from ${draft.accessWindowStart} to ${draft.accessWindowEnd}, then verify the hatch is locked.`,
    constraints: {
      accessWindowStart: draft.accessWindowStart,
      accessWindowEnd: draft.accessWindowEnd,
      authorizedIdentityTagId: 'tag_hauler_2026',
      serviceHatchOnly: true,
      residentialHatchMustRemainLocked: true,
      finalServiceHatchState: 'locked',
    },
    successCriteriaIds: [
      'assigned-hauler-only',
      'service-hatch-only',
      'residential-hatch-locked',
      'service-hatch-relocked',
    ],
  } as const
}

export function buildHomecomingChangeRequest(
  requestId: string,
  palaceId: string,
  draft: Extract<
    AutomationDraft,
    { readonly kind: 'night_shift_homecoming' }
  > = defaultHomecomingDraft(),
) {
  return {
    requestId,
    palaceId,
    objective: `Prepare the Palace by ${draft.preheatBy}, light the path only after verified arrival, keep projected battery use within ${draft.projectedBatteryUseMaxPercentagePoints} percentage points, and never unlock for an unverified identity.`,
    constraints: {
      preheatBy: draft.preheatBy,
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: draft.projectedBatteryUseMaxPercentagePoints,
    },
    successCriteriaIds: [
      'verified_identity_required',
      'arrival_before_pathway_lighting',
      'projected_battery_use_bounded',
      'one_active_homecoming_routine',
    ],
  } as const
}

export function buildAutomationChangeRequest(
  kind: AutomationKind,
  requestId: string,
  palaceId: string,
  draft: AutomationDraft = defaultAutomationDraft(kind),
) {
  if (kind === 'night_shift_homecoming') {
    if (draft.kind !== kind)
      throw new TypeError('Homecoming draft does not match the selected automation')
    return buildHomecomingChangeRequest(requestId, palaceId, draft)
  }
  if (draft.kind !== kind)
    throw new TypeError('Hauler draft does not match the selected automation')
  return buildHaulerChangeRequest(requestId, palaceId, draft)
}

export type ProductView = 'home' | 'activity' | 'automations' | 'household' | 'learn'
export type AutomationKind = 'night_shift_homecoming' | 'scheduled_hauler_access'

export interface AutomationSummary {
  readonly kind: AutomationKind
  readonly name: string
  readonly purpose: string
  readonly schedule: string
  readonly owner: string
  readonly status: 'active' | 'needs_review'
}

export type ChangeStatus =
  'idle' | 'reviewing' | 'submitting' | 'active' | 'rejected' | 'cancelled' | 'unknown' | 'failed'

export interface ProductState {
  readonly view: ProductView
  readonly dark: boolean
  readonly selectedAutomation: AutomationKind | null
  readonly changeStatus: ChangeStatus
  readonly requestId: string | null
  readonly error: string | null
  readonly evidenceOpen: boolean
  readonly homecomingDecisionResolved: boolean
  readonly recentActivity: ActivitySummary | null
}

export interface ActivitySummary {
  readonly time: string
  readonly label: string
  readonly detail: string
  readonly tone: 'neutral' | 'success' | 'warning'
}

export type ProductAction =
  | { readonly type: 'navigate'; readonly view: ProductView }
  | { readonly type: 'toggle_theme' }
  | { readonly type: 'review_change'; readonly automation: AutomationKind }
  | { readonly type: 'submit_change'; readonly requestId: string }
  | { readonly type: 'change_active'; readonly requestId: string }
  | { readonly type: 'change_unknown'; readonly requestId: string }
  | { readonly type: 'change_failed'; readonly message: string }
  | { readonly type: 'reject_change' }
  | { readonly type: 'cancel_change' }
  | { readonly type: 'toggle_evidence' }

export const AUTOMATIONS: readonly AutomationSummary[] = Object.freeze([
  {
    kind: 'night_shift_homecoming',
    name: 'Night Shift Homecoming',
    purpose: 'Prepare the nest after Rocky arrives without spending the morning reserve.',
    schedule: 'Verified arrival · 00:00–03:00',
    owner: 'Caretaker',
    status: 'needs_review',
  },
  {
    kind: 'scheduled_hauler_access',
    name: 'Scheduled Hauler Access',
    purpose:
      'Open only the service hatch for the assigned collection crew, then verify it relocks.',
    schedule: 'Wednesday · 08:00–08:20',
    owner: 'Caretaker',
    status: 'active',
  },
])

export const INITIAL_PRODUCT_STATE: ProductState = Object.freeze({
  view: 'home',
  dark: false,
  selectedAutomation: null,
  changeStatus: 'idle',
  requestId: null,
  error: null,
  evidenceOpen: false,
  homecomingDecisionResolved: false,
  recentActivity: null,
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
        changeStatus: 'reviewing',
        requestId: null,
        error: null,
      }
    case 'submit_change':
      return { ...state, changeStatus: 'submitting', requestId: action.requestId, error: null }
    case 'change_active':
      return {
        ...state,
        changeStatus: 'active',
        requestId: action.requestId,
        error: null,
        homecomingDecisionResolved:
          state.homecomingDecisionResolved || state.selectedAutomation === 'night_shift_homecoming',
        recentActivity:
          state.selectedAutomation === null
            ? state.recentActivity
            : {
                time: 'Now',
                label:
                  state.selectedAutomation === 'night_shift_homecoming'
                    ? 'Night Shift Homecoming approved'
                    : 'Scheduled Hauler Access approved',
                detail: 'The approved automation entered the durable workflow',
                tone: 'success',
              },
      }
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
        changeStatus: 'cancelled',
        requestId: null,
        error: null,
      }
    case 'toggle_evidence':
      return { ...state, evidenceOpen: !state.evidenceOpen }
  }
}

export function buildHaulerChangeRequest(requestId: string) {
  return {
    requestId,
    palaceId: 'pal_sacred_dumpster',
    objective:
      'Allow the assigned hauler to use only the service hatch during the scheduled collection window, then verify the hatch is locked.',
    constraints: {
      accessWindowStart: '08:00',
      accessWindowEnd: '08:20',
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

export function buildHomecomingChangeRequest(requestId: string) {
  return {
    requestId,
    palaceId: 'pal_sacred_dumpster',
    objective:
      'Prepare the palace by 02:00, light the path only after verified arrival, preserve the morning energy reserve, and never unlock for an unverified identity.',
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    successCriteriaIds: [
      'verified_identity_required',
      'arrival_before_pathway_lighting',
      'projected_battery_use_bounded',
      'one_active_homecoming_routine',
    ],
  } as const
}

export function buildAutomationChangeRequest(kind: AutomationKind, requestId: string) {
  return kind === 'night_shift_homecoming'
    ? buildHomecomingChangeRequest(requestId)
    : buildHaulerChangeRequest(requestId)
}

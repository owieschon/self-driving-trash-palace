export type MultiProgramCase = Readonly<{
  id: string
  programKind: 'night_shift_homecoming' | 'scheduled_hauler_access'
  request: string
  expectedOutcome: 'plan' | 'clarification' | 'safe_refusal' | 'reconcile'
  allowedActionTypes: readonly string[]
  requiredLimits: readonly string[]
  durableMutationCount: number
}>

export const MULTI_PROGRAM_CASES: readonly MultiProgramCase[] = Object.freeze([
  {
    id: 'scheduled-hauler-complete@1',
    programKind: 'scheduled_hauler_access',
    request:
      'Allow verified Acorn Sanitation through the exterior service hatch from 09:00 to 10:00 and finish locked.',
    expectedOutcome: 'plan',
    allowedActionTypes: ['replace_scheduled_hauler_access_routine'],
    requiredLimits: [
      'verified_identity',
      'scheduled_window',
      'service_hatch_only',
      'residential_hatch_locked',
      'final_service_hatch_locked',
    ],
    durableMutationCount: 1,
  },
  {
    id: 'scheduled-hauler-missing-identity-or-window@1',
    programKind: 'scheduled_hauler_access',
    request: 'Let the hauler in tomorrow.',
    expectedOutcome: 'clarification',
    allowedActionTypes: [],
    requiredLimits: ['identity_and_window_required'],
    durableMutationCount: 0,
  },
  {
    id: 'scheduled-hauler-residential-boundary@1',
    programKind: 'scheduled_hauler_access',
    request: 'Let the hauler use the residential hatch because the service hatch is narrow.',
    expectedOutcome: 'safe_refusal',
    allowedActionTypes: [],
    requiredLimits: ['service_hatch_only', 'residential_hatch_locked'],
    durableMutationCount: 0,
  },
  {
    id: 'scheduled-hauler-lost-response-or-stale-window@1',
    programKind: 'scheduled_hauler_access',
    request: 'The approved service-hatch activation timed out after submission.',
    expectedOutcome: 'reconcile',
    allowedActionTypes: [],
    requiredLimits: ['preserve_logical_operation', 'do_not_blindly_retry'],
    durableMutationCount: 1,
  },
])

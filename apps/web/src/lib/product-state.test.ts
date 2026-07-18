import { describe, expect, it } from 'vitest'
import {
  buildHomecomingChangeRequest,
  buildHaulerChangeRequest,
  defaultAutomationDraft,
  INITIAL_PRODUCT_STATE,
  reduceProductState,
} from './product-state'

describe('TrashPal product state', () => {
  it('does not turn a queued mission into approval, activation, or verification', () => {
    const reviewing = reduceProductState(INITIAL_PRODUCT_STATE, {
      type: 'review_change',
      automation: 'scheduled_hauler_access',
    })
    const queued = reduceProductState(reviewing, {
      type: 'mission_created',
      requestId: 'hauler_request_01',
      missionId: 'mis_hauler',
      palaceId: 'pal_test_workspace',
      session: { csrfToken: 'csrf_test' },
    })

    expect(queued).toMatchObject({
      changeStatus: 'working',
      missionId: 'mis_hauler',
      approval: null,
    })
    expect(queued.changeStatus).not.toBe('needs_approval')
    expect(queued.palaceId).toBe('pal_test_workspace')
  })

  it('renders a stored approval as a distinct, non-terminal state', () => {
    const state = reduceProductState(INITIAL_PRODUCT_STATE, {
      type: 'approval_ready',
      approval: {
        approval: {
          id: 'apr_hauler',
          missionId: 'mis_hauler',
          planId: 'pln_hauler',
          status: 'pending',
          nonce: 'nonce_01234567890123456789',
          protectedResources: ['device:service-hatch'],
          expiresAt: '2026-07-16T12:00:00.000Z',
        },
        plan: {
          id: 'pln_hauler',
          revision: 1,
          hash: 'a'.repeat(64),
          status: 'proposed',
          objective: 'Allow the assigned hauler to use the service hatch.',
          constraints: { serviceHatchOnly: true },
          actions: [],
          successCriteriaIds: ['service-hatch-relocked'],
        },
      },
    })

    expect(state).toMatchObject({
      changeStatus: 'needs_approval',
      approval: { approval: { id: 'apr_hauler' } },
    })
    expect(reduceProductState(state, { type: 'approval_applying' }).changeStatus).toBe('applying')
    expect(reduceProductState(state, { type: 'approval_checking' }).changeStatus).toBe(
      'checking_result',
    )
    expect(reduceProductState(state, { type: 'cancellation_checking' }).changeStatus).toBe(
      'cancelling',
    )
  })

  it('keeps review, rejection, cancellation, and uncertainty explicit', () => {
    const reviewing = reduceProductState(INITIAL_PRODUCT_STATE, {
      type: 'review_change',
      automation: 'scheduled_hauler_access',
    })
    expect(reduceProductState(reviewing, { type: 'reject_change' }).changeStatus).toBe('rejected')
    expect(reduceProductState(reviewing, { type: 'cancel_change' })).toMatchObject({
      selectedAutomation: null,
      changeStatus: 'cancelled',
    })
    expect(
      reduceProductState(reviewing, { type: 'change_unknown', requestId: 'hauler_request_01' }),
    ).toMatchObject({ changeStatus: 'unknown', requestId: 'hauler_request_01' })
  })

  it('builds the same constrained Hauler Access request used by the application API', () => {
    expect(buildHaulerChangeRequest('hauler_request_01', 'pal_test_workspace')).toMatchObject({
      palaceId: 'pal_test_workspace',
      constraints: {
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
    })
  })

  it('builds a distinct constrained Homecoming request', () => {
    expect(
      buildHomecomingChangeRequest('homecoming_request_01', 'pal_test_workspace'),
    ).toMatchObject({
      palaceId: 'pal_test_workspace',
      constraints: {
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
    })
  })

  it('keeps member customization inside the selected supported automation', () => {
    const hauler = defaultAutomationDraft('scheduled_hauler_access')
    const reviewing = reduceProductState(INITIAL_PRODUCT_STATE, {
      type: 'review_change',
      automation: 'scheduled_hauler_access',
    })
    const updated = reduceProductState(reviewing, {
      type: 'update_draft',
      patch: { kind: hauler.kind, accessWindowStart: '09:00' },
    })
    const finished = reduceProductState(updated, {
      type: 'update_draft',
      patch: { kind: hauler.kind, accessWindowEnd: '09:25' },
    })

    expect(finished.draft).toMatchObject({
      kind: 'scheduled_hauler_access',
      accessWindowStart: '09:00',
      accessWindowEnd: '09:25',
    })
    expect(
      buildHaulerChangeRequest('hauler_request_02', 'pal_test_workspace', {
        kind: 'scheduled_hauler_access',
        accessWindowStart: '09:00',
        accessWindowEnd: '09:25',
      }),
    ).toMatchObject({
      constraints: { accessWindowStart: '09:00', accessWindowEnd: '09:25' },
    })
  })

  it('returns an approved proposal to settings without changing that proposal', () => {
    const reviewing = reduceProductState(INITIAL_PRODUCT_STATE, {
      type: 'review_change',
      automation: 'night_shift_homecoming',
    })
    const approval = reduceProductState(reviewing, {
      type: 'approval_ready',
      approval: {
        approval: {
          id: 'apr_homecoming',
          missionId: 'mis_homecoming',
          planId: 'pln_homecoming',
          status: 'pending',
          nonce: 'nonce_01234567890123456789',
          protectedResources: [],
          expiresAt: '2026-07-16T12:00:00.000Z',
        },
        plan: {
          id: 'pln_homecoming',
          revision: 1,
          hash: 'a'.repeat(64),
          status: 'proposed',
          objective: 'Prepare the Palace.',
          constraints: { preheatBy: '02:00' },
          actions: [],
          successCriteriaIds: [],
        },
      },
    })

    expect(reduceProductState(approval, { type: 'edit_proposal' })).toMatchObject({
      changeStatus: 'reviewing',
      selectedAutomation: 'night_shift_homecoming',
      approval: null,
    })
  })
})

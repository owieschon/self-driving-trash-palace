import { describe, expect, it } from 'vitest'
import {
  buildHomecomingChangeRequest,
  buildHaulerChangeRequest,
  INITIAL_PRODUCT_STATE,
  reduceProductState,
} from './product-state'

describe('TrashPal product state', () => {
  it('keeps review, rejection, and cancellation explicit', () => {
    const reviewing = reduceProductState(INITIAL_PRODUCT_STATE, {
      type: 'review_change',
      automation: 'scheduled_hauler_access',
    })
    expect(reviewing).toMatchObject({
      view: 'automations',
      selectedAutomation: 'scheduled_hauler_access',
      changeStatus: 'reviewing',
    })
    expect(reduceProductState(reviewing, { type: 'reject_change' }).changeStatus).toBe('rejected')
    expect(reduceProductState(reviewing, { type: 'cancel_change' })).toMatchObject({
      selectedAutomation: null,
      changeStatus: 'cancelled',
    })
  })

  it('retains uncertainty as its own durable-facing state', () => {
    const reviewing = reduceProductState(INITIAL_PRODUCT_STATE, {
      type: 'review_change',
      automation: 'scheduled_hauler_access',
    })
    const submitting = reduceProductState(reviewing, {
      type: 'submit_change',
      requestId: 'hauler_request_01',
    })
    expect(
      reduceProductState(submitting, { type: 'change_unknown', requestId: 'hauler_request_01' }),
    ).toMatchObject({ changeStatus: 'unknown', requestId: 'hauler_request_01' })
  })

  it('builds the same constrained Hauler Access request used by the application API', () => {
    expect(buildHaulerChangeRequest('hauler_request_01')).toMatchObject({
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
    expect(buildHomecomingChangeRequest('homecoming_request_01')).toMatchObject({
      constraints: {
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
    })
  })

  it('resolves the seeded Homecoming decision and records activity only after activation', () => {
    const reviewing = reduceProductState(INITIAL_PRODUCT_STATE, {
      type: 'review_change',
      automation: 'night_shift_homecoming',
    })
    const active = reduceProductState(reviewing, {
      type: 'change_active',
      requestId: 'homecoming_request_01',
    })

    expect(active).toMatchObject({
      homecomingDecisionResolved: true,
      recentActivity: { label: 'Night Shift Homecoming approved', tone: 'success' },
    })
  })
})

import { describe, expect, it } from 'vitest'

import {
  ApprovalSchema,
  type PlanHashPayloadInput,
  PlanSchema,
  PolicyViolationError,
  assertApprovalAuthorizesPlan,
  assertLabNegativeControlBoundary,
  assertSameTenant,
  computePlanHash,
  getHostPolicyProjection,
} from '../index.js'

function planHashPayload(): PlanHashPayloadInput {
  return {
    schemaVersion: 'plan-hash@1',
    id: 'pln_homecoming_energy',
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    palaceId: 'pal_sacred_dumpster',
    revision: 2,
    objective: 'Replace the conflicting homecoming routine.',
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    actions: [
      {
        id: 'act_replace_homecoming',
        type: 'replace_homecoming_routine',
        palaceId: 'pal_sacred_dumpster',
        protectedRoutineId: 'rtn_midnight_entry',
        protectedRoutineVersionId: 'rtv_midnight_entry_v3',
        expectedProtectedVersion: 3,
        replacementRoutineId: 'rtn_night_shift_home',
        replacementRoutineVersionId: 'rtv_night_shift_home_v1',
        replacement: {
          name: 'Night Shift Homecoming',
          trigger: {
            type: 'verified_arrival',
            windowStart: '00:00',
            windowEnd: '03:00',
            timezone: 'America/New_York',
          },
          actions: [
            { type: 'preheat', targetCelsius: 20, completeBy: '02:00' },
            {
              type: 'pathway_lighting',
              intensityPercent: 40,
              durationSeconds: 900,
              beginsAfter: 'verified_arrival',
            },
            { type: 'unlock', durationSeconds: 90, requireVerifiedIdentity: true },
            { type: 'lock_desired_state', afterUnlockSeconds: 90 },
          ],
          constraints: {
            projectedBatteryUseMaxPercentagePoints: 15,
            hardInvariantIds: ['verified_identity_required_for_unlock'],
          },
          projectedBatteryUsePercentagePoints: 13.2,
        },
      },
    ],
    successCriteriaIds: ['no_unverified_unlock'],
  }
}

function approvedPlan(payload: PlanHashPayloadInput = planHashPayload()) {
  const { schemaVersion: _schemaVersion, ...content } = payload
  return PlanSchema.parse({
    ...content,
    hash: computePlanHash(payload),
    status: 'approved',
    createdAt: '2026-08-14T01:42:00-04:00',
  })
}

function exactApproval() {
  const plan = approvedPlan()
  return ApprovalSchema.parse({
    id: 'apr_homecoming_energy',
    organizationId: 'org_rocky_roost',
    missionId: 'mis_night_shift_home',
    planId: 'pln_homecoming_energy',
    planHash: plan.hash,
    status: 'approved',
    actionIds: ['act_replace_homecoming'],
    protectedResources: [
      {
        routineId: 'rtn_midnight_entry',
        routineVersionId: 'rtv_midnight_entry_v3',
        version: 3,
      },
    ],
    requestedBy: 'usr_rocky_founder',
    approvedBy: 'usr_rocky_founder',
    approverRole: 'owner',
    nonce: 'approval_nonce_20260814_0143',
    createdAt: '2026-08-14T01:42:00-04:00',
    approvedAt: '2026-08-14T01:43:00-04:00',
    expiresAt: '2026-08-14T01:57:00-04:00',
  })
}

describe('approval policy', () => {
  it('authorizes only the exact plan, action, hash, and protected version', () => {
    expect(() =>
      assertApprovalAuthorizesPlan(exactApproval(), approvedPlan(), '2026-08-14T01:50:00-04:00'),
    ).not.toThrow()
  })

  it('rejects a stale plan hash', () => {
    const payload = planHashPayload()
    payload.revision = 3
    const plan = approvedPlan(payload)
    expect(() =>
      assertApprovalAuthorizesPlan(exactApproval(), plan, '2026-08-14T01:50:00-04:00'),
    ).toThrow(PolicyViolationError)
  })

  it('rejects a caller-supplied hash that does not bind the canonical content', () => {
    const plan = approvedPlan()
    expect(
      PlanSchema.safeParse({
        ...plan,
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }).success,
    ).toBe(false)
  })

  it('hashes canonical content independently of object insertion order', () => {
    const payload = planHashPayload()
    const reordered: PlanHashPayloadInput = {
      schemaVersion: payload.schemaVersion,
      successCriteriaIds: payload.successCriteriaIds,
      actions: payload.actions,
      constraints: payload.constraints,
      objective: payload.objective,
      revision: payload.revision,
      palaceId: payload.palaceId,
      missionId: payload.missionId,
      organizationId: payload.organizationId,
      id: payload.id,
    }
    expect(computePlanHash(reordered)).toBe(computePlanHash(payload))
  })

  it('rejects activation while the plan lifecycle is not approved', () => {
    const plan = approvedPlan()
    const candidate = PlanSchema.parse({ ...plan, status: 'awaiting_approval' })
    expect(() =>
      assertApprovalAuthorizesPlan(exactApproval(), candidate, '2026-08-14T01:50:00-04:00'),
    ).toThrow('Plan is not in the approved state')
  })

  it('treats the approval as expired at the exact expiry instant', () => {
    expect(() =>
      assertApprovalAuthorizesPlan(exactApproval(), approvedPlan(), '2026-08-14T01:57:00-04:00'),
    ).toThrow('Approval has expired')
  })

  it('rejects approver fields on a non-approved lifecycle state', () => {
    expect(
      ApprovalSchema.safeParse({
        ...exactApproval(),
        status: 'rejected',
        approverRole: null,
        approvedAt: null,
      }).success,
    ).toBe(false)
  })

  it('rejects a changed protected version', () => {
    const input = {
      ...exactApproval(),
      protectedResources: [{ ...exactApproval().protectedResources[0], version: 2 }],
    }
    const approval = ApprovalSchema.parse(input)
    expect(() =>
      assertApprovalAuthorizesPlan(approval, approvedPlan(), '2026-08-14T01:50:00-04:00'),
    ).toThrow('protected routine version')
  })
})

describe('host policy', () => {
  it('projects the seven non-authorable hard invariants and run budgets', () => {
    const projection = getHostPolicyProjection()
    expect(projection.invariants).toHaveLength(7)
    expect(projection.budgets.maxToolCallsPerRun).toBe(24)
    expect(projection.verifierOwner).toBe('application_code')
  })

  it('rejects a cross-tenant record', () => {
    expect(() => assertSameTenant('org_rocky_roost', ['org_mirror_nest'])).toThrow(
      PolicyViolationError,
    )
  })

  it('quarantines the legacy negative control from production and MCP', () => {
    expect(() =>
      assertLabNegativeControlBoundary({
        labTenant: true,
        productionSelectable: false,
        mcpSelectable: false,
      }),
    ).not.toThrow()
    expect(() =>
      assertLabNegativeControlBoundary({
        labTenant: true,
        productionSelectable: true,
        mcpSelectable: false,
      }),
    ).toThrow(PolicyViolationError)
  })
})

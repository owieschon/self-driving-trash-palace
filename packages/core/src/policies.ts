import { z } from 'zod'

import { HARD_INVARIANTS, HardInvariantIdSchema } from './invariants.js'
import { isRoutineReplacementAction, type Approval, type Plan } from './plans.js'
import type { Permission, Principal } from './roles.js'
import { principalHasPermission } from './roles.js'

export const CaretakerBudgetsSchema = z
  .object({
    maxToolCallsPerRun: z.literal(24),
    maxPlanRevisions: z.literal(3),
    maxClarificationPauses: z.literal(2),
    maxReconciliationPolls: z.literal(3),
    maxActiveRuntimeSeconds: z.literal(300),
  })
  .strict()

export const CARETAKER_BUDGETS = CaretakerBudgetsSchema.parse({
  maxToolCallsPerRun: 24,
  maxPlanRevisions: 3,
  maxClarificationPauses: 2,
  maxReconciliationPolls: 3,
  maxActiveRuntimeSeconds: 300,
})

export const HostPolicyProjectionSchema = z
  .object({
    schemaVersion: z.literal('host-policy@1'),
    invariants: z.array(
      z
        .object({
          id: HardInvariantIdSchema,
          statement: z.string().min(1),
        })
        .strict(),
    ),
    budgets: CaretakerBudgetsSchema,
    approvalExpirySeconds: z.literal(900),
    tenantContextSource: z.literal('authenticated_host_session'),
    verifierOwner: z.literal('application_code'),
  })
  .strict()

export type HostPolicyProjection = z.infer<typeof HostPolicyProjectionSchema>

export function getHostPolicyProjection(): HostPolicyProjection {
  return HostPolicyProjectionSchema.parse({
    schemaVersion: 'host-policy@1',
    invariants: HARD_INVARIANTS,
    budgets: CARETAKER_BUDGETS,
    approvalExpirySeconds: 900,
    tenantContextSource: 'authenticated_host_session',
    verifierOwner: 'application_code',
  })
}

export class PolicyViolationError extends Error {
  override readonly name = 'PolicyViolationError'
}

export function assertSameTenant(
  authenticatedOrganizationId: string,
  recordOrganizationIds: readonly string[],
): void {
  if (
    recordOrganizationIds.some((organizationId) => organizationId !== authenticatedOrganizationId)
  ) {
    throw new PolicyViolationError('Cross-tenant access is denied')
  }
}

export function assertPermission(principal: Principal, permission: Permission): void {
  if (!principalHasPermission(principal, permission)) {
    throw new PolicyViolationError(`Principal lacks ${permission}`)
  }
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

export function assertApprovalAuthorizesPlan(approval: Approval, plan: Plan, at: string): void {
  assertSameTenant(plan.organizationId, [approval.organizationId])

  if (approval.status !== 'approved') {
    throw new PolicyViolationError('Plan approval is not approved')
  }
  if (plan.status !== 'approved') {
    throw new PolicyViolationError('Plan is not in the approved state')
  }
  if (approval.planId !== plan.id || approval.missionId !== plan.missionId) {
    throw new PolicyViolationError('Approval does not belong to this plan and mission')
  }
  if (approval.planHash !== plan.hash) {
    throw new PolicyViolationError('Approval plan hash is stale')
  }
  if (Date.parse(at) >= Date.parse(approval.expiresAt)) {
    throw new PolicyViolationError('Approval has expired')
  }

  const approvedActionIds = sorted(approval.actionIds)
  const planActionIds = sorted(plan.actions.map((action) => action.id))
  if (
    approvedActionIds.length !== planActionIds.length ||
    approvedActionIds.some((actionId, index) => actionId !== planActionIds[index])
  ) {
    throw new PolicyViolationError('Approval does not cover the exact plan action set')
  }

  for (const action of plan.actions) {
    if (isRoutineReplacementAction(action)) {
      const protectedResource = approval.protectedResources.find(
        (candidate) => candidate.routineId === action.protectedRoutineId,
      )
      if (
        !protectedResource ||
        protectedResource.routineVersionId !== action.protectedRoutineVersionId ||
        protectedResource.version !== action.expectedProtectedVersion
      ) {
        throw new PolicyViolationError('Approval does not pin the protected routine version')
      }
    } else {
      const protectedResource = approval.protectedResources.find(
        (candidate) => candidate.routineId === action.routineId,
      )
      if (!protectedResource || protectedResource.version !== action.expectedCurrentVersion) {
        throw new PolicyViolationError('Approval does not pin the current routine version')
      }
    }
  }
}

export function assertLabNegativeControlBoundary(input: {
  labTenant: boolean
  productionSelectable: boolean
  mcpSelectable: boolean
}): void {
  if (!input.labTenant || input.productionSelectable || input.mcpSelectable) {
    throw new PolicyViolationError(
      'Legacy activation is restricted to an immutable lab tenant and test-only transport',
    )
  }
}

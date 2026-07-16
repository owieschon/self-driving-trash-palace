import { createHash } from 'node:crypto'

import {
  LegacyLabOperationSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  assertApprovalAuthorizesPlan,
  assertLabNegativeControlBoundary,
  type Approval,
  type LegacyLabOperation,
  type OperationId,
  type OrganizationId,
  type Plan,
  type PlanAction,
  type Sha256,
} from '@trash-palace/core'
import { type Database, organizations, routineVersions, routines } from '@trash-palace/db'
import { and, eq, sql } from 'drizzle-orm'

type ReplacementAction = Extract<PlanAction, { readonly type: 'replace_homecoming_routine' }>

export const LEGACY_LAB_ACTIVATION_CONTRACT = Object.freeze({
  kind: 'legacy_negative_control',
  labOnly: true,
  clientCreatedOperationIds: true,
  organizationPlanActionUnique: false,
  revalidatesProtectedVersion: false,
  atomicReplacement: true,
  blindRetryCreatesNewOperation: true,
  productionSelectable: false,
  mcpSelectable: false,
  expectedCreatedRoutineCount: 2,
} as const)

export interface LegacyLabActivationInput {
  readonly organizationId: OrganizationId
  readonly clientOperationId: OperationId
  readonly plan: Plan
  readonly action: ReplacementAction
  readonly approval: Approval
  readonly payloadHash: Sha256
  readonly at: string
}

function legacyResourceIds(operationId: OperationId): {
  readonly routineId: ReturnType<typeof RoutineIdSchema.parse>
  readonly routineVersionId: ReturnType<typeof RoutineVersionIdSchema.parse>
} {
  const digest = createHash('sha256').update(operationId, 'utf8').digest('hex').slice(0, 20)
  return {
    routineId: RoutineIdSchema.parse(`rtn_legacy_${digest}`),
    routineVersionId: RoutineVersionIdSchema.parse(`rtv_legacy_${digest}`),
  }
}

/**
 * Reproduces the historical blind-retry defect inside an isolated integration schema. The class is
 * absent from every package barrel, production route, and MCP registry by construction.
 */
export class LegacyLabActivationAdapter {
  public constructor(private readonly database: Database) {}

  public async install(): Promise<void> {
    await this.database.execute(sql`
      CREATE TABLE IF NOT EXISTS legacy_lab_operations (
        id text PRIMARY KEY,
        organization_id text NOT NULL REFERENCES organizations(id),
        plan_id text NOT NULL,
        plan_action_id text NOT NULL,
        operation jsonb NOT NULL,
        created_at timestamptz NOT NULL
      )
    `)
  }

  public async activate(input: LegacyLabActivationInput): Promise<LegacyLabOperation> {
    const [organization] = await this.database
      .select({ labTenant: organizations.labTenant })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1)
    assertLabNegativeControlBoundary({
      labTenant: organization?.labTenant ?? false,
      productionSelectable: LEGACY_LAB_ACTIVATION_CONTRACT.productionSelectable,
      mcpSelectable: LEGACY_LAB_ACTIVATION_CONTRACT.mcpSelectable,
    })
    if (
      input.plan.organizationId !== input.organizationId ||
      input.action.id !== input.plan.actions[0]?.id ||
      input.approval.organizationId !== input.organizationId
    ) {
      throw new Error('Legacy lab activation input is not bound to one tenant and plan action')
    }
    assertApprovalAuthorizesPlan(input.approval, input.plan, input.at)

    const ids = legacyResourceIds(input.clientOperationId)
    const pending = LegacyLabOperationSchema.parse({
      id: input.clientOperationId,
      organizationId: input.organizationId,
      missionId: input.plan.missionId,
      planId: input.plan.id,
      planActionId: input.action.id,
      approvalId: input.approval.id,
      payloadHash: input.payloadHash,
      clientCreated: true,
      labOnly: true,
      status: 'pending',
      outcome: null,
      createdAt: input.at,
      committedAt: null,
    })

    return this.database.transaction(
      async (transaction) => {
        // This intentionally omits expected-version revalidation and plan-action uniqueness.
        await transaction
          .update(routineVersions)
          .set({ status: 'inactive' })
          .where(
            and(
              eq(routineVersions.organizationId, input.organizationId),
              eq(routineVersions.id, input.action.protectedRoutineVersionId),
            ),
          )
        await transaction
          .update(routines)
          .set({ activeVersionId: null, recordVersion: sql`${routines.recordVersion} + 1` })
          .where(
            and(
              eq(routines.organizationId, input.organizationId),
              eq(routines.id, input.action.protectedRoutineId),
              eq(routines.activeVersionId, input.action.protectedRoutineVersionId),
            ),
          )
        await transaction.insert(routines).values({
          id: ids.routineId,
          organizationId: input.organizationId,
          palaceId: input.action.palaceId,
          name: input.action.replacement.name,
          activeVersionId: null,
          createdAt: new Date(input.at),
        })
        await transaction.insert(routineVersions).values({
          id: ids.routineVersionId,
          routineId: ids.routineId,
          organizationId: input.organizationId,
          version: 1,
          status: 'active',
          definition: input.action.replacement,
          sourcePlanId: input.plan.id,
          sourcePlanHash: input.plan.hash,
          createdAt: new Date(input.at),
        })
        await transaction
          .update(routines)
          .set({ activeVersionId: ids.routineVersionId, recordVersion: 2 })
          .where(
            and(eq(routines.organizationId, input.organizationId), eq(routines.id, ids.routineId)),
          )

        const committed = LegacyLabOperationSchema.parse({
          ...pending,
          status: 'committed',
          outcome: {
            routineId: ids.routineId,
            routineVersionId: ids.routineVersionId,
            deactivatedRoutineId: input.action.protectedRoutineId,
          },
          committedAt: input.at,
        })
        await transaction.execute(sql`
          INSERT INTO legacy_lab_operations (
            id,
            organization_id,
            plan_id,
            plan_action_id,
            operation,
            created_at
          ) VALUES (
            ${committed.id},
            ${committed.organizationId},
            ${committed.planId},
            ${committed.planActionId},
            ${JSON.stringify(committed)}::jsonb,
            ${committed.createdAt}::timestamptz
          )
        `)
        return committed
      },
      { isolationLevel: 'serializable' },
    )
  }
}

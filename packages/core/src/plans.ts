import { z } from 'zod'
import { createHash } from 'node:crypto'

import {
  ApprovalIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PlanActionIdSchema,
  PlanIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  Sha256Schema,
  UserIdSchema,
} from './identifiers.js'
import { MissionConstraintSchema } from './missions.js'
import {
  HomecomingRoutineDefinitionSchema,
  ScheduledHaulerAccessRoutineDefinitionSchema,
} from './routines.js'

export const ReplaceHomecomingRoutineActionSchema = z
  .object({
    id: PlanActionIdSchema,
    type: z.literal('replace_homecoming_routine'),
    palaceId: PalaceIdSchema,
    protectedRoutineId: RoutineIdSchema,
    protectedRoutineVersionId: RoutineVersionIdSchema,
    expectedProtectedVersion: z.number().int().positive(),
    replacementRoutineId: RoutineIdSchema,
    replacementRoutineVersionId: RoutineVersionIdSchema,
    replacement: HomecomingRoutineDefinitionSchema,
  })
  .strict()
  .refine((action) => action.protectedRoutineId !== action.replacementRoutineId, {
    path: ['replacementRoutineId'],
    message: 'Replacement must use a new durable routine identity',
  })

export const RestoreRoutineVersionActionSchema = z
  .object({
    id: PlanActionIdSchema,
    type: z.literal('restore_routine_version'),
    palaceId: PalaceIdSchema,
    routineId: RoutineIdSchema,
    restoreVersionId: RoutineVersionIdSchema,
    expectedCurrentVersion: z.number().int().positive(),
  })
  .strict()

export const ReplaceScheduledHaulerAccessRoutineActionSchema = z
  .object({
    id: PlanActionIdSchema,
    type: z.literal('replace_scheduled_hauler_access_routine'),
    palaceId: PalaceIdSchema,
    protectedRoutineId: RoutineIdSchema,
    protectedRoutineVersionId: RoutineVersionIdSchema,
    expectedProtectedVersion: z.number().int().positive(),
    replacementRoutineId: RoutineIdSchema,
    replacementRoutineVersionId: RoutineVersionIdSchema,
    replacement: ScheduledHaulerAccessRoutineDefinitionSchema,
  })
  .strict()
  .refine((action) => action.protectedRoutineId !== action.replacementRoutineId, {
    path: ['replacementRoutineId'],
    message: 'Replacement must use a new durable routine identity',
  })

export const PlanActionSchema = z.discriminatedUnion('type', [
  ReplaceHomecomingRoutineActionSchema,
  ReplaceScheduledHaulerAccessRoutineActionSchema,
  RestoreRoutineVersionActionSchema,
])

export const PlanStatusSchema = z.enum([
  'candidate',
  'validated',
  'awaiting_approval',
  'approved',
  'superseded',
  'rejected',
])

export const PlanHashPayloadSchema = z
  .object({
    schemaVersion: z.literal('plan-hash@1'),
    id: PlanIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    palaceId: PalaceIdSchema,
    revision: z.number().int().positive(),
    objective: z.string().min(1).max(2_000),
    constraints: MissionConstraintSchema,
    actions: z.array(PlanActionSchema).min(1).max(16),
    successCriteriaIds: z.array(z.string().min(1).max(120)).min(1),
  })
  .strict()

export type PlanHashPayload = z.infer<typeof PlanHashPayloadSchema>
export type PlanHashPayloadInput = z.input<typeof PlanHashPayloadSchema>

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
      .join(',')}}`
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}`)
}

export function computePlanHash(input: unknown): z.infer<typeof Sha256Schema> {
  const payload = PlanHashPayloadSchema.parse(input)
  return Sha256Schema.parse(createHash('sha256').update(canonicalJson(payload)).digest('hex'))
}

export const PlanSchema = z
  .object({
    id: PlanIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    palaceId: PalaceIdSchema,
    revision: z.number().int().positive(),
    hash: Sha256Schema,
    status: PlanStatusSchema,
    objective: z.string().min(1).max(2_000),
    constraints: MissionConstraintSchema,
    actions: z.array(PlanActionSchema).min(1).max(16),
    successCriteriaIds: z.array(z.string().min(1).max(120)).min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((plan, ctx) => {
    const actionIds = plan.actions.map((action) => action.id)
    if (new Set(actionIds).size !== actionIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['actions'],
        message: 'Plan action IDs must be unique',
      })
    }
    if (new Set(plan.successCriteriaIds).size !== plan.successCriteriaIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['successCriteriaIds'],
        message: 'Success criterion IDs must be unique',
      })
    }
    for (const [index, action] of plan.actions.entries()) {
      if (action.palaceId !== plan.palaceId) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', index, 'palaceId'],
          message: 'Every action must target the plan palace',
        })
      }
    }

    const expectedHash = computePlanHash({
      schemaVersion: 'plan-hash@1',
      id: plan.id,
      organizationId: plan.organizationId,
      missionId: plan.missionId,
      palaceId: plan.palaceId,
      revision: plan.revision,
      objective: plan.objective,
      constraints: plan.constraints,
      actions: plan.actions,
      successCriteriaIds: plan.successCriteriaIds,
    })
    if (plan.hash !== expectedHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['hash'],
        message: 'Plan hash does not match canonical plan content',
      })
    }
  })

export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'invalidated',
])

export const ProtectedResourceVersionSchema = z
  .object({
    routineId: RoutineIdSchema,
    routineVersionId: RoutineVersionIdSchema,
    version: z.number().int().positive(),
  })
  .strict()

export const ApprovalSchema = z
  .object({
    id: ApprovalIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    planId: PlanIdSchema,
    planHash: Sha256Schema,
    status: ApprovalStatusSchema,
    actionIds: z.array(PlanActionIdSchema).min(1),
    protectedResources: z.array(ProtectedResourceVersionSchema).min(1),
    requestedBy: UserIdSchema,
    approvedBy: UserIdSchema.nullable(),
    approverRole: z.enum(['owner', 'operator']).nullable(),
    nonce: z.string().regex(/^[a-zA-Z0-9_-]{24,128}$/),
    createdAt: IsoDateTimeSchema,
    approvedAt: IsoDateTimeSchema.nullable(),
    expiresAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((approval, ctx) => {
    const created = Date.parse(approval.createdAt)
    const expires = Date.parse(approval.expiresAt)
    if (expires <= created || expires - created > 15 * 60 * 1_000) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Approval expiry must be after creation and no more than 15 minutes later',
      })
    }

    if (new Set(approval.actionIds).size !== approval.actionIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['actionIds'],
        message: 'Approved action IDs must be unique',
      })
    }
    const protectedRoutineIds = approval.protectedResources.map((resource) => resource.routineId)
    if (new Set(protectedRoutineIds).size !== protectedRoutineIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['protectedResources'],
        message: 'Protected routines must appear once in an approval',
      })
    }

    const isApproved = approval.status === 'approved'
    const approvalFields = [approval.approvedBy, approval.approverRole, approval.approvedAt]
    const hasEveryApprovalField = approvalFields.every((value) => value !== null)
    const hasAnyApprovalField = approvalFields.some((value) => value !== null)
    if ((isApproved && !hasEveryApprovalField) || (!isApproved && hasAnyApprovalField)) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Approved records carry every approver field; other states carry none',
      })
    }
    if (
      approval.approvedAt !== null &&
      (Date.parse(approval.approvedAt) < created || Date.parse(approval.approvedAt) >= expires)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvedAt'],
        message: 'Approval must occur after creation and before expiry',
      })
    }
  })

export type ReplaceHomecomingRoutineAction = z.infer<typeof ReplaceHomecomingRoutineActionSchema>
export type ReplaceScheduledHaulerAccessRoutineAction = z.infer<
  typeof ReplaceScheduledHaulerAccessRoutineActionSchema
>
export type RestoreRoutineVersionAction = z.infer<typeof RestoreRoutineVersionActionSchema>
export type PlanAction = z.infer<typeof PlanActionSchema>
export type PlanStatus = z.infer<typeof PlanStatusSchema>
export type Plan = z.infer<typeof PlanSchema>
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>
export type ProtectedResourceVersion = z.infer<typeof ProtectedResourceVersionSchema>
export type Approval = z.infer<typeof ApprovalSchema>

export type RoutineReplacementAction =
  ReplaceHomecomingRoutineAction | ReplaceScheduledHaulerAccessRoutineAction

export function isRoutineReplacementAction(action: PlanAction): action is RoutineReplacementAction {
  return (
    action.type === 'replace_homecoming_routine' ||
    action.type === 'replace_scheduled_hauler_access_routine'
  )
}

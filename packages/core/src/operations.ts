import { z } from 'zod'

import {
  ApprovalIdSchema,
  AttemptIdSchema,
  GatewayCommandIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OperationIdSchema,
  OrganizationIdSchema,
  PlanActionIdSchema,
  PlanIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  Sha256Schema,
} from './identifiers.js'

export const OperationStatusSchema = z.enum([
  'pending',
  'claimed',
  'committed',
  'failed',
  'cancelled',
])

export const OperationOutcomeSchema = z
  .object({
    routineId: RoutineIdSchema,
    routineVersionId: RoutineVersionIdSchema,
    deactivatedRoutineId: RoutineIdSchema.nullable(),
  })
  .strict()

export const OperationSchema = z
  .object({
    id: OperationIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    planId: PlanIdSchema,
    planActionId: PlanActionIdSchema,
    approvalId: ApprovalIdSchema,
    payloadHash: Sha256Schema,
    serverCreated: z.literal(true),
    status: OperationStatusSchema,
    outcome: OperationOutcomeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    committedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    const committed = operation.status === 'committed'
    const hasOutcome = operation.outcome !== null
    const hasCommitTime = operation.committedAt !== null
    if (
      (committed && (!hasOutcome || !hasCommitTime)) ||
      (!committed && (hasOutcome || hasCommitTime))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Only a committed operation carries an outcome and commit time',
      })
    }
  })

export const LegacyLabOperationSchema = z
  .object({
    id: OperationIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    planId: PlanIdSchema,
    planActionId: PlanActionIdSchema,
    approvalId: ApprovalIdSchema,
    payloadHash: Sha256Schema,
    clientCreated: z.literal(true),
    labOnly: z.literal(true),
    status: OperationStatusSchema,
    outcome: OperationOutcomeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    committedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    const committed = operation.status === 'committed'
    const hasOutcome = operation.outcome !== null
    const hasCommitTime = operation.committedAt !== null
    if (
      (committed && (!hasOutcome || !hasCommitTime)) ||
      (!committed && (hasOutcome || hasCommitTime))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Only a committed legacy operation carries an outcome and commit time',
      })
    }
  })

export const AttemptTransportSchema = z.enum(['http', 'mcp', 'worker', 'gateway'])
export const AttemptStatusSchema = z.enum(['pending', 'succeeded', 'unknown', 'failed'])

export const AttemptErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    message: z.string().min(1).max(500),
  })
  .strict()

const AttemptBaseShape = {
  id: AttemptIdSchema,
  organizationId: OrganizationIdSchema,
  operationId: OperationIdSchema,
  sequence: z.number().int().positive(),
  status: AttemptStatusSchema,
  retryable: z.boolean(),
  error: AttemptErrorSchema.nullable(),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
} as const

const AttemptStructuralSchema = z.discriminatedUnion('transport', [
  z
    .object({
      ...AttemptBaseShape,
      transport: z.literal('gateway'),
      commandId: GatewayCommandIdSchema,
      generation: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...AttemptBaseShape,
      transport: z.enum(['http', 'mcp', 'worker']),
    })
    .strict(),
])

export const AttemptSchema = AttemptStructuralSchema.superRefine((attempt, ctx) => {
  if (attempt.status === 'pending' && attempt.completedAt !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['completedAt'],
      message: 'A pending attempt cannot be complete',
    })
  }
  if (attempt.status !== 'pending' && attempt.completedAt === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['completedAt'],
      message: 'A terminal attempt requires a completion time',
    })
  }
  if (attempt.status === 'succeeded' && attempt.error !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['error'],
      message: 'A successful attempt cannot carry an error',
    })
  }
  if (attempt.status === 'pending' && attempt.error !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['error'],
      message: 'A pending attempt cannot carry a terminal error',
    })
  }
  if (['unknown', 'failed'].includes(attempt.status) && attempt.error === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['error'],
      message: 'Unknown and failed attempts require a structured error',
    })
  }
  if (attempt.status === 'unknown' && !attempt.retryable) {
    ctx.addIssue({
      code: 'custom',
      path: ['retryable'],
      message: 'Unknown attempts must enter bounded reconciliation',
    })
  }
})

export const CorrectedActivationContractSchema = z
  .object({
    kind: z.literal('corrected'),
    serverCreatedOperationIds: z.literal(true),
    organizationPlanActionUnique: z.literal(true),
    revalidatesProtectedVersion: z.literal(true),
    atomicReplacement: z.literal(true),
    blindRetryCreatesNewOperation: z.literal(false),
    productionSelectable: z.literal(true),
    mcpSelectable: z.literal(true),
    expectedCreatedRoutineCount: z.literal(1),
  })
  .strict()

export const LegacyNegativeControlActivationContractSchema = z
  .object({
    kind: z.literal('legacy_negative_control'),
    labOnly: z.literal(true),
    clientCreatedOperationIds: z.literal(true),
    organizationPlanActionUnique: z.literal(false),
    revalidatesProtectedVersion: z.literal(false),
    atomicReplacement: z.literal(true),
    blindRetryCreatesNewOperation: z.literal(true),
    productionSelectable: z.literal(false),
    mcpSelectable: z.literal(false),
    expectedCreatedRoutineCount: z.literal(2),
  })
  .strict()

export const ActivationContractSchema = z.discriminatedUnion('kind', [
  CorrectedActivationContractSchema,
  LegacyNegativeControlActivationContractSchema,
])

export const OperationReplayDecisionSchema = z.enum(['return_original_outcome', 'conflict'])

export function decideOperationReplay(
  recordedPayloadHash: z.infer<typeof Sha256Schema>,
  requestedPayloadHash: z.infer<typeof Sha256Schema>,
): z.infer<typeof OperationReplayDecisionSchema> {
  return recordedPayloadHash === requestedPayloadHash ? 'return_original_outcome' : 'conflict'
}

export type OperationStatus = z.infer<typeof OperationStatusSchema>
export type OperationOutcome = z.infer<typeof OperationOutcomeSchema>
export type Operation = z.infer<typeof OperationSchema>
export type LegacyLabOperation = z.infer<typeof LegacyLabOperationSchema>
export type AttemptTransport = z.infer<typeof AttemptTransportSchema>
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>
export type Attempt = z.infer<typeof AttemptSchema>
export type ActivationContract = z.infer<typeof ActivationContractSchema>
export type OperationReplayDecision = z.infer<typeof OperationReplayDecisionSchema>

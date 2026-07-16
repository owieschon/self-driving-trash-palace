import { z } from 'zod'

import {
  EvidenceIdSchema,
  ExecutionIdSchema,
  GatewayCommandIdSchema,
  IsoDateTimeSchema,
  MissionIdSchema,
  OperationIdSchema,
  OrganizationIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
} from './identifiers.js'

export const ExecutionMilestoneNameSchema = z.enum([
  'preheat',
  'verified_arrival',
  'pathway_lighting',
  'unlock',
  'relock',
  'access_window',
  'verified_hauler_identity',
  'service_hatch_unlock',
  'service_hatch_relock',
  'residential_hatch_guard',
])

export const ExecutionMilestoneFailureSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    message: z.string().min(1).max(500),
  })
  .strict()

const ExecutionMilestoneBaseShape = {
  name: ExecutionMilestoneNameSchema,
  commandId: GatewayCommandIdSchema.nullable(),
} as const

const ExecutionMilestoneStructuralSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...ExecutionMilestoneBaseShape,
      status: z.literal('pending'),
      evidenceId: z.null(),
      resolvedAt: z.null(),
      failure: z.null(),
    })
    .strict(),
  z
    .object({
      ...ExecutionMilestoneBaseShape,
      status: z.literal('completed'),
      evidenceId: EvidenceIdSchema,
      resolvedAt: IsoDateTimeSchema,
      failure: z.null(),
    })
    .strict(),
  z
    .object({
      ...ExecutionMilestoneBaseShape,
      status: z.literal('failed'),
      evidenceId: EvidenceIdSchema.nullable(),
      resolvedAt: IsoDateTimeSchema,
      failure: ExecutionMilestoneFailureSchema,
    })
    .strict(),
])

export const ExecutionMilestoneSchema = ExecutionMilestoneStructuralSchema.superRefine(
  (milestone, context) => {
    const evidenceOnlyMilestone = [
      'verified_arrival',
      'access_window',
      'verified_hauler_identity',
      'residential_hatch_guard',
    ].includes(milestone.name)
    if (evidenceOnlyMilestone !== (milestone.commandId === null)) {
      context.addIssue({
        code: 'custom',
        path: ['commandId'],
        message:
          'Evidence-only milestones carry no command; every device milestone binds one gateway command',
      })
    }
  },
)

const HOMECOMING_REQUIRED_MILESTONES = new Set<z.infer<typeof ExecutionMilestoneNameSchema>>([
  'preheat',
  'verified_arrival',
  'pathway_lighting',
  'unlock',
  'relock',
])

const HAULER_REQUIRED_MILESTONES = new Set<z.infer<typeof ExecutionMilestoneNameSchema>>([
  'access_window',
  'verified_hauler_identity',
  'service_hatch_unlock',
  'service_hatch_relock',
  'residential_hatch_guard',
])

export const ExecutionStatusSchema = z.enum(['scheduled', 'running', 'observed', 'failed'])

export const ExecutionSchema = z
  .object({
    schemaVersion: z.literal('execution@2').default('execution@2'),
    id: ExecutionIdSchema,
    organizationId: OrganizationIdSchema,
    missionId: MissionIdSchema,
    operationId: OperationIdSchema,
    routineId: RoutineIdSchema,
    routineVersionId: RoutineVersionIdSchema,
    programKind: z.enum(['night_shift_homecoming', 'scheduled_hauler_access']).optional(),
    status: ExecutionStatusSchema,
    triggeredByEvidenceId: EvidenceIdSchema,
    evidenceIds: z.array(EvidenceIdSchema),
    startedAt: IsoDateTimeSchema,
    deadline: IsoDateTimeSchema,
    milestones: z.array(ExecutionMilestoneSchema).length(5),
    updatedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((progress, context) => {
    const names = progress.milestones.map((milestone) => milestone.name)
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: 'custom',
        path: ['milestones'],
        message: 'Execution progress must contain each milestone exactly once',
      })
    }
    const requiredMilestones =
      progress.programKind === 'scheduled_hauler_access'
        ? HAULER_REQUIRED_MILESTONES
        : HOMECOMING_REQUIRED_MILESTONES
    for (const required of requiredMilestones) {
      if (!names.includes(required)) {
        context.addIssue({
          code: 'custom',
          path: ['milestones'],
          message: `Execution progress is missing the ${required} milestone`,
        })
      }
    }
    if (Date.parse(progress.deadline) < Date.parse(progress.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['deadline'],
        message: 'Execution deadline cannot precede its start',
      })
    }
    if (Date.parse(progress.updatedAt) < Date.parse(progress.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'Execution update cannot precede its start',
      })
    }
    const terminal = progress.status === 'observed' || progress.status === 'failed'
    if (terminal !== (progress.completedAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Only observed or failed executions carry a completion time',
      })
    }
    if (
      progress.completedAt !== null &&
      Date.parse(progress.completedAt) < Date.parse(progress.startedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Execution completion cannot precede its start',
      })
    }
    if (new Set(progress.evidenceIds).size !== progress.evidenceIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceIds'],
        message: 'Execution evidence IDs must be unique',
      })
    }
    if (!progress.evidenceIds.includes(progress.triggeredByEvidenceId)) {
      context.addIssue({
        code: 'custom',
        path: ['triggeredByEvidenceId'],
        message: 'Execution evidence must retain the evidence that triggered it',
      })
    }
    for (const [index, milestone] of progress.milestones.entries()) {
      if (
        milestone.resolvedAt &&
        Date.parse(milestone.resolvedAt) > Date.parse(progress.updatedAt)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['milestones', index, 'resolvedAt'],
          message: 'A milestone cannot resolve after the execution update',
        })
      }
      if (milestone.evidenceId !== null && !progress.evidenceIds.includes(milestone.evidenceId)) {
        context.addIssue({
          code: 'custom',
          path: ['milestones', index, 'evidenceId'],
          message: 'Resolved milestone evidence must be retained by the execution',
        })
      }
    }
    if (
      progress.status === 'observed' &&
      !progress.milestones.every((milestone) => milestone.status === 'completed')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'An observed execution requires all five milestones to complete',
      })
    }
    if (
      progress.status === 'failed' &&
      !progress.milestones.some((milestone) => milestone.status === 'failed') &&
      progress.completedAt !== null &&
      Date.parse(progress.completedAt) < Date.parse(progress.deadline)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Execution failure requires a known milestone failure or elapsed deadline',
      })
    }
  })

export const ExecutionProgressSchema = ExecutionSchema

export const ExecutionReadinessDecisionSchema = z.discriminatedUnion('ready', [
  z.object({ ready: z.literal(false), reason: z.literal('not_ready') }).strict(),
  z
    .object({
      ready: z.literal(true),
      reason: z.enum(['all_completed', 'known_failure', 'deadline_elapsed']),
    })
    .strict(),
])

export function classifyExecutionReadiness(
  progress: z.output<typeof ExecutionSchema>,
  evaluatedAt: z.infer<typeof IsoDateTimeSchema>,
): z.infer<typeof ExecutionReadinessDecisionSchema> {
  const parsedProgress = ExecutionSchema.parse(progress)
  const parsedEvaluatedAt = IsoDateTimeSchema.parse(evaluatedAt)

  if (parsedProgress.milestones.some((milestone) => milestone.status === 'failed')) {
    return { ready: true, reason: 'known_failure' }
  }
  if (parsedProgress.milestones.every((milestone) => milestone.status === 'completed')) {
    return { ready: true, reason: 'all_completed' }
  }
  if (Date.parse(parsedEvaluatedAt) >= Date.parse(parsedProgress.deadline)) {
    return { ready: true, reason: 'deadline_elapsed' }
  }
  return { ready: false, reason: 'not_ready' }
}

export type ExecutionMilestoneName = z.infer<typeof ExecutionMilestoneNameSchema>
export type ExecutionMilestoneFailure = z.infer<typeof ExecutionMilestoneFailureSchema>
export type ExecutionMilestone = z.output<typeof ExecutionMilestoneSchema>
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>
export type Execution = z.output<typeof ExecutionSchema>
export type ExecutionProgress = Execution
export type ExecutionReadinessDecision = z.infer<typeof ExecutionReadinessDecisionSchema>

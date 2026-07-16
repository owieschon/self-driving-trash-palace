import { z } from 'zod'

import {
  ContextReceiptIdSchema,
  IsoDateTimeSchema,
  MissionEventIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  RunIdSchema,
  UserIdSchema,
} from './identifiers.js'

export const MissionStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_for_user',
  'waiting_for_system',
  'succeeded',
  'failed',
  'cancelled',
])

export const MissionPhaseSchema = z.enum([
  'understand',
  'plan',
  'validate',
  'approve',
  'execute',
  'reconcile',
  'observe',
  'verify',
])

export const MissionProgramKindSchema = z.enum([
  'night_shift_homecoming',
  'scheduled_hauler_access',
])

export const MissionStateSchema = z
  .object({
    status: MissionStatusSchema,
    phase: MissionPhaseSchema,
  })
  .strict()
  .superRefine((state, ctx) => {
    const allowed =
      (state.status === 'queued' && state.phase === 'understand') ||
      (state.status === 'running' &&
        ['understand', 'plan', 'validate', 'execute', 'reconcile', 'verify'].includes(
          state.phase,
        )) ||
      (state.status === 'waiting_for_user' &&
        ['plan', 'approve', 'reconcile', 'verify'].includes(state.phase)) ||
      (state.status === 'waiting_for_system' && state.phase === 'observe') ||
      (state.status === 'succeeded' && state.phase === 'verify') ||
      (state.status === 'failed' &&
        ['execute', 'reconcile', 'observe', 'verify'].includes(state.phase)) ||
      state.status === 'cancelled'

    if (!allowed) {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid mission state ${state.status}/${state.phase}`,
      })
    }
  })

export const HomecomingMissionConstraintSchema = z
  .object({
    preheatBy: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    requireVerifiedIdentityForUnlock: z.literal(true),
    pathwayLightingBeginsAfter: z.literal('verified_arrival'),
    projectedBatteryUseMaxPercentagePoints: z.number().min(0).max(100),
  })
  .strict()

export const ScheduledHaulerAccessConstraintSchema = z
  .object({
    accessWindowStart: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    accessWindowEnd: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    authorizedIdentityTagId: z.string().regex(/^tag_[a-z0-9][a-z0-9_-]{7,63}$/),
    serviceHatchOnly: z.literal(true),
    residentialHatchMustRemainLocked: z.literal(true),
    finalServiceHatchState: z.literal('locked'),
  })
  .strict()
  .refine((constraints) => constraints.accessWindowStart !== constraints.accessWindowEnd, {
    path: ['accessWindowEnd'],
    message: 'Hauler access window must have distinct start and end times',
  })

export const MissionConstraintSchema = z.union([
  HomecomingMissionConstraintSchema,
  ScheduledHaulerAccessConstraintSchema,
])

export const TaskLedgerItemSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
    label: z.string().min(1).max(160),
    status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
    evidenceRefs: z.array(z.string().min(1)).default([]),
  })
  .strict()

export const MissionSchema = z
  .object({
    id: MissionIdSchema,
    organizationId: OrganizationIdSchema,
    palaceId: PalaceIdSchema,
    initiatedBy: UserIdSchema,
    programKind: MissionProgramKindSchema.optional(),
    objective: z.string().min(1).max(2_000),
    constraints: MissionConstraintSchema,
    successCriteriaIds: z.array(z.string().min(1)).min(1),
    state: MissionStateSchema,
    version: z.number().int().nonnegative(),
    runId: RunIdSchema.nullable(),
    contextReceiptId: ContextReceiptIdSchema.nullable(),
    taskLedger: z.array(TaskLedgerItemSchema).max(32),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((mission, ctx) => {
    const constraintKind = HomecomingMissionConstraintSchema.safeParse(mission.constraints).success
      ? 'night_shift_homecoming'
      : 'scheduled_hauler_access'
    if (mission.programKind !== undefined && mission.programKind !== constraintKind) {
      ctx.addIssue({
        code: 'custom',
        path: ['constraints'],
        message: `Mission constraints do not match program ${mission.programKind}`,
      })
    }
    if (new Set(mission.successCriteriaIds).size !== mission.successCriteriaIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['successCriteriaIds'],
        message: 'Success criterion IDs must be unique',
      })
    }
  })

export const MissionTransitionEventSchema = z.enum([
  'lease_acquired',
  'context_sufficient',
  'material_ambiguity',
  'clarification_answered',
  'user_response_expired',
  'candidate_persisted',
  'validation_failed',
  'validation_passed',
  'approval_rejected',
  'approval_expired_or_stale',
  'approval_granted',
  'execution_committed',
  'execution_unknown',
  'execution_non_retryable_failure',
  'reconcile_commit_found',
  'reconcile_absent_retryable',
  'reconcile_budget_exhausted',
  'reconcile_retry_authorized',
  'reconcile_stopped',
  'evidence_arrived',
  'observation_deadline_expired',
  'verification_passed',
  'safe_correction_available',
  'intervention_required',
  'corrective_work_requested',
  'terminal_result_acknowledged',
  'lease_lost',
  'cancel_requested',
  'cancel_reconciliation_required',
  'cancel_reconciliation_completed',
])

export type MissionStatus = z.infer<typeof MissionStatusSchema>
export type MissionPhase = z.infer<typeof MissionPhaseSchema>
export type MissionProgramKind = z.infer<typeof MissionProgramKindSchema>
export type HomecomingMissionConstraint = z.infer<typeof HomecomingMissionConstraintSchema>
export type ScheduledHaulerAccessConstraint = z.infer<typeof ScheduledHaulerAccessConstraintSchema>
export type MissionState = z.infer<typeof MissionStateSchema>
export type Mission = z.infer<typeof MissionSchema>
export type MissionTransitionEvent = z.infer<typeof MissionTransitionEventSchema>

export function missionProgramKindOf(mission: Pick<Mission, 'programKind' | 'constraints'>) {
  if (mission.programKind !== undefined) return mission.programKind
  return HomecomingMissionConstraintSchema.safeParse(mission.constraints).success
    ? ('night_shift_homecoming' as const)
    : ('scheduled_hauler_access' as const)
}

export type MissionTransition = Readonly<{
  from: MissionState
  event: MissionTransitionEvent
  to: MissionState
  hostAction: string
}>

function state(status: MissionStatus, phase: MissionPhase): MissionState {
  return MissionStateSchema.parse({ status, phase })
}

export const MISSION_TRANSITIONS: readonly MissionTransition[] = [
  {
    from: state('queued', 'understand'),
    event: 'lease_acquired',
    to: state('running', 'understand'),
    hostAction: 'create_run_and_context_receipt',
  },
  {
    from: state('running', 'understand'),
    event: 'context_sufficient',
    to: state('running', 'plan'),
    hostAction: 'persist_facts_and_task_ledger',
  },
  {
    from: state('running', 'plan'),
    event: 'material_ambiguity',
    to: state('waiting_for_user', 'plan'),
    hostAction: 'request_bounded_clarification',
  },
  {
    from: state('waiting_for_user', 'plan'),
    event: 'clarification_answered',
    to: state('running', 'plan'),
    hostAction: 'persist_answer_and_revise_plan',
  },
  {
    from: state('waiting_for_user', 'plan'),
    event: 'user_response_expired',
    to: state('cancelled', 'plan'),
    hostAction: 'record_user_response_expired',
  },
  {
    from: state('running', 'plan'),
    event: 'candidate_persisted',
    to: state('running', 'validate'),
    hostAction: 'freeze_plan_revision',
  },
  {
    from: state('running', 'validate'),
    event: 'validation_failed',
    to: state('running', 'plan'),
    hostAction: 'record_evidence_and_replan',
  },
  {
    from: state('running', 'validate'),
    event: 'validation_passed',
    to: state('waiting_for_user', 'approve'),
    hostAction: 'create_approval_request',
  },
  {
    from: state('waiting_for_user', 'approve'),
    event: 'approval_rejected',
    to: state('running', 'plan'),
    hostAction: 'invalidate_approval_request',
  },
  {
    from: state('waiting_for_user', 'approve'),
    event: 'approval_expired_or_stale',
    to: state('running', 'plan'),
    hostAction: 'revalidate_and_revise_plan',
  },
  {
    from: state('waiting_for_user', 'approve'),
    event: 'approval_granted',
    to: state('running', 'execute'),
    hostAction: 'materialize_logical_operations',
  },
  {
    from: state('running', 'execute'),
    event: 'approval_expired_or_stale',
    to: state('running', 'plan'),
    hostAction: 'invalidate_operation_and_revise_plan',
  },
  {
    from: state('running', 'execute'),
    event: 'execution_committed',
    to: state('waiting_for_system', 'observe'),
    hostAction: 'await_external_evidence',
  },
  {
    from: state('running', 'execute'),
    event: 'execution_unknown',
    to: state('running', 'reconcile'),
    hostAction: 'preserve_logical_operation',
  },
  {
    from: state('running', 'execute'),
    event: 'execution_non_retryable_failure',
    to: state('failed', 'execute'),
    hostAction: 'persist_terminal_receipt',
  },
  {
    from: state('running', 'reconcile'),
    event: 'reconcile_commit_found',
    to: state('waiting_for_system', 'observe'),
    hostAction: 'return_original_operation_outcome',
  },
  {
    from: state('running', 'reconcile'),
    event: 'reconcile_absent_retryable',
    to: state('running', 'execute'),
    hostAction: 'retry_same_logical_operation',
  },
  {
    from: state('running', 'reconcile'),
    event: 'reconcile_budget_exhausted',
    to: state('waiting_for_user', 'reconcile'),
    hostAction: 'present_evidence_and_safest_action',
  },
  {
    from: state('waiting_for_user', 'reconcile'),
    event: 'reconcile_retry_authorized',
    to: state('running', 'execute'),
    hostAction: 'retry_existing_logical_operation',
  },
  {
    from: state('waiting_for_user', 'reconcile'),
    event: 'reconcile_stopped',
    to: state('cancelled', 'reconcile'),
    hostAction: 'stop_remaining_actions',
  },
  {
    from: state('waiting_for_system', 'observe'),
    event: 'evidence_arrived',
    to: state('running', 'verify'),
    hostAction: 'run_deterministic_assertions',
  },
  {
    from: state('waiting_for_system', 'observe'),
    event: 'observation_deadline_expired',
    to: state('running', 'verify'),
    hostAction: 'verify_failure_evidence',
  },
  {
    from: state('running', 'verify'),
    event: 'verification_passed',
    to: state('succeeded', 'verify'),
    hostAction: 'freeze_verifier_receipt',
  },
  {
    from: state('running', 'verify'),
    event: 'safe_correction_available',
    to: state('running', 'plan'),
    hostAction: 'propose_new_revision',
  },
  {
    from: state('running', 'verify'),
    event: 'intervention_required',
    to: state('waiting_for_user', 'verify'),
    hostAction: 'present_failed_assertions',
  },
  {
    from: state('waiting_for_user', 'verify'),
    event: 'corrective_work_requested',
    to: state('running', 'plan'),
    hostAction: 'create_new_plan_revision',
  },
  {
    from: state('waiting_for_user', 'verify'),
    event: 'terminal_result_acknowledged',
    to: state('failed', 'verify'),
    hostAction: 'freeze_failed_verifier_receipt',
  },
  {
    from: state('running', 'execute'),
    event: 'cancel_reconciliation_required',
    to: state('running', 'reconcile'),
    hostAction: 'stop_remaining_actions_and_reconcile_effect',
  },
  {
    from: state('running', 'reconcile'),
    event: 'cancel_reconciliation_required',
    to: state('running', 'reconcile'),
    hostAction: 'continue_reconciling_cancelled_effect',
  },
  {
    from: state('waiting_for_system', 'observe'),
    event: 'cancel_reconciliation_required',
    to: state('running', 'reconcile'),
    hostAction: 'stop_remaining_actions_and_reconcile_effect',
  },
  {
    from: state('running', 'reconcile'),
    event: 'cancel_reconciliation_completed',
    to: state('cancelled', 'reconcile'),
    hostAction: 'freeze_reconciled_cancellation_receipt',
  },
] as const

function equalState(left: MissionState, right: MissionState): boolean {
  return left.status === right.status && left.phase === right.phase
}

export class InvalidMissionTransitionError extends Error {
  override readonly name = 'InvalidMissionTransitionError'
}

export function isTerminalMissionState(value: MissionState): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(value.status)
}

export function resolveMissionTransition(
  currentInput: MissionState,
  eventInput: MissionTransitionEvent,
): MissionState {
  const current = MissionStateSchema.parse(currentInput)
  const event = MissionTransitionEventSchema.parse(eventInput)

  if (isTerminalMissionState(current)) {
    throw new InvalidMissionTransitionError(
      `Terminal mission state ${current.status}/${current.phase} is immutable`,
    )
  }

  if (event === 'lease_lost') return current
  if (event === 'cancel_requested') return state('cancelled', current.phase)

  const transition = MISSION_TRANSITIONS.find(
    (candidate) => equalState(candidate.from, current) && candidate.event === event,
  )
  if (!transition) {
    throw new InvalidMissionTransitionError(
      `Event ${event} is not valid from ${current.status}/${current.phase}`,
    )
  }
  return transition.to
}

export const MissionEventSchema = z
  .object({
    id: MissionEventIdSchema,
    missionId: MissionIdSchema,
    organizationId: OrganizationIdSchema,
    sequence: z.number().int().nonnegative(),
    event: MissionTransitionEventSchema,
    from: MissionStateSchema,
    to: MissionStateSchema,
    occurredAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((missionEvent, ctx) => {
    let expected: MissionState
    try {
      expected = resolveMissionTransition(missionEvent.from, missionEvent.event)
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['event'], message: String(error) })
      return
    }
    if (!equalState(expected, missionEvent.to)) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `Expected ${expected.status}/${expected.phase}`,
      })
    }
  })

export type MissionEvent = z.infer<typeof MissionEventSchema>

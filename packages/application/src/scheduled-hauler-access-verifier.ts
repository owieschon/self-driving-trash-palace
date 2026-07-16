import {
  ApprovalSchema,
  MissionSchema,
  OperationSchema,
  PersistedEvidenceRecordSchema,
  PlanSchema,
  ScheduledHaulerAccessConstraintSchema,
  VerificationAssertionSchema,
  deriveGatewayCommandId,
  type Evidence,
  type PersistedEvidenceRecord,
  type VerificationAssertion,
  type VerificationPredicate,
} from '@trash-palace/core'

import { ConflictError } from './errors.js'
import { HAULER_LOGICAL_KEYS } from './scheduled-hauler-access-execution-planner.js'
import type { DeterministicVerifierPort } from './ports.js'

export const HAULER_VERIFICATION_CRITERIA = [
  'no_unverified_hauler_unlock',
  'one_active_approved_hauler_routine',
  'prior_hauler_routine_inactive',
  'hauler_routine_matches_approved_plan',
  'verified_hauler_inside_window',
  'service_hatch_only',
  'service_hatch_locked_after_access',
  'tenant_boundary_preserved',
] as const

export class ScheduledHaulerAccessDeterministicVerifier implements DeterministicVerifierPort {
  public evaluate(
    input: Parameters<DeterministicVerifierPort['evaluate']>[0],
  ): Promise<readonly VerificationAssertion[]> {
    const mission = MissionSchema.parse(input.mission)
    const plan = PlanSchema.parse(input.plan)
    const approval = ApprovalSchema.parse(input.approval)
    const operations = input.operations.map((operation) => OperationSchema.parse(operation))
    const records = input.evidence.map((record) => PersistedEvidenceRecordSchema.parse(record))
    const constraints = ScheduledHaulerAccessConstraintSchema.parse(mission.constraints)
    const action = plan.actions[0]
    if (
      mission.programKind !== 'scheduled_hauler_access' ||
      plan.actions.length !== 1 ||
      action?.type !== 'replace_scheduled_hauler_access_routine'
    ) {
      throw new ConflictError('Hauler verification requires one matching program action')
    }
    if (
      plan.missionId !== mission.id ||
      approval.planId !== plan.id ||
      approval.planHash !== plan.hash ||
      approval.status !== 'approved'
    ) {
      throw new ConflictError('Hauler verification approval chain is not exact')
    }
    const operation = operations[0]
    if (
      operations.length !== 1 ||
      operation?.status !== 'committed' ||
      operation.outcome?.routineId !== action.replacementRoutineId ||
      operation.outcome.routineVersionId !== action.replacementRoutineVersionId ||
      operation.outcome.deactivatedRoutineId !== action.protectedRoutineId
    ) {
      throw new ConflictError('Hauler verification requires one committed bound operation')
    }

    const scoped = records.filter(
      (record) =>
        record.evidence.organizationId === mission.organizationId &&
        record.evidence.missionId === mission.id &&
        record.evidence.palaceId === mission.palaceId,
    )
    const evidence = scoped.map((record) => record.evidence)
    const fallback = evidence[0]
    if (fallback === undefined) throw new ConflictError('Hauler verification requires evidence')
    const identity = evidence
      .filter(
        (item): item is Extract<Evidence, { type: 'identity_arrival' }> =>
          item.type === 'identity_arrival',
      )
      .find(
        (item) =>
          item.verified &&
          item.identityTagId === constraints.authorizedIdentityTagId &&
          withinWindow(
            item.observedAt,
            action.replacement.trigger.timezone,
            constraints.accessWindowStart,
            constraints.accessWindowEnd,
          ),
      )
    const unverified = evidence.find(
      (item): item is Extract<Evidence, { type: 'identity_arrival' }> =>
        item.type === 'identity_arrival' && !item.verified,
    )
    const deviceCommands = scoped.filter(
      (
        record,
      ): record is PersistedEvidenceRecord & {
        evidence: Extract<Evidence, { type: 'device_command' }>
      } => record.evidence.type === 'device_command',
    )
    const expectedUnlockCommandId = deriveGatewayCommandId(operation.id, HAULER_LOGICAL_KEYS.unlock)
    const expectedRelockCommandId = deriveGatewayCommandId(operation.id, HAULER_LOGICAL_KEYS.relock)
    const unlock = deviceCommands.find(
      (record) =>
        record.evidence.command === 'unlock' &&
        record.evidence.causedByEvidenceId === identity?.id &&
        record.authorityReceipt.authority === 'gateway_callback' &&
        record.authorityReceipt.commandId === expectedUnlockCommandId,
    )
    const relock = deviceCommands.find(
      (record) =>
        record.evidence.command === 'locked_desired_state' &&
        record.authorityReceipt.authority === 'gateway_callback' &&
        record.authorityReceipt.commandId === expectedRelockCommandId,
    )
    const foreignUnlock = deviceCommands.find(
      (record) =>
        record.evidence.command === 'unlock' &&
        (record.authorityReceipt.authority !== 'gateway_callback' ||
          record.authorityReceipt.commandId !== expectedUnlockCommandId),
    )
    const activeState = evidence.find(
      (item) =>
        item.type === 'routine_state' &&
        item.routineId === action.replacementRoutineId &&
        item.active &&
        item.planId === plan.id &&
        item.planHash === plan.hash,
    )
    const inactiveState = evidence.find(
      (item) =>
        item.type === 'routine_state' &&
        item.routineId === action.protectedRoutineId &&
        !item.active,
    )
    const tenantAudit = evidence.find(
      (item) =>
        item.type === 'tenant_access_audit' &&
        item.attemptedOrganizationId === mission.organizationId &&
        item.allowed,
    )
    const unlockInsideWindow =
      unlock !== undefined &&
      withinWindow(
        unlock.evidence.observedAt,
        action.replacement.trigger.timezone,
        constraints.accessWindowStart,
        constraints.accessWindowEnd,
      )
    const relocked =
      unlock !== undefined &&
      relock !== undefined &&
      unlock.evidence.deviceId === relock.evidence.deviceId &&
      Date.parse(relock.evidence.observedAt) >= Date.parse(unlock.evidence.observedAt)

    const assertion = (
      predicate: VerificationPredicate,
      passed: boolean,
      supporting: readonly (Evidence | undefined)[],
      message: string,
    ) =>
      VerificationAssertionSchema.parse({
        predicate,
        passed,
        evidenceIds: supporting.filter((item): item is Evidence => item !== undefined).length
          ? supporting.filter((item): item is Evidence => item !== undefined).map((item) => item.id)
          : [fallback.id],
        message,
      })

    return Promise.resolve([
      assertion(
        {
          id: HAULER_VERIFICATION_CRITERIA[0],
          type: 'no_unlock_for_unverified_identity',
          unverifiedArrivalEvidenceId: unverified?.id ?? fallback.id,
        },
        unverified !== undefined && foreignUnlock === undefined,
        [unverified, foreignUnlock?.evidence],
        'No unverified or non-service-hatch unlock was accepted.',
      ),
      assertion(
        {
          id: HAULER_VERIFICATION_CRITERIA[1],
          type: 'active_routine_count',
          planId: plan.id,
          expected: 1,
        },
        activeState !== undefined,
        [activeState],
        'Exactly one approved hauler routine is active.',
      ),
      assertion(
        {
          id: HAULER_VERIFICATION_CRITERIA[2],
          type: 'routine_inactive',
          routineId: action.protectedRoutineId,
        },
        inactiveState !== undefined,
        [inactiveState],
        'The prior hauler routine is inactive.',
      ),
      assertion(
        {
          id: HAULER_VERIFICATION_CRITERIA[3],
          type: 'routine_matches_plan',
          routineId: action.replacementRoutineId,
          planId: plan.id,
          planHash: plan.hash,
        },
        activeState !== undefined,
        [activeState],
        'The active hauler routine matches the approved plan.',
      ),
      assertion(
        {
          id: HAULER_VERIFICATION_CRITERIA[4],
          type: 'unlock_after_arrival_within',
          arrivalEvidenceId: identity?.id ?? fallback.id,
          maximumDelaySeconds: 5,
        },
        identity !== undefined && unlockInsideWindow,
        [identity, unlock?.evidence],
        'Verified hauler identity caused access inside the approved window.',
      ),
      assertion(
        {
          id: HAULER_VERIFICATION_CRITERIA[5],
          type: 'no_cross_tenant_access',
          organizationId: mission.organizationId,
        },
        foreignUnlock === undefined,
        [tenantAudit, foreignUnlock?.evidence],
        'No command escaped the approved service-hatch operation.',
      ),
      assertion(
        {
          id: HAULER_VERIFICATION_CRITERIA[6],
          type: 'lock_after_unlock_elapsed',
          expectedSeconds: action.replacement.actions[0].durationSeconds,
          toleranceSeconds: 5,
        },
        relocked,
        [unlock?.evidence, relock?.evidence],
        'The service hatch returned to locked state after access.',
      ),
      assertion(
        {
          id: HAULER_VERIFICATION_CRITERIA[7],
          type: 'no_cross_tenant_access',
          organizationId: mission.organizationId,
        },
        scoped.length === records.length && tenantAudit !== undefined,
        [tenantAudit],
        'Evidence remains tenant-bound.',
      ),
    ])
  }
}

function withinWindow(
  observedAt: string,
  timezone: string,
  startValue: string,
  endValue: string,
): boolean {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(observedAt))
      .filter((part) => part.type === 'hour' || part.type === 'minute')
      .map((part) => [part.type, Number(part.value)]),
  )
  const current = (values.hour ?? -1) * 60 + (values.minute ?? -1)
  const start = toMinutes(startValue)
  const end = toMinutes(endValue)
  return start < end ? current >= start && current < end : current >= start || current < end
}

function toMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number)
  return (hour ?? 0) * 60 + (minute ?? 0)
}

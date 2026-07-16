import type { Device, PersistedEvidenceRecord, PlanAction } from '@trash-palace/core'

import { ConflictError } from './errors.js'
import { nextLocalTime } from './homecoming-execution-planner.js'
import type { PlannedGatewayEffect } from './models.js'
import { PlannedGatewayEffectSchema } from './models.js'
import type { CapabilityReadProjection, ExecutionPlannerPort } from './ports.js'

export const HAULER_LOGICAL_KEYS = {
  unlock: 'hauler.service-hatch-unlock',
  relock: 'hauler.service-hatch-relock',
} as const

const VERIFICATION_TOLERANCE_MILLISECONDS = 5 * 60 * 1_000

export class ScheduledHaulerAccessExecutionPlanner implements ExecutionPlannerPort {
  public async planActivation(
    input: Parameters<ExecutionPlannerPort['planActivation']>[0],
  ): Promise<readonly PlannedGatewayEffect[]> {
    const action = requireHaulerAction(input.action)
    assertActivationTrigger(input.trigger, input.operation, input.plan, action)
    return []
  }

  public async planEvidence(
    input: Parameters<ExecutionPlannerPort['planEvidence']>[0],
  ): Promise<readonly PlannedGatewayEffect[]> {
    const action = requireHaulerAction(input.action)
    const record = input.evidence
    if (
      record.authorityReceipt.authority !== 'identity_telemetry' ||
      record.evidence.type !== 'identity_arrival' ||
      !record.evidence.verified ||
      record.evidence.identityTagId !== action.replacement.trigger.authorizedIdentityTagId ||
      !withinLocalWindow(
        record.evidence.observedAt,
        action.replacement.trigger.timezone,
        action.replacement.trigger.windowStart,
        action.replacement.trigger.windowEnd,
      )
    ) {
      return []
    }

    const lock = requireServiceHatch(input.capabilities)
    const grant = action.replacement.actions[0]
    const windowEnd = windowEndFor(
      record.evidence.observedAt,
      action.replacement.trigger.timezone,
      action.replacement.trigger.windowEnd,
    )
    const durationEnd = new Date(
      Date.parse(record.evidence.observedAt) + grant.durationSeconds * 1_000,
    ).toISOString()
    const relockAt = Date.parse(durationEnd) < Date.parse(windowEnd) ? durationEnd : windowEnd

    return [
      PlannedGatewayEffectSchema.parse({
        logicalKey: HAULER_LOGICAL_KEYS.unlock,
        milestone: 'service_hatch_unlock',
        cancellationPolicy: 'cancel_if_pending',
        kind: 'unlock',
        payload: {
          deviceId: lock.id,
          identityTagId: record.evidence.identityTagId,
          durationSeconds: Math.max(
            1,
            Math.floor((Date.parse(relockAt) - Date.parse(record.evidence.observedAt)) / 1_000),
          ),
          causedByEvidenceId: record.evidence.id,
        },
        dispatchAt: record.evidence.observedAt,
      }),
      PlannedGatewayEffectSchema.parse({
        logicalKey: HAULER_LOGICAL_KEYS.relock,
        milestone: 'service_hatch_relock',
        cancellationPolicy: 'mandatory_relock',
        kind: 'locked_desired_state',
        payload: {
          deviceId: lock.id,
          causedByEvidenceId: record.evidence.id,
        },
        dispatchAt: relockAt,
      }),
    ]
  }
}

export function haulerExecutionDeadline(activationAt: string, action: PlanAction): string {
  const hauler = requireHaulerAction(action)
  return new Date(
    Date.parse(
      windowEndFor(
        activationAt,
        hauler.replacement.trigger.timezone,
        hauler.replacement.trigger.windowEnd,
      ),
    ) + VERIFICATION_TOLERANCE_MILLISECONDS,
  ).toISOString()
}

function requireHaulerAction(
  action: PlanAction,
): Extract<PlanAction, { type: 'replace_scheduled_hauler_access_routine' }> {
  if (action.type !== 'replace_scheduled_hauler_access_routine') {
    throw new ConflictError('Execution planner requires a scheduled hauler access replacement')
  }
  return action
}

function assertActivationTrigger(
  record: PersistedEvidenceRecord,
  operation: Parameters<ExecutionPlannerPort['planActivation']>[0]['operation'],
  plan: Parameters<ExecutionPlannerPort['planActivation']>[0]['plan'],
  action: Extract<PlanAction, { type: 'replace_scheduled_hauler_access_routine' }>,
): void {
  if (
    record.authorityReceipt.authority !== 'application' ||
    record.authorityReceipt.ruleId !== 'routine.activation.commit' ||
    record.evidence.type !== 'routine_state' ||
    !record.evidence.active ||
    record.evidence.routineId !== operation.outcome?.routineId ||
    record.evidence.routineVersionId !== operation.outcome.routineVersionId ||
    record.evidence.routineId !== action.replacementRoutineId ||
    record.evidence.routineVersionId !== action.replacementRoutineVersionId ||
    record.evidence.planId !== plan.id ||
    record.evidence.planHash !== plan.hash
  ) {
    throw new ConflictError('Activation trigger is not authoritative hauler routine evidence')
  }
}

function requireServiceHatch(projection: CapabilityReadProjection): Device {
  const devices = new Map(projection.devices.map((device) => [device.id, device]))
  const candidates = projection.capabilities
    .filter((capability) => capability.enabled && capability.kind === 'service_hatch_access')
    .map((capability) => devices.get(capability.deviceId))
    .filter(
      (device): device is Device =>
        device?.kind === 'service_hatch_lock' && device.health === 'online',
    )
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new ConflictError('Expected exactly one online service-hatch lock')
  }
  return candidates[0]
}

function withinLocalWindow(
  observedAt: string,
  timezone: string,
  windowStart: string,
  windowEnd: string,
): boolean {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(observedAt))
      .filter((part) => part.type === 'hour' || part.type === 'minute')
      .map((part) => [part.type, Number(part.value)]),
  )
  const minute = (parts.hour ?? -1) * 60 + (parts.minute ?? -1)
  const start = minutes(windowStart)
  const end = minutes(windowEnd)
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

function windowEndFor(observedAt: string, timezone: string, windowEnd: string): string {
  const next = nextLocalTime(observedAt, timezone, windowEnd)
  if (Date.parse(next) > Date.parse(observedAt)) return next
  return nextLocalTime(new Date(Date.parse(observedAt) + 1_000).toISOString(), timezone, windowEnd)
}

function minutes(value: string): number {
  const [hours, minutesPart] = value.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutesPart ?? 0)
}

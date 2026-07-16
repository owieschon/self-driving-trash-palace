import type { Device, PersistedEvidenceRecord, PlanAction } from '@trash-palace/core'
import { deriveGatewayCommandId } from '@trash-palace/core'

import { ConflictError } from './errors.js'
import type { PlannedGatewayEffect } from './models.js'
import { PlannedGatewayEffectSchema } from './models.js'
import type { CapabilityReadProjection, ExecutionPlannerPort } from './ports.js'

export const HOMECOMING_LOGICAL_KEYS = {
  preheat: 'homecoming.preheat',
  pathwayLighting: 'homecoming.pathway-lighting',
  unlock: 'homecoming.unlock',
  relock: 'homecoming.relock',
} as const

const VERIFICATION_TOLERANCE_MILLISECONDS = 5 * 60 * 1_000

export class HomecomingExecutionPlanner implements ExecutionPlannerPort {
  public async planActivation(
    input: Parameters<ExecutionPlannerPort['planActivation']>[0],
  ): Promise<readonly PlannedGatewayEffect[]> {
    const action = requireHomecomingAction(input.action)
    assertActivationTrigger(input.trigger, input.operation, input.plan, action)
    const preheat = action.replacement.actions.find((candidate) => candidate.type === 'preheat')
    if (preheat === undefined) throw new ConflictError('Homecoming routine has no preheat action')
    const thermostat = requireDevice(input.capabilities, 'temperature_target', 'thermostat')
    const completeAt = nextLocalTime(
      input.at,
      action.replacement.trigger.timezone,
      preheat.completeBy,
    )
    return [
      PlannedGatewayEffectSchema.parse({
        logicalKey: HOMECOMING_LOGICAL_KEYS.preheat,
        milestone: 'preheat',
        cancellationPolicy: 'cancel_if_pending',
        kind: 'set_temperature',
        payload: {
          deviceId: thermostat.id,
          targetCelsius: preheat.targetCelsius,
          completeAt,
          causedByEvidenceId: null,
        },
        dispatchAt: input.at,
      }),
    ]
  }

  public async planEvidence(
    input: Parameters<ExecutionPlannerPort['planEvidence']>[0],
  ): Promise<readonly PlannedGatewayEffect[]> {
    const action = requireHomecomingAction(input.action)
    const evidence = input.evidence.evidence
    if (
      input.evidence.authorityReceipt.authority === 'identity_telemetry' &&
      evidence.type === 'identity_arrival'
    ) {
      if (!evidence.verified) return []
      const lighting = action.replacement.actions.find(
        (candidate) => candidate.type === 'pathway_lighting',
      )
      const unlock = action.replacement.actions.find((candidate) => candidate.type === 'unlock')
      if (lighting === undefined || unlock === undefined) {
        throw new ConflictError('Homecoming routine is missing arrival actions')
      }
      const pathwayLight = requireDevice(input.capabilities, 'pathway_lighting', 'pathway_light')
      const lock = requireDevice(input.capabilities, 'lock_desired_state', 'lock')
      return [
        PlannedGatewayEffectSchema.parse({
          logicalKey: HOMECOMING_LOGICAL_KEYS.pathwayLighting,
          milestone: 'pathway_lighting',
          cancellationPolicy: 'cancel_if_pending',
          kind: 'set_lighting',
          payload: {
            deviceId: pathwayLight.id,
            intensityPercent: lighting.intensityPercent,
            durationSeconds: lighting.durationSeconds,
            causedByEvidenceId: evidence.id,
          },
          dispatchAt: input.at,
        }),
        PlannedGatewayEffectSchema.parse({
          logicalKey: HOMECOMING_LOGICAL_KEYS.unlock,
          milestone: 'unlock',
          cancellationPolicy: 'cancel_if_pending',
          kind: 'unlock',
          payload: {
            deviceId: lock.id,
            identityTagId: evidence.identityTagId,
            durationSeconds: unlock.durationSeconds,
            causedByEvidenceId: evidence.id,
          },
          dispatchAt: input.at,
        }),
      ]
    }

    if (
      input.evidence.authorityReceipt.authority === 'gateway_callback' &&
      input.evidence.authorityReceipt.commandId ===
        deriveGatewayCommandId(input.operation.id, HOMECOMING_LOGICAL_KEYS.unlock) &&
      evidence.type === 'device_command' &&
      evidence.command === 'unlock'
    ) {
      const relock = action.replacement.actions.find(
        (candidate) => candidate.type === 'lock_desired_state',
      )
      if (relock === undefined) throw new ConflictError('Homecoming routine has no relock action')
      const lock = requireDevice(input.capabilities, 'lock_desired_state', 'lock')
      return [
        PlannedGatewayEffectSchema.parse({
          logicalKey: HOMECOMING_LOGICAL_KEYS.relock,
          milestone: 'relock',
          cancellationPolicy: 'mandatory_relock',
          kind: 'locked_desired_state',
          payload: {
            deviceId: lock.id,
            causedByEvidenceId: evidence.id,
          },
          dispatchAt: new Date(
            Date.parse(evidence.observedAt) + relock.afterUnlockSeconds * 1_000,
          ).toISOString(),
        }),
      ]
    }

    return []
  }
}

export function homecomingExecutionDeadline(activationAt: string, action: PlanAction): string {
  const homecoming = requireHomecomingAction(action)
  const preheat = homecoming.replacement.actions.find((candidate) => candidate.type === 'preheat')
  const relock = homecoming.replacement.actions.find(
    (candidate) => candidate.type === 'lock_desired_state',
  )
  if (preheat === undefined) throw new ConflictError('Homecoming routine has no preheat action')
  if (relock === undefined) throw new ConflictError('Homecoming routine has no relock action')
  const preheatDeadline = Date.parse(
    nextLocalTime(activationAt, homecoming.replacement.trigger.timezone, preheat.completeBy),
  )
  const arrivalWindowDeadline =
    Date.parse(
      nextLocalTime(
        activationAt,
        homecoming.replacement.trigger.timezone,
        homecoming.replacement.trigger.windowEnd,
      ),
    ) +
    relock.afterUnlockSeconds * 1_000
  return new Date(
    Math.max(preheatDeadline, arrivalWindowDeadline) + VERIFICATION_TOLERANCE_MILLISECONDS,
  ).toISOString()
}

function requireHomecomingAction(
  action: PlanAction,
): Extract<PlanAction, { type: 'replace_homecoming_routine' }> {
  if (action.type !== 'replace_homecoming_routine') {
    throw new ConflictError('Execution planner requires a homecoming routine replacement')
  }
  return action
}

function assertActivationTrigger(
  record: PersistedEvidenceRecord,
  operation: Parameters<ExecutionPlannerPort['planActivation']>[0]['operation'],
  plan: Parameters<ExecutionPlannerPort['planActivation']>[0]['plan'],
  action: Extract<PlanAction, { type: 'replace_homecoming_routine' }>,
): void {
  if (
    record.authorityReceipt.authority !== 'application' ||
    record.authorityReceipt.ruleId !== 'routine.activation.commit' ||
    record.authorityReceipt.ruleVersion !== 1 ||
    record.evidence.type !== 'routine_state' ||
    !record.evidence.active ||
    record.evidence.routineId !== operation.outcome?.routineId ||
    record.evidence.routineVersionId !== operation.outcome.routineVersionId ||
    record.evidence.routineId !== action.replacementRoutineId ||
    record.evidence.routineVersionId !== action.replacementRoutineVersionId ||
    record.evidence.planId !== plan.id ||
    record.evidence.planHash !== plan.hash
  ) {
    throw new ConflictError('Activation trigger is not authoritative routine-state evidence')
  }
}

function requireDevice(
  projection: CapabilityReadProjection,
  capabilityKind: CapabilityReadProjection['capabilities'][number]['kind'],
  deviceKind: Device['kind'],
): Device {
  const devices = new Map(projection.devices.map((device) => [device.id, device]))
  const candidates = projection.capabilities
    .filter((capability) => capability.enabled && capability.kind === capabilityKind)
    .map((capability) => devices.get(capability.deviceId))
    .filter(
      (device): device is Device =>
        device !== undefined && device.kind === deviceKind && device.health === 'online',
    )
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new ConflictError(
      `Expected exactly one online ${deviceKind} with ${capabilityKind} capability`,
    )
  }
  return candidates[0]
}

/**
 * Resolves the next exact wall-clock occurrence. Missing DST times fail closed; repeated times
 * choose the earliest matching instant that is not earlier than the reference.
 */
export function nextLocalTime(referenceIso: string, timeZone: string, timeOfDay: string): string {
  const reference = new Date(referenceIso)
  if (!Number.isFinite(reference.getTime())) throw new ConflictError('Activation time is invalid')
  const timeMatch = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(timeOfDay)
  if (timeMatch === null) throw new ConflictError('Scheduled local time is invalid')
  const hour = Number(timeOfDay.slice(0, 2))
  const minute = Number(timeOfDay.slice(3, 5))
  const referenceParts = zonedParts(reference, timeZone)
  let desiredDay = Date.UTC(referenceParts.year, referenceParts.month - 1, referenceParts.day)
  const currentDayCandidates = resolveZonedInstants(desiredDay, hour, minute, timeZone)
  const currentDayResult = currentDayCandidates.find(
    (candidate) => candidate.getTime() >= reference.getTime(),
  )
  if (currentDayResult !== undefined) return currentDayResult.toISOString()

  const targetMinute = hour * 60 + minute
  const referenceMinute = referenceParts.hour * 60 + referenceParts.minute
  if (currentDayCandidates.length === 0 && targetMinute >= referenceMinute) {
    throw new ConflictError(
      `Scheduled local time ${timeOfDay} does not exist in ${timeZone} on this date`,
    )
  }

  desiredDay += 24 * 60 * 60 * 1_000
  const nextDayCandidates = resolveZonedInstants(desiredDay, hour, minute, timeZone)
  if (nextDayCandidates[0] === undefined) {
    throw new ConflictError(
      `Scheduled local time ${timeOfDay} does not exist in ${timeZone} on the next date`,
    )
  }
  return nextDayCandidates[0].toISOString()
}

function resolveZonedInstants(
  desiredDayUtc: number,
  hour: number,
  minute: number,
  timeZone: string,
): readonly Date[] {
  const desired = new Date(desiredDayUtc)
  const targetAsUtc = Date.UTC(
    desired.getUTCFullYear(),
    desired.getUTCMonth(),
    desired.getUTCDate(),
    hour,
    minute,
  )
  const offsets = new Set<number>()
  for (let hourOffset = -36; hourOffset <= 36; hourOffset += 1) {
    const sampleTime = targetAsUtc + hourOffset * 60 * 60 * 1_000
    const parts = zonedParts(new Date(sampleTime), timeZone)
    const renderedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
    offsets.add(renderedAsUtc - sampleTime)
  }
  const matches = new Map<number, Date>()
  for (const offset of offsets) {
    const candidate = new Date(targetAsUtc - offset)
    const parts = zonedParts(candidate, timeZone)
    if (
      parts.year === desired.getUTCFullYear() &&
      parts.month === desired.getUTCMonth() + 1 &&
      parts.day === desired.getUTCDate() &&
      parts.hour === hour &&
      parts.minute === minute
    ) {
      matches.set(candidate.getTime(), candidate)
    }
  }
  return [...matches.values()].sort((left, right) => left.getTime() - right.getTime())
}

function zonedParts(
  value: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(value)
  } catch {
    throw new ConflictError(`Timezone ${timeZone} is not supported`)
  }
  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((candidate) => candidate.type === type)?.value
    if (found === undefined) throw new ConflictError(`Could not resolve ${type} in ${timeZone}`)
    return Number(found)
  }
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
  }
}

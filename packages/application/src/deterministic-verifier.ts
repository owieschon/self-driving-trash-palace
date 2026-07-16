import {
  ApprovalSchema,
  ContextReceiptSchema,
  ExecutionSchema,
  HomecomingMissionConstraintSchema,
  MissionSchema,
  OperationSchema,
  PersistedEvidenceRecordSchema,
  PlanSchema,
  VerificationAssertionSchema,
  VerificationPredicateSchema,
  type Approval,
  type ContextReceipt,
  type Evidence,
  type Mission,
  type Operation,
  type PersistedEvidenceRecord,
  type Plan,
  type VerificationAssertion,
  type VerificationPredicate,
} from '@trash-palace/core'

import { ConflictError } from './errors.js'
import { ACTIVATION_APPLICATION_EVIDENCE_RULES } from './execution-materialization-service.js'
import { nextLocalTime } from './homecoming-execution-planner.js'
import type { StoredExecution } from './models.js'
import type { DeterministicVerifierPort } from './ports.js'
import { hashCanonical } from './primitives.js'

export const HOMECOMING_VERIFICATION_CRITERIA = [
  'no_unverified_unlock',
  'one_active_approved_routine',
  'midnight_entry_inactive',
  'routine_matches_approved_plan',
  'temperature_ready_by_two',
  'lighting_follows_verified_arrival',
  'unlock_follows_verified_arrival',
  'locked_state_after_ninety_seconds',
  'battery_projection_within_bound',
  'tenant_boundary_preserved',
] as const

const MAXIMUM_ARRIVAL_COMMAND_DELAY_SECONDS = 5
const RELOCK_TOLERANCE_SECONDS = 5
const TEMPERATURE_TOLERANCE_CELSIUS = 0.5

export interface HomecomingVerificationTimingPolicy {
  readonly maximumArrivalCommandDelaySeconds: number
  readonly relockToleranceSeconds: number
}

export const PRODUCTION_HOMECOMING_VERIFICATION_TIMING = Object.freeze({
  maximumArrivalCommandDelaySeconds: MAXIMUM_ARRIVAL_COMMAND_DELAY_SECONDS,
  relockToleranceSeconds: RELOCK_TOLERANCE_SECONDS,
}) satisfies HomecomingVerificationTimingPolicy

export interface ApprovedVerificationMaterial {
  readonly mission: Mission
  readonly plan: Plan
  readonly approval: Approval
  readonly operations: readonly Operation[]
  readonly contextReceipt: ContextReceipt
  readonly executions: readonly StoredExecution[]
  readonly evidence: readonly PersistedEvidenceRecord[]
}

interface CompiledMaterial {
  readonly predicates: readonly VerificationPredicate[]
  readonly evidence: readonly Evidence[]
  readonly scope: Pick<Mission, 'id' | 'organizationId' | 'palaceId'>
  readonly bindings: VerificationEvidenceBindings
}

interface VerificationEvidenceBindings {
  readonly activeRoutine: Evidence['id'] | undefined
  readonly protectedRoutineInactive: Evidence['id'] | undefined
  readonly batteryProjection: Evidence['id'] | undefined
  readonly tenantAudit: Evidence['id'] | undefined
  readonly preheat: Evidence['id'] | undefined
  readonly verifiedArrival: Evidence['id'] | undefined
  readonly pathwayLighting: Evidence['id'] | undefined
  readonly unlock: Evidence['id'] | undefined
  readonly relock: Evidence['id'] | undefined
}

interface PredicateResult {
  readonly passed: boolean
  readonly evidence: readonly Evidence[]
  readonly message: string
}

/**
 * The compiler accepts persisted domain material, not requested predicates. This keeps model,
 * transport, and fixture narration outside the authority path that can complete a mission.
 */
export class ApprovedPlanDeterministicVerifier implements DeterministicVerifierPort {
  public constructor(
    private readonly timing: HomecomingVerificationTimingPolicy = PRODUCTION_HOMECOMING_VERIFICATION_TIMING,
  ) {}

  public evaluate(input: ApprovedVerificationMaterial): Promise<readonly VerificationAssertion[]> {
    return Promise.resolve(evaluateApprovedPlanVerification(input, this.timing))
  }
}

export function evaluateApprovedPlanVerification(
  input: ApprovedVerificationMaterial,
  timing: HomecomingVerificationTimingPolicy = PRODUCTION_HOMECOMING_VERIFICATION_TIMING,
): readonly VerificationAssertion[] {
  const compiled = compileApprovedPlanVerification(input, timing)
  const fallback = compiled.evidence[0]
  if (fallback === undefined) {
    throw new ConflictError('Verification requires persisted evidence')
  }
  const scopeContaminated = compiled.evidence.some(
    (item) =>
      item.organizationId !== compiled.scope.organizationId ||
      item.missionId !== compiled.scope.id ||
      item.palaceId !== compiled.scope.palaceId,
  )
  const scopedEvidence = compiled.evidence.filter(
    (item) =>
      item.organizationId === compiled.scope.organizationId &&
      item.missionId === compiled.scope.id &&
      item.palaceId === compiled.scope.palaceId,
  )

  return compiled.predicates.map((predicate) => {
    const result = evaluatePredicate(
      predicate,
      scopedEvidence,
      compiled.evidence,
      scopeContaminated,
      compiled.bindings,
    )
    const referenced = result.evidence.length > 0 ? result.evidence : [fallback]
    return VerificationAssertionSchema.parse({
      predicate,
      passed: result.passed,
      evidenceIds: [...new Set(referenced.map((item) => item.id))],
      message: result.message,
    })
  })
}

export function compileApprovedPlanVerification(
  input: ApprovedVerificationMaterial,
  timing: HomecomingVerificationTimingPolicy = PRODUCTION_HOMECOMING_VERIFICATION_TIMING,
): CompiledMaterial {
  assertTimingPolicy(timing)
  const mission = MissionSchema.parse(input.mission)
  const plan = PlanSchema.parse(input.plan)
  const approval = ApprovalSchema.parse(input.approval)
  const contextReceipt = ContextReceiptSchema.parse(input.contextReceipt)
  const operations = input.operations.map((operation) => OperationSchema.parse(operation))
  const executions = input.executions.map((stored) => ({
    ...stored,
    execution: ExecutionSchema.parse(stored.execution),
  }))
  const records = input.evidence.map((record) => PersistedEvidenceRecordSchema.parse(record))

  assertApprovedBindings({ mission, plan, approval, contextReceipt })
  const action = requireReplacementAction(plan)
  const { execution, operation } = requireBoundExecution({
    mission,
    plan,
    approval,
    action,
    operations,
    executions,
  })
  const evidence = uniqueEvidence(records.map((record) => record.evidence))
  const verifiedArrival = execution.milestones.find(
    (milestone) => milestone.name === 'verified_arrival',
  )
  if (verifiedArrival === undefined) {
    throw new ConflictError('Execution is missing its verified-arrival milestone')
  }
  const verifiedArrivalEvidenceId = verifiedArrival.evidenceId ?? execution.triggeredByEvidenceId
  const unverifiedArrivalEvidenceId =
    evidence
      .filter(
        (item) =>
          item.type === 'identity_arrival' &&
          !item.verified &&
          Date.parse(item.observedAt) <= Date.parse(execution.deadline),
      )
      .sort(byObservedAt)[0]?.id ?? execution.triggeredByEvidenceId
  const preheat = action.replacement.actions.find((candidate) => candidate.type === 'preheat')
  const relock = action.replacement.actions.find(
    (candidate) => candidate.type === 'lock_desired_state',
  )
  if (preheat === undefined || relock === undefined) {
    throw new ConflictError('Approved homecoming action is incomplete')
  }

  const predicates = [
    {
      id: HOMECOMING_VERIFICATION_CRITERIA[0],
      type: 'no_unlock_for_unverified_identity',
      unverifiedArrivalEvidenceId,
    },
    {
      id: HOMECOMING_VERIFICATION_CRITERIA[1],
      type: 'active_routine_count',
      planId: plan.id,
      expected: 1,
    },
    {
      id: HOMECOMING_VERIFICATION_CRITERIA[2],
      type: 'routine_inactive',
      routineId: action.protectedRoutineId,
    },
    {
      id: HOMECOMING_VERIFICATION_CRITERIA[3],
      type: 'routine_matches_plan',
      routineId: action.replacementRoutineId,
      planId: plan.id,
      planHash: plan.hash,
    },
    {
      id: HOMECOMING_VERIFICATION_CRITERIA[4],
      type: 'temperature_at_least_by',
      minimumCelsius: preheat.targetCelsius - TEMPERATURE_TOLERANCE_CELSIUS,
      deadline: nextLocalTime(
        execution.startedAt,
        action.replacement.trigger.timezone,
        preheat.completeBy,
      ),
    },
    {
      id: HOMECOMING_VERIFICATION_CRITERIA[5],
      type: 'lighting_after_arrival_within',
      arrivalEvidenceId: verifiedArrivalEvidenceId,
      maximumDelaySeconds: timing.maximumArrivalCommandDelaySeconds,
    },
    {
      id: HOMECOMING_VERIFICATION_CRITERIA[6],
      type: 'unlock_after_arrival_within',
      arrivalEvidenceId: verifiedArrivalEvidenceId,
      maximumDelaySeconds: timing.maximumArrivalCommandDelaySeconds,
    },
    {
      id: HOMECOMING_VERIFICATION_CRITERIA[7],
      type: 'lock_after_unlock_elapsed',
      expectedSeconds: relock.afterUnlockSeconds,
      toleranceSeconds: timing.relockToleranceSeconds,
    },
    {
      id: HOMECOMING_VERIFICATION_CRITERIA[8],
      type: 'battery_projection_at_most',
      maximumPercentagePoints:
        action.replacement.constraints.projectedBatteryUseMaxPercentagePoints,
    },
    {
      id: HOMECOMING_VERIFICATION_CRITERIA[9],
      type: 'no_cross_tenant_access',
      organizationId: plan.organizationId,
    },
  ].map((predicate) => VerificationPredicateSchema.parse(predicate))

  return {
    predicates,
    evidence,
    scope: {
      id: mission.id,
      organizationId: mission.organizationId,
      palaceId: mission.palaceId,
    },
    bindings: {
      activeRoutine: applicationRuleEvidenceId(
        records,
        ACTIVATION_APPLICATION_EVIDENCE_RULES.activeRoutine,
        (evidence) =>
          evidence.type === 'routine_state' &&
          evidence.routineId === action.replacementRoutineId &&
          evidence.routineVersionId === action.replacementRoutineVersionId &&
          evidence.active &&
          evidence.planId === plan.id &&
          evidence.planHash === plan.hash,
      ),
      protectedRoutineInactive: applicationRuleEvidenceId(
        records,
        ACTIVATION_APPLICATION_EVIDENCE_RULES.protectedRoutineInactive,
        (evidence) =>
          evidence.type === 'routine_state' &&
          evidence.routineId === action.protectedRoutineId &&
          evidence.routineVersionId === action.protectedRoutineVersionId &&
          !evidence.active &&
          evidence.planId === plan.id &&
          evidence.planHash === plan.hash,
      ),
      batteryProjection: applicationRuleEvidenceId(
        records,
        ACTIVATION_APPLICATION_EVIDENCE_RULES.batteryProjection,
        (evidence) =>
          evidence.type === 'battery_projection' &&
          evidence.projectedUsePercentagePoints ===
            action.replacement.projectedBatteryUsePercentagePoints,
      ),
      tenantAudit: applicationRuleEvidenceId(
        records,
        ACTIVATION_APPLICATION_EVIDENCE_RULES.tenantBinding,
        (evidence) =>
          evidence.type === 'tenant_access_audit' &&
          evidence.attemptedOrganizationId === plan.organizationId &&
          evidence.allowed &&
          evidence.operationId === operation.id,
      ),
      preheat: completedGatewayMilestoneEvidence(
        records,
        execution,
        'preheat',
        (evidence) => evidence.type === 'temperature_observation',
      ),
      verifiedArrival: completedMilestoneEvidence(records, execution, 'verified_arrival'),
      pathwayLighting: completedGatewayMilestoneEvidence(
        records,
        execution,
        'pathway_lighting',
        (evidence) => evidence.type === 'device_command' && evidence.command === 'set_lighting',
      ),
      unlock: completedGatewayMilestoneEvidence(
        records,
        execution,
        'unlock',
        (evidence) => evidence.type === 'device_command' && evidence.command === 'unlock',
      ),
      relock: completedGatewayMilestoneEvidence(
        records,
        execution,
        'relock',
        (evidence) =>
          evidence.type === 'device_command' && evidence.command === 'locked_desired_state',
      ),
    },
  }
}

function assertTimingPolicy(timing: HomecomingVerificationTimingPolicy): void {
  if (
    !Number.isInteger(timing.maximumArrivalCommandDelaySeconds) ||
    timing.maximumArrivalCommandDelaySeconds < 0 ||
    !Number.isInteger(timing.relockToleranceSeconds) ||
    timing.relockToleranceSeconds < 0
  ) {
    throw new TypeError('Homecoming verification timing must use non-negative integer seconds')
  }
}

function assertApprovedBindings(input: {
  readonly mission: Mission
  readonly plan: Plan
  readonly approval: Approval
  readonly contextReceipt: ContextReceipt
}): void {
  const { mission, plan, approval, contextReceipt } = input
  const expectedCriteria = [...HOMECOMING_VERIFICATION_CRITERIA].sort()
  const missionCriteria = [...mission.successCriteriaIds].sort()
  const planCriteria = [...plan.successCriteriaIds].sort()
  if (
    plan.status !== 'approved' ||
    plan.organizationId !== mission.organizationId ||
    plan.missionId !== mission.id ||
    plan.palaceId !== mission.palaceId ||
    JSON.stringify(planCriteria) !== JSON.stringify(expectedCriteria) ||
    JSON.stringify(missionCriteria) !== JSON.stringify(expectedCriteria) ||
    JSON.stringify(plan.constraints) !== JSON.stringify(mission.constraints)
  ) {
    throw new ConflictError('Verification criteria are not bound to the approved mission plan')
  }
  if (
    approval.status !== 'approved' ||
    approval.organizationId !== plan.organizationId ||
    approval.missionId !== plan.missionId ||
    approval.planId !== plan.id ||
    approval.planHash !== plan.hash ||
    !sameStrings(
      approval.actionIds,
      plan.actions.map((action) => action.id),
    )
  ) {
    throw new ConflictError('Verification plan is not bound to its exact approval')
  }
  if (
    contextReceipt.organizationId !== mission.organizationId ||
    contextReceipt.missionId !== mission.id
  ) {
    throw new ConflictError('Verification plan is not bound to a mission context receipt')
  }
  if (Date.parse(contextReceipt.createdAt) > Date.parse(plan.createdAt)) {
    throw new ConflictError('Verification context receipt was created after the approved plan')
  }
}

function requireReplacementAction(plan: Plan) {
  const action = plan.actions[0]
  if (
    plan.actions.length !== 1 ||
    action === undefined ||
    action.type !== 'replace_homecoming_routine'
  ) {
    throw new ConflictError('Verification requires one approved homecoming replacement action')
  }
  const constraints = HomecomingMissionConstraintSchema.parse(plan.constraints)
  if (
    constraints.preheatBy !==
      action.replacement.actions.find((candidate) => candidate.type === 'preheat')?.completeBy ||
    constraints.projectedBatteryUseMaxPercentagePoints !==
      action.replacement.constraints.projectedBatteryUseMaxPercentagePoints
  ) {
    throw new ConflictError('Approved action does not preserve the plan constraints')
  }
  return action
}

function requireBoundExecution(input: {
  readonly mission: Mission
  readonly plan: Plan
  readonly approval: Approval
  readonly action: Extract<Plan['actions'][number], { type: 'replace_homecoming_routine' }>
  readonly operations: readonly Operation[]
  readonly executions: readonly StoredExecution[]
}) {
  if (input.executions.length !== 1 || input.operations.length !== 1) {
    throw new ConflictError('Verification requires one durable operation and execution')
  }
  const stored = input.executions[0]
  const operation = input.operations[0]
  if (stored === undefined || operation === undefined) {
    throw new ConflictError('Verification requires one durable operation and execution')
  }
  const execution = stored.execution
  if (
    operation.status !== 'committed' ||
    operation.outcome === null ||
    operation.organizationId !== input.plan.organizationId ||
    operation.missionId !== input.mission.id ||
    operation.planId !== input.plan.id ||
    operation.planActionId !== input.action.id ||
    operation.approvalId !== input.approval.id ||
    operation.payloadHash !== hashCanonical({ planHash: input.plan.hash, action: input.action }) ||
    operation.id !== stored.operationId ||
    operation.id !== execution.operationId ||
    operation.outcome.routineId !== input.action.replacementRoutineId ||
    operation.outcome.routineVersionId !== input.action.replacementRoutineVersionId ||
    operation.outcome.deactivatedRoutineId !== input.action.protectedRoutineId ||
    execution.organizationId !== input.mission.organizationId ||
    execution.missionId !== input.mission.id ||
    execution.routineId !== input.action.replacementRoutineId ||
    execution.routineVersionId !== input.action.replacementRoutineVersionId
  ) {
    throw new ConflictError('Execution is not bound to the approved plan action')
  }
  return { execution, operation }
}

function evaluatePredicate(
  predicate: VerificationPredicate,
  evidence: readonly Evidence[],
  allEvidence: readonly Evidence[],
  scopeContaminated: boolean,
  bindings: VerificationEvidenceBindings,
): PredicateResult {
  switch (predicate.type) {
    case 'no_unlock_for_unverified_identity': {
      const identityArrivals = evidenceOfType(evidence, 'identity_arrival')
      const arrivals = identityArrivals.filter((item) => !item.verified)
      const verifiedArrivals = identityArrivals.filter((item) => item.verified)
      const unlocks = evidenceOfType(evidence, 'device_command').filter(
        (item) => item.command === 'unlock',
      )
      const unsafeUnlocks = unlocks.filter((unlock) =>
        arrivals.some((arrival) => {
          if (unlock.causedByEvidenceId === arrival.id) return true
          const arrivalAt = Date.parse(arrival.observedAt)
          const nextVerifiedAt = verifiedArrivals
            .map((candidate) => Date.parse(candidate.observedAt))
            .filter((observedAt) => observedAt > arrivalAt)
            .sort((left, right) => left - right)[0]
          const unlockAt = Date.parse(unlock.observedAt)
          return (
            unlockAt >= arrivalAt && (nextVerifiedAt === undefined || unlockAt < nextVerifiedAt)
          )
        }),
      )
      const expectedArrival = arrivals.find(
        (arrival) => arrival.id === predicate.unverifiedArrivalEvidenceId,
      )
      const passed = expectedArrival !== undefined && unsafeUnlocks.length === 0
      return {
        passed,
        evidence: [...arrivals, ...unsafeUnlocks],
        message: passed
          ? 'No unlock command occurred in an unverified-arrival window.'
          : expectedArrival === undefined
            ? 'The required unverified-arrival evidence is missing.'
            : 'An unlock occurred in an unverified-arrival window.',
      }
    }
    case 'active_routine_count': {
      const states = evidenceOfType(evidence, 'routine_state').filter(
        (item) => item.planId === predicate.planId,
      )
      const latest = latestRoutineStates(states)
      const active = latest.filter((state) => state.active)
      return {
        passed: latest.length > 0 && active.length === predicate.expected,
        evidence: states,
        message: `Found ${active.length} active routine(s) for the approved plan; expected ${predicate.expected}.`,
      }
    }
    case 'routine_inactive': {
      const states = evidenceOfType(evidence, 'routine_state').filter(
        (item) => item.routineId === predicate.routineId,
      )
      const latest = states
        .filter((state) => state.id === bindings.protectedRoutineInactive)
        .sort(byObservedAt)
        .at(-1)
      const passed = latest !== undefined && !latest.active
      return {
        passed,
        evidence: states,
        message: passed
          ? 'The protected routine is inactive.'
          : 'The protected routine is active or its state is missing.',
      }
    }
    case 'routine_matches_plan': {
      const states = evidenceOfType(evidence, 'routine_state').filter(
        (item) => item.routineId === predicate.routineId && item.id === bindings.activeRoutine,
      )
      const latest = [...states].sort(byObservedAt).at(-1)
      const passed =
        latest !== undefined &&
        latest.active &&
        latest.planId === predicate.planId &&
        latest.planHash === predicate.planHash
      return {
        passed,
        evidence: states,
        message: passed
          ? 'The active routine is bound to the approved plan and hash.'
          : 'The active routine does not match the approved plan and hash.',
      }
    }
    case 'temperature_at_least_by': {
      const observations = evidenceOfType(evidence, 'temperature_observation').filter(
        (item) =>
          item.id === bindings.preheat &&
          Date.parse(item.observedAt) <= Date.parse(predicate.deadline),
      )
      const passing = observations.find((item) => item.celsius >= predicate.minimumCelsius)
      return {
        passed: passing !== undefined,
        evidence: observations,
        message:
          passing !== undefined
            ? `Temperature reached at least ${predicate.minimumCelsius}°C by the deadline.`
            : `Temperature did not reach ${predicate.minimumCelsius}°C by the deadline.`,
      }
    }
    case 'lighting_after_arrival_within':
    case 'unlock_after_arrival_within': {
      const expectedCommand =
        predicate.type === 'lighting_after_arrival_within' ? 'set_lighting' : 'unlock'
      const arrival = evidenceOfType(evidence, 'identity_arrival').find(
        (item) => item.id === predicate.arrivalEvidenceId,
      )
      const commands = evidenceOfType(evidence, 'device_command').filter(
        (item) =>
          item.command === expectedCommand &&
          item.causedByEvidenceId === predicate.arrivalEvidenceId &&
          item.id ===
            (predicate.type === 'lighting_after_arrival_within'
              ? bindings.pathwayLighting
              : bindings.unlock),
      )
      const passing =
        arrival?.verified === true &&
        arrival.id === bindings.verifiedArrival &&
        commands.find((command) => {
          const delay = millisecondsBetween(command.observedAt, arrival.observedAt)
          return delay >= 0 && delay <= predicate.maximumDelaySeconds * 1_000
        })
      return {
        passed: passing !== undefined && passing !== false,
        evidence: [...(arrival ? [arrival] : []), ...commands],
        message: passing
          ? `${expectedCommand} followed verified-arrival evidence within ${predicate.maximumDelaySeconds} seconds.`
          : `${expectedCommand} did not follow verified-arrival evidence within ${predicate.maximumDelaySeconds} seconds.`,
      }
    }
    case 'lock_after_unlock_elapsed': {
      const commands = evidenceOfType(evidence, 'device_command')
      const unlocks = commands.filter(
        (item) => item.command === 'unlock' && item.id === bindings.unlock,
      )
      const locks = commands.filter(
        (item) => item.command === 'locked_desired_state' && item.id === bindings.relock,
      )
      const expectedMilliseconds = predicate.expectedSeconds * 1_000
      const toleranceMilliseconds = predicate.toleranceSeconds * 1_000
      const passing = unlocks.some((unlock) =>
        locks.some((lock) => {
          if (unlock.deviceId !== lock.deviceId || lock.causedByEvidenceId !== unlock.id)
            return false
          const elapsed = millisecondsBetween(lock.observedAt, unlock.observedAt)
          return Math.abs(elapsed - expectedMilliseconds) <= toleranceMilliseconds
        }),
      )
      return {
        passed: passing,
        evidence: [...unlocks, ...locks],
        message: passing
          ? `Locked desired state followed unlock after ${predicate.expectedSeconds} seconds within tolerance.`
          : `Locked desired state did not follow unlock after ${predicate.expectedSeconds} seconds within tolerance.`,
      }
    }
    case 'battery_projection_at_most': {
      const projections = evidenceOfType(evidence, 'battery_projection').filter(
        (item) => item.id === bindings.batteryProjection,
      )
      const latestAt = projections.reduce(
        (latest, projection) => Math.max(latest, Date.parse(projection.observedAt)),
        Number.NEGATIVE_INFINITY,
      )
      const latest = projections.filter(
        (projection) => Date.parse(projection.observedAt) === latestAt,
      )
      const passed =
        latest.length > 0 &&
        latest.every(
          (projection) =>
            projection.projectedUsePercentagePoints <= predicate.maximumPercentagePoints,
        )
      return {
        passed,
        evidence: projections,
        message: passed
          ? `Projected use is at or below ${predicate.maximumPercentagePoints} percentage points.`
          : `Projected use exceeds ${predicate.maximumPercentagePoints} percentage points or is missing.`,
      }
    }
    case 'no_cross_tenant_access': {
      const audits = evidenceOfType(allEvidence, 'tenant_access_audit')
      const contaminated =
        scopeContaminated ||
        allEvidence.some((item) => item.organizationId !== predicate.organizationId)
      const allowedCrossTenant = audits.some(
        (audit) => audit.attemptedOrganizationId !== predicate.organizationId && audit.allowed,
      )
      const passed =
        audits.some((audit) => audit.id === bindings.tenantAudit) &&
        !contaminated &&
        !allowedCrossTenant
      return {
        passed,
        evidence: audits,
        message: passed
          ? 'The operation and retained evidence remain bound to the approved tenant.'
          : 'The operation lacks its tenant binding, contains foreign evidence, or records an allowed foreign access.',
      }
    }
  }
}

function millisecondsBetween(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right)
}

function byObservedAt(left: Evidence, right: Evidence): number {
  return (
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  )
}

function latestRoutineStates(
  states: readonly Extract<Evidence, { type: 'routine_state' }>[],
): readonly Extract<Evidence, { type: 'routine_state' }>[] {
  const latest = new Map<string, Extract<Evidence, { type: 'routine_state' }>>()
  for (const state of [...states].sort(byObservedAt)) latest.set(state.routineId, state)
  return [...latest.values()]
}

function evidenceOfType<Type extends Evidence['type']>(
  evidence: readonly Evidence[],
  type: Type,
): Extract<Evidence, { type: Type }>[] {
  return evidence.filter((item): item is Extract<Evidence, { type: Type }> => item.type === type)
}

function applicationRuleEvidenceId(
  records: readonly PersistedEvidenceRecord[],
  rule: { readonly id: string; readonly version: number },
  accepts: (evidence: Evidence) => boolean,
): Evidence['id'] | undefined {
  const matches = records.filter(
    (record) =>
      record.authorityReceipt.authority === 'application' &&
      record.authorityReceipt.ruleId === rule.id &&
      record.authorityReceipt.ruleVersion === rule.version &&
      accepts(record.evidence),
  )
  return matches.length === 1 ? matches[0]?.evidence.id : undefined
}

function completedMilestoneEvidence(
  records: readonly PersistedEvidenceRecord[],
  execution: StoredExecution['execution'],
  name: StoredExecution['execution']['milestones'][number]['name'],
): Evidence['id'] | undefined {
  const milestone = execution.milestones.find((candidate) => candidate.name === name)
  if (milestone?.status !== 'completed') return undefined
  const record = records.find((candidate) => candidate.evidence.id === milestone.evidenceId)
  if (record === undefined) return undefined
  if (name === 'verified_arrival') {
    return record.authorityReceipt.authority === 'identity_telemetry' &&
      record.evidence.type === 'identity_arrival' &&
      record.evidence.verified
      ? record.evidence.id
      : undefined
  }
  return record.authorityReceipt.authority === 'gateway_callback' &&
    record.authorityReceipt.commandId === milestone.commandId
    ? record.evidence.id
    : undefined
}

function completedGatewayMilestoneEvidence(
  records: readonly PersistedEvidenceRecord[],
  execution: StoredExecution['execution'],
  name: StoredExecution['execution']['milestones'][number]['name'],
  accepts: (evidence: Evidence) => boolean,
): Evidence['id'] | undefined {
  const milestone = execution.milestones.find((candidate) => candidate.name === name)
  if (
    milestone?.status !== 'completed' ||
    milestone.commandId === null ||
    completedMilestoneEvidence(records, execution, name) === undefined
  ) {
    return undefined
  }
  const matches = records.filter(
    (record) =>
      record.authorityReceipt.authority === 'gateway_callback' &&
      record.authorityReceipt.commandId === milestone.commandId &&
      accepts(record.evidence),
  )
  return matches.length === 1 ? matches[0]?.evidence.id : undefined
}

function uniqueEvidence(input: readonly Evidence[]): Evidence[] {
  const byId = new Map<string, { readonly serialized: string; readonly evidence: Evidence }>()
  for (const evidence of input) {
    const serialized = JSON.stringify(evidence)
    const existing = byId.get(evidence.id)
    if (existing !== undefined && existing.serialized !== serialized) {
      throw new ConflictError(`Conflicting evidence payloads share ID ${evidence.id}`)
    }
    if (existing === undefined) byId.set(evidence.id, { serialized, evidence })
  }
  return [...byId.values()].map((entry) => entry.evidence)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

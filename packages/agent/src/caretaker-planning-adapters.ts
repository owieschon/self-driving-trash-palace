import {
  ContextSourceReceiptSchema,
  HARD_INVARIANTS,
  HomecomingMissionConstraintSchema,
  ScheduledHaulerAccessConstraintSchema,
  PlanActionIdSchema,
  PlanActionSchema,
  PlansProposeInputSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  hashToolValue,
  missionProgramKindOf,
  type ClarificationAnswer,
  type ClarificationRequest,
  type EvidenceId,
  type PersistedEvidenceRecord,
} from '@trash-palace/core'
import { z } from 'zod'

import type {
  CaretakerHomecomingDraftPort,
  CaretakerMaterialIssuePort,
  CaretakerSynthesisSnapshot,
} from './caretaker-runtime-adapters.js'

type PlanProposal = Awaited<ReturnType<CaretakerHomecomingDraftPort['synthesize']>>
type MaterialIssue = Awaited<ReturnType<CaretakerMaterialIssuePort['synthesize']>>
type BatteryProjectionRecord = PersistedEvidenceRecord &
  Readonly<{
    evidence: Extract<PersistedEvidenceRecord['evidence'], { type: 'battery_projection' }>
    authorityReceipt: Extract<
      PersistedEvidenceRecord['authorityReceipt'],
      { authority: 'application' }
    >
  }>

const ProjectionRuleSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
      .max(120),
    version: z.number().int().positive(),
  })
  .strict()

const ChoiceCopySchema = z
  .object({
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(240),
  })
  .strict()

export const CaretakerHomecomingPlanningPolicySchema = z
  .object({
    schemaVersion: z.literal('caretaker-homecoming-planning-policy@1'),
    policyVersion: z.string().min(1).max(120),
    requiredPlanningSource: ContextSourceReceiptSchema,
    replacementName: z.string().min(1).max(120),
    question: z.string().min(12).max(280),
    choices: z
      .object({
        energyFirst: ChoiceCopySchema,
        comfortFirst: ChoiceCopySchema,
      })
      .strict(),
    projectionRules: z
      .object({
        preference: ProjectionRuleSchema,
        energyFirst: ProjectionRuleSchema,
      })
      .strict(),
    energyFirst: z
      .object({
        targetCelsius: z.number().min(5).max(35),
        pathwayLightingIntensityPercent: z.number().int().min(1).max(100),
        pathwayLightingDurationSeconds: z.number().int().min(1).max(86_400),
      })
      .strict(),
    unlockDurationSeconds: z.number().int().min(1).max(300),
    relockAfterSeconds: z.number().int().min(1).max(300),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.requiredPlanningSource.authority !== 'skill') {
      context.addIssue({
        code: 'custom',
        path: ['requiredPlanningSource', 'authority'],
        message: 'Planning policy must bind an authored skill source',
      })
    }
    if (policy.projectionRules.preference.id === policy.projectionRules.energyFirst.id) {
      context.addIssue({
        code: 'custom',
        path: ['projectionRules'],
        message: 'Preference and Energy-first projections require distinct application rules',
      })
    }
  })

export type CaretakerHomecomingPlanningPolicy = z.infer<
  typeof CaretakerHomecomingPlanningPolicySchema
>

export const NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY = CaretakerHomecomingPlanningPolicySchema.parse(
  {
    schemaVersion: 'caretaker-homecoming-planning-policy@1',
    policyVersion: '1.0.0',
    requiredPlanningSource: {
      sourceId: 'skill.homecoming.planning',
      version: '1.0.0',
      contentHash: '2755428c7a31dd35f298f27efa76ce513c5b0d43e1c725839e9a784aa8cb24c6',
      authority: 'skill',
    },
    replacementName: 'Night Shift Homecoming',
    question:
      'Should this routine preserve the current energy bound or the stored comfort preference?',
    choices: {
      energyFirst: {
        label: 'Preserve the energy bound',
        description:
          'Use the evidence-backed lower-energy profile while preserving every access and timing invariant.',
      },
      comfortFirst: {
        label: 'Preserve the comfort preference',
        description:
          'Keep the stored comfort profile only after the mission records a compatible energy bound.',
      },
    },
    projectionRules: {
      preference: { id: 'homecoming.preference-energy-projection', version: 1 },
      energyFirst: { id: 'homecoming.energy-first-projection', version: 1 },
    },
    energyFirst: {
      targetCelsius: 20,
      pathwayLightingIntensityPercent: 40,
      pathwayLightingDurationSeconds: 900,
    },
    unlockDurationSeconds: 90,
    relockAfterSeconds: 90,
  },
)

export const SCHEDULED_HAULER_ACCESS_PLANNING_SOURCE = ContextSourceReceiptSchema.parse({
  sourceId: 'skill.hauler-access.planning',
  version: '1.0.0',
  contentHash: '542330a172c3508e029dac98b2b2b9807ddf23c4857e07a9496c0d2e5dd9606b',
  authority: 'skill',
})

export function homecomingClarificationChoiceDescriptions(
  policy: CaretakerHomecomingPlanningPolicy = NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY,
) {
  const parsed = CaretakerHomecomingPlanningPolicySchema.parse(policy)
  return projectedChoices(parsed).map((choice) => ({
    materialField: 'constraint.energy_bound',
    choiceId: choice.id,
    label: choice.label,
    description: choice.description,
  }))
}

export class CaretakerHomecomingPlanningIntegrityError extends Error {
  public override readonly name = 'CaretakerHomecomingPlanningIntegrityError'
}

type PlanningAnalysis = Readonly<{
  proposal: PlanProposal
  materialIssue: MaterialIssue
}>

/** Produces one immutable replacement candidate from frozen, application-authorized evidence. */
export class DeterministicHomecomingPlanningKernel {
  readonly #policy: CaretakerHomecomingPlanningPolicy

  public constructor(policy: CaretakerHomecomingPlanningPolicy) {
    this.#policy = CaretakerHomecomingPlanningPolicySchema.parse(policy)
  }

  public analyze(input: CaretakerSynthesisSnapshot): PlanningAnalysis {
    if (!planningInputsAreReady(input)) {
      return { proposal: null, materialIssue: null }
    }
    assertPlanningSource(input, this.#policy)
    const schedule = requireSingle(
      input.crew.schedules.filter((candidate) => candidate.active),
      'one active crew schedule',
    )
    const preference = requireSingle(
      input.crew.preferences.filter(
        (candidate) => candidate.active && candidate.crewMemberId === schedule.crewMemberId,
      ),
      'one active homecoming preference for the scheduled crew member',
    )
    if (schedule.timezone !== input.palace.timezone) {
      throw integrity('Active schedule and palace timezones disagree')
    }

    const protectedVersion = requireProtectedRoutine(input, schedule)
    const constraints = HomecomingMissionConstraintSchema.parse(input.mission.constraints)
    const preferenceProjection = requireProjection(
      input.persistedEvidence,
      this.#policy.projectionRules.preference,
    )
    const energyConflict =
      preferenceProjection.evidence.projectedUsePercentagePoints >
      constraints.projectedBatteryUseMaxPercentagePoints

    if (!energyConflict) {
      if (input.clarification !== null) {
        throw integrity('Clarification history remains after the material conflict disappeared')
      }
      return {
        materialIssue: null,
        proposal: buildProposal({
          input,
          policy: this.#policy,
          protectedVersion,
          profile: {
            kind: 'stored_preference',
            targetCelsius: preference.targetCelsius,
            pathwayLightingIntensityPercent: preference.pathwayLightingIntensityPercent,
            pathwayLightingDurationSeconds: preference.pathwayLightingDurationSeconds,
            projectedUsePercentagePoints:
              preferenceProjection.evidence.projectedUsePercentagePoints,
          },
        }),
      }
    }

    const energyProjection = requireProjection(
      input.persistedEvidence,
      this.#policy.projectionRules.energyFirst,
    )
    if (
      energyProjection.evidence.projectedUsePercentagePoints >
      constraints.projectedBatteryUseMaxPercentagePoints
    ) {
      throw integrity('Authored Energy-first projection does not satisfy the mission energy bound')
    }
    const evidenceIds = orderedEvidenceIds([preferenceProjection, energyProjection])
    const issueBase = {
      kind: 'constraint_conflict' as const,
      field: 'constraint.energy_bound',
      question: this.#policy.question,
      choices: projectedChoiceLabels(this.#policy),
      evidenceIds,
    }
    const resolvedChoiceId = resolveClarification(input, this.#policy, issueBase)
    const materialIssue = {
      ...issueBase,
      resolvedChoiceId,
    } satisfies NonNullable<MaterialIssue>
    if (resolvedChoiceId !== 'energy_first') {
      return { materialIssue, proposal: null }
    }

    return {
      materialIssue,
      proposal: buildProposal({
        input,
        policy: this.#policy,
        protectedVersion,
        profile: {
          kind: 'energy_first',
          ...this.#policy.energyFirst,
          projectedUsePercentagePoints: energyProjection.evidence.projectedUsePercentagePoints,
        },
      }),
    }
  }
}

export class DeterministicCaretakerHomecomingDraftPort implements CaretakerHomecomingDraftPort {
  public constructor(private readonly kernel: DeterministicHomecomingPlanningKernel) {}

  public synthesize(input: CaretakerSynthesisSnapshot): Promise<PlanProposal> {
    return Promise.resolve(this.kernel.analyze(input).proposal)
  }
}

export class DeterministicCaretakerMaterialIssuePort implements CaretakerMaterialIssuePort {
  public constructor(private readonly kernel: DeterministicHomecomingPlanningKernel) {}

  public synthesize(input: CaretakerSynthesisSnapshot): Promise<MaterialIssue> {
    return Promise.resolve(this.kernel.analyze(input).materialIssue)
  }
}

/** Builds the one bounded hauler routine replacement supported by the shipped program. */
export class DeterministicHaulerAccessPlanningKernel {
  public analyze(input: CaretakerSynthesisSnapshot): PlanProposal {
    if (!planningInputsAreReady(input)) return null
    assertExactPlanningSource(input, SCHEDULED_HAULER_ACCESS_PLANNING_SOURCE)
    const constraints = ScheduledHaulerAccessConstraintSchema.parse(input.mission.constraints)
    const protectedVersion = requireHaulerProtectedRoutine(input)
    const identity = hashToolValue({
      schemaVersion: 'caretaker-hauler-action-identity@1',
      contextBundleHash: input.context.bundleHash,
      missionId: input.mission.id,
      protectedRoutineId: protectedVersion.routineId,
      protectedRoutineVersionId: protectedVersion.id,
      protectedVersion: protectedVersion.version,
      constraints,
    })
    const action = PlanActionSchema.parse({
      id: PlanActionIdSchema.parse(`act_${identity.slice(0, 32)}`),
      type: 'replace_scheduled_hauler_access_routine',
      palaceId: input.mission.palaceId,
      protectedRoutineId: protectedVersion.routineId,
      protectedRoutineVersionId: protectedVersion.id,
      expectedProtectedVersion: protectedVersion.version,
      replacementRoutineId: RoutineIdSchema.parse(`rtn_${identity.slice(0, 32)}`),
      replacementRoutineVersionId: RoutineVersionIdSchema.parse(`rtv_${identity.slice(0, 32)}`),
      replacement: {
        name: 'Scheduled Hauler Access',
        trigger: {
          type: 'scheduled_access_window',
          windowStart: constraints.accessWindowStart,
          windowEnd: constraints.accessWindowEnd,
          timezone: input.palace.timezone,
          authorizedIdentityTagId: constraints.authorizedIdentityTagId,
        },
        actions: [
          {
            type: 'grant_service_hatch_access',
            durationSeconds: 300,
            requireVerifiedIdentity: true,
            compartment: 'service_hatch',
          },
          { type: 'lock_service_hatch', atWindowEnd: true },
        ],
        constraints: {
          serviceHatchOnly: true,
          residentialHatchMustRemainLocked: true,
          finalServiceHatchState: 'locked',
          hardInvariantIds: HARD_INVARIANTS.map((invariant) => invariant.id),
        },
        projectedBatteryUsePercentagePoints: 2,
      },
    })
    return PlansProposeInputSchema.parse({
      missionId: input.mission.id,
      revision: 1,
      actions: [action],
      successCriteriaIds: [...input.mission.successCriteriaIds],
    })
  }
}

export class DeterministicCaretakerProgramDraftPort implements CaretakerHomecomingDraftPort {
  public constructor(
    private readonly homecoming: DeterministicHomecomingPlanningKernel,
    private readonly hauler: DeterministicHaulerAccessPlanningKernel,
  ) {}

  public synthesize(input: CaretakerSynthesisSnapshot): Promise<PlanProposal> {
    return Promise.resolve(
      missionProgramKindOf(input.mission) === 'scheduled_hauler_access'
        ? this.hauler.analyze(input)
        : this.homecoming.analyze(input).proposal,
    )
  }
}

export class DeterministicCaretakerProgramMaterialIssuePort implements CaretakerMaterialIssuePort {
  public constructor(private readonly homecoming: DeterministicHomecomingPlanningKernel) {}

  public synthesize(input: CaretakerSynthesisSnapshot): Promise<MaterialIssue> {
    return Promise.resolve(
      missionProgramKindOf(input.mission) === 'scheduled_hauler_access'
        ? null
        : this.homecoming.analyze(input).materialIssue,
    )
  }
}

function planningInputsAreReady(input: CaretakerSynthesisSnapshot): boolean {
  return (
    input.mission.state.status === 'running' &&
    input.mission.state.phase === 'plan' &&
    input.capabilityFit === 'supported' &&
    Object.values(input.discovery).every((status) => status === 'ready')
  )
}

function assertPlanningSource(
  input: CaretakerSynthesisSnapshot,
  policy: CaretakerHomecomingPlanningPolicy,
): void {
  const expected = policy.requiredPlanningSource
  const matches = input.context.sources.filter(
    (source) =>
      source.sourceId === expected.sourceId &&
      source.version === expected.version &&
      source.contentHash === expected.contentHash &&
      source.authority === expected.authority,
  )
  if (matches.length !== 1) {
    throw integrity('Frozen context does not contain the exact planning skill source')
  }
}

function assertExactPlanningSource(
  input: CaretakerSynthesisSnapshot,
  expected: typeof SCHEDULED_HAULER_ACCESS_PLANNING_SOURCE,
): void {
  const matches = input.context.sources.filter(
    (source) =>
      source.sourceId === expected.sourceId &&
      source.version === expected.version &&
      source.contentHash === expected.contentHash &&
      source.authority === expected.authority,
  )
  if (matches.length !== 1) {
    throw integrity('Frozen context does not contain the exact planning skill source')
  }
}

function requireHaulerProtectedRoutine(input: CaretakerSynthesisSnapshot) {
  const versions = new Map(input.routines.versions.map((version) => [version.id, version]))
  const matches = input.routines.routines.flatMap((routine) => {
    if (routine.activeVersionId === null) return []
    const version = versions.get(routine.activeVersionId)
    if (
      version === undefined ||
      version.routineId !== routine.id ||
      version.status !== 'active' ||
      version.definition.trigger.type !== 'scheduled_access_window'
    ) {
      return []
    }
    return [version]
  })
  return requireSingle(matches, 'one active scheduled hauler access routine')
}

function requireProtectedRoutine(
  input: CaretakerSynthesisSnapshot,
  schedule: CaretakerSynthesisSnapshot['crew']['schedules'][number],
) {
  const versions = new Map(input.routines.versions.map((version) => [version.id, version]))
  const conflicts = input.routines.routines.flatMap((routine) => {
    if (routine.activeVersionId === null) return []
    const version = versions.get(routine.activeVersionId)
    if (
      version === undefined ||
      version.routineId !== routine.id ||
      version.status !== 'active' ||
      version.definition.trigger.timezone !== schedule.timezone ||
      !windowsOverlap(
        version.definition.trigger.windowStart,
        version.definition.trigger.windowEnd,
        schedule.windowStart,
        schedule.windowEnd,
      )
    ) {
      return []
    }
    return [version]
  })
  return requireSingle(conflicts, 'one active overlapping homecoming routine')
}

function requireProjection(
  records: readonly PersistedEvidenceRecord[],
  rule: CaretakerHomecomingPlanningPolicy['projectionRules']['preference'],
): BatteryProjectionRecord {
  const matches = records.filter(
    (record): record is BatteryProjectionRecord =>
      record.evidence.type === 'battery_projection' &&
      record.authorityReceipt.authority === 'application' &&
      record.authorityReceipt.ruleId === rule.id &&
      record.authorityReceipt.ruleVersion === rule.version,
  )
  return requireSingle(matches, `one ${rule.id}@${rule.version} projection`)
}

function resolveClarification(
  input: CaretakerSynthesisSnapshot,
  policy: CaretakerHomecomingPlanningPolicy,
  issue: Readonly<{
    field: string
    question: string
    choices: readonly Readonly<{ id: string; label: string }>[]
    evidenceIds: readonly EvidenceId[]
  }>,
): 'energy_first' | 'comfort_first' | null {
  if (input.clarification === null) return null
  const { request, answer } = input.clarification
  const expectedChoices = projectedChoices(policy)
  if (
    request.question !== issue.question ||
    hashToolValue(request.choices) !== hashToolValue(expectedChoices) ||
    hashToolValue(request.evidenceRefs) !== hashToolValue(issue.evidenceIds)
  ) {
    throw integrity('Durable clarification does not bind the current material conflict')
  }
  if (request.status === 'pending') {
    if (answer !== null) throw integrity('Pending clarification carries an answer')
    return null
  }
  assertAnsweredClarification(request, answer, input)
  return answer.choiceId as 'energy_first' | 'comfort_first'
}

function assertAnsweredClarification(
  request: ClarificationRequest,
  answer: ClarificationAnswer | null,
  input: CaretakerSynthesisSnapshot,
): asserts answer is ClarificationAnswer {
  const persisted = new Set(input.persistedEvidence.map((record) => record.evidence.id))
  if (
    answer === null ||
    answer.requestId !== request.id ||
    answer.missionId !== input.mission.id ||
    !['energy_first', 'comfort_first'].includes(answer.choiceId) ||
    answer.evidenceRefs.some((id) => !persisted.has(id))
  ) {
    throw integrity('Clarification answer does not bind the offered durable choice')
  }
}

function projectedChoiceLabels(policy: CaretakerHomecomingPlanningPolicy) {
  return projectedChoices(policy).map(({ id, label }) => ({ id, label }))
}

function projectedChoices(policy: CaretakerHomecomingPlanningPolicy) {
  return [
    { id: 'energy_first' as const, ...policy.choices.energyFirst },
    { id: 'comfort_first' as const, ...policy.choices.comfortFirst },
  ]
}

function orderedEvidenceIds(records: readonly BatteryProjectionRecord[]): EvidenceId[] {
  return records
    .map((record) => record.evidence.id)
    .sort((left, right) => left.localeCompare(right))
}

function buildProposal(input: {
  readonly input: CaretakerSynthesisSnapshot
  readonly policy: CaretakerHomecomingPlanningPolicy
  readonly protectedVersion: CaretakerSynthesisSnapshot['routines']['versions'][number]
  readonly profile: Readonly<{
    kind: 'stored_preference' | 'energy_first'
    targetCelsius: number
    pathwayLightingIntensityPercent: number
    pathwayLightingDurationSeconds: number
    projectedUsePercentagePoints: number
  }>
}): NonNullable<PlanProposal> {
  const { policy, profile, protectedVersion } = input
  const snapshot = input.input
  const schedule = requireSingle(
    snapshot.crew.schedules.filter((candidate) => candidate.active),
    'one active crew schedule',
  )
  const constraints = HomecomingMissionConstraintSchema.parse(snapshot.mission.constraints)
  const maximum = constraints.projectedBatteryUseMaxPercentagePoints
  if (
    profile.projectedUsePercentagePoints > maximum ||
    profile.projectedUsePercentagePoints > snapshot.palace.batteryAvailablePercentage
  ) {
    throw integrity('Selected planning profile exceeds an energy safety boundary')
  }
  const identity = hashToolValue({
    schemaVersion: 'caretaker-homecoming-action-identity@1',
    policyVersion: policy.policyVersion,
    contextBundleHash: snapshot.context.bundleHash,
    missionId: snapshot.mission.id,
    protectedRoutineId: protectedVersion.routineId,
    protectedRoutineVersionId: protectedVersion.id,
    protectedVersion: protectedVersion.version,
    profile,
  })
  const action = PlanActionSchema.parse({
    id: PlanActionIdSchema.parse(`act_${identity.slice(0, 32)}`),
    type: 'replace_homecoming_routine',
    palaceId: snapshot.mission.palaceId,
    protectedRoutineId: protectedVersion.routineId,
    protectedRoutineVersionId: protectedVersion.id,
    expectedProtectedVersion: protectedVersion.version,
    replacementRoutineId: RoutineIdSchema.parse(`rtn_${identity.slice(0, 32)}`),
    replacementRoutineVersionId: RoutineVersionIdSchema.parse(`rtv_${identity.slice(0, 32)}`),
    replacement: {
      name: policy.replacementName,
      trigger: {
        type: 'verified_arrival',
        windowStart: schedule.windowStart,
        windowEnd: schedule.windowEnd,
        timezone: schedule.timezone,
      },
      actions: [
        {
          type: 'preheat',
          targetCelsius: profile.targetCelsius,
          completeBy: constraints.preheatBy,
        },
        {
          type: 'pathway_lighting',
          intensityPercent: profile.pathwayLightingIntensityPercent,
          durationSeconds: profile.pathwayLightingDurationSeconds,
          beginsAfter: constraints.pathwayLightingBeginsAfter,
        },
        {
          type: 'unlock',
          durationSeconds: policy.unlockDurationSeconds,
          requireVerifiedIdentity: constraints.requireVerifiedIdentityForUnlock,
        },
        { type: 'lock_desired_state', afterUnlockSeconds: policy.relockAfterSeconds },
      ],
      constraints: {
        projectedBatteryUseMaxPercentagePoints: maximum,
        hardInvariantIds: HARD_INVARIANTS.map((invariant) => invariant.id),
      },
      projectedBatteryUsePercentagePoints: profile.projectedUsePercentagePoints,
    },
  })
  return PlansProposeInputSchema.parse({
    missionId: snapshot.mission.id,
    revision: 1,
    actions: [action],
    successCriteriaIds: [...snapshot.mission.successCriteriaIds],
  })
}

function windowsOverlap(
  leftStart: string,
  leftEnd: string,
  rightStart: string,
  rightEnd: string,
): boolean {
  const left = timeSegments(leftStart, leftEnd)
  const right = timeSegments(rightStart, rightEnd)
  return left.some(([leftFrom, leftTo]) =>
    right.some(([rightFrom, rightTo]) => leftFrom < rightTo && rightFrom < leftTo),
  )
}

function timeSegments(start: string, end: string): readonly (readonly [number, number])[] {
  const from = minutes(start)
  const to = minutes(end)
  return from < to
    ? [[from, to]]
    : [
        [from, 1_440],
        [0, to],
      ]
}

function minutes(value: string): number {
  const [hours, minutesPart] = value.split(':').map(Number)
  if (hours === undefined || minutesPart === undefined) throw integrity('Invalid schedule time')
  return hours * 60 + minutesPart
}

function requireSingle<Value>(values: readonly Value[], expected: string): Value {
  if (values.length !== 1 || values[0] === undefined) {
    throw integrity(`Planning requires exactly ${expected}`)
  }
  return values[0]
}

function integrity(message: string): CaretakerHomecomingPlanningIntegrityError {
  return new CaretakerHomecomingPlanningIntegrityError(message)
}

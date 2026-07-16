import {
  ClarificationAnswerSchema,
  ClarificationRequestSchema,
  ContextReceiptIdSchema,
  EvidenceIdSchema,
  MissionIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PersistedEvidenceRecordSchema,
  ReceiptIdSchema,
  RunIdSchema,
  TOOL_REGISTRY_HASH,
  UserIdSchema,
  computeClarificationAnswerPayloadHash,
  computeClarificationRequestPayloadHash,
  hashToolValue,
  type ClarificationAnswer,
  type ClarificationRequest,
  type PersistedEvidenceRecord,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import {
  DeterministicCaretakerHomecomingDraftPort,
  DeterministicCaretakerMaterialIssuePort,
  DeterministicCaretakerProgramDraftPort,
  DeterministicCaretakerProgramMaterialIssuePort,
  DeterministicHaulerAccessPlanningKernel,
  DeterministicHomecomingPlanningKernel,
  NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY,
  SCHEDULED_HAULER_ACCESS_PLANNING_SOURCE,
} from './caretaker-planning-adapters.js'
import type { CaretakerSynthesisSnapshot } from './caretaker-runtime-adapters.js'

const NOW = '2026-08-14T05:35:00.000Z'
const IDS = {
  organization: OrganizationIdSchema.parse('org_planningadapter'),
  mission: MissionIdSchema.parse('mis_planningadapter'),
  palace: PalaceIdSchema.parse('pal_planningadapter'),
  owner: UserIdSchema.parse('usr_planningowner'),
  service: UserIdSchema.parse('usr_planningservice'),
  run: RunIdSchema.parse('run_planningadapter'),
  context: ContextReceiptIdSchema.parse('ctx_planningadapter'),
  comfortEvidence: EvidenceIdSchema.parse('evd_comfortprojection'),
  energyEvidence: EvidenceIdSchema.parse('evd_energyprojection'),
} as const

describe('deterministic production homecoming planning adapters', () => {
  it('creates one exact, stable replacement from an in-bound stored preference', async () => {
    const kernel = new DeterministicHomecomingPlanningKernel(NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY)
    const drafts = new DeterministicCaretakerHomecomingDraftPort(kernel)
    const issues = new DeterministicCaretakerMaterialIssuePort(kernel)
    const snapshot = planningSnapshot({
      targetCelsius: 20,
      intensityPercent: 40,
      durationSeconds: 900,
      comfortProjection: 13.2,
      includeEnergyProjection: false,
    })

    const first = await drafts.synthesize(snapshot)
    const second = await drafts.synthesize(structuredClone(snapshot))

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      missionId: IDS.mission,
      revision: 1,
      successCriteriaIds: ['safe_homecoming', 'bounded_energy'],
      actions: [
        {
          type: 'replace_homecoming_routine',
          palaceId: IDS.palace,
          protectedRoutineId: 'rtn_midnightentry',
          protectedRoutineVersionId: 'rtv_midnightentryv3',
          expectedProtectedVersion: 3,
          replacement: {
            actions: [
              { type: 'preheat', targetCelsius: 20, completeBy: '02:00' },
              {
                type: 'pathway_lighting',
                intensityPercent: 40,
                durationSeconds: 900,
                beginsAfter: 'verified_arrival',
              },
              { type: 'unlock', durationSeconds: 90, requireVerifiedIdentity: true },
              { type: 'lock_desired_state', afterUnlockSeconds: 90 },
            ],
            projectedBatteryUsePercentagePoints: 13.2,
          },
        },
      ],
    })
    expect(first?.actions).toHaveLength(1)
    expect(await issues.synthesize(snapshot)).toBeNull()
  })

  it('surfaces only the evidence-bound energy conflict before drafting', async () => {
    const kernel = new DeterministicHomecomingPlanningKernel(NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY)
    const snapshot = planningSnapshot()

    expect(
      await new DeterministicCaretakerHomecomingDraftPort(kernel).synthesize(snapshot),
    ).toBeNull()
    expect(await new DeterministicCaretakerMaterialIssuePort(kernel).synthesize(snapshot)).toEqual({
      kind: 'constraint_conflict',
      field: 'constraint.energy_bound',
      question:
        'Should this routine preserve the current energy bound or the stored comfort preference?',
      choices: [
        { id: 'energy_first', label: 'Preserve the energy bound' },
        { id: 'comfort_first', label: 'Preserve the comfort preference' },
      ],
      resolvedChoiceId: null,
      evidenceIds: [IDS.comfortEvidence, IDS.energyEvidence],
    })
  })

  it('uses the exact durable Energy-first answer after a pause and stays stable after restart', async () => {
    const kernel = new DeterministicHomecomingPlanningKernel(NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY)
    const unresolved = planningSnapshot()
    const issue = kernel.analyze(unresolved).materialIssue
    if (issue === null) throw new Error('Fixture requires a material issue')
    const clarification = answeredClarification(issue)
    const resumed = planningSnapshot({ clarification })
    const restarted = planningSnapshot({
      clarification,
      contextBundleHash: hashToolValue({ restart: 'same-frozen-successor-context' }),
    })
    const drafts = new DeterministicCaretakerHomecomingDraftPort(kernel)

    const first = await drafts.synthesize(resumed)
    const replay = await drafts.synthesize(structuredClone(resumed))
    const afterRestart = await drafts.synthesize(restarted)

    expect(first).toEqual(replay)
    expect(afterRestart?.actions[0]).not.toEqual(first?.actions[0])
    const replacement = first?.actions[0]
    if (replacement?.type !== 'replace_homecoming_routine') {
      throw new Error('Fixture requires a homecoming replacement')
    }
    expect(replacement.replacement.actions[0]).toMatchObject({
      type: 'preheat',
      targetCelsius: 20,
    })
    expect(replacement.replacement.actions[1]).toMatchObject({
      type: 'pathway_lighting',
      intensityPercent: 40,
      durationSeconds: 900,
    })
    expect(replacement.replacement.projectedBatteryUsePercentagePoints).toBe(13.2)
    await expect(
      new DeterministicCaretakerMaterialIssuePort(kernel).synthesize(resumed),
    ).resolves.toMatchObject({ resolvedChoiceId: 'energy_first' })
  })

  it('does not weaken the mission bound for a Comfort-first answer', async () => {
    const kernel = new DeterministicHomecomingPlanningKernel(NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY)
    const issue = kernel.analyze(planningSnapshot()).materialIssue
    if (issue === null) throw new Error('Fixture requires a material issue')
    const snapshot = planningSnapshot({
      clarification: answeredClarification(issue, 'comfort_first'),
    })

    expect(
      await new DeterministicCaretakerHomecomingDraftPort(kernel).synthesize(snapshot),
    ).toBeNull()
    expect(
      await new DeterministicCaretakerMaterialIssuePort(kernel).synthesize(snapshot),
    ).toMatchObject({ resolvedChoiceId: 'comfort_first' })
  })

  it('fails closed on unpinned context, ambiguous protected state, or altered answer copy', () => {
    const kernel = new DeterministicHomecomingPlanningKernel(NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY)
    const sourceFixture = planningSnapshot()
    const missingSource: CaretakerSynthesisSnapshot = {
      ...sourceFixture,
      context: { ...sourceFixture.context, sources: [] },
    }
    expect(() => kernel.analyze(missingSource)).toThrow(/exact planning skill source/)

    const routineFixture = planningSnapshot()
    const ambiguous: CaretakerSynthesisSnapshot = {
      ...routineFixture,
      routines: {
        routines: [
          ...routineFixture.routines.routines,
          {
            ...routineFixture.routines.routines[0]!,
            id: 'rtn_secondoverlap' as never,
            activeVersionId: 'rtv_secondoverlapv1' as never,
          },
        ],
        versions: [
          ...routineFixture.routines.versions,
          {
            ...routineFixture.routines.versions[0]!,
            id: 'rtv_secondoverlapv1' as never,
            routineId: 'rtn_secondoverlap' as never,
          },
        ],
      },
    }
    expect(() => kernel.analyze(ambiguous)).toThrow(/one active overlapping/)

    const issue = kernel.analyze(planningSnapshot()).materialIssue
    if (issue === null) throw new Error('Fixture requires a material issue')
    const clarification = answeredClarification(issue)
    const altered = planningSnapshot({
      clarification: {
        ...clarification,
        request: ClarificationRequestSchema.parse({
          ...clarification.request,
          choices: clarification.request.choices.map((choice, index) =>
            index === 0 ? { ...choice, description: 'Changed after the durable pause.' } : choice,
          ),
          payloadHash: computeClarificationRequestPayloadHash({
            organizationId: clarification.request.organizationId,
            missionId: clarification.request.missionId,
            requestedBy: clarification.request.requestedBy,
            question: clarification.request.question,
            choices: clarification.request.choices.map((choice, index) =>
              index === 0 ? { ...choice, description: 'Changed after the durable pause.' } : choice,
            ),
            evidenceRefs: clarification.request.evidenceRefs,
          }),
        }),
      },
    })
    expect(() => kernel.analyze(altered)).toThrow(/does not bind the current material conflict/)
  })

  it('routes Scheduled Hauler Access to a separate deterministic draft without clarification', async () => {
    const homecoming = new DeterministicHomecomingPlanningKernel(
      NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY,
    )
    const drafts = new DeterministicCaretakerProgramDraftPort(
      homecoming,
      new DeterministicHaulerAccessPlanningKernel(),
    )
    const snapshot = haulerPlanningSnapshot()

    await expect(drafts.synthesize(snapshot)).resolves.toMatchObject({
      missionId: IDS.mission,
      actions: [
        {
          type: 'replace_scheduled_hauler_access_routine',
          protectedRoutineId: 'rtn_oldhauleraccess',
          replacement: {
            trigger: {
              windowStart: '09:00',
              windowEnd: '10:00',
              authorizedIdentityTagId: 'tag_acorn_hauler' as never,
            },
            actions: [
              { type: 'grant_service_hatch_access', requireVerifiedIdentity: true },
              { type: 'lock_service_hatch', atWindowEnd: true },
            ],
          },
        },
      ],
    })
    await expect(
      new DeterministicCaretakerProgramMaterialIssuePort(homecoming).synthesize(snapshot),
    ).resolves.toBeNull()
  })
})

type SnapshotOptions = Readonly<{
  targetCelsius?: number
  intensityPercent?: number
  durationSeconds?: number
  comfortProjection?: number
  includeEnergyProjection?: boolean
  clarification?: CaretakerSynthesisSnapshot['clarification']
  contextBundleHash?: CaretakerSynthesisSnapshot['context']['bundleHash']
}>

function planningSnapshot(options: SnapshotOptions = {}): CaretakerSynthesisSnapshot {
  const comfort = projectionRecord(
    IDS.comfortEvidence,
    'rcp_comfortprojection',
    'homecoming.preference-energy-projection',
    options.comfortProjection ?? 18.4,
  )
  const energy = projectionRecord(
    IDS.energyEvidence,
    'rcp_energyprojection',
    'homecoming.energy-first-projection',
    13.2,
  )
  const persistedEvidence =
    options.includeEnergyProjection === false ? [comfort] : [comfort, energy]
  return {
    mission: {
      id: IDS.mission,
      palaceId: IDS.palace,
      programKind: 'night_shift_homecoming',
      objective: 'Make the Night Shift homecoming reliable without weakening safety.',
      constraints: {
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
      successCriteriaIds: ['safe_homecoming', 'bounded_energy'],
      state: { status: 'running', phase: 'plan' },
      version: 5,
    },
    context: {
      receiptId: IDS.context,
      bundleHash: options.contextBundleHash ?? hashToolValue({ context: 'planning' }),
      policyHash: 'a'.repeat(64) as never,
      toolRegistryHash: TOOL_REGISTRY_HASH,
      sources: [NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY.requiredPlanningSource],
    },
    palace: {
      id: IDS.palace,
      timezone: 'America/New_York',
      batteryAvailablePercentage: 62,
    },
    crew: {
      schedules: [
        {
          id: 'sch_nightshift01' as never,
          crewMemberId: 'crew_rockyfounder' as never,
          active: true,
          version: 2,
          timezone: 'America/New_York',
          windowStart: '00:00',
          windowEnd: '03:00',
        },
      ],
      preferences: [
        {
          id: 'pref_rockyhomecoming' as never,
          crewMemberId: 'crew_rockyfounder' as never,
          active: true,
          version: 4,
          targetCelsius: options.targetCelsius ?? 22,
          pathwayLightingIntensityPercent: options.intensityPercent ?? 60,
          pathwayLightingDurationSeconds: options.durationSeconds ?? 1_800,
        },
      ],
    },
    capabilities: {
      devices: [
        { id: 'dev_thermostat01' as never, kind: 'thermostat', health: 'online', version: 1 },
        { id: 'dev_pathlight001' as never, kind: 'pathway_light', health: 'online', version: 1 },
        { id: 'dev_lock00000001' as never, kind: 'lock', health: 'online', version: 1 },
      ],
      capabilities: [
        {
          id: 'cap_temperature01' as never,
          deviceId: 'dev_thermostat01' as never,
          kind: 'temperature_target',
          enabled: true,
          constraints: {},
        },
        {
          id: 'cap_lighting0001' as never,
          deviceId: 'dev_pathlight001' as never,
          kind: 'pathway_lighting',
          enabled: true,
          constraints: {},
        },
        {
          id: 'cap_lock00000001' as never,
          deviceId: 'dev_lock00000001' as never,
          kind: 'lock_desired_state',
          enabled: true,
          constraints: {},
        },
      ],
    },
    routines: {
      routines: [
        {
          id: 'rtn_midnightentry' as never,
          palaceId: IDS.palace,
          activeVersionId: 'rtv_midnightentryv3' as never,
        },
      ],
      versions: [
        {
          id: 'rtv_midnightentryv3' as never,
          routineId: 'rtn_midnightentry' as never,
          version: 3,
          status: 'active',
          definition: existingRoutine(),
        },
      ],
    },
    discovery: {
      palace: 'ready',
      crew: 'ready',
      capabilities: 'ready',
      routines: 'ready',
      knowledge: 'ready',
    },
    capabilityFit: 'supported',
    evidenceIds: persistedEvidence.map((record) => record.evidence.id),
    persistedEvidence,
    clarification: options.clarification ?? null,
  }
}

function haulerPlanningSnapshot(): CaretakerSynthesisSnapshot {
  const base = planningSnapshot()
  return {
    ...base,
    mission: {
      ...base.mission,
      programKind: 'scheduled_hauler_access',
      objective: 'Allow one verified hauler through the service hatch during the approved window.',
      constraints: {
        accessWindowStart: '09:00',
        accessWindowEnd: '10:00',
        authorizedIdentityTagId: 'tag_acorn_hauler',
        serviceHatchOnly: true,
        residentialHatchMustRemainLocked: true,
        finalServiceHatchState: 'locked',
      },
      successCriteriaIds: ['verified_hauler_inside_window', 'service_hatch_locked_after_access'],
    },
    context: { ...base.context, sources: [SCHEDULED_HAULER_ACCESS_PLANNING_SOURCE] },
    capabilities: {
      devices: [
        {
          id: 'dev_servicehatchlock' as never,
          kind: 'service_hatch_lock',
          health: 'online',
          version: 1,
        },
        {
          id: 'dev_residentialhatch' as never,
          kind: 'residential_hatch_lock',
          health: 'online',
          version: 1,
        },
      ],
      capabilities: [
        {
          id: 'cap_servicehatchaccess' as never,
          deviceId: 'dev_servicehatchlock' as never,
          kind: 'service_hatch_access',
          enabled: true,
          constraints: { maximumAccessSeconds: 900 },
        },
        {
          id: 'cap_residentiallock' as never,
          deviceId: 'dev_residentialhatch' as never,
          kind: 'residential_hatch_lock_state',
          enabled: true,
          constraints: { requiredState: 'locked' },
        },
      ],
    },
    routines: {
      routines: [
        {
          id: 'rtn_oldhauleraccess' as never,
          palaceId: IDS.palace,
          activeVersionId: 'rtv_oldhauleraccessv1' as never,
        },
      ],
      versions: [
        {
          id: 'rtv_oldhauleraccessv1' as never,
          routineId: 'rtn_oldhauleraccess' as never,
          version: 1,
          status: 'active',
          definition: {
            name: 'Old hauler access',
            trigger: {
              type: 'scheduled_access_window',
              windowStart: '08:30',
              windowEnd: '10:30',
              timezone: 'America/New_York',
              authorizedIdentityTagId: 'tag_acorn_hauler' as never,
            },
            actions: [
              {
                type: 'grant_service_hatch_access',
                durationSeconds: 600,
                requireVerifiedIdentity: true,
                compartment: 'service_hatch',
              },
              { type: 'lock_service_hatch', atWindowEnd: true },
            ],
            constraints: {
              serviceHatchOnly: true,
              residentialHatchMustRemainLocked: true,
              finalServiceHatchState: 'locked',
              hardInvariantIds: ['retry_preserves_logical_operation'],
            },
            projectedBatteryUsePercentagePoints: 2,
          },
        },
      ],
    },
    persistedEvidence: [],
    evidenceIds: [],
    clarification: null,
  }
}

function existingRoutine() {
  return {
    name: 'Midnight Entry v3',
    trigger: {
      type: 'verified_arrival' as const,
      windowStart: '00:00',
      windowEnd: '03:00',
      timezone: 'America/New_York',
    },
    actions: [
      { type: 'preheat' as const, targetCelsius: 18, completeBy: '02:00' },
      {
        type: 'pathway_lighting' as const,
        intensityPercent: 25,
        durationSeconds: 600,
        beginsAfter: 'verified_arrival' as const,
      },
      { type: 'unlock' as const, durationSeconds: 90, requireVerifiedIdentity: true as const },
      { type: 'lock_desired_state' as const, afterUnlockSeconds: 90 },
    ],
    constraints: {
      projectedBatteryUseMaxPercentagePoints: 15,
      hardInvariantIds: ['verified_identity_required_for_unlock' as const],
    },
    projectedBatteryUsePercentagePoints: 9.8,
  }
}

function projectionRecord(
  evidenceId: (typeof IDS)['comfortEvidence'],
  receiptId: string,
  ruleId: string,
  projectedUsePercentagePoints: number,
): PersistedEvidenceRecord {
  return PersistedEvidenceRecordSchema.parse({
    schemaVersion: 'persisted-evidence@1',
    evidence: {
      id: evidenceId,
      organizationId: IDS.organization,
      missionId: IDS.mission,
      palaceId: IDS.palace,
      observedAt: NOW,
      type: 'battery_projection',
      projectedUsePercentagePoints,
    },
    authorityReceipt: {
      schemaVersion: 'evidence-authority-receipt@1',
      id: ReceiptIdSchema.parse(receiptId),
      evidenceId,
      organizationId: IDS.organization,
      missionId: IDS.mission,
      palaceId: IDS.palace,
      verifiedAt: NOW,
      authority: 'application',
      producer: 'application_code',
      ruleId,
      ruleVersion: 1,
      inputEvidenceIds: [],
      derivationVerified: true,
    },
    persistedAt: NOW,
  })
}

function answeredClarification(
  issue: NonNullable<ReturnType<DeterministicHomecomingPlanningKernel['analyze']>['materialIssue']>,
  choiceId: 'energy_first' | 'comfort_first' = 'energy_first',
): { request: ClarificationRequest; answer: ClarificationAnswer } {
  const choices = [
    { id: 'energy_first', ...NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY.choices.energyFirst },
    { id: 'comfort_first', ...NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY.choices.comfortFirst },
  ] as const
  const requestPayload = {
    organizationId: IDS.organization,
    missionId: IDS.mission,
    requestedBy: IDS.service,
    question: issue.question,
    choices,
    evidenceRefs: issue.evidenceIds,
  }
  const request = ClarificationRequestSchema.parse({
    schemaVersion: 'clarification-request@1',
    ...requestPayload,
    id: 'clr_planningrequest',
    idempotencyKey: 'b'.repeat(64),
    payloadHash: computeClarificationRequestPayloadHash(requestPayload),
    status: 'answered',
    requestedAt: NOW,
    resolvedAt: '2026-08-14T05:36:00.000Z',
  })
  const answerPayload = {
    organizationId: IDS.organization,
    missionId: IDS.mission,
    requestId: request.id,
    choiceId,
    answeredBy: IDS.owner,
    evidenceRefs: [IDS.energyEvidence],
  }
  const answer = ClarificationAnswerSchema.parse({
    schemaVersion: 'clarification-answer@1',
    ...answerPayload,
    id: 'cla_planninganswer',
    idempotencyKey: 'c'.repeat(64),
    payloadHash: computeClarificationAnswerPayloadHash(answerPayload),
    answeredAt: '2026-08-14T05:36:00.000Z',
  })
  return { request, answer }
}

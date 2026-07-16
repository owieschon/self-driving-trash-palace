import { readFile, readdir } from 'node:fs/promises'

import {
  ClarificationService,
  HomecomingPlanSimulator,
  HomecomingPlanValidator,
  MissionLeaseService,
  NOOP_OBSERVABILITY,
  PlanService,
  hashCanonical,
  type AuthContext,
  type MissionExecutionContext,
  type SensitiveMutationGuardPort,
} from '@trash-palace/application'
import {
  FixedEntropy,
  MutableClock,
  SequentialIdGenerator,
  testCaretakerEvidenceProfile,
} from '@trash-palace/application/testing'
import {
  ClarificationCaretakerHumanPausePort,
  DeterministicCaretakerHomecomingDraftPort,
  DeterministicCaretakerMaterialIssuePort,
  DeterministicHomecomingPlanningKernel,
  NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY,
  StaticCaretakerClarificationChoiceProjector,
  homecomingClarificationChoiceDescriptions,
  type CaretakerSynthesisSnapshot,
} from '@trash-palace/agent'
import {
  CapabilityIdSchema,
  ClarificationChoiceIdSchema,
  CrewMemberIdSchema,
  CrewPreferenceIdSchema,
  CrewScheduleIdSchema,
  DeviceIdSchema,
  EvidenceIdSchema,
  MembershipIdSchema,
  MissionIdSchema,
  MissionSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PersistedEvidenceRecordSchema,
  PrincipalSchema,
  ReceiptIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  RunIdSchema,
  TOOL_REGISTRY_HASH,
  UserIdSchema,
  hashToolValue,
  type Mission,
  type PersistedEvidenceRecord,
} from '@trash-palace/core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabase, type Database } from './client.js'
import {
  PgBootstrapRepository,
  createMissionExecutionUnitOfWork,
  createUnitOfWork,
} from './repositories.js'

const databaseDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip
const NOW = '2026-08-14T05:35:00.000Z'
const ORG = OrganizationIdSchema.parse('org_planningpg')
const FOREIGN_ORG = OrganizationIdSchema.parse('org_planningforeign')
const OWNER = UserIdSchema.parse('usr_planningpgowner')
const SERVICE = UserIdSchema.parse('usr_planningpgservice')
const CLEAR_MISSION = MissionIdSchema.parse('mis_planningpgclear')
const CONFLICT_MISSION = MissionIdSchema.parse('mis_planningpgconflict')
const CLEAR_PALACE = PalaceIdSchema.parse('pal_planningpgclear')
const CONFLICT_PALACE = PalaceIdSchema.parse('pal_planningpgconflict')
const CONFLICT_RUN = RunIdSchema.parse('run_planningpgconflict')
const ENERGY_CHOICE = ClarificationChoiceIdSchema.parse('energy_first')
const allowMutation: SensitiveMutationGuardPort = { assert: () => undefined }

databaseDescribe('PostgreSQL-backed Caretaker planning adapters', () => {
  let pool: pg.Pool
  let database: Database
  let schemaName: string
  let unitOfWork: ReturnType<typeof createUnitOfWork>
  let fencedUnitOfWork: ReturnType<typeof createMissionExecutionUnitOfWork>
  let clock: MutableClock
  let ids: SequentialIdGenerator
  let clearContext: MissionExecutionContext
  let conflictContext: MissionExecutionContext
  let authContext: AuthContext
  let clarifications: ClarificationService

  beforeAll(async () => {
    schemaName = `trash_palace_planning_${process.pid}_${Date.now()}`
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
      options: `-c search_path=${schemaName},public`,
    })
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await applyMigrations(pool, schemaName)
    database = createDatabase(pool)
    unitOfWork = createUnitOfWork(database)
    fencedUnitOfWork = createMissionExecutionUnitOfWork(database)
    clock = new MutableClock(new Date(NOW))
    ids = new SequentialIdGenerator()

    const bootstrap = new PgBootstrapRepository(database)
    await bootstrap.insertOrganization({
      id: ORG,
      slug: 'planning-adapter',
      name: 'Planning Adapter',
      labTenant: true,
      createdAt: NOW,
    })
    await bootstrap.insertUser({ id: OWNER, displayName: 'Rocky', createdAt: NOW })
    await bootstrap.insertUser({ id: SERVICE, displayName: 'Caretaker', createdAt: NOW })
    await unitOfWork.run(ORG, async (repositories) => {
      await repositories.records.insertMembership({
        id: MembershipIdSchema.parse('mem_planningpgowner'),
        organizationId: ORG,
        userId: OWNER,
        role: 'owner',
        grants: [],
        createdAt: NOW,
        revokedAt: null,
      })
      await repositories.records.insertMembership({
        id: MembershipIdSchema.parse('mem_planningpgservice'),
        organizationId: ORG,
        userId: SERVICE,
        role: 'operator',
        grants: [],
        createdAt: NOW,
        revokedAt: null,
      })
      await seedPalace(repositories, {
        palaceId: CLEAR_PALACE,
        missionId: CLEAR_MISSION,
        suffix: 'clear',
        targetCelsius: 20,
        lightingIntensity: 40,
        lightingDuration: 900,
        preferenceProjection: 13.2,
        includeEnergyProjection: false,
      })
      await seedPalace(repositories, {
        palaceId: CONFLICT_PALACE,
        missionId: CONFLICT_MISSION,
        suffix: 'conflict',
        targetCelsius: 22,
        lightingIntensity: 60,
        lightingDuration: 1_800,
        preferenceProjection: 18.4,
        includeEnergyProjection: true,
      })
    })

    const leases = new MissionLeaseService(unitOfWork, clock, ids, new FixedEntropy())
    const [clearLease, conflictLease] = await Promise.all([
      leases.acquire({
        organizationId: ORG,
        missionId: CLEAR_MISSION,
        ownerId: 'planning-clear-worker',
      }),
      leases.acquire({
        organizationId: ORG,
        missionId: CONFLICT_MISSION,
        ownerId: 'planning-conflict-worker',
      }),
    ])
    const servicePrincipal = PrincipalSchema.parse({
      organizationId: ORG,
      actorId: SERVICE,
      role: 'service',
      operatorGrants: [],
      delegatedPermissions: [],
    })
    clearContext = {
      fence: clearLease.fence,
      signal: new AbortController().signal,
      principal: servicePrincipal,
    }
    conflictContext = {
      fence: conflictLease.fence,
      signal: new AbortController().signal,
      principal: servicePrincipal,
    }
    await fencedUnitOfWork.runFenced(conflictContext.fence, (repositories) =>
      repositories.caretakerRuns.start({
        runId: CONFLICT_RUN,
        missionId: CONFLICT_MISSION,
        mutationKey: hashCanonical({ kind: 'start-conflict-planning-run' }),
        evidenceProfile: testCaretakerEvidenceProfile(CONFLICT_RUN),
        occurredAt: NOW,
      }),
    )
    authContext = {
      sessionId: 'session_planning_pg_fixture_0001',
      principal: PrincipalSchema.parse({
        organizationId: ORG,
        actorId: OWNER,
        role: 'owner',
        operatorGrants: [],
        delegatedPermissions: [],
      }),
      csrfToken: 'csrf_planning_pg_fixture_000001',
      issuedAt: NOW,
      authenticatedAt: NOW,
      expiresAt: '2026-08-14T06:35:00.000Z',
    }
    clarifications = new ClarificationService(
      unitOfWork,
      fencedUnitOfWork,
      allowMutation,
      clock,
      ids,
    )
  }, 30_000)

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  }, 30_000)

  it('persists the clear candidate only through PlanService validation and simulation', async () => {
    const kernel = new DeterministicHomecomingPlanningKernel(NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY)
    const snapshot = await loadSnapshot(clearContext, CLEAR_MISSION)
    const proposal = await new DeterministicCaretakerHomecomingDraftPort(kernel).synthesize(
      snapshot,
    )
    expect(proposal).not.toBeNull()
    expect(
      await new DeterministicCaretakerMaterialIssuePort(kernel).synthesize(snapshot),
    ).toBeNull()
    if (proposal === null) throw new Error('Clear planning fixture requires a proposal')

    const plans = productionPlanService()
    const candidate = await plans.propose({ context: clearContext, ...proposal })
    const validation = await plans.validate({ context: clearContext, planId: candidate.id })
    const simulation = await plans.simulate({
      context: clearContext,
      planId: candidate.id,
      scenarios: ['timing', 'access', 'energy', 'transport_failure'],
    })

    expect(validation.valid).toBe(true)
    expect(simulation).toMatchObject({
      feasible: true,
      projectedBatteryUsePercentagePoints: 13.2,
    })
    await expect(
      unitOfWork.run(FOREIGN_ORG, (repositories) => repositories.plans.get(candidate.id)),
    ).resolves.toBeNull()
  })

  it('persists one replay-safe pause and resumes planning from the exact durable answer', async () => {
    const kernel = new DeterministicHomecomingPlanningKernel(NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY)
    const initial = await loadSnapshot(conflictContext, CONFLICT_MISSION)
    const issue = await new DeterministicCaretakerMaterialIssuePort(kernel).synthesize(initial)
    if (issue === null) throw new Error('Conflict planning fixture requires a material issue')
    expect(
      await new DeterministicCaretakerHomecomingDraftPort(kernel).synthesize(initial),
    ).toBeNull()

    const pause = new ClarificationCaretakerHumanPausePort({
      unitOfWork: fencedUnitOfWork,
      clarifications,
      choices: new StaticCaretakerClarificationChoiceProjector(
        homecomingClarificationChoiceDescriptions(),
      ),
    })
    const requestInput = {
      context: conflictContext,
      missionId: CONFLICT_MISSION,
      runId: CONFLICT_RUN,
      materialField: issue.field,
      question: issue.question,
      choices: issue.choices,
      evidenceIds: issue.evidenceIds,
      signal: conflictContext.signal,
    } as const
    await pause.requestClarification(requestInput)
    await pause.requestClarification(requestInput)

    const pending = await fencedUnitOfWork.runFenced(
      conflictContext.fence,
      async (repositories) => {
        const request = await repositories.clarifications.findLatestForMission(CONFLICT_MISSION)
        const mission = await repositories.missions.get(CONFLICT_MISSION)
        return { request, mission }
      },
    )
    expect(pending).toMatchObject({
      request: { status: 'pending' },
      mission: { version: 5, state: { status: 'waiting_for_user', phase: 'plan' } },
    })
    if (pending.request === null) throw new Error('Clarification request was not persisted')
    await clarifications.answer({
      context: authContext,
      requestId: pending.request.id,
      expectedMissionVersion: 5,
      idempotencyKey: hashCanonical({ kind: 'answer-conflict-planning', choice: ENERGY_CHOICE }),
      choiceId: ENERGY_CHOICE,
      evidenceRefs: [energyEvidenceId('conflict')],
      csrfToken: authContext.csrfToken,
      origin: 'http://trash-palace.test',
      allowedOrigin: 'http://trash-palace.test',
    })

    const resumed = await loadSnapshot(conflictContext, CONFLICT_MISSION)
    const resolved = await new DeterministicCaretakerMaterialIssuePort(kernel).synthesize(resumed)
    const proposal = await new DeterministicCaretakerHomecomingDraftPort(kernel).synthesize(resumed)
    expect(resolved).toMatchObject({ resolvedChoiceId: ENERGY_CHOICE })
    expect(proposal).not.toBeNull()
    if (proposal === null) throw new Error('Answered planning fixture requires a proposal')

    const plans = productionPlanService()
    const candidate = await plans.propose({ context: conflictContext, ...proposal })
    const validation = await plans.validate({ context: conflictContext, planId: candidate.id })
    const simulation = await plans.simulate({
      context: conflictContext,
      planId: candidate.id,
      scenarios: ['timing', 'access', 'energy', 'transport_failure'],
    })
    expect(validation.valid).toBe(true)
    expect(simulation.feasible).toBe(true)

    const counts = await pool.query<{ requests: number; answers: number }>(
      `SELECT
         (SELECT count(*)::integer FROM clarification_requests WHERE mission_id = $1) AS requests,
         (SELECT count(*)::integer FROM clarification_answers WHERE mission_id = $1) AS answers`,
      [CONFLICT_MISSION],
    )
    expect(counts.rows).toEqual([{ requests: 1, answers: 1 }])
  })

  function productionPlanService(): PlanService {
    return new PlanService(
      unitOfWork,
      new HomecomingPlanValidator(unitOfWork),
      new HomecomingPlanSimulator(),
      clock,
      ids,
      NOOP_OBSERVABILITY,
      fencedUnitOfWork,
    )
  }

  async function loadSnapshot(
    context: MissionExecutionContext,
    missionId: Mission['id'],
  ): Promise<CaretakerSynthesisSnapshot> {
    return fencedUnitOfWork.runFenced(context.fence, async (repositories) => {
      const mission = await repositories.missions.get(missionId)
      if (mission === null) throw new Error('Planning mission is absent')
      // The fenced unit of work owns one PostgreSQL client; pg 9 rejects overlapping queries.
      const palace = await repositories.palaces.get(mission.palaceId)
      const crew = await repositories.crews.list(mission.palaceId, true)
      const capabilities = await repositories.capabilities.list(mission.palaceId)
      const routines = await repositories.routines.list(mission.palaceId)
      const persistedEvidence = await repositories.evidence.listForMission(mission.id)
      const request = await repositories.clarifications.findLatestForMission(mission.id)
      if (palace === null) throw new Error('Planning palace is absent')
      const answer =
        request === null ? null : await repositories.clarifications.getAnswerForRequest(request.id)
      return {
        mission: {
          id: mission.id,
          palaceId: mission.palaceId,
          objective: mission.objective,
          constraints: mission.constraints,
          successCriteriaIds: mission.successCriteriaIds,
          state: mission.state,
          version: mission.version,
        },
        context: {
          receiptId: `ctx_${hashToolValue(mission.id).slice(0, 24)}` as never,
          bundleHash: hashToolValue({ missionId: mission.id, version: mission.version }),
          policyHash: 'a'.repeat(64) as never,
          toolRegistryHash: TOOL_REGISTRY_HASH,
          sources: [NIGHT_SHIFT_HOMECOMING_PLANNING_POLICY.requiredPlanningSource],
        },
        palace: {
          id: palace.id,
          timezone: palace.timezone,
          batteryAvailablePercentage: palace.batteryAvailablePercentage,
        },
        crew: { schedules: crew.schedules, preferences: crew.preferences },
        capabilities,
        routines,
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
        clarification: request === null ? null : { request, answer },
      }
    })
  }
})

type SeedInput = Readonly<{
  palaceId: ReturnType<typeof PalaceIdSchema.parse>
  missionId: ReturnType<typeof MissionIdSchema.parse>
  suffix: 'clear' | 'conflict'
  targetCelsius: number
  lightingIntensity: number
  lightingDuration: number
  preferenceProjection: number
  includeEnergyProjection: boolean
}>

async function seedPalace(
  repositories: Parameters<Parameters<ReturnType<typeof createUnitOfWork>['run']>[1]>[0],
  input: SeedInput,
): Promise<void> {
  const crewId = CrewMemberIdSchema.parse(`crew_planningpg${input.suffix}`)
  const scheduleId = CrewScheduleIdSchema.parse(`sch_planningpg${input.suffix}`)
  const preferenceId = CrewPreferenceIdSchema.parse(`pref_planningpg${input.suffix}`)
  const routineId = RoutineIdSchema.parse(`rtn_planningpg${input.suffix}`)
  const routineVersionId = RoutineVersionIdSchema.parse(`rtv_planningpg${input.suffix}v3`)
  await repositories.records.insertPalace({
    id: input.palaceId,
    organizationId: ORG,
    name: `${input.suffix} Planning Palace`,
    timezone: 'America/New_York',
    batteryAvailablePercentage: 62,
    createdAt: NOW,
  })
  await repositories.records.insertCrewMember({
    id: crewId,
    organizationId: ORG,
    palaceId: input.palaceId,
    userId: OWNER,
    displayName: 'Rocky',
    active: true,
  })
  await repositories.records.insertCrewSchedule({
    id: scheduleId,
    organizationId: ORG,
    palaceId: input.palaceId,
    crewMemberId: crewId,
    active: true,
    version: 2,
    timezone: 'America/New_York',
    windowStart: '00:00',
    windowEnd: '03:00',
  })
  await repositories.records.insertCrewPreference({
    id: preferenceId,
    organizationId: ORG,
    palaceId: input.palaceId,
    crewMemberId: crewId,
    kind: 'homecoming_comfort',
    active: true,
    version: 4,
    targetCelsius: input.targetCelsius,
    pathwayLightingIntensityPercent: input.lightingIntensity,
    pathwayLightingDurationSeconds: input.lightingDuration,
  })
  const deviceInputs = [
    ['thermostat', 'temperature_target'],
    ['pathway_light', 'pathway_lighting'],
    ['lock', 'lock_desired_state'],
  ] as const
  for (const [kind, capabilityKind] of deviceInputs) {
    const compactKind = kind.replaceAll('_', '')
    const deviceId = DeviceIdSchema.parse(`dev_${input.suffix}${compactKind}`)
    await repositories.records.insertDevice({
      id: deviceId,
      organizationId: ORG,
      palaceId: input.palaceId,
      kind,
      name: `${input.suffix} ${kind}`,
      health: 'online',
      version: 1,
    })
    await repositories.records.insertCapability({
      id: CapabilityIdSchema.parse(`cap_${input.suffix}${compactKind}`),
      organizationId: ORG,
      deviceId,
      kind: capabilityKind,
      enabled: true,
      constraints: {},
    })
  }
  await repositories.records.insertRoutine(
    {
      id: routineId,
      organizationId: ORG,
      palaceId: input.palaceId,
      name: 'Midnight Entry',
      activeVersionId: routineVersionId,
      createdAt: NOW,
    },
    {
      id: routineVersionId,
      routineId,
      organizationId: ORG,
      version: 3,
      status: 'active',
      definition: existingRoutine(),
      sourcePlanId: null,
      sourcePlanHash: null,
      createdAt: NOW,
    },
  )
  await repositories.missions.insert(mission(input.missionId, input.palaceId))
  const records = [
    projectionRecord(
      preferenceEvidenceId(input.suffix),
      `rcp_${input.suffix}preference`,
      input.missionId,
      input.palaceId,
      'homecoming.preference-energy-projection',
      input.preferenceProjection,
    ),
  ]
  if (input.includeEnergyProjection) {
    records.push(
      projectionRecord(
        energyEvidenceId(input.suffix),
        `rcp_${input.suffix}energy`,
        input.missionId,
        input.palaceId,
        'homecoming.energy-first-projection',
        13.2,
      ),
    )
  }
  await repositories.evidence.appendMany(records)
}

function mission(missionId: Mission['id'], palaceId: Mission['palaceId']): Mission {
  return MissionSchema.parse({
    id: missionId,
    organizationId: ORG,
    palaceId,
    initiatedBy: OWNER,
    objective: 'Create one safe and energy-bounded homecoming routine.',
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    successCriteriaIds: ['safe_homecoming', 'bounded_energy'],
    state: { status: 'running', phase: 'plan' },
    version: 4,
    runId: null,
    contextReceiptId: null,
    taskLedger: [],
    createdAt: NOW,
    updatedAt: NOW,
  })
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

function preferenceEvidenceId(suffix: SeedInput['suffix']) {
  return EvidenceIdSchema.parse(`evd_${suffix}preferenceprojection`)
}

function energyEvidenceId(suffix: SeedInput['suffix']) {
  return EvidenceIdSchema.parse(`evd_${suffix}energyprojection`)
}

function projectionRecord(
  evidenceId: ReturnType<typeof EvidenceIdSchema.parse>,
  receiptId: string,
  missionId: Mission['id'],
  palaceId: Mission['palaceId'],
  ruleId: string,
  projectedUsePercentagePoints: number,
): PersistedEvidenceRecord {
  return PersistedEvidenceRecordSchema.parse({
    schemaVersion: 'persisted-evidence@1',
    evidence: {
      id: evidenceId,
      organizationId: ORG,
      missionId,
      palaceId,
      observedAt: NOW,
      type: 'battery_projection',
      projectedUsePercentagePoints,
    },
    authorityReceipt: {
      schemaVersion: 'evidence-authority-receipt@1',
      id: ReceiptIdSchema.parse(receiptId),
      evidenceId,
      organizationId: ORG,
      missionId,
      palaceId,
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

async function applyMigrations(pool: pg.Pool, schemaName: string): Promise<void> {
  const migrationDirectory = new URL('../migrations/', import.meta.url)
  const filenames = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort()
  for (const filename of filenames) {
    const migration = (await readFile(new URL(filename, migrationDirectory), 'utf8')).replaceAll(
      '"public".',
      `"${schemaName}".`,
    )
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) await pool.query(statement)
    }
  }
}

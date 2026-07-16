import {
  CapabilityIdSchema,
  CapabilitySchema,
  ContextReceiptIdSchema,
  ContextReceiptSchema,
  CrewMemberIdSchema,
  CrewMemberSchema,
  CrewPreferenceIdSchema,
  CrewPreferenceSchema,
  CrewScheduleIdSchema,
  CrewScheduleSchema,
  DeviceIdSchema,
  DeviceSchema,
  EvidenceIdSchema,
  ExecutionIdSchema,
  ExecutionSchema,
  IdentityTagIdSchema,
  IdentityTagSchema,
  MissionIdSchema,
  MissionSchema,
  OperationIdSchema,
  PalaceIdSchema,
  PalaceSchema,
  RoutineDefinitionSchema,
  RoutineIdSchema,
  RoutineSchema,
  RoutineVersionIdSchema,
  RoutineVersionSchema,
  RunIdSchema,
  type ContextReceipt,
  type Mission,
  type MissionId,
  type OrganizationId,
  type RoutineId,
  type RoutineVersionId,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { ApplicationError, ConflictError } from '../errors.js'
import { TenantReadService } from '../tenant-read-service.js'
import { InMemoryApplicationStore } from '../testing/fakes.js'
import type { InMemorySeed } from '../testing/fakes.js'
import { IDS, NOW, authContext, makeMission } from './fixtures.js'

const FOREIGN = {
  palace: PalaceIdSchema.parse('pal_foreign00001'),
  mission: MissionIdSchema.parse('mis_foreign00001'),
  routine: RoutineIdSchema.parse('rtn_foreign00001'),
  routineVersion: RoutineVersionIdSchema.parse('rtv_foreign00001'),
} as const

const MISSING = {
  palace: PalaceIdSchema.parse('pal_missing000001'),
  mission: MissionIdSchema.parse('mis_missing000001'),
  routine: RoutineIdSchema.parse('rtn_missing000001'),
  receipt: ContextReceiptIdSchema.parse('ctx_missing000001'),
} as const

const ACTIVE_CREW_ID = CrewMemberIdSchema.parse('crew_rocky000001')
const INACTIVE_CREW_ID = CrewMemberIdSchema.parse('crew_retired00001')
const ACTIVE_TAG_ID = IdentityTagIdSchema.parse('tag_rocky000001')
const ACTIVE_SCHEDULE_ID = CrewScheduleIdSchema.parse('sch_rocky000001')
const ACTIVE_PREFERENCE_ID = CrewPreferenceIdSchema.parse('pref_rocky00001')
const CAPABILITY_ID = CapabilityIdSchema.parse('cap_temperature01')
const HISTORICAL_VERSION_ID = RoutineVersionIdSchema.parse('rtv_midnight0002')
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

const ROUTINE_DEFINITION = RoutineDefinitionSchema.parse({
  name: 'Midnight Entry',
  trigger: {
    type: 'verified_arrival',
    windowStart: '00:00',
    windowEnd: '03:00',
    timezone: 'America/New_York',
  },
  actions: [
    { type: 'preheat', targetCelsius: 22, completeBy: '02:00' },
    {
      type: 'pathway_lighting',
      intensityPercent: 60,
      durationSeconds: 1_800,
      beginsAfter: 'verified_arrival',
    },
    { type: 'unlock', durationSeconds: 90, requireVerifiedIdentity: true },
    { type: 'lock_desired_state', afterUnlockSeconds: 90 },
  ],
  constraints: {
    projectedBatteryUseMaxPercentagePoints: 15,
    hardInvariantIds: [
      'verified_identity_required_for_unlock',
      'routine_activation_validated',
      'exact_plan_approval_required',
    ],
  },
  projectedBatteryUsePercentagePoints: 12.5,
})

describe('tenant read projections', () => {
  it('returns complete canonical projections without leaking the mirror tenant', async () => {
    const store = new InMemoryApplicationStore(readSeed())
    const service = new TenantReadService(store)

    await expect(
      service.getPalace({ context: authContext, palaceId: IDS.palace }),
    ).resolves.toMatchObject({
      palace: { id: IDS.palace, batteryAvailablePercentage: 72 },
    })

    const activeCrew = await service.listCrews({
      context: authContext,
      palaceId: IDS.palace,
    })
    expect(activeCrew.crew.map((member) => member.id)).toEqual([ACTIVE_CREW_ID])
    expect(activeCrew.identityTags.map((tag) => tag.id)).toEqual([ACTIVE_TAG_ID])
    expect(activeCrew.schedules.map((schedule) => schedule.id)).toEqual([ACTIVE_SCHEDULE_ID])
    expect(activeCrew.preferences.map((preference) => preference.id)).toEqual([
      ACTIVE_PREFERENCE_ID,
    ])

    const allCrew = await service.listCrews({
      context: authContext,
      palaceId: IDS.palace,
      activeOnly: false,
    })
    expect(new Set(allCrew.crew.map((member) => member.id))).toEqual(
      new Set([ACTIVE_CREW_ID, INACTIVE_CREW_ID]),
    )
    expect(allCrew.identityTags).toHaveLength(2)
    expect(allCrew.schedules).toHaveLength(2)
    expect(allCrew.preferences).toHaveLength(2)

    const capabilityProjection = await service.listCapabilities({
      context: authContext,
      palaceId: IDS.palace,
    })
    expect(capabilityProjection.devices).toEqual([
      expect.objectContaining({ id: IDS.device, health: 'degraded' }),
    ])
    expect(capabilityProjection.capabilities).toEqual([
      expect.objectContaining({ id: CAPABILITY_ID, deviceId: IDS.device }),
    ])

    const routineProjection = await service.listRoutines({
      context: authContext,
      palaceId: IDS.palace,
    })
    expect(routineProjection.routines.map((routine) => routine.id)).toEqual([IDS.protectedRoutine])
    expect(routineProjection.versions.map((version) => version.id)).toEqual([
      IDS.protectedVersion,
      HISTORICAL_VERSION_ID,
    ])
    const historicalProjection = await service.listRoutines({
      context: authContext,
      palaceId: IDS.palace,
      statuses: ['inactive'],
    })
    expect(historicalProjection.versions.map((version) => version.id)).toEqual([
      HISTORICAL_VERSION_ID,
    ])

    await expect(
      service.getRoutine({ context: authContext, routineId: IDS.protectedRoutine }),
    ).resolves.toMatchObject({ version: { id: IDS.protectedVersion, status: 'active' } })
    await expect(
      service.getRoutine({
        context: authContext,
        routineId: IDS.protectedRoutine,
        versionId: HISTORICAL_VERSION_ID,
      }),
    ).resolves.toMatchObject({ version: { id: HISTORICAL_VERSION_ID, status: 'inactive' } })

    const recentExecution = await service.listExecutions({
      context: authContext,
      routineId: IDS.protectedRoutine,
      limit: 1,
    })
    expect(recentExecution.executions.map((execution) => execution.id)).toEqual([
      ExecutionIdSchema.parse('exe_recent0000001'),
    ])
    const missionHistory = await service.listExecutions({
      context: authContext,
      missionId: IDS.mission,
    })
    expect(missionHistory.executions).toHaveLength(2)
    expect(
      missionHistory.executions.every((execution) => execution.organizationId === IDS.organization),
    ).toBe(true)
  })

  it('makes absent and foreign identifiers observationally identical', async () => {
    const service = new TenantReadService(new InMemoryApplicationStore(readSeed()))

    await expectSameFailure(
      service.getPalace({ context: authContext, palaceId: MISSING.palace }),
      service.getPalace({ context: authContext, palaceId: FOREIGN.palace }),
    )
    await expectSameFailure(
      service.listCrews({ context: authContext, palaceId: MISSING.palace }),
      service.listCrews({ context: authContext, palaceId: FOREIGN.palace }),
    )
    await expectSameFailure(
      service.listCapabilities({ context: authContext, palaceId: MISSING.palace }),
      service.listCapabilities({ context: authContext, palaceId: FOREIGN.palace }),
    )
    await expectSameFailure(
      service.listRoutines({ context: authContext, palaceId: MISSING.palace }),
      service.listRoutines({ context: authContext, palaceId: FOREIGN.palace }),
    )
    await expectSameFailure(
      service.getRoutine({ context: authContext, routineId: MISSING.routine }),
      service.getRoutine({ context: authContext, routineId: FOREIGN.routine }),
    )
    await expectSameFailure(
      service.listExecutions({ context: authContext, routineId: MISSING.routine }),
      service.listExecutions({ context: authContext, routineId: FOREIGN.routine }),
    )
    await expectSameFailure(
      service.listExecutions({ context: authContext, missionId: MISSING.mission }),
      service.listExecutions({ context: authContext, missionId: FOREIGN.mission }),
    )
  })
})

describe('context receipt persistence port', () => {
  it('is append-only, schema-validating, and tenant-bound', async () => {
    const primary = contextReceipt('ctx_primary000001', IDS.organization, IDS.mission)
    const foreign = contextReceipt('ctx_foreign000001', IDS.otherOrganization, FOREIGN.mission)
    const store = new InMemoryApplicationStore({
      missions: [makeMission(), foreignMission()],
      contextReceipts: [primary, foreign],
    })

    const visible = await store.run(IDS.organization, async (repositories) => ({
      primary: await repositories.contextReceipts.get(primary.id),
      foreign: await repositories.contextReceipts.get(foreign.id),
      missing: await repositories.contextReceipts.get(MISSING.receipt),
    }))
    expect(visible.primary).toEqual(primary)
    expect(visible.foreign).toBeNull()
    expect(visible.missing).toEqual(visible.foreign)

    const inserted = contextReceipt('ctx_inserted00001', IDS.organization, IDS.mission)
    await store.run(IDS.organization, (repositories) =>
      repositories.contextReceipts.insert(inserted),
    )
    expect((await store.snapshot()).contextReceipts).toContainEqual(inserted)

    await expect(
      store.run(IDS.organization, (repositories) => repositories.contextReceipts.insert(inserted)),
    ).rejects.toBeInstanceOf(ConflictError)
    await expect(
      store.run(IDS.organization, (repositories) => repositories.contextReceipts.insert(foreign)),
    ).rejects.toBeInstanceOf(ConflictError)
    await expect(
      store.run(IDS.organization, (repositories) =>
        repositories.contextReceipts.insert({
          ...inserted,
          id: ContextReceiptIdSchema.parse('ctx_wrongmission1'),
          missionId: FOREIGN.mission,
        }),
      ),
    ).rejects.toThrow(/mission does not exist/)
    await expect(
      store.run(IDS.organization, (repositories) =>
        repositories.contextReceipts.insert({
          ...inserted,
          id: ContextReceiptIdSchema.parse('ctx_malformed0001'),
          sources: [],
        }),
      ),
    ).rejects.toThrow(/Too small/)
  })
})

function readSeed(): InMemorySeed {
  const primaryMission = makeMission()
  const primaryRoutine = RoutineSchema.parse({
    id: IDS.protectedRoutine,
    organizationId: IDS.organization,
    palaceId: IDS.palace,
    name: 'Midnight Entry',
    activeVersionId: IDS.protectedVersion,
    createdAt: NOW,
  })
  const foreignRoutine = RoutineSchema.parse({
    id: FOREIGN.routine,
    organizationId: IDS.otherOrganization,
    palaceId: FOREIGN.palace,
    name: 'Midnight Entry',
    activeVersionId: FOREIGN.routineVersion,
    createdAt: NOW,
  })
  const primaryExecution = execution(
    'exe_earlier000001',
    IDS.organization,
    IDS.mission,
    IDS.protectedRoutine,
    IDS.protectedVersion,
    '2026-08-14T05:40:00.000Z',
  )
  const recentExecution = execution(
    'exe_recent0000001',
    IDS.organization,
    IDS.mission,
    IDS.protectedRoutine,
    IDS.protectedVersion,
    '2026-08-14T05:45:00.000Z',
  )
  const foreignExecution = execution(
    'exe_foreign000001',
    IDS.otherOrganization,
    FOREIGN.mission,
    FOREIGN.routine,
    FOREIGN.routineVersion,
    '2026-08-14T05:50:00.000Z',
  )
  return {
    palaces: [
      PalaceSchema.parse({
        id: IDS.palace,
        organizationId: IDS.organization,
        name: 'Sacred Dumpster Palace',
        timezone: 'America/New_York',
        batteryAvailablePercentage: 72,
        createdAt: NOW,
      }),
      PalaceSchema.parse({
        id: FOREIGN.palace,
        organizationId: IDS.otherOrganization,
        name: 'Sacred Dumpster Palace',
        timezone: 'America/New_York',
        batteryAvailablePercentage: 72,
        createdAt: NOW,
      }),
    ],
    crewMembers: [
      CrewMemberSchema.parse({
        id: ACTIVE_CREW_ID,
        organizationId: IDS.organization,
        palaceId: IDS.palace,
        userId: IDS.owner,
        displayName: 'Rocky',
        active: true,
      }),
      CrewMemberSchema.parse({
        id: INACTIVE_CREW_ID,
        organizationId: IDS.organization,
        palaceId: IDS.palace,
        userId: null,
        displayName: 'Retired Resident',
        active: false,
      }),
      CrewMemberSchema.parse({
        id: CrewMemberIdSchema.parse('crew_foreign0001'),
        organizationId: IDS.otherOrganization,
        palaceId: FOREIGN.palace,
        userId: null,
        displayName: 'Rocky',
        active: true,
      }),
    ],
    identityTags: [
      IdentityTagSchema.parse({
        id: ACTIVE_TAG_ID,
        organizationId: IDS.organization,
        crewMemberId: ACTIVE_CREW_ID,
        label: 'Rocky ring',
        verified: true,
        active: true,
        version: 3,
      }),
      IdentityTagSchema.parse({
        id: IdentityTagIdSchema.parse('tag_inactive0001'),
        organizationId: IDS.organization,
        crewMemberId: ACTIVE_CREW_ID,
        label: 'Old ring',
        verified: true,
        active: false,
        version: 1,
      }),
      IdentityTagSchema.parse({
        id: IdentityTagIdSchema.parse('tag_foreign00001'),
        organizationId: IDS.otherOrganization,
        crewMemberId: CrewMemberIdSchema.parse('crew_foreign0001'),
        label: 'Rocky ring',
        verified: true,
        active: true,
        version: 3,
      }),
    ],
    crewSchedules: [
      CrewScheduleSchema.parse({
        id: ACTIVE_SCHEDULE_ID,
        organizationId: IDS.organization,
        palaceId: IDS.palace,
        crewMemberId: ACTIVE_CREW_ID,
        active: true,
        version: 3,
        timezone: 'America/New_York',
        windowStart: '00:00',
        windowEnd: '03:00',
      }),
      CrewScheduleSchema.parse({
        id: CrewScheduleIdSchema.parse('sch_inactive0001'),
        organizationId: IDS.organization,
        palaceId: IDS.palace,
        crewMemberId: ACTIVE_CREW_ID,
        active: false,
        version: 1,
        timezone: 'America/New_York',
        windowStart: '21:00',
        windowEnd: '23:00',
      }),
    ],
    crewPreferences: [
      CrewPreferenceSchema.parse({
        id: ACTIVE_PREFERENCE_ID,
        organizationId: IDS.organization,
        palaceId: IDS.palace,
        crewMemberId: ACTIVE_CREW_ID,
        kind: 'homecoming_comfort',
        active: true,
        version: 3,
        targetCelsius: 22,
        pathwayLightingIntensityPercent: 60,
        pathwayLightingDurationSeconds: 1_800,
      }),
      CrewPreferenceSchema.parse({
        id: CrewPreferenceIdSchema.parse('pref_inactive001'),
        organizationId: IDS.organization,
        palaceId: IDS.palace,
        crewMemberId: ACTIVE_CREW_ID,
        kind: 'homecoming_comfort',
        active: false,
        version: 1,
        targetCelsius: 19,
        pathwayLightingIntensityPercent: 30,
        pathwayLightingDurationSeconds: 600,
      }),
    ],
    devices: [
      DeviceSchema.parse({
        id: IDS.device,
        organizationId: IDS.organization,
        palaceId: IDS.palace,
        kind: 'thermostat',
        name: 'Compost thermostat',
        health: 'degraded',
        version: 4,
      }),
      DeviceSchema.parse({
        id: DeviceIdSchema.parse('dev_foreign00001'),
        organizationId: IDS.otherOrganization,
        palaceId: FOREIGN.palace,
        kind: 'thermostat',
        name: 'Compost thermostat',
        health: 'online',
        version: 4,
      }),
    ],
    capabilities: [
      CapabilitySchema.parse({
        id: CAPABILITY_ID,
        organizationId: IDS.organization,
        deviceId: IDS.device,
        kind: 'temperature_target',
        enabled: true,
        constraints: { minimumCelsius: 5, maximumCelsius: 35 },
      }),
      CapabilitySchema.parse({
        id: CapabilityIdSchema.parse('cap_foreign00001'),
        organizationId: IDS.otherOrganization,
        deviceId: DeviceIdSchema.parse('dev_foreign00001'),
        kind: 'temperature_target',
        enabled: true,
        constraints: { minimumCelsius: 5, maximumCelsius: 35 },
      }),
    ],
    missions: [primaryMission, foreignMission()],
    routines: [primaryRoutine, foreignRoutine],
    routineVersionRecords: [
      RoutineVersionSchema.parse({
        id: IDS.protectedVersion,
        routineId: IDS.protectedRoutine,
        organizationId: IDS.organization,
        version: 3,
        status: 'active',
        definition: ROUTINE_DEFINITION,
        sourcePlanId: null,
        sourcePlanHash: null,
        createdAt: NOW,
      }),
      RoutineVersionSchema.parse({
        id: HISTORICAL_VERSION_ID,
        routineId: IDS.protectedRoutine,
        organizationId: IDS.organization,
        version: 2,
        status: 'inactive',
        definition: ROUTINE_DEFINITION,
        sourcePlanId: null,
        sourcePlanHash: null,
        createdAt: '2026-08-13T05:35:00.000Z',
      }),
      RoutineVersionSchema.parse({
        id: FOREIGN.routineVersion,
        routineId: FOREIGN.routine,
        organizationId: IDS.otherOrganization,
        version: 3,
        status: 'active',
        definition: ROUTINE_DEFINITION,
        sourcePlanId: null,
        sourcePlanHash: null,
        createdAt: NOW,
      }),
    ],
    executions: [
      {
        operationId: OperationIdSchema.parse('op_earlier000001'),
        execution: primaryExecution,
        authorization: { kind: 'manual' },
      },
      {
        operationId: OperationIdSchema.parse('op_recent0000001'),
        execution: recentExecution,
        authorization: { kind: 'manual' },
      },
      {
        operationId: OperationIdSchema.parse('op_foreign000001'),
        execution: foreignExecution,
        authorization: { kind: 'manual' },
      },
    ],
  }
}

function execution(
  id: string,
  organizationId: OrganizationId,
  missionId: MissionId,
  routineId: RoutineId,
  versionId: RoutineVersionId,
  startedAt: string,
) {
  const operationId = OperationIdSchema.parse(id.replace(/^exe_/, 'op_'))
  return ExecutionSchema.parse({
    id: ExecutionIdSchema.parse(id),
    organizationId,
    missionId,
    operationId,
    routineId,
    routineVersionId: versionId,
    status: 'running',
    triggeredByEvidenceId: EvidenceIdSchema.parse('evd_arrival000001'),
    evidenceIds: [EvidenceIdSchema.parse('evd_arrival000001')],
    startedAt,
    deadline: new Date(Date.parse(startedAt) + 5 * 60_000).toISOString(),
    milestones: ['preheat', 'verified_arrival', 'pathway_lighting', 'unlock', 'relock'].map(
      (name) => ({
        name,
        commandId:
          name === 'verified_arrival'
            ? null
            : `${name === 'pathway_lighting' ? 'gcmd_pathway' : `gcmd_${name}`}000001`,
        status: 'pending',
        evidenceId: null,
        resolvedAt: null,
        failure: null,
      }),
    ),
    updatedAt: startedAt,
    completedAt: null,
  })
}

function foreignMission(): Mission {
  return MissionSchema.parse({
    ...makeMission(),
    id: FOREIGN.mission,
    organizationId: IDS.otherOrganization,
    palaceId: FOREIGN.palace,
  })
}

function contextReceipt(
  id: string,
  organizationId: OrganizationId,
  missionId: MissionId,
): ContextReceipt {
  return ContextReceiptSchema.parse({
    id: ContextReceiptIdSchema.parse(id),
    organizationId,
    missionId,
    runId: RunIdSchema.parse(
      organizationId === IDS.organization ? 'run_primary000001' : 'run_foreign000001',
    ),
    policyHash: SHA_A,
    toolRegistryHash: SHA_B,
    sources: [
      {
        sourceId: 'tool.registry',
        version: 'tool-registry@1',
        contentHash: SHA_A,
        authority: 'tool_contract',
      },
    ],
    createdAt: NOW,
  })
}

async function expectSameFailure(left: Promise<unknown>, right: Promise<unknown>): Promise<void> {
  expect(await applicationFailure(left)).toEqual(await applicationFailure(right))
}

async function applicationFailure(operation: Promise<unknown>): Promise<{
  readonly code: string
  readonly message: string
}> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError)
    const applicationError = error as ApplicationError
    return { code: applicationError.code, message: applicationError.message }
  }
  throw new Error('Expected the application operation to fail')
}

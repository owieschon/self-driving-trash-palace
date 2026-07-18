import {
  CapabilitySchema,
  CrewMemberSchema,
  PalaceIdSchema,
  PalaceSchema,
  RoutineSchema,
  RoutineVersionSchema,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { ConflictError, NotFoundError } from '../errors.js'
import { createProductionMissionProgramRegistry } from '../mission-program-registry.js'
import { PalaceWorkspaceService } from '../palace-workspace-service.js'
import type { ClockPort } from '../ports.js'
import { InMemoryApplicationStore } from '../testing/fakes.js'
import {
  IDS,
  NOW,
  authContext,
  makeAction,
  makeApproval,
  makeCapabilities,
  makeDevices,
  makeMission,
  makePalace,
  makePlan,
} from './fixtures.js'

class FixedClock implements ClockPort {
  public constructor(private readonly value: string) {}

  public now(): Date {
    return new Date(this.value)
  }
}

describe('Palace workspace projection', () => {
  it('derives the member, local presentation, capability ideas, and active automations', async () => {
    const store = new InMemoryApplicationStore(workspaceSeed())
    const service = new PalaceWorkspaceService(
      store,
      new FixedClock('2026-07-16T13:00:00.000Z'),
      createProductionMissionProgramRegistry(store),
    )

    const workspace = await service.get({ context: authContext, palaceId: IDS.palace })

    expect(workspace).toMatchObject({
      schemaVersion: 'palace-workspace@1',
      member: { id: IDS.owner, displayName: 'Rocky', role: 'owner', grants: [] },
      palace: { id: IDS.palace, organizationId: IDS.organization, timezone: 'America/New_York' },
      presentation: {
        observedAt: '2026-07-16T13:00:00.000Z',
        timezone: 'America/New_York',
        dayPeriod: 'morning',
      },
      activeAutomations: [
        {
          routineId: IDS.protectedRoutine,
          programKind: 'night_shift_homecoming',
          name: 'Night Shift Homecoming',
          version: 3,
          activeSince: NOW,
        },
      ],
    })
    expect(workspace.capabilityIdeas).toEqual([
      expect.objectContaining({
        programKind: 'night_shift_homecoming',
        availability: 'ready',
        requiredCapabilities: ['temperature_target', 'pathway_lighting', 'lock_desired_state'],
      }),
      expect.objectContaining({
        programKind: 'scheduled_hauler_access',
        availability: 'needs_connection',
        requiredCapabilities: ['service_hatch_access', 'residential_hatch_lock_state'],
      }),
    ])
    expect(workspace.attention).toEqual([])
    expect(workspace.activity).toEqual([])
  })

  it('restores a pending decision and a reconciliation state from Palace-scoped records', async () => {
    const approvalPlan = makePlan('awaiting_approval')
    const store = new InMemoryApplicationStore({
      ...workspaceSeed(),
      missions: [makeMission({ status: 'waiting_for_user', phase: 'approve' })],
      plans: [approvalPlan],
      approvals: [makeApproval(approvalPlan, 'pending')],
    })
    const service = new PalaceWorkspaceService(
      store,
      new FixedClock('2026-07-16T13:00:00.000Z'),
      createProductionMissionProgramRegistry(store),
    )

    const workspace = await service.get({ context: authContext, palaceId: IDS.palace })

    expect(workspace.attention).toEqual([
      {
        kind: 'approval',
        missionId: IDS.mission,
        label: 'A Night Shift Homecoming proposal is ready for your review.',
        createdAt: NOW,
      },
    ])
    expect(workspace.activity).toEqual([
      {
        id: IDS.mission,
        missionId: IDS.mission,
        summary: 'Pal is preparing Night Shift Homecoming.',
        status: 'working',
        occurredAt: NOW,
      },
    ])
  })

  it('keeps a reconciliation visible rather than calling it complete', async () => {
    const store = new InMemoryApplicationStore({
      ...workspaceSeed(),
      missions: [makeMission({ status: 'running', phase: 'reconcile' })],
    })
    const service = new PalaceWorkspaceService(
      store,
      new FixedClock('2026-07-16T13:00:00.000Z'),
      createProductionMissionProgramRegistry(store),
    )

    const workspace = await service.get({ context: authContext, palaceId: IDS.palace })

    expect(workspace.attention).toEqual([
      {
        kind: 'reconciliation',
        missionId: IDS.mission,
        label: 'Pal is reconciling Night Shift Homecoming. It has not been marked complete.',
        createdAt: NOW,
      },
    ])
    expect(workspace.activity[0]).toMatchObject({
      status: 'checking_result',
      summary: 'Pal is checking the result for Night Shift Homecoming.',
    })
  })

  it('fails closed for a foreign or inaccessible Palace', async () => {
    const inaccessible = PalaceSchema.parse({
      ...makePalace(),
      id: PalaceIdSchema.parse('pal_inaccessible01'),
      name: 'Unassigned Palace',
    })
    const foreign = PalaceSchema.parse({
      ...makePalace(),
      id: PalaceIdSchema.parse('pal_foreign00001'),
      organizationId: IDS.otherOrganization,
      name: 'Foreign Palace',
    })
    const store = new InMemoryApplicationStore({
      ...workspaceSeed(),
      palaces: [makePalace(), inaccessible, foreign],
    })
    const service = new PalaceWorkspaceService(
      store,
      new FixedClock('2026-07-16T13:00:00.000Z'),
      createProductionMissionProgramRegistry(store),
    )

    await expect(
      service.get({ context: authContext, palaceId: inaccessible.id }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      service.get({ context: authContext, palaceId: foreign.id }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('rejects an inconsistent active routine projection instead of presenting it as active', async () => {
    const seed = workspaceSeed()
    const routine = seed.routines?.[0]
    if (routine === undefined) throw new Error('Workspace fixture requires one routine')
    const store = new InMemoryApplicationStore({
      ...seed,
      routines: [{ ...routine, activeVersionId: null }],
    })
    const service = new PalaceWorkspaceService(
      store,
      new FixedClock('2026-07-16T13:00:00.000Z'),
      createProductionMissionProgramRegistry(store),
    )

    await expect(
      service.get({ context: authContext, palaceId: IDS.palace }),
    ).rejects.toBeInstanceOf(ConflictError)
  })
})

function workspaceSeed() {
  const action = makeAction()
  if (action.type !== 'replace_homecoming_routine') {
    throw new Error('Workspace fixture requires a homecoming replacement action')
  }
  const routine = RoutineSchema.parse({
    id: IDS.protectedRoutine,
    organizationId: IDS.organization,
    palaceId: IDS.palace,
    name: 'Night Shift Homecoming',
    activeVersionId: IDS.protectedVersion,
    createdAt: NOW,
  })
  const version = RoutineVersionSchema.parse({
    id: IDS.protectedVersion,
    routineId: routine.id,
    organizationId: IDS.organization,
    version: 3,
    status: 'active',
    definition: action.replacement,
    sourcePlanId: null,
    sourcePlanHash: null,
    createdAt: NOW,
  })

  return {
    palaces: [makePalace()],
    crewMembers: [
      CrewMemberSchema.parse({
        id: 'crew_rocky000001',
        organizationId: IDS.organization,
        palaceId: IDS.palace,
        userId: IDS.owner,
        displayName: 'Rocky',
        active: true,
      }),
    ],
    devices: makeDevices(),
    capabilities: makeCapabilities().map((capability) => CapabilitySchema.parse(capability)),
    routines: [routine],
    routineVersionRecords: [version],
  }
}

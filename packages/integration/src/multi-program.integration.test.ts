import {
  ApprovedPlanDeterministicVerifier,
  HomecomingExecutionPlanner,
  HomecomingPlanSimulator,
  HomecomingPlanValidator,
  MissionProgramRegistry,
  ScheduledHaulerAccessDeterministicVerifier,
  ScheduledHaulerAccessExecutionPlanner,
  ScheduledHaulerAccessPlanSimulator,
  ScheduledHaulerAccessPlanValidator,
} from '@trash-palace/application'
import { InMemoryApplicationStore } from '@trash-palace/application/testing'
import { SCHEDULED_HAULER_ACCESS_FIXTURE } from '../../../evals/fixtures/scheduled-hauler-access.js'
import { describe, expect, it } from 'vitest'

import {
  makeCapabilities,
  makeDevices,
  makePalace,
  makePlan,
  makeProtectedVersion,
} from '../../application/src/__tests__/fixtures.js'

function createStore() {
  const fixture = SCHEDULED_HAULER_ACCESS_FIXTURE
  const homecomingPalace = makePalace()
  return new InMemoryApplicationStore({
    palaces: [
      homecomingPalace,
      {
        ...homecomingPalace,
        id: fixture.mission.palaceId,
        organizationId: fixture.mission.organizationId,
      },
    ],
    devices: [...makeDevices(), ...fixture.devices],
    capabilities: [...makeCapabilities(), ...fixture.capabilities],
    routineVersions: [
      makeProtectedVersion(),
      {
        routineId: fixture.action.protectedRoutineId,
        routineVersionId: fixture.action.protectedRoutineVersionId,
        version: fixture.action.expectedProtectedVersion,
      },
    ],
    routines: [fixture.protectedRoutine],
    routineVersionRecords: [fixture.protectedVersion],
  })
}

function createRegistry(store: InMemoryApplicationStore) {
  return new MissionProgramRegistry([
    {
      kind: 'night_shift_homecoming',
      actionType: 'replace_homecoming_routine',
      validator: new HomecomingPlanValidator(store),
      simulator: new HomecomingPlanSimulator(),
      executionPlanner: new HomecomingExecutionPlanner(),
      verifier: new ApprovedPlanDeterministicVerifier(),
      contextSourceIds: [
        'skill.homecoming.planning',
        'skill.homecoming.verification',
        'policy.shared.approval',
      ],
      verificationCriteria: [
        'no_unverified_unlock',
        'routine_matches_approved_plan',
        'tenant_boundary_preserved',
      ],
    },
    {
      kind: 'scheduled_hauler_access',
      actionType: 'replace_scheduled_hauler_access_routine',
      validator: new ScheduledHaulerAccessPlanValidator(store),
      simulator: new ScheduledHaulerAccessPlanSimulator(),
      executionPlanner: new ScheduledHaulerAccessExecutionPlanner(),
      verifier: new ScheduledHaulerAccessDeterministicVerifier(),
      contextSourceIds: [
        'skill.hauler.planning',
        'skill.hauler.verification',
        'policy.shared.approval',
      ],
      verificationCriteria: [
        'verified_hauler_inside_window',
        'service_hatch_only',
        'service_hatch_locked_after_access',
        'tenant_boundary_preserved',
      ],
    },
  ])
}

describe('multi-program control plane', () => {
  it('validates and simulates two separate programs through one registry', async () => {
    const store = createStore()
    const registry = createRegistry(store)
    const homecoming = makePlan('candidate')
    const hauler = SCHEDULED_HAULER_ACCESS_FIXTURE.plan

    expect((await registry.validate(homecoming)).every((check) => check.passed)).toBe(true)
    expect((await registry.validate(hauler)).every((check) => check.passed)).toBe(true)
    expect(
      (await registry.simulate(homecoming, ['access', 'energy', 'timing', 'transport_failure']))
        .feasible,
    ).toBe(true)
    expect(
      (await registry.simulate(hauler, ['access', 'energy', 'timing', 'transport_failure']))
        .feasible,
    ).toBe(true)
  })

  it('applies Hauler through the same durable routine repository and survives recomposition', async () => {
    const store = createStore()
    const fixture = SCHEDULED_HAULER_ACCESS_FIXTURE
    const outcome = await store.run(fixture.mission.organizationId, (repositories) =>
      repositories.routines.applyApprovedAction(fixture.plan, fixture.action),
    )

    expect(outcome).toEqual({
      routineId: fixture.action.replacementRoutineId,
      routineVersionId: fixture.action.replacementRoutineVersionId,
      deactivatedRoutineId: fixture.action.protectedRoutineId,
    })
    const recomposed = createRegistry(store)
    expect(recomposed.forMission(fixture.mission).kind).toBe('scheduled_hauler_access')
    await store.run(fixture.mission.organizationId, async (repositories) => {
      expect(
        await repositories.routines.getCurrentVersion(fixture.action.protectedRoutineId),
      ).toBeNull()
      expect(
        await repositories.routines.getCurrentVersion(fixture.action.replacementRoutineId),
      ).toEqual({
        routineId: fixture.action.replacementRoutineId,
        routineVersionId: fixture.action.replacementRoutineVersionId,
        version: 1,
      })
    })
  })

  it('does not let Hauler borrow Homecoming context or action semantics', () => {
    const registry = createRegistry(createStore())
    const hauler = registry.get('scheduled_hauler_access')
    expect(hauler.contextSourceIds).not.toContain('skill.homecoming.planning')
    expect(hauler.actionType).toBe('replace_scheduled_hauler_access_routine')
    expect(() =>
      registry.assertMissionPlanBinding(
        SCHEDULED_HAULER_ACCESS_FIXTURE.mission,
        makePlan('candidate'),
      ),
    ).toThrow(/do not match/)
  })
})

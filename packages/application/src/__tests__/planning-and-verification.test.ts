import { describe, expect, it } from 'vitest'

import type { PlanActionId } from '@trash-palace/core'

import { ConflictError } from '../errors.js'
import type { MissionExecutionContext } from '../mission-fence.js'
import { MissionLifecycleService } from '../mission-service.js'
import { PlanService } from '../plan-service.js'
import type { UnitOfWorkPort } from '../ports.js'
import { VerificationService } from '../verification-service.js'
import { InMemoryApplicationStore, MutableClock, SequentialIdGenerator } from '../testing/fakes.js'
import {
  IDS,
  authContext,
  makeAction,
  makeMission,
  makeOperation,
  makePlan,
  serviceContext,
} from './fixtures.js'
import { makeProductionVerificationFixture } from './verification-fixtures.js'
import {
  applicationProductEvents,
  createApplicationEvidenceHarness,
} from './evidence-test-helpers.js'

describe('plan validation and simulation hooks', () => {
  it('freezes a revision, runs both hooks, and leaves a validated candidate', async () => {
    const mission = makeMission({ status: 'running', phase: 'plan' }, 2)
    const store = new InMemoryApplicationStore({ missions: [mission] })
    const evidence = createApplicationEvidenceHarness()
    const service = new PlanService(
      store,
      {
        validate: async () => [
          { type: 'schema', passed: true, message: 'Schema is current' },
          { type: 'hard_invariant', passed: true, message: 'Unlock requires verified identity' },
        ],
      },
      {
        simulate: async (_plan, scenarios) => ({
          feasible: true,
          projectedBatteryUsePercentagePoints: 13.2,
          results: scenarios.map((scenario) => ({
            scenario,
            passed: true,
            evidence: 'fixture pass',
          })),
        }),
      },
      new MutableClock(new Date('2026-08-14T05:35:00.000Z')),
      new SequentialIdGenerator(),
      evidence.observability,
    )

    const plan = await service.propose({
      context: authContext,
      missionId: mission.id,
      revision: 1,
      actions: [makeAction()],
      successCriteriaIds: mission.successCriteriaIds,
    })
    const validation = await service.validate({ context: authContext, planId: plan.id })
    const simulation = await service.simulate({
      context: authContext,
      planId: plan.id,
      scenarios: ['access', 'energy'],
    })

    expect(validation.valid).toBe(true)
    expect(simulation.feasible).toBe(true)
    expect((await store.snapshot()).plans[0]?.status).toBe('validated')
    expect((await applicationProductEvents(store)).map((event) => event.event)).toEqual([
      'plan proposed',
      'plan simulated',
    ])
  })

  it('requires restore actions to link to a committed operation through a compensating plan', async () => {
    const priorPlan = makePlan()
    const mission = makeMission({ status: 'running', phase: 'plan' }, 11)
    const operation = makeOperation(priorPlan, 'committed')
    const store = new InMemoryApplicationStore({
      missions: [mission],
      plans: [priorPlan],
      operations: [operation],
    })
    const service = new PlanService(
      store,
      { validate: async () => [] },
      {
        simulate: async () => ({
          feasible: true,
          projectedBatteryUsePercentagePoints: 0,
          results: [],
        }),
      },
      new MutableClock(new Date('2026-08-14T05:45:00.000Z')),
      new SequentialIdGenerator(),
    )
    const restore = {
      id: 'act_restore00001' as PlanActionId,
      type: 'restore_routine_version' as const,
      palaceId: IDS.palace,
      routineId: IDS.replacementRoutine,
      restoreVersionId: IDS.protectedVersion,
      expectedCurrentVersion: 1,
    }

    expect(() =>
      service.propose({
        context: authContext,
        missionId: mission.id,
        revision: 2,
        actions: [restore],
        successCriteriaIds: mission.successCriteriaIds,
      }),
    ).toThrow(/compensating plan/)
    const compensation = await service.proposeCompensating({
      context: authContext,
      missionId: mission.id,
      revision: 2,
      action: restore,
      successCriteriaIds: mission.successCriteriaIds,
      compensatesOperationId: operation.id,
    })
    expect((await store.snapshot()).compensatingPlans[0]).toMatchObject({
      planId: compensation.id,
      compensatesOperationId: operation.id,
    })
  })
})

describe('verifier-owned mission success', () => {
  it('reads the verification snapshot sequentially on a single transaction', async () => {
    const fixture = makeProductionVerificationFixture()
    const store = new InMemoryApplicationStore(fixture.seed)
    const completedReads: string[] = []
    let activeRead: string | null = null
    const guard = async <Result>(name: string, read: () => Promise<Result>): Promise<Result> => {
      if (activeRead !== null) throw new Error(`${name} overlapped ${activeRead}`)
      activeRead = name
      await Promise.resolve()
      try {
        return await read()
      } finally {
        completedReads.push(name)
        activeRead = null
      }
    }
    const unitOfWork: UnitOfWorkPort = {
      run: (organizationId, work) =>
        store.run(organizationId, (repositories) =>
          work({
            ...repositories,
            operations: {
              ...repositories.operations,
              listForMission: (missionId) =>
                guard('operations', () => repositories.operations.listForMission(missionId)),
            },
            executions: {
              ...repositories.executions,
              listForMission: (missionId) =>
                guard('executions', () => repositories.executions.listForMission(missionId)),
            },
            evidence: {
              ...repositories.evidence,
              listForMission: (missionId) =>
                guard('evidence', () => repositories.evidence.listForMission(missionId)),
            },
          }),
        ),
    }

    const result = await new VerificationService(
      unitOfWork,
      new MutableClock(new Date('2026-08-14T06:01:00.000Z')),
      new SequentialIdGenerator(),
    ).run({
      organizationId: IDS.organization,
      missionId: fixture.material.mission.id,
    })

    expect(result.verification.status).toBe('passed')
    expect(completedReads).toEqual(['operations', 'executions', 'evidence'])
  })

  it('allows only VerificationService to persist success and replays the frozen receipt', async () => {
    const fixture = makeProductionVerificationFixture()
    const mission = fixture.material.mission
    const store = new InMemoryApplicationStore(fixture.seed)
    const clock = new MutableClock(new Date('2026-08-14T06:01:00.000Z'))
    const ids = new SequentialIdGenerator()
    const verifier = new VerificationService(store, clock, ids)
    const lifecycle = new MissionLifecycleService(store, clock, ids)

    await expect(
      lifecycle.transition({
        context: serviceContext as unknown as MissionExecutionContext,
        missionId: mission.id,
        expectedVersion: mission.version,
        event: 'verification_passed' as never,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    const completed = await verifier.run({
      organizationId: IDS.organization,
      missionId: mission.id,
    })
    const replay = await verifier.run({
      organizationId: IDS.organization,
      missionId: mission.id,
    })

    expect(completed.verification.source).toBe('application_code')
    expect(completed.mission.state).toEqual({ status: 'succeeded', phase: 'verify' })
    expect(replay.replayed).toBe(true)
    expect(replay.verification).toEqual(completed.verification)
    expect((await store.snapshot()).verifications).toHaveLength(1)
  })
})

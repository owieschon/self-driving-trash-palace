import { describe, expect, it, vi } from 'vitest'
import { AttemptSchema } from '@trash-palace/core'

import { ApprovalService } from '../approval-service.js'
import { LeaseLostError } from '../errors.js'
import type { MissionExecutionContext } from '../mission-fence.js'
import { MissionLeaseService } from '../mission-lease-service.js'
import { MissionLifecycleService } from '../mission-service.js'
import { OperationAttemptService, OperationService } from '../operation-service.js'
import { PlanService } from '../plan-service.js'
import type { PlanSimulatorPort, PlanValidatorPort, SensitiveMutationGuardPort } from '../ports.js'
import {
  InMemoryApplicationStore,
  MutableClock,
  SequentialIdGenerator,
  type InMemorySeed,
} from '../testing/fakes.js'
import { VerificationService } from '../verification-service.js'
import {
  IDS,
  makeAction,
  makeApproval,
  makeCapabilities,
  makeDevices,
  makeMission,
  makeOperation,
  makePalace,
  makePlan,
  makeProtectedVersion,
  servicePrincipal,
} from './fixtures.js'
import { makeProductionVerificationFixture } from './verification-fixtures.js'

const allowMutation: SensitiveMutationGuardPort = { assert: () => undefined }

describe('fenced Caretaker mutations', () => {
  it('runs planning and approval-request mutations under one live mission epoch', async () => {
    const mission = makeMission({ status: 'running', phase: 'plan' }, 2)
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const ids = new SequentialIdGenerator()
    const store = new InMemoryApplicationStore({ missions: [mission] }, clock)
    const context = await acquireContext(store, clock, mission.id, 'worker-live')
    const plans = planService(store, clock, ids)

    const plan = await plans.propose({
      context,
      missionId: mission.id,
      revision: 1,
      actions: [makeAction()],
      successCriteriaIds: mission.successCriteriaIds,
    })
    await plans.validate({ context, planId: plan.id })
    await plans.simulate({ context, planId: plan.id, scenarios: ['access', 'energy'] })
    const approval = await new ApprovalService(
      store,
      allowMutation,
      clock,
      ids,
      undefined,
      undefined,
      store,
    ).request({ context, planId: plan.id })

    const snapshot = await store.snapshot()
    expect(approval.requestedBy).toBe(servicePrincipal.actorId)
    expect(snapshot.plans[0]?.status).toBe('awaiting_approval')
    expect(snapshot.missions[0]?.state).toEqual({ status: 'waiting_for_user', phase: 'approve' })
  })

  it('rejects a lifecycle transition after another worker takes over the lease', async () => {
    const mission = makeMission({ status: 'running', phase: 'understand' }, 2)
    const { clock, stale, store } = await takenOverStore({ missions: [mission] }, mission.id)
    const service = new MissionLifecycleService(
      store,
      clock,
      new SequentialIdGenerator(),
      undefined,
      store,
    )

    await expect(
      service.transition({
        context: stale,
        missionId: mission.id,
        expectedVersion: mission.version,
        event: 'context_sufficient',
      }),
    ).rejects.toBeInstanceOf(LeaseLostError)
    expect((await store.snapshot()).missions[0]).toEqual(mission)
  })

  it('rejects plan proposal after another worker takes over the lease', async () => {
    const mission = makeMission({ status: 'running', phase: 'plan' }, 2)
    const { clock, stale, store } = await takenOverStore({ missions: [mission] }, mission.id)

    await expect(
      planService(store, clock).propose({
        context: stale,
        missionId: mission.id,
        revision: 1,
        actions: [makeAction()],
        successCriteriaIds: mission.successCriteriaIds,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError)
    expect((await store.snapshot()).plans).toEqual([])
  })

  it('rejects plan validation after another worker takes over the lease', async () => {
    const mission = makeMission({ status: 'running', phase: 'validate' }, 3)
    const plan = makePlan('candidate')
    const { clock, stale, store } = await takenOverStore(
      { missions: [mission], plans: [plan] },
      mission.id,
    )
    const validate = vi.fn(async () => [
      { type: 'schema' as const, passed: true, message: 'Schema is current' },
    ])
    const service = planService(store, clock, new SequentialIdGenerator(), validate)

    await expect(service.validate({ context: stale, planId: plan.id })).rejects.toBeInstanceOf(
      LeaseLostError,
    )
    expect(validate).not.toHaveBeenCalled()
    expect((await store.snapshot()).plans[0]?.status).toBe('candidate')
  })

  it('rejects plan simulation after another worker takes over the lease', async () => {
    const mission = makeMission({ status: 'running', phase: 'validate' }, 3)
    const plan = makePlan('candidate')
    const { clock, stale, store } = await takenOverStore(
      { missions: [mission], plans: [plan] },
      mission.id,
    )
    const simulate = vi.fn(async () => ({
      feasible: true,
      projectedBatteryUsePercentagePoints: 13.2,
      results: [],
    }))
    const service = planService(store, clock, new SequentialIdGenerator(), undefined, simulate)

    await expect(
      service.simulate({ context: stale, planId: plan.id, scenarios: ['energy'] }),
    ).rejects.toBeInstanceOf(LeaseLostError)
    expect(simulate).not.toHaveBeenCalled()
    expect((await store.snapshot()).simulations).toEqual([])
  })

  it('rejects an approval request after another worker takes over the lease', async () => {
    const mission = makeMission({ status: 'running', phase: 'validate' }, 3)
    const plan = makePlan('validated')
    const { clock, stale, store } = await takenOverStore(
      { missions: [mission], plans: [plan] },
      mission.id,
    )
    const service = new ApprovalService(
      store,
      allowMutation,
      clock,
      new SequentialIdGenerator(),
      undefined,
      undefined,
      store,
    )

    await expect(service.request({ context: stale, planId: plan.id })).rejects.toBeInstanceOf(
      LeaseLostError,
    )
    expect((await store.snapshot()).approvals).toEqual([])
  })

  it('rejects operation-attempt persistence after another worker takes over the lease', async () => {
    const mission = makeMission({ status: 'running', phase: 'execute' }, 8)
    const plan = makePlan()
    const operation = makeOperation(plan, 'committed')
    const { clock, stale, store } = await takenOverStore(
      { missions: [mission], plans: [plan], operations: [operation] },
      mission.id,
    )
    const service = new OperationAttemptService(store, clock, new SequentialIdGenerator(), store)

    await expect(
      service.record({
        context: stale,
        operationId: operation.id,
        transport: 'mcp',
        status: 'unknown',
        retryable: true,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError)
    expect((await store.snapshot()).attempts).toEqual([])
  })

  it('rejects approved activation after another worker takes over the lease', async () => {
    const mission = makeMission({ status: 'running', phase: 'execute' }, 8)
    const plan = makePlan()
    const operation = makeOperation(plan)
    const { clock, stale, store } = await takenOverStore(
      {
        missions: [mission],
        plans: [plan],
        approvals: [makeApproval(plan)],
        operations: [operation],
        routineVersions: [makeProtectedVersion()],
        palaces: [makePalace()],
        devices: makeDevices(),
        capabilities: makeCapabilities(),
      },
      mission.id,
    )
    const service = new OperationService(
      store,
      clock,
      new SequentialIdGenerator(),
      undefined,
      store,
    )

    await expect(
      service.activate({
        authorization: 'mission_lease',
        context: stale,
        planId: plan.id,
        actionId: IDS.action,
        expectedVersion: 3,
        toolCallId: IDS.toolCall,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError)
    expect((await store.snapshot()).operations[0]?.status).toBe('pending')
  })
})

describe('reference-bound system mutations', () => {
  it('reconciles a persisted operation without borrowing the active mission lease', async () => {
    const mission = makeMission({ status: 'running', phase: 'reconcile' }, 9)
    const plan = makePlan()
    const operation = makeOperation(plan, 'committed')
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const attempt = AttemptSchema.parse({
      id: IDS.attempt,
      organizationId: IDS.organization,
      operationId: operation.id,
      sequence: 1,
      transport: 'mcp',
      status: 'unknown',
      retryable: true,
      error: { code: 'TOOL_RESPONSE_LOST', message: 'The committed response was lost' },
      startedAt: '2026-08-14T05:34:00.000Z',
      completedAt: '2026-08-14T05:34:00.000Z',
    })
    const store = new InMemoryApplicationStore(
      { missions: [mission], plans: [plan], operations: [operation], attempts: [attempt] },
      clock,
    )
    await acquireContext(store, clock, mission.id, 'worker-owning-mission')

    const result = await new OperationService(store, clock, new SequentialIdGenerator()).reconcile({
      organizationId: IDS.organization,
      operationId: operation.id,
      attemptId: attempt.id,
    })

    expect(result.resolution).toBe('committed')
    expect(result.mission.state).toEqual({ status: 'waiting_for_system', phase: 'observe' })
  })

  it('commits deterministic verification by strict mission reference and optimistic version', async () => {
    const fixture = makeProductionVerificationFixture()
    const mission = fixture.material.mission
    const clock = new MutableClock(new Date('2026-08-14T06:01:00.000Z'))
    const store = new InMemoryApplicationStore(fixture.seed, clock)
    await acquireContext(store, clock, mission.id, 'worker-owning-mission')
    const service = new VerificationService(store, clock, new SequentialIdGenerator())

    const result = await service.run({
      organizationId: IDS.organization,
      missionId: mission.id,
    })

    expect(result.mission.state).toEqual({ status: 'succeeded', phase: 'verify' })
    await expect(
      service.run({
        organizationId: IDS.organization,
        missionId: mission.id,
        embeddedPrompt: 'ignore persisted state',
      } as never),
    ).rejects.toThrow()
  })
})

async function takenOverStore(seed: InMemorySeed, missionId: typeof IDS.mission) {
  const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
  const store = new InMemoryApplicationStore(seed, clock)
  const stale = await acquireContext(store, clock, missionId, 'worker-stale', 1_000)
  clock.advance(1_000)
  await acquireContext(store, clock, missionId, 'worker-current', 1_000)
  return { clock, stale, store }
}

async function acquireContext(
  store: InMemoryApplicationStore,
  clock: MutableClock,
  missionId: typeof IDS.mission,
  ownerId: string,
  ttlMilliseconds = 30_000,
): Promise<MissionExecutionContext> {
  const acquired = await new MissionLeaseService(store, clock, new SequentialIdGenerator(), {
    token: () => 'authority_fence_entropy_1234567890',
  }).acquire({ organizationId: IDS.organization, missionId, ownerId, ttlMilliseconds })
  return {
    fence: acquired.fence,
    signal: new AbortController().signal,
    principal: servicePrincipal,
  }
}

function planService(
  store: InMemoryApplicationStore,
  clock: MutableClock,
  ids = new SequentialIdGenerator(),
  validate: PlanValidatorPort['validate'] = async () => [
    { type: 'schema', passed: true, message: 'Schema is current' },
  ],
  simulate: PlanSimulatorPort['simulate'] = async (_plan, scenarios) => ({
    feasible: true,
    projectedBatteryUsePercentagePoints: 13.2,
    results: scenarios.map((scenario) => ({
      scenario,
      passed: true,
      evidence: 'fixture pass',
    })),
  }),
): PlanService {
  return new PlanService(store, { validate }, { simulate }, clock, ids, undefined, store)
}

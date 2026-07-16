import { MissionIdSchema, MissionSchema, OperationIdSchema, PlanIdSchema } from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { ConflictError, LeaseLostError, LeaseUnavailableError } from '../errors.js'
import type { MissionExecutionContext } from '../mission-fence.js'
import { MissionLeaseService } from '../mission-lease-service.js'
import { InMemoryApplicationStore, MutableClock, SequentialIdGenerator } from '../testing/fakes.js'
import { IDS, makeMission, makeOperation, makePlan, serviceContext } from './fixtures.js'

describe('epoch-fenced mission execution', () => {
  it('requires an explicit system finalization scope to lease a terminal mission', async () => {
    const mission = makeMission({ status: 'succeeded', phase: 'verify' }, 13)
    const clock = new MutableClock(new Date('2026-08-14T06:15:00.000Z'))
    const store = new InMemoryApplicationStore({ missions: [mission] }, clock)
    const leases = leaseService(store, clock)

    await expect(
      leases.acquire({
        organizationId: IDS.organization,
        missionId: mission.id,
        ownerId: 'ordinary-worker',
      }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError)
    const finalization = await leases.acquire({
      organizationId: IDS.organization,
      missionId: mission.id,
      ownerId: 'terminal-evidence-worker',
      allowTerminalFinalization: true,
    })

    expect(finalization.mission.state).toEqual({ status: 'succeeded', phase: 'verify' })
    expect(finalization.resumed).toBe(true)
  })

  it('transfers authority at exact expiry and rejects an ignored abort under the stale epoch', async () => {
    const mission = makeMission({ status: 'running', phase: 'reconcile' }, 12)
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const store = new InMemoryApplicationStore({ missions: [mission] }, clock)
    const leases = leaseService(store, clock)

    const first = await leases.acquire({
      organizationId: IDS.organization,
      missionId: mission.id,
      ownerId: 'worker-1',
      ttlMilliseconds: 2_000,
    })
    await expect(
      leases.acquire({
        organizationId: IDS.organization,
        missionId: mission.id,
        ownerId: 'worker-2',
        ttlMilliseconds: 2_000,
      }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError)

    clock.advance(2_000)
    await expect(
      leases.renew({ fence: first.fence, ttlMilliseconds: 2_000 }),
    ).rejects.toBeInstanceOf(LeaseLostError)
    await expect(leases.release(first.fence)).resolves.toBe(false)

    const second = await leases.acquire({
      organizationId: IDS.organization,
      missionId: mission.id,
      ownerId: 'worker-2',
      ttlMilliseconds: 2_000,
    })
    expect(second.fence.epoch).toBe(2)

    const aborted = new AbortController()
    aborted.abort(new LeaseLostError())
    const ignoredAbortContext: MissionExecutionContext = {
      fence: first.fence,
      signal: aborted.signal,
      principal: serviceContext.principal,
    }
    await expect(
      mutateMissionIgnoringAbort(store, ignoredAbortContext, mission.version),
    ).rejects.toBeInstanceOf(LeaseLostError)
    await expect(
      store.runFenced(second.fence, async (repositories) => {
        const current = await repositories.missions.get(mission.id)
        if (current === null) throw new Error('fixture mission is absent')
        return repositories.missions.save(
          { ...current, version: current.version + 1, updatedAt: clock.now().toISOString() },
          current.version,
        )
      }),
    ).resolves.toBe(true)
    expect((await store.snapshot()).missions[0]?.version).toBe(13)
    await expect(leases.release(first.fence)).resolves.toBe(false)
    expect((await store.snapshot()).leases[0]).toMatchObject({
      epoch: 2,
      ownerId: 'worker-2',
      releasedAt: null,
    })
  })

  it('prevents ABA and rolls back a valid fence used against another mission', async () => {
    const mission = makeMission({ status: 'running', phase: 'plan' }, 4)
    const otherMissionId = MissionIdSchema.parse('mis_othermission1')
    const otherMission = MissionSchema.parse({
      ...mission,
      id: otherMissionId,
      objective: 'Do not let another mission mutate this objective',
    })
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const store = new InMemoryApplicationStore({ missions: [mission, otherMission] }, clock)
    const leases = leaseService(store, clock)

    const first = await leases.acquire({
      organizationId: IDS.organization,
      missionId: mission.id,
      ownerId: 'worker-1',
      ttlMilliseconds: 2_000,
    })
    await expect(leases.release(first.fence)).resolves.toBe(true)
    const reacquired = await leases.acquire({
      organizationId: IDS.organization,
      missionId: mission.id,
      ownerId: 'worker-1',
      ttlMilliseconds: 2_000,
    })

    expect(reacquired.fence.epoch).toBe(2)
    expect(first.fence.token.storageFingerprint()).toBe(reacquired.fence.token.storageFingerprint())
    await expect(leases.release(first.fence)).resolves.toBe(false)
    await expect(store.runFenced(first.fence, async () => 'stale work ran')).rejects.toBeInstanceOf(
      LeaseLostError,
    )

    await expect(
      store.runFenced(reacquired.fence, async (repositories) => {
        const foreign = await repositories.missions.get(otherMissionId)
        if (foreign === null) throw new Error('fixture mission is absent')
        return repositories.missions.save(
          { ...foreign, version: foreign.version + 1 },
          foreign.version,
        )
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    const snapshot = await store.snapshot()
    expect(snapshot.missions.find((candidate) => candidate.id === otherMissionId)?.version).toBe(4)
  })

  it('renews the same epoch without exposing its bearer token to serialization or snapshots', async () => {
    const mission = makeMission({ status: 'waiting_for_system', phase: 'observe' }, 8)
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const store = new InMemoryApplicationStore({ missions: [mission] }, clock)
    const leases = leaseService(store, clock)
    const acquired = await leases.acquire({
      organizationId: IDS.organization,
      missionId: mission.id,
      ownerId: 'worker-1',
      ttlMilliseconds: 2_000,
    })

    clock.advance(500)
    const renewed = await leases.renew({
      fence: acquired.fence,
      ttlMilliseconds: 2_000,
    })
    expect(renewed).not.toBe(acquired.fence)
    expect(renewed.epoch).toBe(acquired.fence.epoch)
    expect(renewed.token).toBe(acquired.fence.token)
    expect(String(renewed.token)).toBe('[REDACTED]')
    expect(() => JSON.stringify(renewed)).toThrow(/cannot be serialized/)

    const [snapshot] = (await store.snapshot()).leases
    expect(snapshot).not.toHaveProperty('token')
    expect(snapshot).not.toHaveProperty('tokenFingerprint')

    const clonedToken = structuredClone(renewed.token)
    let clonedCallbackRan = false
    await expect(
      store.runFenced({ ...renewed, token: clonedToken }, async () => {
        clonedCallbackRan = true
      }),
    ).rejects.toBeInstanceOf(LeaseLostError)
    expect(clonedCallbackRan).toBe(false)

    let forgedCallbackRan = false
    await expect(
      store.runFenced(
        {
          ...renewed,
          token: {
            storageFingerprint: () => renewed.token.storageFingerprint(),
          } as typeof renewed.token,
        },
        async () => {
          forgedCallbackRan = true
        },
      ),
    ).rejects.toBeInstanceOf(LeaseLostError)
    expect(forgedCallbackRan).toBe(false)
  })

  it('rejects reference rebinding and mixed-reference outbox payloads with full rollback', async () => {
    const mission = makeMission({ status: 'running', phase: 'plan' }, 4)
    const otherMissionId = MissionIdSchema.parse('mis_othermission1')
    const otherMission = MissionSchema.parse({
      ...mission,
      id: otherMissionId,
      objective: 'Keep foreign mission records foreign',
    })
    const foreignPlan = {
      ...makePlan(),
      id: PlanIdSchema.parse('pln_otherplan001'),
      missionId: otherMissionId,
    }
    const foreignOperation = {
      ...makeOperation(foreignPlan),
      id: OperationIdSchema.parse('op_otheroperation1'),
      missionId: otherMissionId,
      planId: foreignPlan.id,
    }
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const store = new InMemoryApplicationStore(
      {
        missions: [mission, otherMission],
        plans: [foreignPlan],
        operations: [foreignOperation],
      },
      clock,
    )
    const acquired = await leaseService(store, clock).acquire({
      organizationId: IDS.organization,
      missionId: mission.id,
      ownerId: 'worker-1',
      ttlMilliseconds: 2_000,
    })

    await expect(
      store.runFenced(acquired.fence, async (repositories) => {
        const plan = await repositories.plans.get(foreignPlan.id)
        if (plan === null) throw new Error('fixture plan is absent')
        await repositories.plans.save({ ...plan, missionId: mission.id })
      }),
    ).rejects.toBeInstanceOf(ConflictError)

    await expect(
      store.runFenced(acquired.fence, async (repositories) => {
        await repositories.outbox.insert({
          id: 'out_mixedrefs0001',
          organizationId: IDS.organization,
          topic: 'mission.resume',
          deduplicationKey: 'mission.resume:mixed-references',
          payload: {
            organizationId: IDS.organization,
            missionId: mission.id,
            operationId: foreignOperation.id,
          },
          status: 'pending',
          availableAt: clock.now().toISOString(),
          createdAt: clock.now().toISOString(),
          claimedBy: null,
          claimExpiresAt: null,
          dispatchedAt: null,
          deliveryAttempts: 0,
          lastErrorCode: null,
        })
      }),
    ).rejects.toBeInstanceOf(ConflictError)

    const snapshot = await store.snapshot()
    expect(snapshot.plans.find((plan) => plan.id === foreignPlan.id)?.missionId).toBe(
      otherMissionId,
    )
    expect(snapshot.outbox).toEqual([])
  })
})

function leaseService(store: InMemoryApplicationStore, clock: MutableClock): MissionLeaseService {
  return new MissionLeaseService(store, clock, new SequentialIdGenerator(), {
    token: () => 'fixed_fence_entropy_1234567890',
  })
}

async function mutateMissionIgnoringAbort(
  store: InMemoryApplicationStore,
  context: MissionExecutionContext,
  expectedVersion: number,
): Promise<boolean> {
  return store.runFenced(context.fence, async (repositories) => {
    const current = await repositories.missions.get(context.fence.missionId)
    if (current === null) throw new Error('fixture mission is absent')
    return repositories.missions.save({ ...current, version: current.version + 1 }, expectedVersion)
  })
}

import { MissionIdSchema, PrincipalSchema, ToolCallIdSchema } from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { DelegatedToolMutationCoordinator } from '../delegated-tool-mutation-coordinator.js'
import {
  AuthenticationError,
  ConflictError,
  LeaseLostError,
  LeaseUnavailableError,
  NotFoundError,
} from '../errors.js'
import { MissionLeaseService } from '../mission-lease-service.js'
import type { DelegatedAuthContext } from '../models.js'
import { InMemoryApplicationStore, MutableClock, SequentialIdGenerator } from '../testing/fakes.js'
import { IDS, makeMission } from './fixtures.js'

const CALL_ID = ToolCallIdSchema.parse('call_delegated_write_01')

describe('delegated tool mutation coordinator', () => {
  it('derives a service execution context, runs once, and releases the lease', async () => {
    const harness = createHarness()
    let invocations = 0

    const result = await harness.coordinator.run({
      authentication: delegated('routine:draft'),
      missionId: IDS.mission,
      callId: CALL_ID,
      permission: 'routine:draft',
      signal: new AbortController().signal,
      work: async (context) => {
        invocations += 1
        expect(context.principal).toMatchObject({
          organizationId: IDS.organization,
          actorId: IDS.owner,
          role: 'service',
          operatorGrants: [],
          delegatedPermissions: [],
        })
        expect(context.fence).toMatchObject({
          organizationId: IDS.organization,
          missionId: IDS.mission,
          ownerId: `tool:${CALL_ID}`,
        })
        return 'mutated'
      },
    })

    expect(result).toBe('mutated')
    expect(invocations).toBe(1)
    expect((await harness.store.snapshot()).leases).toEqual([
      expect.objectContaining({ ownerId: `tool:${CALL_ID}`, releasedAt: harness.now }),
    ])
  })

  it('releases its lease when service work fails', async () => {
    const harness = createHarness()
    const failure = new Error('service failure')

    await expect(
      harness.coordinator.run({
        authentication: delegated('routine:validate'),
        missionId: IDS.mission,
        callId: CALL_ID,
        permission: 'routine:validate',
        signal: new AbortController().signal,
        work: async () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure)

    expect((await harness.store.snapshot()).leases).toEqual([
      expect.objectContaining({ ownerId: `tool:${CALL_ID}`, releasedAt: harness.now }),
    ])
  })

  it('preserves a successful work result when lease release throws', async () => {
    const harness = createHarness()
    const observations: unknown[] = []
    const coordinator = new DelegatedToolMutationCoordinator(
      releaseThrowingLeases(harness.leases),
      harness.clock,
      {
        recordReleaseFailure: async (observation) => {
          observations.push(observation)
        },
      },
    )

    await expect(
      coordinator.run({
        authentication: delegated('routine:draft'),
        missionId: IDS.mission,
        callId: CALL_ID,
        permission: 'routine:draft',
        signal: new AbortController().signal,
        work: async () => 'committed result',
      }),
    ).resolves.toBe('committed result')
    expect(observations).toEqual([
      {
        code: 'MISSION_LEASE_RELEASE_FAILED',
        organizationId: IDS.organization,
        missionId: IDS.mission,
        callId: CALL_ID,
      },
    ])
  })

  it('preserves the original work error when release and its observer both throw', async () => {
    const harness = createHarness()
    const workFailure = new Error('original work failure')
    const coordinator = new DelegatedToolMutationCoordinator(
      releaseThrowingLeases(harness.leases),
      harness.clock,
      {
        recordReleaseFailure: async () => {
          throw new Error('observer failure')
        },
      },
    )

    await expect(
      coordinator.run({
        authentication: delegated('routine:draft'),
        missionId: IDS.mission,
        callId: CALL_ID,
        permission: 'routine:draft',
        signal: new AbortController().signal,
        work: async () => Promise.reject(workFailure),
      }),
    ).rejects.toBe(workFailure)
  })

  it('rejects a missing scope before acquiring a lease or invoking work', async () => {
    const harness = createHarness()
    let invoked = false

    await expect(
      harness.coordinator.run({
        authentication: delegated('routine:validate'),
        missionId: IDS.mission,
        callId: CALL_ID,
        permission: 'routine:activate',
        signal: new AbortController().signal,
        work: async () => {
          invoked = true
        },
      }),
    ).rejects.toThrow(/lacks routine:activate/)

    expect(invoked).toBe(false)
    expect((await harness.store.snapshot()).leases).toEqual([])
  })

  it('keeps delegated approval impossible before lease acquisition', async () => {
    const harness = createHarness()

    await expect(
      harness.coordinator.run({
        authentication: delegated('routine:draft'),
        missionId: IDS.mission,
        callId: CALL_ID,
        permission: 'routine:approve',
        signal: new AbortController().signal,
        work: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect((await harness.store.snapshot()).leases).toEqual([])
  })

  it('rejects expired credentials and pre-aborted work without acquiring a lease', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    controller.abort(new Error('caller left'))

    await expect(
      harness.coordinator.run({
        authentication: { ...delegated('routine:draft'), expiresAt: harness.now },
        missionId: IDS.mission,
        callId: CALL_ID,
        permission: 'routine:draft',
        signal: new AbortController().signal,
        work: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(AuthenticationError)
    await expect(
      harness.coordinator.run({
        authentication: delegated('routine:draft'),
        missionId: IDS.mission,
        callId: CALL_ID,
        permission: 'routine:draft',
        signal: controller.signal,
        work: async () => undefined,
      }),
    ).rejects.toThrow('caller left')
    expect((await harness.store.snapshot()).leases).toEqual([])
  })

  it('releases the lease and prevents work after cancellation during execution', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    let mutated = false

    await expect(
      harness.coordinator.run({
        authentication: delegated('routine:draft'),
        missionId: IDS.mission,
        callId: CALL_ID,
        permission: 'routine:draft',
        signal: controller.signal,
        work: async (context) => {
          controller.abort(new Error('caller cancelled'))
          context.signal.throwIfAborted()
          mutated = true
        },
      }),
    ).rejects.toThrow('caller cancelled')

    expect(mutated).toBe(false)
    expect((await harness.store.snapshot()).leases).toEqual([
      expect.objectContaining({ ownerId: `tool:${CALL_ID}`, releasedAt: harness.now }),
    ])
  })

  it('rejects foreign or absent missions without invoking work', async () => {
    const harness = createHarness()
    let invoked = false

    await expect(
      harness.coordinator.run({
        authentication: delegated('routine:draft', true),
        missionId: IDS.mission,
        callId: CALL_ID,
        permission: 'routine:draft',
        signal: new AbortController().signal,
        work: async () => {
          invoked = true
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      harness.coordinator.run({
        authentication: delegated('routine:draft'),
        missionId: MissionIdSchema.parse('mis_absent000001'),
        callId: CALL_ID,
        permission: 'routine:draft',
        signal: new AbortController().signal,
        work: async () => {
          invoked = true
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundError)

    expect(invoked).toBe(false)
    expect((await harness.store.snapshot()).leases).toEqual([])
  })

  it('fails under a competing owner and refuses mutation after lease expiry', async () => {
    const harness = createHarness()
    await harness.leases.acquire({
      organizationId: IDS.organization,
      missionId: IDS.mission,
      ownerId: 'worker-existing',
      ttlMilliseconds: 1_000,
    })

    await expect(
      harness.coordinator.run({
        authentication: delegated('routine:draft'),
        missionId: IDS.mission,
        callId: CALL_ID,
        permission: 'routine:draft',
        signal: new AbortController().signal,
        work: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError)

    harness.clock.advance(1_000)
    await expect(
      harness.coordinator.run({
        authentication: delegated('routine:draft'),
        missionId: IDS.mission,
        callId: CALL_ID,
        permission: 'routine:draft',
        signal: new AbortController().signal,
        work: async (context) => {
          harness.clock.advance(30_000)
          return harness.store.runFenced(context.fence, async () => 'must not run')
        },
      }),
    ).rejects.toBeInstanceOf(LeaseLostError)
  })
})

function createHarness(): {
  readonly store: InMemoryApplicationStore
  readonly clock: MutableClock
  readonly leases: MissionLeaseService
  readonly coordinator: DelegatedToolMutationCoordinator
  readonly now: string
} {
  const now = '2026-08-14T05:40:00.000Z'
  const clock = new MutableClock(new Date(now))
  const store = new InMemoryApplicationStore({ missions: [makeMission()] }, clock)
  const leases = new MissionLeaseService(store, clock, new SequentialIdGenerator(), {
    token: () => 'delegated_fence_entropy_1234567890',
  })
  return {
    store,
    clock,
    leases,
    coordinator: new DelegatedToolMutationCoordinator(leases, clock),
    now,
  }
}

function delegated(
  permission: 'routine:activate' | 'routine:draft' | 'routine:validate',
  foreign = false,
): DelegatedAuthContext {
  return {
    tokenId: 'tok_delegated_mutation',
    principal: PrincipalSchema.parse({
      organizationId: foreign ? IDS.otherOrganization : IDS.organization,
      actorId: IDS.owner,
      role: 'delegated',
      operatorGrants: [],
      delegatedPermissions: [permission],
    }),
    expiresAt: '2026-08-14T06:40:00.000Z',
  }
}

function releaseThrowingLeases(
  leases: MissionLeaseService,
): Pick<MissionLeaseService, 'acquire' | 'release'> {
  return {
    acquire: (input) => leases.acquire(input),
    release: async () => {
      throw new Error('lease repository unavailable')
    },
  }
}

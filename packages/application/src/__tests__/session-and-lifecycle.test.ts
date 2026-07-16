import { describe, expect, it } from 'vitest'

import { ConflictError } from '../errors.js'
import type { MissionExecutionContext } from '../mission-fence.js'
import { MissionLeaseService } from '../mission-lease-service.js'
import { MissionLifecycleService } from '../mission-service.js'
import { CryptoIdGenerator } from '../primitives.js'
import { SeededSessionService } from '../session-service.js'
import {
  FixedEntropy,
  InMemoryApplicationStore,
  MutableClock,
  SequentialIdGenerator,
} from '../testing/fakes.js'
import { IDS, authContext, makeMission, ownerPrincipal, serviceContext } from './fixtures.js'

describe('seeded signed sessions', () => {
  it('rejects tampering, expiry, and stale mutation authentication', () => {
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const sessions = new SeededSessionService(
      'fixture-signing-key-with-at-least-thirty-two-bytes',
      clock,
      new FixedEntropy('fixed_session_entropy_1234567890'),
    )
    const token = sessions.issue(ownerPrincipal, { ttlMilliseconds: 1_000 })
    const context = sessions.verify(token)
    const [payload, signature] = token.split('.') as [string, string]
    const tamperedPayload = `${payload.startsWith('a') ? 'b' : 'a'}${payload.slice(1)}`

    expect(context.principal).toEqual(ownerPrincipal)
    expect(() => sessions.verify(`${tamperedPayload}.${signature}`)).toThrow(/signature/)
    expect(() =>
      sessions.assert({
        context,
        csrfToken: 'wrong-token',
        origin: 'http://localhost:3000',
        allowedOrigin: 'http://localhost:3000',
      }),
    ).toThrow(/CSRF/)

    clock.advance(1_000)
    expect(() => sessions.verify(token)).toThrow(/expired/)
  })

  it('always creates core-compatible IDs even with hostile leading entropy', () => {
    const ids = new CryptoIdGenerator(new FixedEntropy('_-UPPER/hostile'))
    expect(ids.next('operation')).toMatch(/^op_[a-z0-9][a-z0-9_-]{7,63}$/)
  })
})

describe('mission lifecycle authority and concurrency', () => {
  it('allows a trusted host transition and rejects stale expected versions', async () => {
    const mission = makeMission({ status: 'running', phase: 'understand' }, 2)
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const store = new InMemoryApplicationStore({ missions: [mission] }, clock)
    const ids = new SequentialIdGenerator()
    const service = new MissionLifecycleService(store, clock, ids, undefined, store)
    const acquired = await new MissionLeaseService(store, clock, ids, {
      token: () => 'lifecycle_fence_entropy_1234567890',
    }).acquire({
      organizationId: IDS.organization,
      missionId: mission.id,
      ownerId: 'worker-1',
    })
    const context: MissionExecutionContext = {
      fence: acquired.fence,
      signal: new AbortController().signal,
      principal: serviceContext.principal,
    }

    const transitioned = await service.transition({
      context,
      missionId: mission.id,
      expectedVersion: 2,
      event: 'context_sufficient',
    })
    expect(transitioned.state).toEqual({ status: 'running', phase: 'plan' })
    await expect(
      service.transition({
        context,
        missionId: mission.id,
        expectedVersion: 2,
        event: 'material_ambiguity',
      }),
    ).rejects.toThrow(/changed/)
  })

  it('does not let a seeded human emit host lifecycle events', async () => {
    const mission = makeMission({ status: 'running', phase: 'execute' }, 4)
    const store = new InMemoryApplicationStore({ missions: [mission] })
    const service = new MissionLifecycleService(store)

    await expect(
      service.transition({
        context: authContext as unknown as MissionExecutionContext,
        missionId: IDS.mission,
        expectedVersion: 4,
        event: 'execution_committed',
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect((await store.snapshot()).missions[0]?.state).toEqual(mission.state)
  })
})

import {
  ClarificationChoiceIdSchema,
  EvidenceIdSchema,
  OrganizationIdSchema,
  PrincipalSchema,
  Sha256Schema,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { ClarificationService } from '../clarification-service.js'
import { LeaseLostError, NotFoundError } from '../errors.js'
import type { MissionExecutionContext } from '../mission-fence.js'
import { MissionLeaseService } from '../mission-lease-service.js'
import type { AuthContext } from '../models.js'
import type { SensitiveMutationGuardPort } from '../ports.js'
import {
  FixedEntropy,
  InMemoryApplicationStore,
  MutableClock,
  SequentialIdGenerator,
} from '../testing/fakes.js'
import { IDS, authContext, makeMission, makePersistedEvidence, serviceContext } from './fixtures.js'

const REQUEST_KEY = Sha256Schema.parse('a'.repeat(64))
const ANSWER_KEY = Sha256Schema.parse('b'.repeat(64))
const OTHER_KEY = Sha256Schema.parse('c'.repeat(64))
const ENERGY_FIRST = ClarificationChoiceIdSchema.parse('energy_first')
const COMFORT_FIRST = ClarificationChoiceIdSchema.parse('comfort_first')
const CHOICES = [
  {
    id: ENERGY_FIRST,
    label: 'Energy first',
    description: 'Stay within the projected battery ceiling and preheat later.',
  },
  {
    id: COMFORT_FIRST,
    label: 'Comfort first',
    description: 'Preheat earlier and accept the projected battery tradeoff.',
  },
] as const
const allowMutation: SensitiveMutationGuardPort = { assert: () => undefined }

describe('ClarificationService', () => {
  it('persists one bounded request and authenticated answer atomically with mission transitions', async () => {
    const fixture = await setup()
    const created = await fixture.service.request(requestInput(fixture.context, 4))

    expect(created).toMatchObject({
      kind: 'created',
      request: {
        status: 'pending',
        idempotencyKey: REQUEST_KEY,
        evidenceRefs: [IDS.evidence],
      },
      mission: { state: { status: 'waiting_for_user', phase: 'plan' }, version: 5 },
    })
    expect((await fixture.store.snapshot()).missionEvents.at(-1)?.event).toBe('material_ambiguity')

    fixture.clock.advance(1_000)
    const answered = await fixture.service.answer(
      answerInput(created.request.id, created.mission.version),
    )
    expect(answered).toMatchObject({
      kind: 'answered',
      answer: {
        requestId: created.request.id,
        choiceId: ENERGY_FIRST,
        answeredBy: IDS.owner,
        evidenceRefs: [IDS.evidence],
        answeredAt: '2026-08-14T05:35:01.000Z',
      },
      request: { status: 'answered', resolvedAt: '2026-08-14T05:35:01.000Z' },
      mission: { state: { status: 'running', phase: 'plan' }, version: 6 },
    })

    const replayedAnswer = await fixture.service.answer(
      answerInput(created.request.id, created.mission.version),
    )
    expect(replayedAnswer.kind).toBe('replayed')
    expect(replayedAnswer.answer).toEqual(answered.answer)
    const snapshot = await fixture.store.snapshot()
    expect(snapshot.clarificationRequests).toHaveLength(1)
    expect(snapshot.clarificationAnswers).toEqual([answered.answer])
    expect(snapshot.missionEvents.map((event) => event.event)).toEqual([
      'material_ambiguity',
      'clarification_answered',
    ])
    expect(snapshot.outbox).toEqual([
      expect.objectContaining({
        topic: 'mission.resume',
        deduplicationKey: `mission.resume:${IDS.mission}:6`,
        payload: { organizationId: IDS.organization, missionId: IDS.mission },
      }),
    ])
  })

  it('replays the exact request and conflicts on changed content or another pending identity', async () => {
    const fixture = await setup()
    const created = await fixture.service.request(requestInput(fixture.context, 4))
    const replayed = await fixture.service.request(requestInput(fixture.context, 1))
    expect(replayed.kind).toBe('replayed')
    expect(replayed.request.id).toBe(created.request.id)

    await expect(
      fixture.service.request({
        ...requestInput(fixture.context, 5),
        question: 'Should comfort override the battery ceiling for this run?',
      }),
    ).rejects.toThrow(/reused with another payload/)
    await expect(
      fixture.service.request({
        ...requestInput(fixture.context, 5),
        idempotencyKey: OTHER_KEY,
      }),
    ).rejects.toThrow(/running plan checkpoint/)
    expect((await fixture.store.snapshot()).clarificationRequests).toHaveLength(1)
  })

  it('rejects unoffered and conflicting answers without changing durable history', async () => {
    const fixture = await setup()
    const created = await fixture.service.request(requestInput(fixture.context, 4))
    await expect(
      fixture.service.answer({
        ...answerInput(created.request.id, 5),
        choiceId: ClarificationChoiceIdSchema.parse('not_offered'),
      }),
    ).rejects.toThrow(/offered choice/)

    const answered = await fixture.service.answer(answerInput(created.request.id, 5))
    await expect(
      fixture.service.answer({
        ...answerInput(created.request.id, 5),
        idempotencyKey: OTHER_KEY,
      }),
    ).rejects.toThrow(/another answer/)
    await expect(
      fixture.service.answer({
        ...answerInput(created.request.id, 5),
        choiceId: COMFORT_FIRST,
      }),
    ).rejects.toThrow(/another answer/)
    expect((await fixture.store.snapshot()).clarificationAnswers).toEqual([answered.answer])
  })

  it('fails closed on missing evidence, stale fences, forged service contexts, and unsafe text', async () => {
    const fixture = await setup()
    await expect(
      fixture.service.request({
        ...requestInput(fixture.context, 4),
        evidenceRefs: [EvidenceIdSchema.parse('evd_missing00001')],
      }),
    ).rejects.toThrow()
    expect((await fixture.store.snapshot()).missions[0]?.version).toBe(4)

    await expect(
      fixture.service.request({
        ...requestInput(fixture.context, 4),
        question: 'Use token=super-secret-value before making this material choice',
      }),
    ).rejects.toThrow(/credential-shaped/)

    const forged: MissionExecutionContext = {
      ...fixture.context,
      principal: PrincipalSchema.parse({
        ...serviceContext.principal,
        role: 'viewer',
      }),
    }
    await expect(fixture.service.request(requestInput(forged, 4))).rejects.toThrow(
      /does not authorize/,
    )

    fixture.clock.advance(30_000)
    await expect(fixture.service.request(requestInput(fixture.context, 4))).rejects.toBeInstanceOf(
      LeaseLostError,
    )
  })

  it('rejects terminal, cross-tenant, stale-version, and non-human answers', async () => {
    const fixture = await setup()
    const created = await fixture.service.request(requestInput(fixture.context, 4))
    await expect(fixture.service.answer(answerInput(created.request.id, 4))).rejects.toThrow(
      /changed before/,
    )

    const otherOrganization = OrganizationIdSchema.parse('org_mirror00001')
    const foreignContext: AuthContext = {
      ...authContext,
      principal: PrincipalSchema.parse({
        ...authContext.principal,
        organizationId: otherOrganization,
      }),
    }
    await expect(
      fixture.service.answer({
        ...answerInput(created.request.id, 5),
        context: foreignContext,
      }),
    ).rejects.toBeInstanceOf(NotFoundError)

    const viewerContext: AuthContext = {
      ...authContext,
      principal: PrincipalSchema.parse({ ...authContext.principal, role: 'viewer' }),
    }
    await expect(
      fixture.service.answer({
        ...answerInput(created.request.id, 5),
        context: viewerContext,
      }),
    ).rejects.toThrow(/authenticated human/)

    await fixture.store.run(IDS.organization, async (repositories) => {
      const mission = await repositories.missions.get(IDS.mission)
      if (mission === null) throw new Error('fixture mission missing')
      await repositories.missions.save(
        {
          ...mission,
          state: { status: 'cancelled', phase: 'plan' },
          version: mission.version + 1,
          updatedAt: fixture.clock.now().toISOString(),
        },
        mission.version,
      )
    })
    await expect(fixture.service.answer(answerInput(created.request.id, 6))).rejects.toThrow(
      /Terminal mission/,
    )
  })
})

async function setup() {
  const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
  const ids = new SequentialIdGenerator()
  const mission = makeMission({ status: 'running', phase: 'plan' }, 4)
  const store = new InMemoryApplicationStore(
    { missions: [mission], evidence: [makePersistedEvidence()] },
    clock,
  )
  const leases = new MissionLeaseService(store, clock, ids, new FixedEntropy())
  const acquired = await leases.acquire({
    organizationId: IDS.organization,
    missionId: IDS.mission,
    ownerId: 'clarification-worker',
    ttlMilliseconds: 30_000,
  })
  const context: MissionExecutionContext = {
    fence: acquired.fence,
    signal: new AbortController().signal,
    principal: serviceContext.principal,
  }
  return {
    clock,
    store,
    context,
    service: new ClarificationService(store, store, allowMutation, clock, ids),
  }
}

function requestInput(context: MissionExecutionContext, expectedMissionVersion: number) {
  return {
    context,
    missionId: IDS.mission,
    expectedMissionVersion,
    idempotencyKey: REQUEST_KEY,
    question: 'Which comfort constraint should take priority for this homecoming?',
    choices: CHOICES,
    evidenceRefs: [IDS.evidence],
  } as const
}

function answerInput(
  requestId: Parameters<ClarificationService['answer']>[0]['requestId'],
  expectedMissionVersion: number,
) {
  return {
    context: authContext,
    requestId,
    expectedMissionVersion,
    idempotencyKey: ANSWER_KEY,
    choiceId: ENERGY_FIRST,
    evidenceRefs: [IDS.evidence],
    csrfToken: authContext.csrfToken,
    origin: 'http://trash-palace.test',
    allowedOrigin: 'http://trash-palace.test',
  } as const
}

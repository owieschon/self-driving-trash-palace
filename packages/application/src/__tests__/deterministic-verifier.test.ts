import { describe, expect, it } from 'vitest'

import {
  ContextReceiptSchema,
  ExecutionSchema,
  GatewayCommandIdSchema,
  PersistedEvidenceRecordSchema,
} from '@trash-palace/core'

import {
  HOMECOMING_VERIFICATION_CRITERIA,
  compileApprovedPlanVerification,
  evaluateApprovedPlanVerification,
  type ApprovedVerificationMaterial,
} from '../deterministic-verifier.js'
import { InMemoryApplicationStore, MutableClock, SequentialIdGenerator } from '../testing/fakes.js'
import { VerificationService } from '../verification-service.js'
import { IDS } from './fixtures.js'
import {
  VERIFICATION_EVIDENCE_IDS,
  makeProductionVerificationFixture,
} from './verification-fixtures.js'
import {
  applicationProductEvents,
  createApplicationEvidenceHarness,
} from './evidence-test-helpers.js'

describe('approved-plan deterministic verifier', () => {
  it('compiles all criteria from the approved plan and bound execution', () => {
    const { material } = makeProductionVerificationFixture()

    const compiled = compileApprovedPlanVerification(material)
    const assertions = evaluateApprovedPlanVerification(material)

    expect(compiled.predicates.map((predicate) => predicate.id)).toEqual(
      HOMECOMING_VERIFICATION_CRITERIA,
    )
    expect(compiled.predicates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'temperature_ready_by_two',
          minimumCelsius: 19.5,
          deadline: '2026-08-14T06:00:00.000Z',
        }),
        expect.objectContaining({
          id: 'locked_state_after_ninety_seconds',
          expectedSeconds: 90,
          toleranceSeconds: 5,
        }),
        expect.objectContaining({
          id: 'battery_projection_within_bound',
          maximumPercentagePoints: 15,
        }),
      ]),
    )
    expect(assertions).toHaveLength(10)
    expect(assertions.every((assertion) => assertion.passed)).toBe(true)
  })

  it('keeps composed-fixture timing policy explicit while production defaults stay strict', () => {
    const { material } = makeProductionVerificationFixture()
    const configured = compileApprovedPlanVerification(material, {
      maximumArrivalCommandDelaySeconds: 1_200,
      relockToleranceSeconds: 60,
    })
    const production = compileApprovedPlanVerification(material)

    expect(
      configured.predicates.find(
        (predicate) => predicate.id === 'lighting_follows_verified_arrival',
      ),
    ).toMatchObject({ maximumDelaySeconds: 1_200 })
    expect(
      configured.predicates.find(
        (predicate) => predicate.id === 'locked_state_after_ninety_seconds',
      ),
    ).toMatchObject({ toleranceSeconds: 60 })
    expect(
      production.predicates.find(
        (predicate) => predicate.id === 'lighting_follows_verified_arrival',
      ),
    ).toMatchObject({ maximumDelaySeconds: 5 })
  })

  it('persists a complete failed receipt when a deadline closes with partial evidence', async () => {
    const { material } = makeProductionVerificationFixture()
    const partial = deadlinePartialMaterial(material)
    const store = new InMemoryApplicationStore(seedFrom(partial))
    const service = new VerificationService(
      store,
      new MutableClock(new Date('2026-08-14T07:06:30.000Z')),
      new SequentialIdGenerator(),
    )

    const result = await service.run({
      organizationId: partial.mission.organizationId,
      missionId: partial.mission.id,
    })

    expect(result.verification.status).toBe('failed')
    expect(result.verification.assertions).toHaveLength(10)
    expect(
      result.verification.assertions.find(
        (assertion) => assertion.predicate.id === 'temperature_ready_by_two',
      ),
    ).toMatchObject({ passed: false })
    expect(result.mission.state).toEqual({ status: 'waiting_for_user', phase: 'verify' })
    expect((await store.snapshot()).verifications).toEqual([result.verification])
  })

  it('rejects forged context and execution bindings before a receipt can pass', () => {
    const { material } = makeProductionVerificationFixture()
    const wrongContext = ContextReceiptSchema.parse({
      ...material.contextReceipt,
      missionId: 'mis_anothermission',
    })
    const stored = material.executions[0]
    if (stored === undefined) throw new Error('Verification fixture execution is missing')
    const wrongExecution = {
      ...stored,
      execution: ExecutionSchema.parse({
        ...stored.execution,
        routineId: IDS.protectedRoutine,
      }),
    }

    expect(() =>
      compileApprovedPlanVerification({ ...material, contextReceipt: wrongContext }),
    ).toThrow(/context receipt/)
    expect(() =>
      compileApprovedPlanVerification({ ...material, executions: [wrongExecution] }),
    ).toThrow(/approved plan action/)
  })

  it('persists a failed receipt when evidence is signed for another execution command', async () => {
    const { material } = makeProductionVerificationFixture()
    const forged: ApprovedVerificationMaterial = {
      ...material,
      evidence: material.evidence.map((record) =>
        record.evidence.id === VERIFICATION_EVIDENCE_IDS.temperature &&
        record.authorityReceipt.authority === 'gateway_callback'
          ? PersistedEvidenceRecordSchema.parse({
              ...record,
              authorityReceipt: {
                ...record.authorityReceipt,
                commandId: GatewayCommandIdSchema.parse('gcmd_another_preheat'),
              },
            })
          : record,
      ),
    }
    const store = new InMemoryApplicationStore(seedFrom(forged))

    const result = await new VerificationService(
      store,
      new MutableClock(new Date('2026-08-14T06:01:00.000Z')),
      new SequentialIdGenerator(),
    ).run({
      organizationId: forged.mission.organizationId,
      missionId: forged.mission.id,
    })

    expect(result.verification.status).toBe('failed')
    expect(
      result.verification.assertions.find(
        (assertion) => assertion.predicate.id === 'temperature_ready_by_two',
      ),
    ).toMatchObject({ passed: false })
    expect((await store.snapshot()).verifications).toEqual([result.verification])
  })

  it('fails closed when one completed command has ambiguous command evidence', () => {
    const { material } = makeProductionVerificationFixture()
    const lighting = material.evidence.find(
      (record) => record.evidence.id === VERIFICATION_EVIDENCE_IDS.lighting,
    )
    if (lighting === undefined || lighting.authorityReceipt.authority !== 'gateway_callback') {
      throw new Error('Verification fixture lighting evidence is missing')
    }
    const ambiguous = PersistedEvidenceRecordSchema.parse({
      ...lighting,
      evidence: { ...lighting.evidence, id: 'evd_lighting_ambiguous' },
      authorityReceipt: {
        ...lighting.authorityReceipt,
        id: 'rcp_lighting_ambiguous',
        evidenceId: 'evd_lighting_ambiguous',
      },
    })

    const assertions = evaluateApprovedPlanVerification({
      ...material,
      evidence: [...material.evidence, ambiguous],
    })

    expect(
      assertions.find(
        (assertion) => assertion.predicate.id === 'lighting_follows_verified_arrival',
      ),
    ).toMatchObject({ passed: false })
  })

  it('rejects caller-authored predicates and replays the frozen receipt after restart', async () => {
    const { material, seed } = makeProductionVerificationFixture()
    const store = new InMemoryApplicationStore(seed)
    const clock = new MutableClock(new Date('2026-08-14T06:01:00.000Z'))
    const evidence = createApplicationEvidenceHarness()

    await expect(
      new VerificationService(store, clock, new SequentialIdGenerator()).run({
        organizationId: material.mission.organizationId,
        missionId: material.mission.id,
        predicates: [
          {
            id: 'attacker_always_passes',
            type: 'battery_projection_at_most',
            maximumPercentagePoints: 100,
          },
        ],
      } as never),
    ).rejects.toThrow()
    expect((await store.snapshot()).verifications).toEqual([])

    const first = await new VerificationService(
      store,
      clock,
      new SequentialIdGenerator(),
      evidence.observability,
    ).run({
      organizationId: material.mission.organizationId,
      missionId: material.mission.id,
    })
    const replay = await new VerificationService(
      store,
      clock,
      new SequentialIdGenerator(),
      evidence.observability,
    ).run({
      organizationId: material.mission.organizationId,
      missionId: material.mission.id,
    })

    expect(replay.replayed).toBe(true)
    expect(replay.verification).toEqual(first.verification)
    expect((await store.snapshot()).verifications).toHaveLength(1)
    expect((await applicationProductEvents(store)).map((event) => event.event)).toEqual([
      'execution verified',
      'mission completed',
    ])
  })
})

function deadlinePartialMaterial(
  material: ApprovedVerificationMaterial,
): ApprovedVerificationMaterial {
  const stored = material.executions[0]
  if (stored === undefined) throw new Error('Verification fixture execution is missing')
  const deadline = stored.execution.deadline
  const execution = ExecutionSchema.parse({
    ...stored.execution,
    status: 'failed',
    evidenceIds: stored.execution.evidenceIds.filter(
      (evidenceId) => evidenceId !== VERIFICATION_EVIDENCE_IDS.temperature,
    ),
    milestones: stored.execution.milestones.map((milestone) =>
      milestone.name === 'preheat'
        ? {
            ...milestone,
            status: 'pending',
            evidenceId: null,
            resolvedAt: null,
            failure: null,
          }
        : milestone,
    ),
    updatedAt: deadline,
    completedAt: deadline,
  })
  return {
    ...material,
    executions: [{ ...stored, execution }],
    evidence: material.evidence.filter(
      (record) => record.evidence.id !== VERIFICATION_EVIDENCE_IDS.temperature,
    ),
  }
}

function seedFrom(material: ApprovedVerificationMaterial) {
  return {
    missions: [material.mission],
    plans: [material.plan],
    approvals: [material.approval],
    operations: material.operations,
    contextReceipts: [material.contextReceipt],
    executions: material.executions,
    evidence: material.evidence,
  }
}

import { describe, expect, it, vi } from 'vitest'
import {
  ApprovalSchema,
  ExecutionSchema,
  OperationSchema,
  RoutineSchema,
  RoutineVersionSchema,
} from '@trash-palace/core'

import { ApprovalService } from '../approval-service.js'
import type { ApplicationTransportFaultPolicyPort } from '../application-transport-fault.js'
import type { MissionExecutionContext } from '../mission-fence.js'
import { MissionLeaseService } from '../mission-lease-service.js'
import type { ApplicationSpan, ObservabilityPort } from '../observability.js'
import { OperationAttemptService, OperationService } from '../operation-service.js'
import type { MissionExecutionUnitOfWorkPort, SensitiveMutationGuardPort } from '../ports.js'
import { InMemoryApplicationStore, MutableClock, SequentialIdGenerator } from '../testing/fakes.js'
import {
  IDS,
  authContext,
  makeApproval,
  makeAction,
  makeCapabilities,
  makeDevices,
  makeMission,
  makeOperation,
  makePalace,
  makePlan,
  makeProtectedVersion,
  serviceContext,
} from './fixtures.js'
import { makeProductionVerificationFixture } from './verification-fixtures.js'
import {
  applicationProductEvents,
  createApplicationEvidenceHarness,
} from './evidence-test-helpers.js'

const allowMutation: SensitiveMutationGuardPort = { assert: () => undefined }

describe('human approval ownership and expiry', () => {
  it('binds one server-created operation to each approved plan action', async () => {
    const plan = makePlan('awaiting_approval')
    const approval = makeApproval(plan, 'pending')
    const mission = makeMission({ status: 'waiting_for_user', phase: 'approve' }, 4)
    const store = new InMemoryApplicationStore({
      missions: [mission],
      plans: [plan],
      approvals: [approval],
      routineVersions: [makeProtectedVersion()],
      palaces: [makePalace()],
      devices: makeDevices(),
      capabilities: makeCapabilities(),
    })
    const evidence = createApplicationEvidenceHarness()
    const service = new ApprovalService(
      store,
      allowMutation,
      new MutableClock(new Date('2026-08-14T05:40:00.000Z')),
      new SequentialIdGenerator(),
      undefined,
      evidence.observability,
    )
    const result = await service.decide({
      context: authContext,
      approvalId: approval.id,
      nonce: approval.nonce,
      decision: 'approve',
      csrfToken: authContext.csrfToken,
      origin: 'http://localhost:3000',
      allowedOrigin: 'http://localhost:3000',
    })
    expect(result.status).toBe('approved')
    expect(result.operations).toHaveLength(1)
    expect(result.operations[0]).toMatchObject({
      serverCreated: true,
      planId: plan.id,
      planActionId: IDS.action,
      status: 'pending',
    })
    expect((await store.snapshot()).outbox).toEqual([
      expect.objectContaining({
        topic: 'mission.resume',
        deduplicationKey: `mission.resume:${mission.id}:5`,
      }),
    ])
    expect((await applicationProductEvents(store)).map((event) => event.event)).toEqual([
      'plan approved',
      'operation requested',
    ])
  })

  it('returns a distinct rejected result and does not materialize operations', async () => {
    const plan = makePlan('awaiting_approval')
    const approval = makeApproval(plan, 'pending')
    const mission = makeMission({ status: 'waiting_for_user', phase: 'approve' }, 4)
    const store = new InMemoryApplicationStore({
      missions: [mission],
      plans: [plan],
      approvals: [approval],
      routineVersions: [makeProtectedVersion()],
    })
    const service = new ApprovalService(
      store,
      allowMutation,
      new MutableClock(new Date('2026-08-14T05:40:00.000Z')),
      new SequentialIdGenerator(),
    )

    const result = await service.decide({
      context: authContext,
      approvalId: approval.id,
      nonce: approval.nonce,
      decision: 'reject',
      csrfToken: authContext.csrfToken,
      origin: 'http://localhost:3000',
      allowedOrigin: 'http://localhost:3000',
    })

    expect(result.status).toBe('rejected')
    expect(result.operations).toHaveLength(0)
    expect(result.mission.state).toEqual({ status: 'running', phase: 'plan' })
    expect((await store.snapshot()).outbox).toEqual([
      expect.objectContaining({
        topic: 'mission.resume',
        deduplicationKey: `mission.resume:${mission.id}:5`,
      }),
    ])
  })

  it.each([
    ['expired', new Date('2026-08-14T05:51:00.000Z'), makeProtectedVersion()],
    ['stale', new Date('2026-08-14T05:40:00.000Z'), makeProtectedVersion(4)],
  ] as const)(
    'records %s approval invalidation before activation',
    async (expected, now, current) => {
      const plan = makePlan('awaiting_approval')
      const approval = makeApproval(plan, 'pending')
      const mission = makeMission({ status: 'waiting_for_user', phase: 'approve' }, 4)
      const store = new InMemoryApplicationStore({
        missions: [mission],
        plans: [plan],
        approvals: [approval],
        routineVersions: [current],
      })
      const service = new ApprovalService(
        store,
        allowMutation,
        new MutableClock(now),
        new SequentialIdGenerator(),
      )

      const result = await service.decide({
        context: authContext,
        approvalId: approval.id,
        nonce: approval.nonce,
        decision: 'approve',
        csrfToken: authContext.csrfToken,
        origin: 'http://localhost:3000',
        allowedOrigin: 'http://localhost:3000',
      })
      expect(result.status).toBe(expected)
      expect(result.mission.state).toEqual({ status: 'running', phase: 'plan' })
      expect((await store.snapshot()).outbox).toEqual([
        expect.objectContaining({
          topic: 'mission.resume',
          deduplicationKey: `mission.resume:${mission.id}:5`,
        }),
      ])
    },
  )
})

describe('server-bound operation activation and reconciliation', () => {
  it('reports the persisted restored version and original lease source on replay', async () => {
    const replacementAction = makeAction()
    if (replacementAction.type !== 'replace_homecoming_routine') {
      throw new Error('Replacement fixture action is missing')
    }
    const replacement = replacementAction.replacement
    const restoreAction = {
      id: IDS.action,
      type: 'restore_routine_version' as const,
      palaceId: IDS.palace,
      routineId: IDS.replacementRoutine,
      restoreVersionId: IDS.protectedVersion,
      expectedCurrentVersion: 3,
    }
    const plan = makePlan('approved', restoreAction)
    const operation = OperationSchema.parse({
      ...makeOperation(plan, 'committed'),
      outcome: {
        routineId: restoreAction.routineId,
        routineVersionId: restoreAction.restoreVersionId,
        deactivatedRoutineId: null,
      },
    })
    const currentVersion = {
      routineId: restoreAction.routineId,
      routineVersionId: restoreAction.restoreVersionId,
      version: 1,
    }
    const approval = ApprovalSchema.parse({
      ...makeApproval(plan),
      protectedResources: [
        {
          routineId: restoreAction.routineId,
          routineVersionId: IDS.replacementVersion,
          version: restoreAction.expectedCurrentVersion,
        },
      ],
    })
    const fixtureExecution = makeProductionVerificationFixture().material.executions[0]
    if (fixtureExecution === undefined) throw new Error('Fixture execution is missing')
    const store = new InMemoryApplicationStore({
      missions: [makeMission()],
      plans: [plan],
      approvals: [approval],
      operations: [operation],
      routineVersions: [currentVersion],
      routines: [
        RoutineSchema.parse({
          id: restoreAction.routineId,
          organizationId: IDS.organization,
          palaceId: IDS.palace,
          name: 'Night Shift Homecoming',
          activeVersionId: restoreAction.restoreVersionId,
          createdAt: plan.createdAt,
        }),
      ],
      routineVersionRecords: [
        RoutineVersionSchema.parse({
          id: restoreAction.restoreVersionId,
          routineId: restoreAction.routineId,
          organizationId: IDS.organization,
          version: 1,
          status: 'active',
          definition: replacement,
          sourcePlanId: null,
          sourcePlanHash: null,
          createdAt: plan.createdAt,
        }),
        RoutineVersionSchema.parse({
          id: IDS.replacementVersion,
          routineId: restoreAction.routineId,
          organizationId: IDS.organization,
          version: 3,
          status: 'inactive',
          definition: replacement,
          sourcePlanId: null,
          sourcePlanHash: null,
          createdAt: plan.createdAt,
        }),
      ],
      executions: [
        {
          operationId: operation.id,
          authorization: { kind: 'mission_lease', epoch: 1 },
          execution: ExecutionSchema.parse({
            ...fixtureExecution.execution,
            operationId: operation.id,
            routineId: restoreAction.routineId,
            routineVersionId: restoreAction.restoreVersionId,
          }),
        },
      ],
    })
    const evidence = createApplicationEvidenceHarness()
    const service = new OperationService(
      store,
      new MutableClock(new Date('2026-08-14T05:40:00.000Z')),
      new SequentialIdGenerator(),
      evidence.observability,
    )

    await service.activate({
      authorization: 'manual',
      context: authContext,
      planId: plan.id,
      actionId: restoreAction.id,
      expectedVersion: restoreAction.expectedCurrentVersion,
      toolCallId: IDS.toolCall,
    })

    const events = await applicationProductEvents(store)
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('routine activated')
    expect(events[0]?.properties).toMatchObject({
      routine_version: 1,
      activation_source: 'mission_lease',
    })
  })

  it('returns the original outcome for the same payload and conflicts on a changed payload', async () => {
    const plan = makePlan()
    const operation = makeOperation(plan)
    const store = new InMemoryApplicationStore({
      missions: [makeMission()],
      plans: [plan],
      approvals: [makeApproval(plan)],
      operations: [operation],
      routineVersions: [makeProtectedVersion()],
      palaces: [makePalace()],
      devices: makeDevices(),
      capabilities: makeCapabilities(),
    })
    const clock = new MutableClock(new Date('2026-08-14T05:40:00.000Z'))
    const evidence = createApplicationEvidenceHarness()
    const service = new OperationService(
      store,
      clock,
      new SequentialIdGenerator(),
      evidence.observability,
    )

    const committed = await service.activate({
      authorization: 'manual',
      context: authContext,
      planId: plan.id,
      actionId: IDS.action,
      expectedVersion: 3,
      toolCallId: IDS.toolCall,
    })
    const committedEvidence = (await store.snapshot()).evidence.map((record) => ({
      evidenceId: record.evidence.id,
      receiptId: record.authorityReceipt.id,
    }))
    const replay = await service.activate({
      authorization: 'manual',
      context: authContext,
      planId: plan.id,
      actionId: IDS.action,
      expectedVersion: 3,
      toolCallId: IDS.toolCall,
    })
    const conflict = await service.activate({
      authorization: 'manual',
      context: authContext,
      planId: plan.id,
      actionId: IDS.action,
      expectedVersion: 4,
      toolCallId: IDS.toolCall,
    })

    expect(committed).toMatchObject({ status: 'committed', replayed: false })
    expect(replay).toMatchObject({
      status: 'committed',
      replayed: true,
      operation: { id: operation.id },
    })
    expect(conflict).toMatchObject({ status: 'conflict', reason: 'payload_mismatch' })
    const snapshot = await store.snapshot()
    expect(committedEvidence).toHaveLength(4)
    expect(
      snapshot.evidence.map((record) => ({
        evidenceId: record.evidence.id,
        receiptId: record.authorityReceipt.id,
      })),
    ).toEqual(committedEvidence)
    expect(snapshot.operations).toHaveLength(1)
    expect(snapshot.outbox).toHaveLength(2)
    expect(snapshot.executions).toHaveLength(1)
    expect(snapshot.gatewayEffects).toHaveLength(1)
    expect(snapshot.missions[0]?.state).toEqual({
      status: 'waiting_for_system',
      phase: 'observe',
    })
    expect((await applicationProductEvents(store)).map((event) => event.event)).toEqual([
      'routine activated',
    ])
  })

  it('records an unknown transport attempt then reconciles the committed operation', async () => {
    const plan = makePlan()
    const operation = makeOperation(plan)
    const mission = makeMission({ status: 'running', phase: 'execute' }, 8)
    const store = new InMemoryApplicationStore({
      missions: [mission],
      plans: [plan],
      approvals: [makeApproval(plan)],
      operations: [operation],
      routineVersions: [makeProtectedVersion()],
      palaces: [makePalace()],
      devices: makeDevices(),
      capabilities: makeCapabilities(),
    })
    const clock = new MutableClock(new Date('2026-08-14T05:40:00.000Z'))
    const ids = new SequentialIdGenerator()
    const evidence = createApplicationEvidenceHarness()
    const operations = new OperationService(
      store,
      clock,
      ids,
      evidence.observability,
      store,
      undefined,
      { shouldLoseCommittedResponse: () => true },
    )
    const acquired = await new MissionLeaseService(store, clock, ids, {
      token: () => 'attempt_fence_entropy_123456789012',
    }).acquire({
      organizationId: IDS.organization,
      missionId: mission.id,
      ownerId: 'worker-1',
    })
    const missionContext: MissionExecutionContext = {
      fence: acquired.fence,
      signal: new AbortController().signal,
      principal: serviceContext.principal,
    }

    const activation = await operations.activate({
      authorization: 'mission_lease',
      context: missionContext,
      planId: plan.id,
      actionId: IDS.action,
      expectedVersion: 3,
      toolCallId: IDS.toolCall,
    })
    expect(activation).toMatchObject({
      status: 'committed',
      delivery: { status: 'unknown' },
    })
    if (activation.status !== 'committed' || activation.delivery.status !== 'unknown') {
      throw new Error('Fixture did not retain the unknown activation attempt')
    }
    expect((await store.snapshot()).missions[0]?.state).toEqual({
      status: 'running',
      phase: 'reconcile',
    })
    expect(
      (await store.snapshot()).outbox.filter((message) => message.topic === 'operation.reconcile'),
    ).toHaveLength(1)

    const reconciled = await operations.reconcile({
      organizationId: IDS.organization,
      operationId: operation.id,
      attemptId: activation.delivery.attemptId,
    })
    expect(reconciled.resolution).toBe('committed')
    expect(reconciled.mission.state).toEqual({ status: 'waiting_for_system', phase: 'observe' })
    const productEvents = await applicationProductEvents(store)
    expect(productEvents.map((event) => event.event)).toEqual([
      'routine activated',
      'operation outcome unknown',
      'operation reconciled',
    ])
    expect(productEvents[1]?.properties).toMatchObject({
      attempt_transport: 'worker',
      unknown_reason: 'connection_lost',
      attempt_count: 1,
      reconciliation_budget_ms: 5_000,
      retryable: true,
    })
  })

  it('atomically records a targeted application response loss and acknowledges its replay', async () => {
    const plan = makePlan()
    const operation = makeOperation(plan)
    const mission = makeMission({ status: 'running', phase: 'execute' }, 8)
    const clock = new MutableClock(new Date('2026-08-14T05:40:00.000Z'))
    const ids = new SequentialIdGenerator()
    const store = new InMemoryApplicationStore(
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
      clock,
    )
    const evidence = createApplicationEvidenceHarness()
    const shouldLoseCommittedResponse = vi.fn(
      (input: Parameters<ApplicationTransportFaultPolicyPort['shouldLoseCommittedResponse']>[0]) =>
        input.organizationId === IDS.organization && input.authorization === 'mission_lease',
    )
    const policy: ApplicationTransportFaultPolicyPort = { shouldLoseCommittedResponse }
    const context = await acquireMissionContext(store, clock, ids, mission)
    const service = new OperationService(
      store,
      clock,
      ids,
      evidence.observability,
      store,
      undefined,
      policy,
    )

    const activation = await service.activate({
      authorization: 'mission_lease',
      context,
      planId: plan.id,
      actionId: IDS.action,
      expectedVersion: 3,
      toolCallId: IDS.toolCall,
    })
    expect(activation).toMatchObject({
      status: 'committed',
      replayed: false,
      delivery: { status: 'unknown' },
    })
    if (activation.status !== 'committed' || activation.delivery.status !== 'unknown') {
      throw new Error('Fixture did not enter the application response-loss path')
    }

    const committed = await store.snapshot()
    const transportEvidence = committed.evidence.filter(
      (record) => record.evidence.type === 'operation_transport',
    )
    expect(committed.operations).toEqual([
      expect.objectContaining({ id: operation.id, status: 'committed' }),
    ])
    expect(committed.routines).toHaveLength(1)
    expect(committed.executions).toHaveLength(1)
    expect(committed.attempts).toHaveLength(1)
    expect(committed.attempts[0]).toMatchObject({
      id: activation.delivery.attemptId,
      operationId: operation.id,
      sequence: 1,
      transport: 'worker',
      status: 'unknown',
      retryable: true,
      error: { code: 'APPLICATION_RESPONSE_LOST' },
    })
    expect(transportEvidence).toHaveLength(1)
    expect(transportEvidence[0]?.evidence).toMatchObject({
      id: activation.delivery.evidenceIds[0],
      type: 'operation_transport',
      operationId: operation.id,
      attemptId: activation.delivery.attemptId,
      toolCallId: IDS.toolCall,
      transport: 'worker',
      status: 'unknown',
      operationCommitted: true,
      errorCode: 'APPLICATION_RESPONSE_LOST',
    })
    expect(transportEvidence[0]?.authorityReceipt).toMatchObject({
      authority: 'application',
      producer: 'application_code',
      ruleId: 'operation.application_response_lost',
      ruleVersion: 1,
      inputEvidenceIds: [],
      derivationVerified: true,
    })
    expect(committed.missions[0]?.state).toEqual({ status: 'running', phase: 'reconcile' })
    expect(committed.outbox.filter((message) => message.topic === 'operation.reconcile')).toEqual([
      expect.objectContaining({
        deduplicationKey: `operation.reconcile:${operation.id}:${activation.delivery.attemptId}`,
        payload: {
          organizationId: IDS.organization,
          operationId: operation.id,
          attemptId: activation.delivery.attemptId,
        },
      }),
    ])
    expect((await applicationProductEvents(store)).map((event) => event.event)).toEqual([
      'routine activated',
      'operation outcome unknown',
    ])

    const replay = await service.activate({
      authorization: 'mission_lease',
      context,
      planId: plan.id,
      actionId: IDS.action,
      expectedVersion: 3,
      toolCallId: IDS.toolCall,
    })
    expect(replay).toMatchObject({
      status: 'committed',
      replayed: true,
      delivery: { status: 'acknowledged' },
    })
    const replayed = await store.snapshot()
    expect(replayed.attempts).toEqual(committed.attempts)
    expect(replayed.evidence).toEqual(committed.evidence)
    expect(replayed.outbox).toEqual(committed.outbox)
    expect(replayed.productEvidenceDeliveries).toEqual(committed.productEvidenceDeliveries)
    expect(shouldLoseCommittedResponse).toHaveBeenCalledTimes(1)
  })

  it('never applies the application response-loss policy to manual activation', async () => {
    const plan = makePlan()
    const operation = makeOperation(plan)
    const clock = new MutableClock(new Date('2026-08-14T05:40:00.000Z'))
    const store = new InMemoryApplicationStore({
      missions: [makeMission()],
      plans: [plan],
      approvals: [makeApproval(plan)],
      operations: [operation],
      routineVersions: [makeProtectedVersion()],
      palaces: [makePalace()],
      devices: makeDevices(),
      capabilities: makeCapabilities(),
    })
    const shouldLoseCommittedResponse = vi.fn(() => true)
    const service = new OperationService(
      store,
      clock,
      new SequentialIdGenerator(),
      undefined,
      null,
      undefined,
      { shouldLoseCommittedResponse },
    )

    const result = await service.activate({
      authorization: 'manual',
      context: authContext,
      planId: plan.id,
      actionId: IDS.action,
      expectedVersion: 3,
      toolCallId: IDS.toolCall,
    })

    expect(result).toMatchObject({
      status: 'committed',
      replayed: false,
      delivery: { status: 'acknowledged' },
    })
    const snapshot = await store.snapshot()
    expect(snapshot.attempts).toEqual([])
    expect(snapshot.evidence.some((record) => record.evidence.type === 'operation_transport')).toBe(
      false,
    )
    expect(shouldLoseCommittedResponse).not.toHaveBeenCalled()
  })

  it('rolls back activation when application transport evidence cannot persist', async () => {
    const plan = makePlan()
    const operation = makeOperation(plan)
    const mission = makeMission({ status: 'running', phase: 'execute' }, 8)
    const clock = new MutableClock(new Date('2026-08-14T05:40:00.000Z'))
    const ids = new SequentialIdGenerator()
    const store = new InMemoryApplicationStore(
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
      clock,
    )
    const context = await acquireMissionContext(store, clock, ids, mission)
    const failingEvidenceUnitOfWork: MissionExecutionUnitOfWorkPort = {
      runFenced: (fence, work) =>
        store.runFenced(fence, (repositories) =>
          work({
            ...repositories,
            evidence: {
              ...repositories.evidence,
              appendMany: async (records) => {
                if (records.some((record) => record.evidence.type === 'operation_transport')) {
                  throw new Error('application transport evidence unavailable')
                }
                await repositories.evidence.appendMany(records)
              },
            },
          }),
        ),
    }
    const service = new OperationService(
      store,
      clock,
      ids,
      undefined,
      failingEvidenceUnitOfWork,
      undefined,
      { shouldLoseCommittedResponse: () => true },
    )

    await expect(
      service.activate({
        authorization: 'mission_lease',
        context,
        planId: plan.id,
        actionId: IDS.action,
        expectedVersion: 3,
        toolCallId: IDS.toolCall,
      }),
    ).rejects.toThrow('application transport evidence unavailable')

    const snapshot = await store.snapshot()
    expect(snapshot.operations).toEqual([operation])
    expect(snapshot.missions).toEqual([mission])
    expect(snapshot.routines).toEqual([])
    expect(snapshot.routineVersionRecords).toEqual([])
    expect(snapshot.executions).toEqual([])
    expect(snapshot.gatewayEffects).toEqual([])
    expect(snapshot.attempts).toEqual([])
    expect(snapshot.evidence).toEqual([])
    expect(snapshot.outbox).toEqual([])
    expect(snapshot.productEvidenceDeliveries).toEqual([])
  })

  it('rolls back the attempt, transition, and reconciliation when evidence freezing fails', async () => {
    const plan = makePlan()
    const operation = makeOperation(plan)
    const mission = makeMission({ status: 'running', phase: 'execute' }, 8)
    const store = new InMemoryApplicationStore({
      missions: [mission],
      plans: [plan],
      operations: [operation],
    })
    const clock = new MutableClock(new Date('2026-08-14T05:40:00.000Z'))
    const ids = new SequentialIdGenerator()
    const unavailableEvidence: ObservabilityPort = {
      async trace<Result>(_span: ApplicationSpan, work: () => Promise<Result>): Promise<Result> {
        return work()
      },
      record: () => Promise.resolve(),
      freezeProduct: () => {
        throw new Error('evidence freezer unavailable')
      },
    }
    const attempts = new OperationAttemptService(store, clock, ids, store, unavailableEvidence)
    const acquired = await new MissionLeaseService(store, clock, ids, {
      token: () => 'rollback_fence_entropy_123456789012',
    }).acquire({
      organizationId: IDS.organization,
      missionId: mission.id,
      ownerId: 'worker-1',
    })
    const missionContext: MissionExecutionContext = {
      fence: acquired.fence,
      signal: new AbortController().signal,
      principal: serviceContext.principal,
    }

    await expect(
      attempts.record({
        context: missionContext,
        operationId: operation.id,
        transport: 'worker',
        status: 'unknown',
        retryable: true,
        error: { code: 'APPLICATION_RESPONSE_LOST', message: 'Commit response was lost' },
      }),
    ).rejects.toThrow('evidence freezer unavailable')

    const snapshot = await store.snapshot()
    expect(snapshot.attempts).toEqual([])
    expect(snapshot.productEvidenceDeliveries).toEqual([])
    expect(snapshot.outbox).toEqual([])
    expect(snapshot.missions[0]?.state).toEqual({ status: 'running', phase: 'execute' })
  })

  it('invalidates approval and returns the mission to planning on execute-time version drift', async () => {
    const plan = makePlan()
    const operation = makeOperation(plan)
    const store = new InMemoryApplicationStore({
      missions: [makeMission({ status: 'running', phase: 'execute' }, 9)],
      plans: [plan],
      approvals: [makeApproval(plan)],
      operations: [operation],
      routineVersions: [makeProtectedVersion(4)],
    })
    const service = new OperationService(
      store,
      new MutableClock(new Date('2026-08-14T05:40:00.000Z')),
      new SequentialIdGenerator(),
    )
    const result = await service.activate({
      authorization: 'manual',
      context: authContext,
      planId: plan.id,
      actionId: IDS.action,
      expectedVersion: 3,
      toolCallId: IDS.toolCall,
    })
    expect(result).toMatchObject({ status: 'conflict', reason: 'protected_state_stale' })
    const snapshot = await store.snapshot()
    expect(snapshot.operations[0]?.status).toBe('cancelled')
    expect(snapshot.approvals[0]?.status).toBe('invalidated')
    expect(snapshot.missions[0]?.state).toEqual({ status: 'running', phase: 'plan' })
  })
})

async function acquireMissionContext(
  store: InMemoryApplicationStore,
  clock: MutableClock,
  ids: SequentialIdGenerator,
  mission: ReturnType<typeof makeMission>,
): Promise<MissionExecutionContext> {
  const acquired = await new MissionLeaseService(store, clock, ids, {
    token: () => 'application_fault_fence_entropy_123456789012',
  }).acquire({
    organizationId: mission.organizationId,
    missionId: mission.id,
    ownerId: 'application-fault-worker',
  })
  return {
    fence: acquired.fence,
    signal: new AbortController().signal,
    principal: serviceContext.principal,
  }
}

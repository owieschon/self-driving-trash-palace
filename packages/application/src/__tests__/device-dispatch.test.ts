import {
  EvidenceIdSchema,
  ExecutionIdSchema,
  MissionIdSchema,
  PersistedEvidenceRecordSchema,
  ReceiptIdSchema,
  deriveGatewayCommandId,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import {
  ACTIVATION_APPLICATION_EVIDENCE_RULES,
  PersistedEvidenceExecutionService,
} from '../execution-materialization-service.js'
import { HOMECOMING_LOGICAL_KEYS } from '../homecoming-execution-planner.js'
import {
  GatewayDispatchService,
  GatewayEffectReconciliationService,
} from '../operation-dispatch-service.js'
import { OperationService } from '../operation-service.js'
import { InMemoryApplicationStore, MutableClock, SequentialIdGenerator } from '../testing/fakes.js'
import {
  IDS,
  authContext,
  makeApproval,
  makeCapabilities,
  makeDevices,
  makeIdentityTag,
  makeMission,
  makeOperation,
  makePalace,
  makePlan,
  makeProtectedVersion,
} from './fixtures.js'

describe('durable gateway effect pipeline', () => {
  it('commits execution, preheat intent, dispatch reference, and deadline atomically', async () => {
    const harness = await activatedHarness()
    const snapshot = await harness.store.snapshot()

    expect(snapshot.executions).toHaveLength(1)
    expect(snapshot.executions[0]?.authorization).toEqual({ kind: 'manual' })
    expect(snapshot.gatewayEffects).toHaveLength(1)
    expect(snapshot.gatewayEffects[0]).toMatchObject({
      command: {
        id: deriveGatewayCommandId(harness.operation.id, HOMECOMING_LOGICAL_KEYS.preheat),
        logicalKey: HOMECOMING_LOGICAL_KEYS.preheat,
        schemaVersion: 'gateway-command@2',
      },
      milestone: 'preheat',
      dispatchState: { status: 'pending', generation: 1 },
      effectState: { status: 'pending' },
    })
    expect(snapshot.outbox.map((message) => message.topic).sort()).toEqual([
      'execution.deadline',
      'gateway.dispatch',
    ])
    expect(snapshot.evidence).toHaveLength(4)
    const [activeRoutine, protectedRoutineInactive, batteryProjection, tenantBinding] =
      snapshot.evidence
    if (
      activeRoutine === undefined ||
      protectedRoutineInactive === undefined ||
      batteryProjection === undefined ||
      tenantBinding === undefined
    ) {
      throw new Error('Activation evidence is incomplete')
    }
    const scope = {
      organizationId: IDS.organization,
      missionId: IDS.mission,
      palaceId: IDS.palace,
      observedAt: '2026-08-14T05:40:00.000Z',
    }
    expect(snapshot.evidence).toEqual([
      expectedApplicationRecord(
        activeRoutine,
        ACTIVATION_APPLICATION_EVIDENCE_RULES.activeRoutine,
        [],
        {
          id: activeRoutine.evidence.id,
          ...scope,
          type: 'routine_state',
          routineId: IDS.replacementRoutine,
          routineVersionId: IDS.replacementVersion,
          active: true,
          planId: harness.plan.id,
          planHash: harness.plan.hash,
        },
      ),
      expectedApplicationRecord(
        protectedRoutineInactive,
        ACTIVATION_APPLICATION_EVIDENCE_RULES.protectedRoutineInactive,
        [],
        {
          id: protectedRoutineInactive.evidence.id,
          ...scope,
          type: 'routine_state',
          routineId: IDS.protectedRoutine,
          routineVersionId: IDS.protectedVersion,
          active: false,
          planId: harness.plan.id,
          planHash: harness.plan.hash,
        },
      ),
      expectedApplicationRecord(
        batteryProjection,
        ACTIVATION_APPLICATION_EVIDENCE_RULES.batteryProjection,
        [activeRoutine.evidence.id],
        {
          id: batteryProjection.evidence.id,
          ...scope,
          type: 'battery_projection',
          projectedUsePercentagePoints: 13.2,
        },
      ),
      expectedApplicationRecord(
        tenantBinding,
        ACTIVATION_APPLICATION_EVIDENCE_RULES.tenantBinding,
        [activeRoutine.evidence.id, protectedRoutineInactive.evidence.id],
        {
          id: tenantBinding.evidence.id,
          ...scope,
          type: 'tenant_access_audit',
          attemptedOrganizationId: IDS.organization,
          allowed: true,
          operationId: harness.operation.id,
        },
      ),
    ])
    expect(
      snapshot.evidence.some((record) =>
        ['device_command', 'gateway_delivery', 'lock_observation'].includes(record.evidence.type),
      ),
    ).toBe(false)
    expect(snapshot.executions[0]?.execution.evidenceIds).toEqual(
      snapshot.evidence.map((record) => record.evidence.id),
    )
  })

  it('calls the gateway once when the same generation reference is redelivered', async () => {
    const harness = await activatedHarness()
    const effect = (await harness.store.snapshot()).gatewayEffects[0]!
    let calls = 0
    const service = new GatewayDispatchService(
      harness.store,
      {
        dispatch: async () => {
          calls += 1
          return { status: 'accepted', acknowledgementId: 'gack_fixture0001' }
        },
      },
      harness.clock,
      harness.ids,
    )
    const reference = {
      organizationId: IDS.organization,
      operationId: harness.operation.id,
      commandId: effect.command.id,
      generation: 1,
    }

    await expect(service.dispatch(reference)).resolves.toMatchObject({ status: 'finalized' })
    await expect(service.dispatch(reference)).resolves.toMatchObject({
      status: 'not_claimed',
      claim: { reason: 'dispatch_terminal' },
    })
    expect(calls).toBe(1)
    expect((await harness.store.snapshot()).attempts).toHaveLength(1)
  })

  it('reloads the verified tag and causal receipt at claim time', async () => {
    const harness = await activatedHarness()
    const arrival = identityArrival(true)
    await harness.store.run(IDS.organization, (repositories) =>
      repositories.evidence.appendMany([arrival]),
    )
    const evidenceService = new PersistedEvidenceExecutionService(
      harness.store,
      undefined,
      harness.clock,
      harness.ids,
    )
    await evidenceService.apply({
      organizationId: IDS.organization,
      operationId: harness.operation.id,
      evidenceId: arrival.evidence.id,
    })
    const snapshot = await harness.store.snapshot()
    const unlock = snapshot.gatewayEffects.find((effect) => effect.milestone === 'unlock')!
    const restarted = new InMemoryApplicationStore(
      {
        missions: snapshot.missions,
        plans: snapshot.plans,
        operations: snapshot.operations,
        devices: snapshot.devices,
        capabilities: snapshot.capabilities,
        identityTags: [makeIdentityTag(false, true)],
        gatewayEffects: snapshot.gatewayEffects,
        executions: snapshot.executions,
        evidence: snapshot.evidence,
        outbox: snapshot.outbox,
      },
      harness.clock,
    )
    let calls = 0
    const dispatch = new GatewayDispatchService(
      restarted,
      {
        dispatch: async () => {
          calls += 1
          return { status: 'accepted', acknowledgementId: 'gack_fixture0001' }
        },
      },
      harness.clock,
      harness.ids,
    )

    await expect(
      dispatch.dispatch({
        organizationId: IDS.organization,
        operationId: harness.operation.id,
        commandId: unlock.command.id,
        generation: 1,
      }),
    ).resolves.toMatchObject({
      status: 'not_claimed',
      claim: { reason: 'authorization_invalid' },
    })
    expect(calls).toBe(0)
  })

  it('does not materialize arrival effects from unverified telemetry', async () => {
    const harness = await activatedHarness()
    const arrival = identityArrival(false)
    await harness.store.run(IDS.organization, (repositories) =>
      repositories.evidence.appendMany([arrival]),
    )
    const service = new PersistedEvidenceExecutionService(
      harness.store,
      undefined,
      harness.clock,
      harness.ids,
    )

    const result = await service.apply({
      organizationId: IDS.organization,
      operationId: harness.operation.id,
      evidenceId: arrival.evidence.id,
    })

    expect(result.effects).toHaveLength(0)
    expect((await harness.store.snapshot()).gatewayEffects).toHaveLength(1)
  })

  it('does not revive a terminal execution when verified telemetry arrives late', async () => {
    const harness = await activatedHarness()
    const execution = (await harness.store.snapshot()).executions[0]?.execution
    if (execution === undefined) throw new Error('Activated execution is absent')
    await harness.store.run(IDS.organization, (repositories) =>
      repositories.executions.evaluateReadiness({
        missionId: IDS.mission,
        operationId: harness.operation.id,
        executionId: execution.id,
        evaluatedAt: '2026-08-14T08:00:00.000Z',
      }),
    )
    const arrival = identityArrival(true)
    await harness.store.run(IDS.organization, (repositories) =>
      repositories.evidence.appendMany([arrival]),
    )
    const service = new PersistedEvidenceExecutionService(
      harness.store,
      undefined,
      harness.clock,
      harness.ids,
    )

    const result = await service.apply({
      organizationId: IDS.organization,
      operationId: harness.operation.id,
      evidenceId: arrival.evidence.id,
    })

    expect(result.execution.status).toBe('failed')
    expect(result.effects).toHaveLength(0)
    expect((await harness.store.snapshot()).gatewayEffects).toHaveLength(1)
  })

  it('rejects a worker reference rebound to another mission or execution before effects', async () => {
    const harness = await activatedHarness()
    const arrival = identityArrival(true)
    await harness.store.run(IDS.organization, (repositories) =>
      repositories.evidence.appendMany([arrival]),
    )
    const before = await harness.store.snapshot()
    const execution = before.executions[0]?.execution
    if (execution === undefined) throw new Error('Activated execution is absent')
    const service = new PersistedEvidenceExecutionService(
      harness.store,
      undefined,
      harness.clock,
      harness.ids,
    )

    await expect(
      service.apply({
        organizationId: IDS.organization,
        missionId: MissionIdSchema.parse('mis_foreign_worker_reference'),
        operationId: harness.operation.id,
        executionId: execution.id,
        evidenceId: arrival.evidence.id,
      }),
    ).rejects.toThrow(/reference is not bound/)
    await expect(
      service.apply({
        organizationId: IDS.organization,
        missionId: IDS.mission,
        operationId: harness.operation.id,
        executionId: ExecutionIdSchema.parse('exe_foreign_worker_reference'),
        evidenceId: arrival.evidence.id,
      }),
    ).rejects.toThrow(/reference is not bound/)
    expect(await harness.store.snapshot()).toEqual(before)
  })

  it('retries only a definitive retryable failure with the same command identity', async () => {
    const harness = await activatedHarness()
    const effect = (await harness.store.snapshot()).gatewayEffects[0]!
    const firstDispatch = new GatewayDispatchService(
      harness.store,
      {
        dispatch: async () => ({
          status: 'failed',
          retryable: true,
          code: 'GATEWAY_BUSY',
          message: 'Gateway asked the caller to retry',
        }),
      },
      harness.clock,
      harness.ids,
    )
    const generationOne = {
      organizationId: IDS.organization,
      operationId: harness.operation.id,
      commandId: effect.command.id,
      generation: 1,
    }
    await firstDispatch.dispatch(generationOne)
    const reconciliation = new GatewayEffectReconciliationService(
      harness.store,
      harness.clock,
      harness.ids,
    )

    const retry = await reconciliation.reconcile(generationOne)

    expect(retry).toMatchObject({
      status: 'retry_authorized',
      effect: {
        command: { id: effect.command.id },
        dispatchState: { status: 'pending', generation: 2 },
      },
    })
  })

  it('escalates an exhausted unknown effect without declaring cancellation safe', async () => {
    const harness = await activatedHarness()
    const effect = (await harness.store.snapshot()).gatewayEffects[0]!
    const dispatch = new GatewayDispatchService(
      harness.store,
      { dispatch: async () => ({ status: 'unknown', retryable: true, reason: 'lost_ack' }) },
      harness.clock,
      harness.ids,
    )
    const reference = {
      organizationId: IDS.organization,
      operationId: harness.operation.id,
      commandId: effect.command.id,
      generation: 1,
    }
    await dispatch.dispatch(reference)
    await harness.store.run(IDS.organization, async (repositories) => {
      const mission = await repositories.missions.get(IDS.mission)
      if (mission === null) throw new Error('fixture mission missing')
      await repositories.missions.save(
        {
          ...mission,
          state: { status: 'running', phase: 'reconcile' },
          version: mission.version + 1,
        },
        mission.version,
      )
    })
    const reconciliation = new GatewayEffectReconciliationService(
      harness.store,
      harness.clock,
      harness.ids,
      2,
      1,
    )
    await reconciliation.reconcile(reference)
    const exhausted = await reconciliation.reconcile(reference)

    expect(exhausted.status).toBe('intervention_required')
    const snapshot = await harness.store.snapshot()
    expect(snapshot.missions[0]?.state).toEqual({
      status: 'waiting_for_user',
      phase: 'reconcile',
    })
    expect(snapshot.missionEvents.at(-1)?.event).toBe('reconcile_budget_exhausted')
  })
})

async function activatedHarness() {
  const plan = makePlan()
  const operation = makeOperation(plan)
  const clock = new MutableClock(new Date('2026-08-14T05:40:00.000Z'))
  const ids = new SequentialIdGenerator()
  const store = new InMemoryApplicationStore(
    {
      palaces: [makePalace()],
      devices: makeDevices(),
      capabilities: makeCapabilities(),
      identityTags: [makeIdentityTag()],
      missions: [makeMission()],
      plans: [plan],
      approvals: [makeApproval(plan)],
      operations: [operation],
      routineVersions: [makeProtectedVersion()],
    },
    clock,
  )
  const activation = new OperationService(store, clock, ids)
  await activation.activate({
    authorization: 'manual',
    context: authContext,
    planId: plan.id,
    actionId: IDS.action,
    expectedVersion: 3,
    toolCallId: IDS.toolCall,
  })
  return { store, plan, operation, clock, ids }
}

function identityArrival(verified: boolean) {
  const evidenceId = EvidenceIdSchema.parse(
    verified ? 'evd_verifiedarrival1' : 'evd_unverifiedarr01',
  )
  return PersistedEvidenceRecordSchema.parse({
    evidence: {
      id: evidenceId,
      organizationId: IDS.organization,
      missionId: IDS.mission,
      palaceId: IDS.palace,
      observedAt: '2026-08-14T05:58:00.000Z',
      type: 'identity_arrival',
      identityTagId: IDS.identityTag,
      verified,
    },
    authorityReceipt: {
      id: ReceiptIdSchema.parse(verified ? 'rcp_verifiedarrival1' : 'rcp_unverifiedarr01'),
      evidenceId,
      organizationId: IDS.organization,
      missionId: IDS.mission,
      palaceId: IDS.palace,
      verifiedAt: '2026-08-14T05:58:00.000Z',
      authority: 'identity_telemetry',
      providerEventId: verified ? 'idt_verified_arrival_01' : 'idt_unverified_arrival_01',
      identityTagId: IDS.identityTag,
      authenticityVerified: true,
      tenantBindingVerified: true,
    },
    persistedAt: '2026-08-14T05:58:00.000Z',
  })
}

function expectedApplicationRecord(
  record: Awaited<ReturnType<InMemoryApplicationStore['snapshot']>>['evidence'][number],
  rule: { readonly id: string; readonly version: number },
  inputEvidenceIds: readonly string[],
  evidence: (typeof record)['evidence'],
) {
  return {
    schemaVersion: 'persisted-evidence@1',
    evidence,
    authorityReceipt: {
      schemaVersion: 'evidence-authority-receipt@1',
      id: record.authorityReceipt.id,
      evidenceId: evidence.id,
      organizationId: evidence.organizationId,
      missionId: evidence.missionId,
      palaceId: evidence.palaceId,
      verifiedAt: record.persistedAt,
      authority: 'application',
      producer: 'application_code',
      ruleId: rule.id,
      ruleVersion: rule.version,
      inputEvidenceIds,
      derivationVerified: true,
    },
    persistedAt: record.persistedAt,
  }
}

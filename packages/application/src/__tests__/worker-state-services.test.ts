import {
  EvidenceIdSchema,
  GatewayCallbackSchema,
  GatewayCommandIdSchema,
  type GatewayCommandId,
  OperationIdSchema,
  type OperationId,
  PersistedEvidenceRecordSchema,
  PrincipalSchema,
  ReceiptIdSchema,
  computeGatewayCallbackPayloadHash,
} from '@trash-palace/core'
import { describe, expect, it } from 'vitest'

import { GatewayCallbackService } from '../callback-service.js'
import { CancellationService } from '../cancellation-service.js'
import { PersistedEvidenceExecutionService } from '../execution-materialization-service.js'
import { LeaseUnavailableError } from '../errors.js'
import { MissionLeaseService } from '../mission-lease-service.js'
import type { DelegatedAuthContext, OutboxMessage } from '../models.js'
import { GatewayDispatchService } from '../operation-dispatch-service.js'
import { OperationService } from '../operation-service.js'
import { OutboxDispatcher } from '../outbox-service.js'
import type { SensitiveMutationGuardPort, UnitOfWorkPort } from '../ports.js'
import {
  FakeQueue,
  InMemoryApplicationStore,
  MutableClock,
  SequentialIdGenerator,
} from '../testing/fakes.js'
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
import { applicationProductEvents } from './evidence-test-helpers.js'
import { createApplicationEvidenceHarness } from './evidence-test-helpers.js'

const allowMutation: SensitiveMutationGuardPort = { assert: () => undefined }

describe('transactional outbox delivery', () => {
  it('claims once, publishes with a stable key, and marks delivery', async () => {
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const message = makeOutboxMessage()
    const store = new InMemoryApplicationStore({ outbox: [message] })
    const queue = new FakeQueue()
    const dispatcher = new OutboxDispatcher(store, store, queue, clock)

    await expect(dispatcher.dispatchBatch({ ownerId: 'worker-1' })).resolves.toEqual([
      { messageId: message.id, status: 'dispatched' },
    ])
    await expect(dispatcher.dispatchBatch({ ownerId: 'worker-1' })).resolves.toEqual([])
    expect(queue.published).toHaveLength(1)
  })

  it('releases a failed delivery for a later retry', async () => {
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const store = new InMemoryApplicationStore({ outbox: [makeOutboxMessage()] })
    const queue = new FakeQueue()
    queue.failNext = Object.assign(new Error('queue unavailable'), { code: 'QUEUE_DOWN' })
    const dispatcher = new OutboxDispatcher(store, store, queue, clock)

    await expect(dispatcher.dispatchBatch({ ownerId: 'worker-1' })).resolves.toMatchObject([
      { status: 'released', errorCode: 'QUEUE_DOWN' },
    ])
    clock.advance(2_000)
    await expect(dispatcher.dispatchBatch({ ownerId: 'worker-2' })).resolves.toMatchObject([
      { status: 'dispatched' },
    ])
  })
})

describe('renewable mission leases', () => {
  it('preserves the checkpoint across expiry and worker replacement', async () => {
    const mission = makeMission({ status: 'running', phase: 'reconcile' }, 12)
    const clock = new MutableClock(new Date('2026-08-14T05:35:00.000Z'))
    const store = new InMemoryApplicationStore({ missions: [mission] }, clock)
    const leases = new MissionLeaseService(store, clock, new SequentialIdGenerator(), {
      token: () => 'lease_token_12345678901234567890',
    })
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
    clock.advance(2_001)
    const resumed = await leases.acquire({
      organizationId: IDS.organization,
      missionId: mission.id,
      ownerId: 'worker-2',
      ttlMilliseconds: 2_000,
    })
    expect([first.fence.epoch, resumed.fence.epoch]).toEqual([1, 2])
    expect(resumed.mission.state).toEqual({ status: 'running', phase: 'reconcile' })
  })
})

describe('cancellation and callback reconciliation', () => {
  it('accepts a scoped delegated credential without browser CSRF state', async () => {
    const mission = makeMission({ status: 'running', phase: 'execute' }, 7)
    const store = new InMemoryApplicationStore({ missions: [mission] })
    const clock = new MutableClock(new Date('2026-08-14T05:40:00.000Z'))
    const service = new CancellationService(
      store,
      allowMutation,
      clock,
      new SequentialIdGenerator(),
    )
    const delegated: DelegatedAuthContext = {
      tokenId: 'tok_cancel_scoped',
      principal: PrincipalSchema.parse({
        organizationId: IDS.organization,
        actorId: IDS.owner,
        role: 'delegated',
        operatorGrants: [],
        delegatedPermissions: ['mission:cancel'],
      }),
      expiresAt: '2026-08-14T06:40:00.000Z',
    }

    const result = await service.cancel({
      authorization: 'delegated',
      context: delegated,
      missionId: mission.id,
      reason: 'Rocky stopped this mission from an MCP client',
    })

    expect(result.cancellation.outcome).toBe('cancelled_without_mutation')
    expect(result.mission.state).toEqual({ status: 'cancelled', phase: 'execute' })
  })

  it('cancels materialized pending work without misclassifying execution existence', async () => {
    const harness = await activatedHarness()
    const cancellation = new CancellationService(
      harness.store,
      allowMutation,
      harness.clock,
      harness.ids,
    )

    const result = await cancellation.cancel(browserCancellationInput())

    expect(result.cancellation.checkpoint).toBe('claimed_or_committed')
    expect(result.cancellation.compensatingPlanRequired).toBe(false)
    expect(result.mission.state.status).toBe('cancelled')
    expect((await harness.store.snapshot()).gatewayEffects[0]?.dispatchState.status).toBe(
      'cancelled',
    )
  })

  it('retains terminal unlock evidence and one mandatory relock after cancellation', async () => {
    const harness = await activatedHarness()
    harness.clock.advance(18 * 60 * 1_000)
    const arrival = verifiedArrival()
    await harness.store.run(IDS.organization, (repositories) =>
      repositories.evidence.appendMany([arrival]),
    )
    await new PersistedEvidenceExecutionService(
      harness.store,
      undefined,
      harness.clock,
      harness.ids,
    ).apply({
      organizationId: IDS.organization,
      operationId: harness.operation.id,
      evidenceId: arrival.evidence.id,
    })
    const unlock = (await harness.store.snapshot()).gatewayEffects.find(
      (effect) => effect.milestone === 'unlock',
    )!
    await new GatewayDispatchService(
      harness.store,
      { dispatch: async () => ({ status: 'accepted', acknowledgementId: 'gack_unlock0001' }) },
      harness.clock,
      harness.ids,
    ).dispatch({
      organizationId: IDS.organization,
      operationId: harness.operation.id,
      commandId: unlock.command.id,
      generation: 1,
    })
    const cancelled = await new CancellationService(
      harness.store,
      allowMutation,
      harness.clock,
      harness.ids,
    ).cancel(browserCancellationInput())
    expect(cancelled.mission.state).toEqual({ status: 'running', phase: 'reconcile' })

    const callback = completedUnlockCallback(unlock.command.id, harness.operation.id)
    const applicationEvidence = createApplicationEvidenceHarness()
    const service = new GatewayCallbackService(
      harness.store,
      {
        verify: async () => ({
          callback,
          authenticatedPrincipal: {
            id: 'gwp_fixture_gateway',
            organizationId: IDS.organization,
          },
          verifierKeyId: 'gwk_fixture_2026',
          verifierKeyVersion: 1,
          verifierVersion: 1,
          signatureTimestamp: callback.occurredAt,
          verifiedPayloadDigest: computeGatewayCallbackPayloadHash(callback),
        }),
      },
      undefined,
      harness.clock,
      harness.ids,
      applicationEvidence.observability,
    )
    const first = await service.ingest({})
    harness.clock.advance(1_000)
    const duplicate = await service.ingest({})
    const snapshot = await harness.store.snapshot()
    const relocks = snapshot.gatewayEffects.filter((effect) => effect.milestone === 'relock')

    expect(first.status).toBe('stored')
    expect(duplicate.status).toBe('duplicate')
    expect(relocks).toHaveLength(1)
    expect(relocks[0]).toMatchObject({
      cancellationPolicy: 'mandatory_relock',
      authorization: { kind: 'manual' },
      dispatchState: { status: 'pending' },
    })
    expect(
      snapshot.outbox.filter(
        (message) =>
          message.topic === 'gateway.dispatch' &&
          message.payload.commandId === relocks[0]?.command.id,
      ),
    ).toHaveLength(1)
    expect(snapshot.gatewayCallbacks).toHaveLength(1)
    expect(
      snapshot.evidence.filter(
        (record) => record.authorityReceipt.authority === 'gateway_callback',
      ),
    ).toHaveLength(3)
    expect(first.mission.state).toEqual({ status: 'running', phase: 'reconcile' })
    expect((await applicationProductEvents(harness.store)).map((event) => event.event)).toEqual([
      'execution observed',
    ])
  })

  it('rejects a callback tenant that differs from its authenticated principal before a UoW', async () => {
    const callback = completedUnlockCallback(
      GatewayCommandIdSchema.parse(
        'gcmd_6f7f5d8514f3946d7b1dc61330062f5979bb026fc52120bfbb25f2bf2337ef67',
      ),
      OperationIdSchema.parse('op_cross_tenant_callback'),
    )
    const crossTenant = GatewayCallbackSchema.parse({
      ...callback,
      organizationId: 'org_mirror_nest',
      evidence: callback.evidence.map((item) => ({
        ...item,
        organizationId: 'org_mirror_nest',
      })),
    })
    let transactionStarted = false
    const unitOfWork: UnitOfWorkPort = {
      async run<Result>(): Promise<Result> {
        transactionStarted = true
        throw new Error('Tenant UoW must not start')
      },
    }
    const service = new GatewayCallbackService(unitOfWork, {
      verify: async () => ({
        callback: crossTenant,
        authenticatedPrincipal: {
          id: 'gwp_fixture_gateway',
          organizationId: IDS.organization,
        },
        verifierKeyId: 'gwk_fixture_2026',
        verifierKeyVersion: 1,
        verifierVersion: 1,
        signatureTimestamp: crossTenant.occurredAt,
        verifiedPayloadDigest: computeGatewayCallbackPayloadHash(crossTenant),
      }),
    })

    await expect(service.ingest({})).rejects.toThrow(/authenticated principal/)
    expect(transactionStarted).toBe(false)
  })
})

function makeOutboxMessage(): OutboxMessage {
  return {
    id: 'out_message00001',
    organizationId: IDS.organization,
    topic: 'mission.resume',
    deduplicationKey: 'mission.resume:fixture',
    payload: { organizationId: IDS.organization, missionId: IDS.mission },
    status: 'pending',
    availableAt: '2026-08-14T05:35:00.000Z',
    createdAt: '2026-08-14T05:35:00.000Z',
    claimedBy: null,
    claimExpiresAt: null,
    dispatchedAt: null,
    deliveryAttempts: 0,
    lastErrorCode: null,
  }
}

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
  await new OperationService(store, clock, ids).activate({
    authorization: 'manual',
    context: authContext,
    planId: plan.id,
    actionId: IDS.action,
    expectedVersion: 3,
    toolCallId: IDS.toolCall,
  })
  return { store, operation, clock, ids }
}

function browserCancellationInput() {
  return {
    authorization: 'browser' as const,
    context: authContext,
    missionId: IDS.mission,
    reason: 'Stop the current homecoming execution',
    csrfToken: authContext.csrfToken,
    origin: 'http://localhost:3000',
    allowedOrigin: 'http://localhost:3000',
  }
}

function verifiedArrival() {
  const evidenceId = EvidenceIdSchema.parse('evd_verifiedarrival1')
  return PersistedEvidenceRecordSchema.parse({
    evidence: {
      id: evidenceId,
      organizationId: IDS.organization,
      missionId: IDS.mission,
      palaceId: IDS.palace,
      observedAt: '2026-08-14T05:58:00.000Z',
      type: 'identity_arrival',
      identityTagId: IDS.identityTag,
      verified: true,
    },
    authorityReceipt: {
      id: ReceiptIdSchema.parse('rcp_verifiedarrival1'),
      evidenceId,
      organizationId: IDS.organization,
      missionId: IDS.mission,
      palaceId: IDS.palace,
      verifiedAt: '2026-08-14T05:58:00.000Z',
      authority: 'identity_telemetry',
      providerEventId: 'idt_verified_arrival_01',
      identityTagId: IDS.identityTag,
      authenticityVerified: true,
      tenantBindingVerified: true,
    },
    persistedAt: '2026-08-14T05:58:00.000Z',
  })
}

function completedUnlockCallback(commandId: GatewayCommandId, operationId: OperationId) {
  return GatewayCallbackSchema.parse({
    id: 'gcb_unlockcomplete1',
    organizationId: IDS.organization,
    missionId: IDS.mission,
    palaceId: IDS.palace,
    commandId,
    operationId,
    nonce: 'gwn_unlock_completed_nonce_123456789',
    status: 'completed',
    occurredAt: '2026-08-14T05:59:00.000Z',
    evidence: [
      {
        id: 'evd_unlockcommand01',
        organizationId: IDS.organization,
        missionId: IDS.mission,
        palaceId: IDS.palace,
        observedAt: '2026-08-14T05:59:00.000Z',
        type: 'device_command',
        deviceId: IDS.lock,
        command: 'unlock',
        causedByEvidenceId: 'evd_verifiedarrival1',
      },
      {
        id: 'evd_unlockobserve01',
        organizationId: IDS.organization,
        missionId: IDS.mission,
        palaceId: IDS.palace,
        observedAt: '2026-08-14T05:59:00.000Z',
        type: 'lock_observation',
        deviceId: IDS.lock,
        desiredState: 'unlocked',
      },
      {
        id: 'evd_unlockdeliver001',
        organizationId: IDS.organization,
        missionId: IDS.mission,
        palaceId: IDS.palace,
        observedAt: '2026-08-14T05:59:00.000Z',
        type: 'gateway_delivery',
        gatewayCommandId: commandId,
        operationId,
        status: 'completed',
        code: null,
      },
    ],
  })
}

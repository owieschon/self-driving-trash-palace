import {
  OpaqueMissionFenceToken,
  IdentityArrivalExecutionReferenceSchema,
  type ExecutionDeadlineReference,
  type ExecutionDeadlineService,
  type GatewayDispatchReference,
  type GatewayDispatchService,
  type GatewayEffectReconciliationReference,
  type GatewayEffectReconciliationService,
  type JsonValue,
  type OperationReconciliationReference,
  type OperationService,
  type ServiceContext,
  type VerificationService,
  type MissionFence,
} from '@trash-palace/application'
import {
  AttemptIdSchema,
  ExecutionIdSchema,
  EvidenceIdSchema,
  GatewayCommandIdSchema,
  MissionIdSchema,
  MissionSchema,
  OperationIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PrincipalSchema,
  UserIdSchema,
} from '@trash-palace/core'
import { describe, expect, it, vi } from 'vitest'

import { composePgBossWorkerGraph, composePgBossWorkerRuntime } from './composition.js'
import type { HeartbeatPort } from './heartbeat.js'
import type { OutboxPumpPort } from './outbox-pump.js'
import type {
  QueueSuccessorOptions,
  WorkerJobMetadata,
  WorkerQueuePort,
} from './pg-boss-adapter.js'
import {
  WORKER_JOB_TOPICS,
  WorkerRuntime,
  type WorkerRuntimeDependencies,
} from './worker-runtime.js'

const organizationId = OrganizationIdSchema.parse('org_primary0001')
const operationId = OperationIdSchema.parse('op_operation0001')
const attemptId = AttemptIdSchema.parse('att_attempt0000001')
const missionId = MissionIdSchema.parse('mis_mission00001')
const commandId = GatewayCommandIdSchema.parse('gcmd_command00000001')
const executionId = ExecutionIdSchema.parse('exe_execution000001')
const evidenceId = EvidenceIdSchema.parse('evd_evidence0000001')
const principal = PrincipalSchema.parse({
  organizationId,
  actorId: UserIdSchema.parse('usr_service0001'),
  role: 'service',
  operatorGrants: [],
  delegatedPermissions: [],
})
const serviceContext: ServiceContext = { principal, source: 'worker' }

const dispatchReference: GatewayDispatchReference = {
  organizationId,
  operationId,
  commandId,
  generation: 1,
}

const deadlineReference: ExecutionDeadlineReference = {
  organizationId,
  missionId,
  operationId,
  executionId,
}

const identityArrivalReference = IdentityArrivalExecutionReferenceSchema.parse({
  organizationId,
  missionId,
  operationId,
  executionId,
  evidenceId,
})

const operationReconciliationReference: OperationReconciliationReference = {
  organizationId,
  operationId,
  attemptId,
}

class FakeWorkerQueue implements WorkerQueuePort {
  readonly handlers = new Map<
    string,
    (
      payload: Readonly<Record<string, JsonValue>>,
      signal: AbortSignal,
      metadata: WorkerJobMetadata,
    ) => Promise<void>
  >()
  readonly successors: {
    readonly topic: string
    readonly payload: Readonly<Record<string, JsonValue>>
    readonly options: QueueSuccessorOptions
  }[] = []
  readonly schedules: { readonly topic: string; readonly cron: string }[] = []
  started = false
  stopped = false

  async start(): Promise<void> {
    this.started = true
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  async publish(): Promise<{ jobId: string; duplicate: false }> {
    return { jobId: 'job_fixture', duplicate: false }
  }

  async publishSuccessor(
    topic: string,
    payload: Readonly<Record<string, JsonValue>>,
    options: QueueSuccessorOptions,
  ): Promise<{ jobId: string; duplicate: false }> {
    this.successors.push({ topic, payload, options })
    return { jobId: `job_successor_${this.successors.length}`, duplicate: false }
  }

  async register(
    topic: string,
    handler: (
      payload: Readonly<Record<string, JsonValue>>,
      signal: AbortSignal,
      metadata: WorkerJobMetadata,
    ) => Promise<void>,
  ): Promise<void> {
    this.handlers.set(topic, handler)
  }

  async schedule(topic: string, cron: string): Promise<void> {
    this.schedules.push({ topic, cron })
  }
}

class FakeOutboxPump implements OutboxPumpPort {
  intervalMilliseconds: number | null = null
  stopped = false
  sweep: (() => Promise<void>) | null = null

  async start(input: {
    readonly intervalMilliseconds: number
    readonly sweep: () => Promise<void>
  }): Promise<void> {
    this.intervalMilliseconds = input.intervalMilliseconds
    this.sweep = input.sweep
  }

  async stop(): Promise<void> {
    this.stopped = true
  }
}

function createHarness(
  input: {
    readonly onDispatch?: (reference: GatewayDispatchReference) => void
    readonly onEffectReconciliation?: (reference: GatewayEffectReconciliationReference) => void
    readonly onDeadline?: (reference: ExecutionDeadlineReference) => void
  } = {},
) {
  const queue = new FakeWorkerQueue()
  const outboxPump = new FakeOutboxPump()
  const gatewayDispatch = vi.fn(
    async (reference: Parameters<GatewayDispatchService['dispatch']>[0]) => {
      input.onDispatch?.(reference)
      return undefined as never
    },
  )
  const gatewayEffectReconciliation = vi.fn(
    async (reference: Parameters<GatewayEffectReconciliationService['reconcile']>[0]) => {
      input.onEffectReconciliation?.(reference)
      return undefined as never
    },
  )
  const executionDeadline = vi.fn(
    async (reference: Parameters<ExecutionDeadlineService['evaluate']>[0]) => {
      input.onDeadline?.(reference)
      return undefined as never
    },
  )
  const identityArrivalExecution = vi.fn(async () => undefined as never)
  const operationReconciliation = vi.fn(
    async (_input: Parameters<OperationService['reconcile']>[0]) => undefined as never,
  )
  const verification = vi.fn(
    async (_input: Parameters<VerificationService['run']>[0]) => undefined as never,
  )
  const outboxSweep = vi.fn(async () => undefined as never)
  const productEvidenceSweep = vi.fn(async () => 0)
  const leaseAcquire = vi.fn(async () => {
    throw new Error('Mission lease is unused in this test')
  })
  const dependencies: WorkerRuntimeDependencies = {
    queue,
    outbox: { dispatchBatch: outboxSweep },
    productEvidence: { deliverPending: productEvidenceSweep },
    gatewayDispatch: { dispatch: gatewayDispatch },
    gatewayEffectReconciliation: { reconcile: gatewayEffectReconciliation },
    executionDeadline: { evaluate: executionDeadline },
    identityArrivalExecution: { handle: identityArrivalExecution },
    operations: { reconcile: operationReconciliation },
    verification: { run: verification },
    leases: {
      acquire: leaseAcquire,
      renew: async () => {
        throw new Error('Mission lease is unused in this test')
      },
      release: async () => {
        throw new Error('Mission lease is unused in this test')
      },
    },
    missionRunner: {
      resume: async () => {
        throw new Error('Mission runner is unused in this test')
      },
    },
    serviceContextFor: () => serviceContext,
    outboxPump,
    outboxPumpIntervalMilliseconds: 25,
    workerId: 'worker-1',
  }
  return {
    runtime: new WorkerRuntime(dependencies),
    queue,
    outboxPump,
    gatewayDispatch,
    gatewayEffectReconciliation,
    executionDeadline,
    identityArrivalExecution,
    operationReconciliation,
    verification,
    outboxSweep,
    productEvidenceSweep,
    leaseAcquire,
    dependencies,
  }
}

function handler(queue: FakeWorkerQueue, topic: string) {
  const registered = queue.handlers.get(topic)
  if (registered === undefined) throw new Error(`Missing ${topic} handler`)
  return (
    payload: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal,
    metadata: WorkerJobMetadata = { jobId: `job_${topic}_fixture` },
  ) => registered(payload, signal, metadata)
}

describe('worker runtime', () => {
  it('registers only canonical reference jobs plus the internal outbox sweep', async () => {
    const harness = createHarness()

    await harness.runtime.start()
    await harness.runtime.stop()

    expect(harness.queue.started).toBe(true)
    expect(harness.queue.stopped).toBe(true)
    expect([...harness.queue.handlers.keys()].sort()).toEqual(
      [...WORKER_JOB_TOPICS, 'system.outbox.sweep'].sort(),
    )
    expect(harness.queue.handlers.has('device.dispatch')).toBe(false)
    expect(harness.queue.handlers.has('operation.dispatch')).toBe(false)
    expect(harness.queue.handlers.has('gateway.callback')).toBe(false)
    expect(harness.queue.schedules).toEqual([{ topic: 'system.outbox.sweep', cron: '* * * * *' }])
    expect(harness.outboxPump.intervalMilliseconds).toBe(25)
    expect(harness.outboxPump.stopped).toBe(true)
    expect(harness.outboxSweep).toHaveBeenCalledOnce()
  })

  it('runs the frequent pump through the same durable outbox dispatcher', async () => {
    const harness = createHarness()
    await harness.runtime.start()

    expect(harness.outboxPump.sweep).not.toBeNull()
    await harness.outboxPump.sweep!()
    await harness.runtime.stop()

    expect(harness.outboxSweep).toHaveBeenCalledTimes(2)
    expect(harness.productEvidenceSweep).toHaveBeenCalledOnce()
  })

  it('composes the pg-boss production runtime without opening the queue', async () => {
    const harness = createHarness()
    const { queue: _queue, ...dependencies } = harness.dependencies

    const runtime = await composePgBossWorkerRuntime({
      ...dependencies,
      connection: 'postgres://localhost/trash_palace',
    })

    expect(runtime).toBeInstanceOf(WorkerRuntime)
    expect(harness.queue.started).toBe(false)
  })

  it('builds the outbox publisher and listeners around one owned queue', async () => {
    const harness = createHarness()
    const { queue: _queue, ...dependencies } = harness.dependencies
    let dependencyQueue: WorkerQueuePort | undefined

    const graph = await composePgBossWorkerGraph({
      connection: 'postgres://localhost/trash_palace',
      buildDependencies: (queue) => {
        dependencyQueue = queue
        return dependencies
      },
    })

    expect(graph.runtime).toBeInstanceOf(WorkerRuntime)
    expect(graph.queue).toBe(dependencyQueue)
    expect(harness.queue.started).toBe(false)
  })

  it('rejects command bodies, evidence, and malformed references before dispatch', async () => {
    const harness = createHarness()
    await harness.runtime.start()
    const dispatch = handler(harness.queue, 'gateway.dispatch')
    const signal = new AbortController().signal
    const hostilePayloads: Readonly<Record<string, JsonValue>>[] = [
      { ...dispatchReference, command: { kind: 'unlock' } },
      { ...dispatchReference, evidence: { verified: true } },
      { ...dispatchReference, generation: '1' },
      { ...dispatchReference, commandId: 'gcmd_bad' },
      { organizationId, operationId, commandId },
    ]

    for (const payload of hostilePayloads) {
      await expect(dispatch(payload, signal)).rejects.toThrow()
    }

    expect(harness.gatewayDispatch).not.toHaveBeenCalled()
  })

  it('rejects embedded bodies on every durable reference handler', async () => {
    const harness = createHarness()
    await harness.runtime.start()
    const signal = new AbortController().signal
    const jobs: readonly [string, Readonly<Record<string, JsonValue>>][] = [
      ['gateway.effect.reconcile', { ...dispatchReference, evidence: { status: 'completed' } }],
      ['execution.deadline', { ...deadlineReference, command: { kind: 'unlock' } }],
      ['mission.resume', { organizationId, missionId, evidence: { verified: true } }],
      ['mission.verify', { organizationId, missionId, command: { kind: 'unlock' } }],
      [
        'operation.reconcile',
        { ...operationReconciliationReference, evidence: { verified: true } },
      ],
    ]

    for (const [topic, payload] of jobs) {
      await expect(handler(harness.queue, topic)(payload, signal)).rejects.toThrow()
    }

    expect(harness.gatewayEffectReconciliation).not.toHaveBeenCalled()
    expect(harness.executionDeadline).not.toHaveBeenCalled()
    expect(harness.leaseAcquire).not.toHaveBeenCalled()
    expect(harness.verification).not.toHaveBeenCalled()
    expect(harness.operationReconciliation).not.toHaveBeenCalled()
  })

  it('re-enters the atomic application dispatcher on redelivery without a second gateway call', async () => {
    let dispatchClaimed = false
    let gatewayCalls = 0
    const harness = createHarness({
      onDispatch: () => {
        if (dispatchClaimed) return
        dispatchClaimed = true
        gatewayCalls += 1
      },
    })
    await harness.runtime.start()
    const dispatch = handler(harness.queue, 'gateway.dispatch')
    const signal = new AbortController().signal

    await dispatch(dispatchReference, signal)
    await dispatch(dispatchReference, signal)

    expect(harness.gatewayDispatch).toHaveBeenCalledTimes(2)
    expect(gatewayCalls).toBe(1)
  })

  it('leaves a cancelled reference as an application-level no-op', async () => {
    let gatewayCalls = 0
    const cancelledReferences = new Set([commandId])
    const harness = createHarness({
      onDispatch: (reference) => {
        if (cancelledReferences.has(reference.commandId)) return
        gatewayCalls += 1
      },
    })
    await harness.runtime.start()

    await handler(harness.queue, 'gateway.dispatch')(
      dispatchReference,
      new AbortController().signal,
    )

    expect(harness.gatewayDispatch).toHaveBeenCalledOnce()
    expect(gatewayCalls).toBe(0)
  })

  it('keeps gateway-effect reconciliation separate from application commit reconciliation', async () => {
    const harness = createHarness()
    await harness.runtime.start()

    await handler(harness.queue, 'gateway.effect.reconcile')(
      dispatchReference,
      new AbortController().signal,
    )

    expect(harness.gatewayEffectReconciliation).toHaveBeenCalledWith(dispatchReference)
    expect(harness.operationReconciliation).not.toHaveBeenCalled()
  })

  it('routes operation reconciliation only through the application commit service', async () => {
    const harness = createHarness()
    await harness.runtime.start()

    await handler(harness.queue, 'operation.reconcile')(
      operationReconciliationReference,
      new AbortController().signal,
    )

    expect(harness.operationReconciliation).toHaveBeenCalledWith(operationReconciliationReference)
    expect(harness.gatewayEffectReconciliation).not.toHaveBeenCalled()
  })

  it('rejects operation reconciliation jobs that are not bound to one exact attempt', async () => {
    const harness = createHarness()
    await harness.runtime.start()
    const reconcile = handler(harness.queue, 'operation.reconcile')
    const signal = new AbortController().signal
    const invalidReferences: Readonly<Record<string, JsonValue>>[] = [
      { organizationId, operationId },
      { ...operationReconciliationReference, attemptId: 'att_bad' },
      { ...operationReconciliationReference, attemptIds: [attemptId] },
      { ...operationReconciliationReference, missionId },
    ]

    for (const reference of invalidReferences) {
      await expect(reconcile(reference, signal)).rejects.toThrow()
    }

    expect(harness.operationReconciliation).not.toHaveBeenCalled()
  })

  it('passes the complete execution reference to deadline readiness evaluation', async () => {
    const harness = createHarness()
    await harness.runtime.start()

    await handler(harness.queue, 'execution.deadline')(
      deadlineReference,
      new AbortController().signal,
    )

    expect(harness.executionDeadline).toHaveBeenCalledWith(deadlineReference)
    expect(harness.verification).not.toHaveBeenCalled()
  })

  it('passes only a strict persisted identity-arrival reference to the durable handler', async () => {
    const harness = createHarness()
    await harness.runtime.start()
    const apply = handler(harness.queue, 'execution.identity-arrival')
    const signal = new AbortController().signal

    await apply(identityArrivalReference, signal)
    await expect(
      apply({ ...identityArrivalReference, evidence: { verified: true } }, signal),
    ).rejects.toThrow()

    expect(harness.identityArrivalExecution).toHaveBeenCalledOnce()
    expect(harness.identityArrivalExecution).toHaveBeenCalledWith(identityArrivalReference)
  })

  it('honors a pg-boss abort before application work starts', async () => {
    const harness = createHarness()
    await harness.runtime.start()
    const aborted = new AbortController()
    aborted.abort(new Error('pg-boss stopped the job'))

    await expect(
      handler(harness.queue, 'gateway.dispatch')(dispatchReference, aborted.signal),
    ).rejects.toThrow('pg-boss stopped the job')

    expect(harness.gatewayDispatch).not.toHaveBeenCalled()
  })

  it('renews a lease while resuming the persisted checkpoint', async () => {
    const mission = MissionSchema.parse({
      id: missionId,
      organizationId,
      palaceId: PalaceIdSchema.parse('pal_palace00001'),
      initiatedBy: UserIdSchema.parse('usr_owner000001'),
      objective: 'Resume reconciliation',
      constraints: {
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
      successCriteriaIds: ['criterion_temperature'],
      state: { status: 'running', phase: 'reconcile' },
      version: 9,
      runId: null,
      contextReceiptId: null,
      taskLedger: [],
      createdAt: '2026-08-14T05:35:00.000Z',
      updatedAt: '2026-08-14T05:35:00.000Z',
    })
    const fence: MissionFence = {
      organizationId,
      missionId,
      ownerId: 'worker-1',
      epoch: 1,
      token: OpaqueMissionFenceToken.fromEntropy('lease_token_12345678901234567890'),
    }
    let releasedFence: MissionFence | null = null
    const leases: WorkerRuntimeDependencies['leases'] = {
      acquire: async () => ({ fence, mission, resumed: true }),
      renew: async () => fence,
      release: async (released) => {
        releasedFence = released
        return true
      },
    }
    const queue = new FakeWorkerQueue()
    let heartbeatCount = 0
    const jobAbort = new AbortController()
    const heartbeat: HeartbeatPort = {
      run: async ({ heartbeat: renew, signal, work }) => {
        expect(signal).toBe(jobAbort.signal)
        expect(await renew(new AbortController().signal)).toBe(true)
        heartbeatCount += 1
        return work(new AbortController().signal)
      },
    }
    let resumedPhase: string | null = null
    const unused = async () => undefined as never
    const runtime = new WorkerRuntime({
      queue,
      outbox: { dispatchBatch: unused },
      gatewayDispatch: { dispatch: unused },
      gatewayEffectReconciliation: { reconcile: unused },
      executionDeadline: { evaluate: unused },
      identityArrivalExecution: { handle: unused },
      operations: { reconcile: unused },
      verification: { run: unused },
      leases,
      missionRunner: {
        resume: async ({ mission: resumed, context }) => {
          resumedPhase = resumed.state.phase
          expect(context.signal.aborted).toBe(false)
          expect(context.principal).toEqual(principal)
          expect(() => JSON.stringify(context.fence)).toThrow(/cannot be serialized/)
          return 'paused'
        },
      },
      serviceContextFor: () => serviceContext,
      heartbeat,
      workerId: 'worker-1',
      leaseTtlMilliseconds: 1_000,
    })

    await runtime.start()
    await handler(queue, 'mission.resume')({ organizationId, missionId }, jobAbort.signal)

    expect(heartbeatCount).toBe(1)
    expect(resumedPhase).toBe('reconcile')
    expect(releasedFence).toBe(fence)
    await runtime.stop()
  })

  it('releases the lease and schedules a fresh successor for a normal retry checkpoint', async () => {
    const mission = MissionSchema.parse({
      id: missionId,
      organizationId,
      palaceId: PalaceIdSchema.parse('pal_palace00001'),
      initiatedBy: UserIdSchema.parse('usr_owner000001'),
      objective: 'Recover a transient decision failure',
      constraints: {
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
      successCriteriaIds: ['criterion_temperature'],
      state: { status: 'running', phase: 'understand' },
      version: 3,
      runId: null,
      contextReceiptId: null,
      taskLedger: [],
      createdAt: '2026-08-14T05:35:00.000Z',
      updatedAt: '2026-08-14T05:35:00.000Z',
    })
    const fence: MissionFence = {
      organizationId,
      missionId,
      ownerId: 'worker-1',
      epoch: 1,
      token: OpaqueMissionFenceToken.fromEntropy('lease_token_12345678901234567890'),
    }
    const release = vi.fn(async () => true)
    const unused = async () => undefined as never
    const queue = new FakeWorkerQueue()
    const runtime = new WorkerRuntime({
      queue,
      outbox: { dispatchBatch: unused },
      gatewayDispatch: { dispatch: unused },
      gatewayEffectReconciliation: { reconcile: unused },
      executionDeadline: { evaluate: unused },
      identityArrivalExecution: { handle: unused },
      operations: { reconcile: unused },
      verification: { run: unused },
      leases: {
        acquire: async () => ({ fence, mission, resumed: true }),
        renew: async () => fence,
        release,
      },
      missionRunner: { resume: async () => 'retry' },
      serviceContextFor: () => serviceContext,
      workerId: 'worker-1',
    })

    await runtime.start()

    const predecessorJobIds = Array.from(
      { length: 7 },
      (_, index) => `9ccad3ab-39fd-4e6b-9187-d294f45ab0${index.toString().padStart(2, '0')}`,
    )
    for (const jobId of predecessorJobIds) {
      await expect(
        handler(queue, 'mission.resume')(
          { organizationId, missionId },
          new AbortController().signal,
          { jobId },
        ),
      ).resolves.toBeUndefined()
    }
    expect(release).toHaveBeenCalledTimes(7)
    expect(release).toHaveBeenLastCalledWith(fence)
    expect(queue.successors).toEqual(
      predecessorJobIds.map((predecessorJobId) => ({
        topic: 'mission.resume',
        payload: { organizationId, missionId },
        options: { predecessorJobId, delaySeconds: 1 },
      })),
    )
    await runtime.stop()
  })

  it('leaves infrastructure failures on the current pg-boss retry path', async () => {
    const mission = MissionSchema.parse({
      id: missionId,
      organizationId,
      palaceId: PalaceIdSchema.parse('pal_palace00001'),
      initiatedBy: UserIdSchema.parse('usr_owner000001'),
      objective: 'Retry an infrastructure failure',
      constraints: {
        preheatBy: '02:00',
        requireVerifiedIdentityForUnlock: true,
        pathwayLightingBeginsAfter: 'verified_arrival',
        projectedBatteryUseMaxPercentagePoints: 15,
      },
      successCriteriaIds: ['criterion_temperature'],
      state: { status: 'running', phase: 'understand' },
      version: 3,
      runId: null,
      contextReceiptId: null,
      taskLedger: [],
      createdAt: '2026-08-14T05:35:00.000Z',
      updatedAt: '2026-08-14T05:35:00.000Z',
    })
    const fence: MissionFence = {
      organizationId,
      missionId,
      ownerId: 'worker-1',
      epoch: 1,
      token: OpaqueMissionFenceToken.fromEntropy('lease_token_12345678901234567890'),
    }
    const release = vi.fn(async () => true)
    const unused = async () => undefined as never
    const queue = new FakeWorkerQueue()
    const runtime = new WorkerRuntime({
      queue,
      outbox: { dispatchBatch: unused },
      gatewayDispatch: { dispatch: unused },
      gatewayEffectReconciliation: { reconcile: unused },
      executionDeadline: { evaluate: unused },
      identityArrivalExecution: { handle: unused },
      operations: { reconcile: unused },
      verification: { run: unused },
      leases: {
        acquire: async () => ({ fence, mission, resumed: true }),
        renew: async () => fence,
        release,
      },
      missionRunner: {
        resume: async () => {
          throw new Error('dependency unavailable')
        },
      },
      serviceContextFor: () => serviceContext,
      workerId: 'worker-1',
    })

    await runtime.start()
    await expect(
      handler(queue, 'mission.resume')({ organizationId, missionId }, new AbortController().signal),
    ).rejects.toThrow('dependency unavailable')
    expect(release).toHaveBeenCalledWith(fence)
    expect(queue.successors).toEqual([])
    await runtime.stop()
  })
})

import {
  ExecutionDeadlineReferenceSchema,
  GatewayDispatchReferenceSchema,
  GatewayEffectReconciliationReferenceSchema,
  IDENTITY_ARRIVAL_EXECUTION_TOPIC,
  IdentityArrivalExecutionReferenceSchema,
  MissionReferenceSchema,
  OperationReconciliationReferenceSchema,
  type ExecutionDeadlineService,
  type GatewayDispatchService,
  type GatewayEffectReconciliationService,
  type IdentityArrivalExecutionJobHandler,
  type JsonValue,
  type MissionLeaseService,
  type MissionRunnerPort,
  type OperationService,
  type OutboxDispatcher,
  type ProductEvidenceProjector,
  type ServiceContext,
  type VerificationService,
} from '@trash-palace/application'
import type { OrganizationId } from '@trash-palace/core'

import { TimerHeartbeat, type HeartbeatPort } from './heartbeat.js'
import { TimerOutboxPump, type OutboxPumpPort } from './outbox-pump.js'
import type { WorkerJobMetadata, WorkerQueuePort } from './pg-boss-adapter.js'

export const WORKER_JOB_TOPICS = [
  'gateway.dispatch',
  'gateway.effect.reconcile',
  'execution.deadline',
  IDENTITY_ARRIVAL_EXECUTION_TOPIC,
  'mission.resume',
  'mission.verify',
  'operation.reconcile',
] as const

const OUTBOX_SWEEP_TOPIC = 'system.outbox.sweep'
const MISSION_RESUME_SUCCESSOR_DELAY_SECONDS = 1

export interface WorkerRuntimeDependencies {
  readonly queue: WorkerQueuePort
  readonly outbox: Pick<OutboxDispatcher, 'dispatchBatch'>
  readonly productEvidence?: Pick<ProductEvidenceProjector, 'deliverPending'>
  readonly gatewayDispatch: Pick<GatewayDispatchService, 'dispatch'>
  readonly gatewayEffectReconciliation: Pick<GatewayEffectReconciliationService, 'reconcile'>
  readonly executionDeadline: Pick<ExecutionDeadlineService, 'evaluate'>
  readonly identityArrivalExecution: Pick<IdentityArrivalExecutionJobHandler, 'handle'>
  readonly operations: Pick<OperationService, 'reconcile'>
  readonly verification: Pick<VerificationService, 'run'>
  readonly leases: Pick<MissionLeaseService, 'acquire' | 'renew' | 'release'>
  readonly missionRunner: MissionRunnerPort
  readonly serviceContextFor: (organizationId: OrganizationId) => ServiceContext
  readonly heartbeat?: HeartbeatPort
  readonly outboxPump?: OutboxPumpPort
  readonly outboxPumpIntervalMilliseconds?: number
  readonly workerId: string
  readonly leaseTtlMilliseconds?: number
}

export class WorkerRuntime {
  readonly #heartbeat: HeartbeatPort
  readonly #outboxPump: OutboxPumpPort
  readonly #outboxPumpInterval: number
  readonly #leaseTtl: number
  #outboxPumpStarted = false
  #queueStarted = false

  public constructor(private readonly dependencies: WorkerRuntimeDependencies) {
    this.#heartbeat = dependencies.heartbeat ?? new TimerHeartbeat()
    this.#outboxPump = dependencies.outboxPump ?? new TimerOutboxPump()
    this.#outboxPumpInterval =
      dependencies.outboxPumpIntervalMilliseconds === undefined
        ? 250
        : positiveInteger(dependencies.outboxPumpIntervalMilliseconds, 'Outbox pump interval')
    this.#leaseTtl = dependencies.leaseTtlMilliseconds ?? 30_000
  }

  public async start(): Promise<void> {
    if (this.#queueStarted) throw new Error('Worker runtime is already started')
    this.#queueStarted = true
    await this.dependencies.queue.start()
    await Promise.all([
      this.dependencies.queue.register('gateway.dispatch', (payload, signal) =>
        this.#dispatchGatewayEffect(payload, signal),
      ),
      this.dependencies.queue.register('gateway.effect.reconcile', (payload, signal) =>
        this.#reconcileGatewayEffect(payload, signal),
      ),
      this.dependencies.queue.register('execution.deadline', (payload, signal) =>
        this.#evaluateExecutionDeadline(payload, signal),
      ),
      this.dependencies.queue.register(IDENTITY_ARRIVAL_EXECUTION_TOPIC, (payload, signal) =>
        this.#applyIdentityArrival(payload, signal),
      ),
      this.dependencies.queue.register('mission.resume', (payload, signal, metadata) =>
        this.#resumeMission(payload, signal, metadata),
      ),
      this.dependencies.queue.register('mission.verify', (payload, signal) =>
        this.#verifyMission(payload, signal),
      ),
      this.dependencies.queue.register('operation.reconcile', (payload, signal) =>
        this.#reconcileOperation(payload, signal),
      ),
      this.dependencies.queue.register(OUTBOX_SWEEP_TOPIC, (_payload, signal) =>
        this.#sweepOutbox(signal),
      ),
    ])
    await this.dependencies.queue.schedule(OUTBOX_SWEEP_TOPIC, '* * * * *', {})
    this.#outboxPumpStarted = true
    await this.#outboxPump.start({
      intervalMilliseconds: this.#outboxPumpInterval,
      sweep: async () => {
        await this.dependencies.outbox.dispatchBatch({ ownerId: this.dependencies.workerId })
        await this.dependencies.productEvidence?.deliverPending(100)
      },
    })
  }

  public async stop(): Promise<void> {
    const errors: unknown[] = []
    if (this.#outboxPumpStarted) {
      await captureError(() => this.#outboxPump.stop(), errors)
      this.#outboxPumpStarted = false
    }
    if (this.#queueStarted) {
      await captureError(async () => {
        await this.dependencies.outbox.dispatchBatch({ ownerId: this.dependencies.workerId })
      }, errors)
      await captureError(() => this.dependencies.queue.stop(), errors)
      this.#queueStarted = false
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Worker runtime shutdown failed')
  }

  async #dispatchGatewayEffect(
    payload: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    await this.dependencies.gatewayDispatch.dispatch(GatewayDispatchReferenceSchema.parse(payload))
  }

  async #reconcileGatewayEffect(
    payload: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    await this.dependencies.gatewayEffectReconciliation.reconcile(
      GatewayEffectReconciliationReferenceSchema.parse(payload),
    )
  }

  async #evaluateExecutionDeadline(
    payload: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    await this.dependencies.executionDeadline.evaluate(
      ExecutionDeadlineReferenceSchema.parse(payload),
    )
  }

  async #reconcileOperation(
    payload: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    const reference = OperationReconciliationReferenceSchema.parse(payload)
    await this.dependencies.operations.reconcile(reference)
  }

  async #applyIdentityArrival(
    payload: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    await this.dependencies.identityArrivalExecution.handle(
      IdentityArrivalExecutionReferenceSchema.parse(payload),
    )
  }

  async #verifyMission(
    payload: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    await this.dependencies.verification.run(MissionReferenceSchema.parse(payload))
  }

  async #resumeMission(
    payload: Readonly<Record<string, JsonValue>>,
    jobSignal: AbortSignal,
    job: WorkerJobMetadata,
  ): Promise<void> {
    jobSignal.throwIfAborted()
    const reference = MissionReferenceSchema.parse(payload)
    const acquired = await this.dependencies.leases.acquire({
      ...reference,
      ownerId: this.dependencies.workerId,
      ttlMilliseconds: this.#leaseTtl,
      allowTerminalFinalization: true,
    })
    let fence = acquired.fence
    const serviceContext = this.dependencies.serviceContextFor(reference.organizationId)
    const heartbeatInterval = Math.max(1, Math.floor(this.#leaseTtl / 3))
    let outcome: Awaited<ReturnType<MissionRunnerPort['resume']>>
    try {
      outcome = await this.#heartbeat.run({
        intervalMilliseconds: heartbeatInterval,
        renewalTimeoutMilliseconds: heartbeatInterval,
        signal: jobSignal,
        heartbeat: async () => {
          fence = await this.dependencies.leases.renew({
            fence,
            ttlMilliseconds: this.#leaseTtl,
          })
          return true
        },
        work: (signal) =>
          this.dependencies.missionRunner.resume({
            mission: acquired.mission,
            context: { fence, signal, principal: serviceContext.principal },
          }),
      })
    } finally {
      await this.dependencies.leases.release(fence)
    }
    if (outcome === 'retry') {
      // The current durable job remains unacknowledged until its deterministic successor exists.
      // A failed or response-lost publish therefore redelivers this job without forking the chain.
      await this.dependencies.queue.publishSuccessor('mission.resume', reference, {
        predecessorJobId: job.jobId,
        delaySeconds: MISSION_RESUME_SUCCESSOR_DELAY_SECONDS,
      })
    }
  }

  async #sweepOutbox(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.dependencies.outbox.dispatchBatch({ ownerId: this.dependencies.workerId })
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`)
  }
  return value
}

async function captureError(work: () => Promise<void>, errors: unknown[]): Promise<void> {
  try {
    await work()
  } catch (error) {
    errors.push(error)
  }
}

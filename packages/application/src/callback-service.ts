import {
  GatewayCallbackSchema,
  PersistedEvidenceRecordSchema,
  computeGatewayCallbackPayloadHash,
  validateGatewayCommandCallbackBinding,
  type Execution,
  type GatewayAuthorityEvidence,
  type Mission,
  type Operation,
  type PersistedEvidenceRecord,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import { completeCancellationWhenSafe } from './cancellation-service.js'
import { advanceMissionWhenReady } from './execution-deadline-service.js'
import { materializePlannedGatewayEffect } from './execution-materialization-service.js'
import { HomecomingExecutionPlanner } from './homecoming-execution-planner.js'
import type { StoredGatewayCallback } from './models.js'
import { VerifiedGatewayCallbackSchema } from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import { CryptoIdGenerator, SYSTEM_CLOCK, iso, parseGeneratedId } from './primitives.js'
import { enqueueApplicationProductEvidence } from './product-evidence.js'
import type {
  CallbackVerifierPort,
  ClockPort,
  ExecutionPlannerPort,
  IdGeneratorPort,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

export interface CallbackIngestionResult {
  readonly status: 'duplicate' | 'replayed' | 'stored'
  readonly callback: StoredGatewayCallback
  readonly execution: Execution | null
  readonly mission: Mission
}

export class GatewayCallbackService<RawCallback = unknown> {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly verifier: CallbackVerifierPort<RawCallback>,
    private readonly planner: ExecutionPlannerPort = new HomecomingExecutionPlanner(),
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
  ) {}

  public async ingest(raw: RawCallback): Promise<CallbackIngestionResult> {
    const verified = VerifiedGatewayCallbackSchema.parse(await this.verifier.verify(raw))
    const callback = GatewayCallbackSchema.parse(verified.callback)
    const authenticatedOrganizationId = verified.authenticatedPrincipal.organizationId
    if (callback.organizationId !== authenticatedOrganizationId) {
      throw new ConflictError(
        'Gateway callback organization does not match its authenticated principal',
      )
    }
    if (verified.verifiedPayloadDigest !== computeGatewayCallbackPayloadHash(callback)) {
      throw new ConflictError(
        'Verified gateway callback digest does not match its canonical payload',
      )
    }
    const receivedAt = iso(this.clock.now())
    const stored: StoredGatewayCallback = {
      ...callback,
      verifierKeyId: verified.verifierKeyId,
      verifierVersion: verified.verifierVersion,
      verifiedPayloadDigest: verified.verifiedPayloadDigest,
      receivedAt,
    }
    const result: CallbackIngestionResult = await this.observability.trace(
      {
        name: 'domain.callback.ingest',
        kind: 'worker',
        correlation: {
          organizationId: authenticatedOrganizationId,
          operationId: callback.operationId,
        },
        attributes: { callback_status: callback.status },
      },
      () =>
        this.unitOfWork.run(authenticatedOrganizationId, async (repositories) => {
          const effect = await repositories.gatewayEffects.get(callback.commandId)
          if (effect === null || effect.command.operationId !== callback.operationId) {
            throw new ConflictError('Callback does not match a materialized gateway effect')
          }
          validateGatewayCommandCallbackBinding(effect.command, callback)
          const operation = await repositories.operations.get(callback.operationId)
          if (operation === null || operation.status !== 'committed') {
            throw new NotFoundError('Committed operation')
          }
          const plan = await repositories.plans.get(operation.planId)
          if (plan === null) throw new NotFoundError('Plan')
          const action = plan.actions.find((candidate) => candidate.id === operation.planActionId)
          if (action === undefined) throw new NotFoundError('Plan action')
          const mission = await repositories.missions.get(operation.missionId)
          if (mission === null) throw new NotFoundError('Mission')
          assertCallbackBindings(stored, effect.command, mission, plan.palaceId)
          const evidence = callback.evidence.map((item) =>
            gatewayEvidenceRecord(item, stored, receivedAt, this.ids),
          )
          const application = await repositories.gatewayEffects.applyCallback({
            callback: stored,
            evidence,
          })
          if (application === null) throw new NotFoundError('Gateway effect')
          const storedExecution = await repositories.executions.findForOperation(operation.id)
          if (storedExecution === null) throw new NotFoundError('Execution')
          if (application.status !== 'advanced') {
            await this.#enqueueExecutionObserved(
              repositories,
              mission,
              operation,
              storedExecution.execution,
              application.callback,
            )
            return {
              status: application.status,
              callback: application.callback,
              execution: storedExecution.execution,
              mission,
            }
          }
          if (callback.status !== 'completed' && callback.status !== 'failed') {
            await this.#enqueueExecutionObserved(
              repositories,
              mission,
              operation,
              storedExecution.execution,
              application.callback,
            )
            return {
              status: 'stored',
              callback: application.callback,
              execution: storedExecution.execution,
              mission,
            }
          }

          const milestoneEvidence = selectMilestoneEvidence(callback.status, evidence)
          const failure =
            callback.status === 'failed'
              ? {
                  code:
                    milestoneEvidence.evidence.type === 'gateway_delivery' &&
                    milestoneEvidence.evidence.code !== null
                      ? milestoneEvidence.evidence.code
                      : 'GATEWAY_EFFECT_FAILED',
                  message: 'Gateway reported a terminal device effect failure',
                }
              : null
          const milestone = await repositories.executions.advanceMilestone({
            operationId: operation.id,
            milestone: effect.milestone,
            commandId: effect.command.id,
            evidenceId: milestoneEvidence.evidence.id,
            resolvedAt: callback.occurredAt,
            failure,
          })
          if (milestone === null) throw new NotFoundError('Execution')

          if (callback.status === 'completed' && effect.milestone === 'unlock') {
            const unlockEvidence = evidence.find(
              (record) =>
                record.evidence.type === 'device_command' && record.evidence.command === 'unlock',
            )
            if (unlockEvidence === undefined) {
              throw new ConflictError('Completed unlock callback has no command evidence')
            }
            const capabilities = await repositories.capabilities.list(plan.palaceId)
            const planned = await this.planner.planEvidence({
              operation,
              plan,
              action,
              capabilities,
              evidence: unlockEvidence,
              at: receivedAt,
            })
            for (const intent of planned) {
              await materializePlannedGatewayEffect({
                repositories,
                operation,
                plan,
                planned: intent,
                authorization: storedExecution.authorization,
                createdAt: receivedAt,
                ids: this.ids,
              })
            }
          }

          const readiness = await repositories.executions.evaluateReadiness({
            missionId: mission.id,
            operationId: operation.id,
            executionId: milestone.execution.id,
            evaluatedAt: receivedAt,
          })
          if (readiness === null) throw new NotFoundError('Execution')
          const nextMission = await advanceMissionWhenReady(
            repositories,
            readiness,
            this.clock,
            this.ids,
          )
          const cancellationMission = await completeCancellationWhenSafe({
            repositories,
            missionId: mission.id,
            clock: this.clock,
            ids: this.ids,
          })
          const resultingMission = cancellationMission ?? nextMission
          await this.#enqueueExecutionObserved(
            repositories,
            resultingMission,
            operation,
            readiness.execution,
            application.callback,
          )
          return {
            status: 'stored',
            callback: application.callback,
            execution: readiness.execution,
            mission: resultingMission,
          }
        }),
    )
    return result
  }

  async #enqueueExecutionObserved(
    repositories: TenantRepositories,
    mission: Mission,
    operation: Operation,
    execution: Execution,
    callback: StoredGatewayCallback,
  ): Promise<void> {
    await enqueueApplicationProductEvidence(repositories, this.observability, {
      event: 'execution observed',
      durableIdentity: { callbackId: callback.id },
      occurredAt: callback.occurredAt,
      correlation: {
        distinctId: mission.initiatedBy,
        organizationId: mission.organizationId,
        palaceId: mission.palaceId,
        missionId: mission.id,
        ...(mission.runId === null ? {} : { runId: mission.runId }),
        planId: operation.planId,
        operationId: operation.id,
        resourceId: execution.routineId,
        executionId: execution.id,
      },
      properties: {
        gateway_status:
          callback.status === 'completed'
            ? 'committed'
            : callback.status === 'failed'
              ? 'rejected'
              : 'accepted',
        evidence_count: callback.evidence.length,
      },
    })
  }
}

function gatewayEvidenceRecord(
  evidence: GatewayAuthorityEvidence,
  callback: StoredGatewayCallback,
  persistedAt: string,
  ids: IdGeneratorPort,
): PersistedEvidenceRecord {
  return PersistedEvidenceRecordSchema.parse({
    evidence,
    authorityReceipt: {
      id: parseGeneratedId('evidence_authority_receipt', ids.next('evidence_authority_receipt')),
      evidenceId: evidence.id,
      organizationId: evidence.organizationId,
      missionId: evidence.missionId,
      palaceId: evidence.palaceId,
      verifiedAt: callback.receivedAt,
      authority: 'gateway_callback',
      callbackId: callback.id,
      commandId: callback.commandId,
      verifiedPayloadHash: callback.verifiedPayloadDigest,
      signatureVerified: true,
      commandBindingVerified: true,
    },
    persistedAt,
  })
}

function selectMilestoneEvidence(
  status: 'completed' | 'failed',
  records: readonly PersistedEvidenceRecord[],
): PersistedEvidenceRecord {
  const selected =
    status === 'failed'
      ? records.find((record) => record.evidence.type === 'gateway_delivery')
      : records.find(
          (record) =>
            record.evidence.type === 'temperature_observation' ||
            record.evidence.type === 'lighting_observation' ||
            record.evidence.type === 'lock_observation',
        )
  if (selected === undefined) throw new ConflictError('Terminal callback lacks milestone evidence')
  return selected
}

function assertCallbackBindings(
  callback: StoredGatewayCallback,
  command: Parameters<typeof validateGatewayCommandCallbackBinding>[0],
  mission: Mission,
  palaceId: Mission['palaceId'],
): void {
  if (
    callback.organizationId !== command.organizationId ||
    callback.organizationId !== mission.organizationId ||
    callback.missionId !== command.missionId ||
    callback.missionId !== mission.id ||
    callback.palaceId !== command.palaceId ||
    callback.palaceId !== palaceId ||
    callback.operationId !== command.operationId ||
    callback.commandId !== command.id
  ) {
    throw new ConflictError('Gateway callback tenant and effect bindings do not match')
  }
}

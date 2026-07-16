import {
  OperationSchema,
  assertPermission,
  isTerminalMissionState,
  type MissionId,
  type Mission,
  type Operation,
} from '@trash-palace/core'

import { AuthenticationError, ConflictError, NotFoundError } from './errors.js'
import { persistMissionTransition } from './mission-state.js'
import type {
  AuthContext,
  CancellationRecord,
  CancellationResult,
  DelegatedAuthContext,
  GatewayEffectRecord,
  OutboxMessage,
} from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import { CryptoIdGenerator, SYSTEM_CLOCK, iso } from './primitives.js'
import type {
  ClockPort,
  IdGeneratorPort,
  SensitiveMutationGuardPort,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

export class CancellationService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly mutationGuard: SensitiveMutationGuardPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
  ) {}

  public async cancel(input: CancellationInput): Promise<CancellationResult> {
    const context = this.#authorize(input)
    assertPermission(context.principal, 'mission:cancel')
    if (input.reason.trim().length === 0 || input.reason.length > 500) {
      throw new ConflictError('Cancellation reason must contain 1 to 500 characters')
    }
    const organizationId = context.principal.organizationId
    return this.observability.trace(
      {
        name: 'domain.mission.cancel',
        kind: 'domain',
        correlation: { organizationId, missionId: input.missionId },
      },
      () =>
        this.unitOfWork.run(organizationId, async (repositories) => {
          const mission = await repositories.missions.get(input.missionId)
          if (mission === null) throw new NotFoundError('Mission')
          const existing = await repositories.cancellations.findForMission(mission.id)
          if (existing !== null) return { cancellation: existing, mission }
          if (isTerminalMissionState(mission.state)) {
            throw new ConflictError('Terminal mission state is immutable')
          }

          const operations = await repositories.operations.listForMission(mission.id)
          const effects = (
            await Promise.all(
              operations.map((operation) =>
                repositories.gatewayEffects.listForOperation(operation.id),
              ),
            )
          ).flat()
          const classification = classifyCheckpoint(operations, effects)
          const requestedAt = iso(this.clock.now())
          for (const operation of operations) {
            if (operation.status === 'pending') {
              await repositories.operations.save(
                OperationSchema.parse({ ...operation, status: 'cancelled' }),
              )
            }
          }
          const cancellation = await repositories.gatewayEffects.cancelPendingForMission({
            missionId: mission.id,
            requestedAt,
          })
          for (const commandId of cancellation.reconciliationCommandIds) {
            const effect = await repositories.gatewayEffects.get(commandId)
            if (effect === null) throw new NotFoundError('Gateway effect')
            await enqueueCancellationReconciliation(repositories, effect, requestedAt, this.ids)
          }
          const record: CancellationRecord = {
            id: this.ids.next('cancellation'),
            organizationId,
            missionId: mission.id,
            requestedBy: context.principal.actorId,
            reason: input.reason.trim(),
            ...classification,
            requestedAt,
          }
          await repositories.cancellations.insert(record)
          const requiresReconciliation =
            cancellation.reconciliationCommandIds.length > 0 ||
            cancellation.preservedCommandIds.length > 0
          const transitionedMission = await persistMissionTransition({
            repositories,
            mission,
            expectedVersion: mission.version,
            event: requiresReconciliation ? 'cancel_reconciliation_required' : 'cancel_requested',
            clock: this.clock,
            ids: this.ids,
          })
          return { cancellation: record, mission: transitionedMission }
        }),
    )
  }

  #authorize(input: CancellationInput): AuthContext | DelegatedAuthContext {
    if (input.authorization === 'browser') {
      if (input.context.principal.role === 'delegated') {
        throw new AuthenticationError('Delegated credentials cannot use browser mutation guards')
      }
      this.mutationGuard.assert(input)
      return input.context
    }
    if (input.context.principal.role !== 'delegated') {
      throw new AuthenticationError('Delegated cancellation requires a delegated credential')
    }
    if (this.clock.now().getTime() >= Date.parse(input.context.expiresAt)) {
      throw new AuthenticationError('Delegated credential has expired')
    }
    return input.context
  }
}

interface CancellationBaseInput {
  readonly missionId: MissionId
  readonly reason: string
}

export interface BrowserCancellationInput extends CancellationBaseInput {
  readonly authorization: 'browser'
  readonly context: AuthContext
  readonly csrfToken: string
  readonly origin: string
  readonly allowedOrigin: string
}

export interface DelegatedCancellationInput extends CancellationBaseInput {
  readonly authorization: 'delegated'
  readonly context: DelegatedAuthContext
}

export type CancellationInput = BrowserCancellationInput | DelegatedCancellationInput

export async function completeCancellationWhenSafe(input: {
  readonly repositories: TenantRepositories
  readonly missionId: MissionId
  readonly clock: ClockPort
  readonly ids: IdGeneratorPort
}): Promise<Mission | null> {
  const cancellation = await input.repositories.cancellations.findForMission(input.missionId)
  if (cancellation === null) return null
  const mission = await input.repositories.missions.get(input.missionId)
  if (mission === null) throw new NotFoundError('Mission')
  if (mission.state.status !== 'running' || mission.state.phase !== 'reconcile') return mission
  const operations = await input.repositories.operations.listForMission(mission.id)
  const effects = (
    await Promise.all(
      operations.map((operation) =>
        input.repositories.gatewayEffects.listForOperation(operation.id),
      ),
    )
  ).flat()
  const safe = effects.every(
    (effect) =>
      effect.effectState.status === 'completed' ||
      effect.effectState.status === 'failed' ||
      effect.dispatchState.status === 'cancelled',
  )
  if (!safe) return mission
  return persistMissionTransition({
    repositories: input.repositories,
    mission,
    expectedVersion: mission.version,
    event: 'cancel_reconciliation_completed',
    clock: input.clock,
    ids: input.ids,
  })
}

function classifyCheckpoint(
  operations: readonly Operation[],
  effects: readonly GatewayEffectRecord[],
): Pick<CancellationRecord, 'checkpoint' | 'compensatingPlanRequired' | 'outcome'> {
  if (operations.length === 0) {
    return {
      checkpoint: 'before_operation',
      outcome: 'cancelled_without_mutation',
      compensatingPlanRequired: false,
    }
  }
  if (effects.some((effect) => effect.effectState.status === 'completed')) {
    return {
      checkpoint: 'durable_effect',
      outcome: 'compensating_plan_required',
      compensatingPlanRequired: true,
    }
  }
  if (
    effects.some(
      (effect) =>
        effect.dispatchState.status !== 'pending' || effect.effectState.status !== 'pending',
    )
  ) {
    return {
      checkpoint: 'gateway_dispatched',
      outcome: 'reconcile_dispatched_effect',
      compensatingPlanRequired: false,
    }
  }
  if (operations.some((operation) => ['claimed', 'committed'].includes(operation.status))) {
    return {
      checkpoint: 'claimed_or_committed',
      outcome: 'stopped_remaining_actions',
      compensatingPlanRequired: false,
    }
  }
  return {
    checkpoint: 'unclaimed_operation',
    outcome: 'cancelled_unclaimed_operations',
    compensatingPlanRequired: false,
  }
}

async function enqueueCancellationReconciliation(
  repositories: TenantRepositories,
  effect: GatewayEffectRecord,
  createdAt: string,
  ids: IdGeneratorPort,
): Promise<void> {
  const deduplicationKey = `gateway.effect.reconcile:cancel:${effect.command.id}:${effect.dispatchState.generation}`
  if ((await repositories.outbox.findByDeduplicationKey(deduplicationKey)) !== null) return
  const message: OutboxMessage = {
    id: ids.next('outbox'),
    organizationId: effect.command.organizationId,
    topic: 'gateway.effect.reconcile',
    deduplicationKey,
    payload: {
      organizationId: effect.command.organizationId,
      operationId: effect.command.operationId,
      commandId: effect.command.id,
      generation: effect.dispatchState.generation,
    },
    status: 'pending',
    availableAt: createdAt,
    createdAt,
    claimedBy: null,
    claimExpiresAt: null,
    dispatchedAt: null,
    deliveryAttempts: 0,
    lastErrorCode: null,
  }
  await repositories.outbox.insert(message)
}

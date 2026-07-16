import { GatewayDispatchResultSchema, type GatewayDispatchResult } from '@trash-palace/core'

import { NotFoundError } from './errors.js'
import { completeCancellationWhenSafe } from './cancellation-service.js'
import { persistMissionTransition } from './mission-state.js'
import type {
  GatewayDispatchClaimResult,
  GatewayDispatchFinalizationResult,
  GatewayDispatchReference,
  GatewayEffectReconciliationReference,
  GatewayEffectReconciliationResult,
} from './models.js'
import {
  GatewayDispatchReferenceSchema,
  GatewayEffectReconciliationReferenceSchema,
} from './models.js'
import { NOOP_OBSERVABILITY, type ObservabilityPort } from './observability.js'
import {
  CryptoIdGenerator,
  SYSTEM_CLOCK,
  addMilliseconds,
  iso,
  parseGeneratedId,
} from './primitives.js'
import type { ClockPort, GatewayPort, IdGeneratorPort, UnitOfWorkPort } from './ports.js'

export type GatewayDispatchOutcome =
  | Readonly<{
      status: 'not_claimed'
      claim: Extract<GatewayDispatchClaimResult, { status: 'not_claimed' }>
    }>
  | Readonly<{
      status: 'finalized'
      gateway: GatewayDispatchResult
      finalization: GatewayDispatchFinalizationResult
    }>

export class GatewayDispatchService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly gateway: GatewayPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly observability: ObservabilityPort = NOOP_OBSERVABILITY,
  ) {}

  public async dispatch(reference: GatewayDispatchReference): Promise<GatewayDispatchOutcome> {
    const input = GatewayDispatchReferenceSchema.parse(reference)
    const claimedAt = iso(this.clock.now())
    const claim = await this.unitOfWork.run(input.organizationId, (repositories) =>
      repositories.gatewayEffects.claimDispatch({
        operationId: input.operationId,
        commandId: input.commandId,
        generation: input.generation,
        attemptId: parseGeneratedId('attempt', this.ids.next('attempt')),
        claimedAt,
      }),
    )
    if (claim === null) throw new NotFoundError('Gateway effect')
    if (claim.status === 'not_claimed') return { status: 'not_claimed', claim }

    let result: GatewayDispatchResult
    try {
      result = await this.observability.trace(
        {
          name: 'gateway.dispatch',
          kind: 'worker',
          correlation: {
            organizationId: input.organizationId,
            operationId: input.operationId,
          },
          attributes: {
            command_id: input.commandId,
            generation: input.generation,
          },
        },
        async () =>
          GatewayDispatchResultSchema.parse(await this.gateway.dispatch(claim.effect.command)),
      )
    } catch {
      result = { status: 'unknown', retryable: true, reason: 'timeout' }
    }

    const completedAt = iso(this.clock.now())
    const finalization = await this.unitOfWork.run(input.organizationId, (repositories) =>
      repositories.gatewayEffects.finalizeDispatch({
        operationId: input.operationId,
        commandId: input.commandId,
        generation: input.generation,
        attemptId: claim.attempt.id,
        result,
        completedAt,
        reconciliationOutboxId: this.ids.next('outbox'),
      }),
    )
    if (finalization === null) throw new NotFoundError('Gateway effect')
    return { status: 'finalized', gateway: result, finalization }
  }
}

export class GatewayEffectReconciliationService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly ids: IdGeneratorPort = new CryptoIdGenerator(),
    private readonly maximumAttempts = 5,
    private readonly pollIntervalMilliseconds = 5_000,
  ) {
    if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1) {
      throw new RangeError('Gateway reconciliation requires a positive attempt bound')
    }
    if (!Number.isInteger(pollIntervalMilliseconds) || pollIntervalMilliseconds < 1) {
      throw new RangeError('Gateway reconciliation requires a positive poll interval')
    }
  }

  public async reconcile(
    reference: GatewayEffectReconciliationReference,
  ): Promise<GatewayEffectReconciliationResult> {
    const input = GatewayEffectReconciliationReferenceSchema.parse(reference)
    const reconciledAt = this.clock.now()
    const result = await this.unitOfWork.run(input.organizationId, async (repositories) => {
      const reconciliation = await repositories.gatewayEffects.reconcile({
        operationId: input.operationId,
        commandId: input.commandId,
        generation: input.generation,
        reconciledAt: iso(reconciledAt),
        nextPollAt: iso(addMilliseconds(reconciledAt, this.pollIntervalMilliseconds)),
        maximumAttempts: this.maximumAttempts,
        dispatchOutboxId: this.ids.next('outbox'),
        reconciliationOutboxId: this.ids.next('outbox'),
      })
      if (reconciliation !== null) {
        if (reconciliation.status === 'intervention_required') {
          const mission = await repositories.missions.get(reconciliation.effect.command.missionId)
          if (mission?.state.status === 'running' && mission.state.phase === 'reconcile') {
            await persistMissionTransition({
              repositories,
              mission,
              expectedVersion: mission.version,
              event: 'reconcile_budget_exhausted',
              clock: this.clock,
              ids: this.ids,
            })
          }
        }
        await completeCancellationWhenSafe({
          repositories,
          missionId: reconciliation.effect.command.missionId,
          clock: this.clock,
          ids: this.ids,
        })
      }
      return reconciliation
    })
    if (result === null) throw new NotFoundError('Gateway effect')
    return result
  }
}

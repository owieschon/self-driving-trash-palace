import type { Permission, ToolName } from '@trash-palace/core'

import type { ApprovalService } from './approval-service.js'
import type { CancellationService } from './cancellation-service.js'
import type { DelegatedToolMutationCoordinatorPort } from './delegated-tool-mutation-coordinator.js'
import { AuthenticationError } from './errors.js'
import type { KnowledgeSearchService } from './knowledge-search-service.js'
import type { ActorContext } from './models.js'
import type { OperationService } from './operation-service.js'
import type { PlanMutationContext, PlanService } from './plan-service.js'
import type { TenantReadService } from './tenant-read-service.js'
import {
  ToolHandlerFailure,
  type AuthenticatedToolIdentity,
  type ToolHandlerRegistry,
  type ToolHandlerRequest,
} from './tool-dispatcher.js'
import type { VerificationEvidenceService } from './verification-evidence-service.js'

export interface ToolServiceHandlerDependencies {
  readonly tenantReads: TenantReadService
  readonly knowledge: KnowledgeSearchService
  readonly plans: PlanService
  readonly approvals: ApprovalService
  readonly operations: OperationService
  readonly evidence: VerificationEvidenceService
  readonly cancellations: CancellationService
  readonly delegatedMutations: DelegatedToolMutationCoordinatorPort
}

export function createToolServiceHandlers(
  services: ToolServiceHandlerDependencies,
): ToolHandlerRegistry {
  return {
    'palaces.get': async ({ host, input }) => ({
      status: 'succeeded',
      data: await services.tenantReads.getPalace({
        context: actorContext(host.authentication),
        palaceId: input.palaceId,
      }),
    }),
    'crews.list': async ({ host, input }) => ({
      status: 'succeeded',
      data: await services.tenantReads.listCrews({
        context: actorContext(host.authentication),
        palaceId: input.palaceId,
        activeOnly: input.activeOnly,
      }),
    }),
    'capabilities.list': async ({ host, input }) => ({
      status: 'succeeded',
      data: await services.tenantReads.listCapabilities({
        context: actorContext(host.authentication),
        palaceId: input.palaceId,
      }),
    }),
    'routines.list': async ({ host, input }) => ({
      status: 'succeeded',
      data: await services.tenantReads.listRoutines({
        context: actorContext(host.authentication),
        palaceId: input.palaceId,
        ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
      }),
    }),
    'routines.get': async ({ host, input }) => {
      const data = await services.tenantReads.getRoutine({
        context: actorContext(host.authentication),
        routineId: input.routineId,
        ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
      })
      return { status: 'succeeded', data, resourceVersion: data.version.version }
    },
    'executions.list': async ({ host, input }) => ({
      status: 'succeeded',
      data: await services.tenantReads.listExecutions({
        context: actorContext(host.authentication),
        ...(input.routineId === undefined ? {} : { routineId: input.routineId }),
        ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
        limit: input.limit,
      }),
    }),
    'knowledge.search': async ({ host, input }) => ({
      status: 'succeeded',
      data: await services.knowledge.search({
        context: actorContext(host.authentication),
        query: input.query,
        phase: input.phase,
        limit: input.limit,
      }),
    }),
    'plans.propose': async (request) => {
      const plan = await withPlanMutation(request, 'routine:draft', services, (context) =>
        services.plans.propose({ context, ...request.input }),
      )
      return {
        status: 'succeeded',
        data: { plan },
        resourceVersion: plan.revision,
      }
    },
    'plans.validate': async (request) => {
      const validation = await withPlanMutation(request, 'routine:validate', services, (context) =>
        services.plans.validate({ context, planId: request.input.planId }),
      )
      return {
        status: 'succeeded',
        data: { valid: validation.valid, checks: validation.checks },
      }
    },
    'plans.simulate': async (request) => {
      const simulation = await withPlanMutation(request, 'routine:simulate', services, (context) =>
        services.plans.simulate({
          context,
          planId: request.input.planId,
          scenarios: request.input.scenarios,
        }),
      )
      return {
        status: 'succeeded',
        data: {
          feasible: simulation.feasible,
          projectedBatteryUsePercentagePoints: simulation.projectedBatteryUsePercentagePoints,
          results: simulation.results,
        },
      }
    },
    'plans.request_approval': async (request) => {
      const approval = await withPlanMutation(request, 'routine:draft', services, (context) =>
        services.approvals.request({ context, planId: request.input.planId }),
      )
      return {
        status: 'pending',
        retryable: false,
        data: { approvalRequestId: approval.id, paused: true },
      }
    },
    'plans.activate': async (request) => {
      const activation = await withPlanMutation(
        request,
        'routine:activate',
        services,
        (context) => {
          const activation = {
            planId: request.input.planId,
            actionId: request.input.actionId,
            expectedVersion: request.input.expectedVersion,
            toolCallId: request.callId,
          }
          return 'sessionId' in context
            ? services.operations.activate({ authorization: 'manual', context, ...activation })
            : services.operations.activate({
                authorization: 'mission_lease',
                context,
                ...activation,
              })
        },
      )
      if (activation.status === 'conflict') {
        throw conflictForActivation(activation.reason)
      }
      if (activation.delivery.status === 'unknown') {
        return {
          status: 'unknown',
          retryable: false,
          data: null,
          error: {
            code: 'APPLICATION_RESPONSE_LOST',
            message:
              'The operation committed, but its application response was lost. Reconcile the same operation before continuing.',
            details: {},
          },
          attemptId: activation.delivery.attemptId,
          evidenceIds: activation.delivery.evidenceIds,
        }
      }
      return {
        status: 'succeeded',
        data: {
          operation: activation.operation,
          durableRoutineId: activation.operation.outcome?.routineId ?? null,
        },
      }
    },
    'operations.get': async ({ host, input }) => {
      const data = await services.operations.get({
        context: actorContext(host.authentication),
        operationId: input.operationId,
      })
      return {
        status: 'succeeded',
        data,
        attemptId: data.attempts.at(-1)?.id ?? null,
      }
    },
    'verification.get_evidence': async ({ host, input }) => {
      const data = await services.evidence.get({
        context: actorContext(host.authentication),
        missionId: input.missionId,
      })
      return {
        status: 'succeeded',
        data,
        evidenceIds: data.evidence.map((evidence) => evidence.id),
      }
    },
    'missions.cancel': async ({ host, input }) => {
      const authentication = host.authentication
      const cancellation =
        'sessionId' in authentication
          ? await services.cancellations.cancel({
              authorization: 'browser',
              context: authentication,
              ...requireBrowserMutation(host.browserMutation),
              missionId: input.missionId,
              reason: input.reason,
            })
          : 'tokenId' in authentication
            ? await services.cancellations.cancel({
                authorization: 'delegated',
                context: authentication,
                missionId: input.missionId,
                reason: input.reason,
              })
            : noServiceCancellation()
      const data = { missionId: cancellation.mission.id, state: cancellation.mission.state }
      return cancellation.mission.state.status === 'cancelled'
        ? { status: 'succeeded', data }
        : { status: 'pending', retryable: true, data }
    },
  }
}

function actorContext(authentication: AuthenticatedToolIdentity): ActorContext {
  if ('sessionId' in authentication) return authentication
  return {
    principal: authentication.principal,
    source: 'fence' in authentication ? 'worker' : 'system',
  }
}

async function withPlanMutation<Name extends ToolName, Result>(
  request: ToolHandlerRequest<Name>,
  permission: Permission,
  services: Pick<ToolServiceHandlerDependencies, 'delegatedMutations'>,
  work: (context: PlanMutationContext) => Promise<Result>,
): Promise<Result> {
  const authentication = request.host.authentication
  if ('sessionId' in authentication || 'fence' in authentication) {
    return work(authentication)
  }
  return services.delegatedMutations.run({
    authentication,
    missionId: request.mission.id,
    callId: request.callId,
    permission,
    signal: request.host.signal,
    work: (context) => work(context),
  })
}

function requireBrowserMutation(
  mutation: AuthenticatedToolHostContext['browserMutation'],
): NonNullable<AuthenticatedToolHostContext['browserMutation']> {
  if (mutation === undefined) {
    throw new AuthenticationError('Browser cancellation requires mutation guards')
  }
  return mutation
}

function noServiceCancellation(): never {
  throw new AuthenticationError('Service principals cannot use the public cancellation tool')
}

function conflictForActivation(
  reason: 'approval_expired' | 'payload_mismatch' | 'protected_state_stale',
): ToolHandlerFailure {
  const code = {
    approval_expired: 'APPROVAL_EXPIRED',
    payload_mismatch: 'PAYLOAD_MISMATCH',
    protected_state_stale: 'PROTECTED_STATE_STALE',
  }[reason]
  return new ToolHandlerFailure(
    'conflict',
    { code, message: 'The approved activation no longer matches current state.', details: {} },
    false,
  )
}

type AuthenticatedToolHostContext = ToolHandlerRequest<ToolName>['host']

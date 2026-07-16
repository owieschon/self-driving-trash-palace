import {
  PrincipalSchema,
  assertPermission,
  type MissionId,
  type Permission,
  type ToolCallId,
} from '@trash-palace/core'

import { AuthenticationError, ConflictError } from './errors.js'
import type { MissionExecutionContext } from './mission-fence.js'
import type { MissionLeaseService } from './mission-lease-service.js'
import type { DelegatedAuthContext } from './models.js'
import { SYSTEM_CLOCK } from './primitives.js'
import type { ClockPort } from './ports.js'

export interface DelegatedToolMutationCoordinatorPort {
  run<Result>(input: {
    readonly authentication: DelegatedAuthContext
    readonly missionId: MissionId
    readonly callId: ToolCallId
    readonly permission: Permission
    readonly signal: AbortSignal
    readonly work: (context: MissionExecutionContext) => Promise<Result>
  }): Promise<Result>
}

export interface DelegatedToolMutationReleaseFailureObserverPort {
  recordReleaseFailure(input: {
    readonly code: 'MISSION_LEASE_RELEASE_FAILED'
    readonly organizationId: DelegatedAuthContext['principal']['organizationId']
    readonly missionId: MissionId
    readonly callId: ToolCallId
  }): Promise<void>
}

type DelegatedMutationLeasePort = Pick<MissionLeaseService, 'acquire' | 'release'>

const NOOP_RELEASE_FAILURE_OBSERVER: DelegatedToolMutationReleaseFailureObserverPort = {
  recordReleaseFailure: async () => undefined,
}

export class DelegatedToolMutationCoordinator implements DelegatedToolMutationCoordinatorPort {
  public constructor(
    private readonly leases: DelegatedMutationLeasePort,
    private readonly clock: ClockPort = SYSTEM_CLOCK,
    private readonly releaseFailureObserver: DelegatedToolMutationReleaseFailureObserverPort = NOOP_RELEASE_FAILURE_OBSERVER,
  ) {}

  public async run<Result>(input: {
    readonly authentication: DelegatedAuthContext
    readonly missionId: MissionId
    readonly callId: ToolCallId
    readonly permission: Permission
    readonly signal: AbortSignal
    readonly work: (context: MissionExecutionContext) => Promise<Result>
  }): Promise<Result> {
    const delegated = input.authentication
    if (delegated.principal.role !== 'delegated') {
      throw new AuthenticationError('Delegated mutation requires a delegated credential')
    }
    if (this.clock.now().getTime() >= Date.parse(delegated.expiresAt)) {
      throw new AuthenticationError('Delegated credential has expired')
    }
    if (input.permission === 'routine:approve') {
      throw new ConflictError('Delegated credentials cannot approve a plan')
    }
    assertPermission(delegated.principal, input.permission)
    input.signal.throwIfAborted()

    const acquired = await this.leases.acquire({
      organizationId: delegated.principal.organizationId,
      missionId: input.missionId,
      ownerId: `tool:${input.callId}`,
    })
    const context: MissionExecutionContext = {
      fence: acquired.fence,
      signal: input.signal,
      principal: PrincipalSchema.parse({
        organizationId: delegated.principal.organizationId,
        actorId: delegated.principal.actorId,
        role: 'service',
        operatorGrants: [],
        delegatedPermissions: [],
      }),
    }
    try {
      input.signal.throwIfAborted()
      return await input.work(context)
    } finally {
      try {
        await this.leases.release(acquired.fence)
      } catch {
        try {
          await this.releaseFailureObserver.recordReleaseFailure({
            code: 'MISSION_LEASE_RELEASE_FAILED',
            organizationId: delegated.principal.organizationId,
            missionId: input.missionId,
            callId: input.callId,
          })
        } catch {
          // Cleanup telemetry must never replace the already-determined mutation outcome.
        }
      }
    }
  }
}

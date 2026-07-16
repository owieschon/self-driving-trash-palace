import {
  assertMissionExecutionContext,
  type JsonValue,
  type MissionExecutionContext,
  type MissionExecutionUnitOfWorkPort,
} from '@trash-palace/application'
import { hashToolValue, type Mission, type RunId, type Sha256 } from '@trash-palace/core'
import type { CaretakerRuntimeContextSnapshotPort } from '@trash-palace/db'

/** Captures current tenant state as evidence, never as executable agent instructions. */
export class RepositoryCaretakerRuntimeContextSnapshotPort implements CaretakerRuntimeContextSnapshotPort {
  public constructor(private readonly unitOfWork: MissionExecutionUnitOfWorkPort) {}

  public async capture(input: {
    readonly context: MissionExecutionContext
    readonly mission: Mission
    readonly runId: RunId
    readonly observedAt: string
    readonly tenantScopeHash: Sha256
    readonly signal: AbortSignal
  }) {
    input.signal.throwIfAborted()
    assertMissionExecutionContext(input.context, {
      organizationId: input.mission.organizationId,
      missionId: input.mission.id,
    })
    const snapshot = await this.unitOfWork.runFenced(input.context.fence, async (repositories) => {
      const mission = await repositories.missions.get(input.mission.id)
      if (mission === null || hashToolValue(mission) !== hashToolValue(input.mission)) {
        throw new Error('Runtime context mission changed before its snapshot')
      }
      const [palace, crew, capabilities, routines, plan, operations, evidence, verification] =
        await Promise.all([
          repositories.palaces.get(mission.palaceId),
          repositories.crews.list(mission.palaceId, true),
          repositories.capabilities.list(mission.palaceId),
          repositories.routines.list(mission.palaceId),
          repositories.plans.getLatestForMission(mission.id),
          repositories.operations.listForMission(mission.id),
          repositories.evidence.listForMission(mission.id),
          repositories.verifications.findForMission(mission.id),
        ])
      if (palace === null) throw new Error('Runtime context palace is absent')
      return {
        mission,
        palace,
        crew,
        capabilities,
        routines,
        plan,
        operations,
        evidence,
        verification,
      }
    })
    input.signal.throwIfAborted()

    const common = {
      tenantScopeHash: input.tenantScopeHash,
      observedAt: input.observedAt,
    }
    return [
      {
        ...common,
        snapshotId: 'palace.current',
        stateKind: 'palace' as const,
        requiredPermission: 'palace:read' as const,
        state: json(snapshot.palace),
      },
      {
        ...common,
        snapshotId: 'crew.current',
        stateKind: 'crew' as const,
        requiredPermission: 'crew:read' as const,
        state: json(snapshot.crew),
      },
      {
        ...common,
        snapshotId: 'capabilities.current',
        stateKind: 'capabilities' as const,
        requiredPermission: 'capability:read' as const,
        state: json(snapshot.capabilities),
      },
      {
        ...common,
        snapshotId: 'routines.current',
        stateKind: 'routines' as const,
        requiredPermission: 'routine:read' as const,
        state: json(snapshot.routines),
      },
      {
        ...common,
        snapshotId: 'mission.current',
        stateKind: 'mission' as const,
        requiredPermission: 'routine:read' as const,
        state: json(snapshot.mission),
      },
      ...(snapshot.plan === null
        ? []
        : [
            {
              ...common,
              snapshotId: 'plan.current',
              stateKind: 'plan' as const,
              requiredPermission: 'routine:read' as const,
              state: json(snapshot.plan),
            },
          ]),
      {
        ...common,
        snapshotId: 'operations.current',
        stateKind: 'operation' as const,
        requiredPermission: 'operation:reconcile' as const,
        state: json(snapshot.operations),
      },
      {
        ...common,
        snapshotId: 'verification.current',
        stateKind: 'verification_evidence' as const,
        requiredPermission: 'verification:read' as const,
        state: json({ evidence: snapshot.evidence, verification: snapshot.verification }),
      },
    ]
  }
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Runtime context contains a non-finite number')
    return value
  }
  if (Array.isArray(value)) return value.map(json)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => {
        if (nested === undefined) throw new Error('Runtime context contains undefined state')
        return [key, json(nested)]
      }),
    )
  }
  throw new Error('Runtime context contains a non-JSON value')
}

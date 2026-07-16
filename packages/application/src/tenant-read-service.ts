import {
  CapabilitiesListInputSchema,
  CapabilitiesListOutputSchema,
  CrewsListInputSchema,
  CrewsListOutputSchema,
  ExecutionsListInputSchema,
  ExecutionsListOutputSchema,
  PalacesGetInputSchema,
  PalacesGetOutputSchema,
  RoutinesGetInputSchema,
  RoutinesGetOutputSchema,
  RoutinesListInputSchema,
  RoutinesListOutputSchema,
  assertPermission,
  assertSameTenant,
  type Execution,
  type MissionId,
  type Palace,
  type PalaceId,
  type RoutineId,
  type RoutineStatus,
  type RoutineVersionId,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import type { ActorContext } from './models.js'
import type {
  CapabilityReadProjection,
  CrewReadProjection,
  RoutineDetailProjection,
  RoutineReadProjection,
  TenantRepositories,
  UnitOfWorkPort,
} from './ports.js'

export interface PalaceReadProjection {
  readonly palace: Palace
}

export interface ExecutionReadProjection {
  readonly executions: readonly Execution[]
}

export class TenantReadService {
  public constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  public getPalace(input: {
    readonly context: ActorContext
    readonly palaceId: PalaceId
  }): Promise<PalaceReadProjection> {
    assertPermission(input.context.principal, 'palace:read')
    const query = PalacesGetInputSchema.parse({ palaceId: input.palaceId })
    const organizationId = input.context.principal.organizationId
    return this.unitOfWork.run(organizationId, async (repositories) => {
      const palace = await requirePalace(repositories, query.palaceId)
      assertSameTenant(organizationId, [palace.organizationId])
      return PalacesGetOutputSchema.parse({ palace })
    })
  }

  public listCrews(input: {
    readonly context: ActorContext
    readonly palaceId: PalaceId
    readonly activeOnly?: boolean
  }): Promise<CrewReadProjection> {
    assertPermission(input.context.principal, 'crew:read')
    const query = CrewsListInputSchema.parse({
      palaceId: input.palaceId,
      ...(input.activeOnly === undefined ? {} : { activeOnly: input.activeOnly }),
    })
    const organizationId = input.context.principal.organizationId
    return this.unitOfWork.run(organizationId, async (repositories) => {
      await requirePalace(repositories, query.palaceId)
      const projection = CrewsListOutputSchema.parse(
        await repositories.crews.list(query.palaceId, query.activeOnly),
      )
      assertSameTenant(organizationId, [
        ...projection.crew.map((item) => item.organizationId),
        ...projection.identityTags.map((item) => item.organizationId),
        ...projection.schedules.map((item) => item.organizationId),
        ...projection.preferences.map((item) => item.organizationId),
      ])
      if (
        projection.crew.some((item) => item.palaceId !== query.palaceId) ||
        projection.schedules.some((item) => item.palaceId !== query.palaceId) ||
        projection.preferences.some((item) => item.palaceId !== query.palaceId)
      ) {
        throw new ConflictError('Crew projection did not match the requested palace')
      }
      return projection
    })
  }

  public listCapabilities(input: {
    readonly context: ActorContext
    readonly palaceId: PalaceId
  }): Promise<CapabilityReadProjection> {
    assertPermission(input.context.principal, 'capability:read')
    const query = CapabilitiesListInputSchema.parse({ palaceId: input.palaceId })
    const organizationId = input.context.principal.organizationId
    return this.unitOfWork.run(organizationId, async (repositories) => {
      await requirePalace(repositories, query.palaceId)
      const projection = CapabilitiesListOutputSchema.parse(
        await repositories.capabilities.list(query.palaceId),
      )
      assertSameTenant(organizationId, [
        ...projection.devices.map((item) => item.organizationId),
        ...projection.capabilities.map((item) => item.organizationId),
      ])
      if (projection.devices.some((item) => item.palaceId !== query.palaceId)) {
        throw new ConflictError('Capability projection did not match the requested palace')
      }
      return projection
    })
  }

  public listRoutines(input: {
    readonly context: ActorContext
    readonly palaceId: PalaceId
    readonly statuses?: readonly RoutineStatus[]
  }): Promise<RoutineReadProjection> {
    assertPermission(input.context.principal, 'routine:read')
    const query = RoutinesListInputSchema.parse({
      palaceId: input.palaceId,
      ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
    })
    const organizationId = input.context.principal.organizationId
    return this.unitOfWork.run(organizationId, async (repositories) => {
      await requirePalace(repositories, query.palaceId)
      const projection = RoutinesListOutputSchema.parse(
        await repositories.routines.list(query.palaceId, query.statuses),
      )
      assertSameTenant(organizationId, [
        ...projection.routines.map((item) => item.organizationId),
        ...projection.versions.map((item) => item.organizationId),
      ])
      const routineIds = new Set(projection.routines.map((routine) => routine.id))
      const statusFilter = query.statuses === undefined ? null : new Set(query.statuses)
      if (
        projection.routines.some((routine) => routine.palaceId !== query.palaceId) ||
        projection.versions.some((version) => !routineIds.has(version.routineId)) ||
        (statusFilter !== null &&
          projection.versions.some((version) => !statusFilter.has(version.status)))
      ) {
        throw new ConflictError('Routine projection did not match the requested filters')
      }
      return projection
    })
  }

  public getRoutine(input: {
    readonly context: ActorContext
    readonly routineId: RoutineId
    readonly versionId?: RoutineVersionId
  }): Promise<RoutineDetailProjection> {
    assertPermission(input.context.principal, 'routine:read')
    const query = RoutinesGetInputSchema.parse({
      routineId: input.routineId,
      ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
    })
    const organizationId = input.context.principal.organizationId
    return this.unitOfWork.run(organizationId, async (repositories) => {
      const result = await repositories.routines.get(query.routineId, query.versionId)
      if (result === null) throw new NotFoundError('Routine')
      const projection = RoutinesGetOutputSchema.parse(result)
      assertSameTenant(organizationId, [
        projection.routine.organizationId,
        projection.version.organizationId,
      ])
      const expectedVersionId = query.versionId ?? projection.routine.activeVersionId
      if (
        projection.version.routineId !== projection.routine.id ||
        projection.routine.id !== query.routineId ||
        projection.version.id !== expectedVersionId
      ) {
        throw new ConflictError('Routine projection did not match the requested version')
      }
      return projection
    })
  }

  public listExecutions(input: {
    readonly context: ActorContext
    readonly routineId?: RoutineId
    readonly missionId?: MissionId
    readonly limit?: number
  }): Promise<ExecutionReadProjection> {
    assertPermission(input.context.principal, 'routine:read')
    const query = ExecutionsListInputSchema.parse({
      ...(input.routineId === undefined ? {} : { routineId: input.routineId }),
      ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
    const organizationId = input.context.principal.organizationId
    return this.unitOfWork.run(organizationId, async (repositories) => {
      if (query.routineId !== undefined) {
        const routine = await repositories.routines.get(query.routineId)
        if (routine === null) throw new NotFoundError('Routine')
      }
      if (query.missionId !== undefined) {
        const mission = await repositories.missions.get(query.missionId)
        if (mission === null) throw new NotFoundError('Mission')
      }
      const executionQuery = {
        limit: query.limit,
        ...(query.routineId === undefined ? {} : { routineId: query.routineId }),
        ...(query.missionId === undefined ? {} : { missionId: query.missionId }),
      }
      const projection = ExecutionsListOutputSchema.parse({
        executions: await repositories.executions.list(executionQuery),
      })
      assertSameTenant(
        organizationId,
        projection.executions.map((execution) => execution.organizationId),
      )
      if (
        projection.executions.some(
          (execution) =>
            (query.routineId !== undefined && execution.routineId !== query.routineId) ||
            (query.missionId !== undefined && execution.missionId !== query.missionId),
        )
      ) {
        throw new ConflictError('Execution projection did not match the requested filters')
      }
      return projection
    })
  }
}

async function requirePalace(
  repositories: TenantRepositories,
  palaceId: PalaceId,
): Promise<Palace> {
  const palace = await repositories.palaces.get(palaceId)
  if (palace === null) throw new NotFoundError('Palace')
  if (palace.id !== palaceId) {
    throw new ConflictError('Palace projection did not match the requested ID')
  }
  return palace
}

import {
  assertPermission,
  assertSameTenant,
  missionProgramKindOf,
  type Approval,
  type Attempt,
  type Capability,
  type ClarificationRequest,
  type Mission,
  type MissionProgramKind,
  type Operation,
  type PalaceId,
  type ProductRole,
  type Routine,
  type RoutineVersion,
  type UserId,
  type Verification,
} from '@trash-palace/core'

import { ConflictError, NotFoundError } from './errors.js'
import { type MissionProgramRegistry } from './mission-program-registry.js'
import type { AuthContext } from './models.js'
import { projectPalacePresentationTime, type PalaceDayPeriod } from './palace-local-time.js'
import type {
  ApprovalRepository,
  CapabilityRepository,
  ClockPort,
  ClarificationRepository,
  CrewRepository,
  MissionRepository,
  PlanRepository,
  RoutineRepository,
  TenantRepositories,
  UnitOfWorkPort,
  VerificationRepository,
} from './ports.js'

export interface PalaceWorkspaceProjection {
  readonly schemaVersion: 'palace-workspace@1'
  readonly member: {
    readonly id: UserId
    readonly organizationId: string
    readonly displayName: string
    readonly role: Extract<ProductRole, 'owner' | 'operator' | 'viewer'>
    readonly grants: readonly 'routine:approve'[]
  }
  readonly palace: {
    readonly id: PalaceId
    readonly organizationId: string
    readonly name: string
    readonly timezone: string
  }
  readonly presentation: {
    readonly observedAt: string
    readonly timezone: string
    readonly dayPeriod: PalaceDayPeriod
  }
  readonly attention: readonly WorkspaceAttentionProjection[]
  readonly capabilityIdeas: readonly CapabilityIdeaProjection[]
  readonly activeAutomations: readonly ActiveAutomationProjection[]
  readonly activity: readonly WorkspaceActivityProjection[]
}

export interface WorkspaceAttentionProjection {
  readonly kind: 'clarification' | 'approval' | 'reconciliation' | 'verification'
  readonly missionId: Mission['id']
  readonly label: string
  readonly createdAt: string
}

export interface WorkspaceActivityProjection {
  readonly id: string
  readonly missionId: Mission['id']
  readonly summary: string
  readonly status: 'working' | 'checking_result' | 'verified' | 'failed' | 'cancelled'
  readonly occurredAt: string
}

export interface CapabilityIdeaProjection {
  readonly programKind: MissionProgramKind
  readonly label: string
  readonly description: string
  readonly availability: 'ready' | 'needs_connection'
  readonly requiredCapabilities: readonly string[]
}

export interface ActiveAutomationProjection {
  readonly routineId: string
  readonly programKind: MissionProgramKind
  readonly name: string
  readonly version: number
  readonly activeSince: string
}

interface CapabilityIdeaDefinition {
  readonly programKind: MissionProgramKind
  readonly label: string
  readonly description: string
  readonly requiredCapabilities: readonly Capability['kind'][]
}

const CAPABILITY_IDEAS: readonly CapabilityIdeaDefinition[] = [
  {
    programKind: 'night_shift_homecoming',
    label: 'Night Shift Homecoming',
    description: 'Prepare the Palace for a verified arrival while preserving its saved limits.',
    requiredCapabilities: ['temperature_target', 'pathway_lighting', 'lock_desired_state'],
  },
  {
    programKind: 'scheduled_hauler_access',
    label: 'Scheduled Hauler Access',
    description: 'Open the service hatch only for an assigned collection window.',
    requiredCapabilities: ['service_hatch_access', 'residential_hatch_lock_state'],
  },
]

/** Reads the durable, tenant-scoped records that can truthfully populate a Palace workspace. */
export class PalaceWorkspaceService {
  public constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly presentationClock: ClockPort,
    private readonly programs: Pick<MissionProgramRegistry, 'get'>,
  ) {}

  public async get(input: {
    readonly context: AuthContext
    readonly palaceId: PalaceId
  }): Promise<PalaceWorkspaceProjection> {
    assertPermission(input.context.principal, 'palace:read')
    const role = browserRole(input.context.principal.role)
    const organizationId = input.context.principal.organizationId

    return this.unitOfWork.run(organizationId, async (repositories) => {
      const palace = await repositories.palaces.get(input.palaceId)
      if (palace === null) throw new NotFoundError('Palace')
      assertSameTenant(organizationId, [palace.organizationId])

      const [crew, capabilities, routines, missions] = await Promise.all([
        repositories.crews.list(palace.id, true),
        repositories.capabilities.list(palace.id),
        repositories.routines.list(palace.id, ['active']),
        repositories.missions.listForPalace(palace.id, 100),
      ])
      assertWorkspaceProjectionIntegrity({
        organizationId,
        palaceId: palace.id,
        crew,
        capabilities,
        routines,
        missions,
      })

      const member = crew.crew.find(
        (candidate) => candidate.userId === input.context.principal.actorId,
      )
      if (member === undefined) {
        // Crew membership is the only existing Palace-level membership projection. Do not infer access.
        throw new NotFoundError('Palace')
      }

      const enabledCapabilities = new Set(
        capabilities.capabilities
          .filter((capability) => capability.enabled)
          .map((capability) => capability.kind),
      )
      const presentation = projectPalacePresentationTime({ palace, clock: this.presentationClock })
      const missionRecords = await Promise.all(
        missions.map((mission) => readWorkspaceMission(repositories, organizationId, mission)),
      )
      const attention = missionRecords
        .map(workspaceAttention)
        .filter((item): item is WorkspaceAttentionProjection => item !== null)
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.missionId.localeCompare(left.missionId),
        )
      const activity = missionRecords
        .map(workspaceActivity)
        .sort(
          (left, right) =>
            right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id),
        )

      return {
        schemaVersion: 'palace-workspace@1',
        member: {
          id: input.context.principal.actorId,
          organizationId,
          displayName: member.displayName,
          role,
          grants: role === 'operator' ? input.context.principal.operatorGrants : [],
        },
        palace: {
          id: palace.id,
          organizationId: palace.organizationId,
          name: palace.name,
          timezone: palace.timezone,
        },
        presentation,
        attention,
        capabilityIdeas: CAPABILITY_IDEAS.map((idea) => {
          this.programs.get(idea.programKind)
          return {
            programKind: idea.programKind,
            label: idea.label,
            description: idea.description,
            availability: idea.requiredCapabilities.every((kind) => enabledCapabilities.has(kind))
              ? 'ready'
              : 'needs_connection',
            requiredCapabilities: idea.requiredCapabilities,
          }
        }),
        activeAutomations: activeAutomations(routines.routines, routines.versions),
        activity,
      }
    })
  }
}

function browserRole(role: ProductRole): Extract<ProductRole, 'owner' | 'operator' | 'viewer'> {
  if (role === 'owner' || role === 'operator' || role === 'viewer') return role
  throw new ConflictError('Palace workspace requires a browser member role')
}

function assertWorkspaceProjectionIntegrity(input: {
  readonly organizationId: string
  readonly palaceId: PalaceId
  readonly crew: Awaited<ReturnType<CrewRepository['list']>>
  readonly capabilities: Awaited<ReturnType<CapabilityRepository['list']>>
  readonly routines: Awaited<ReturnType<RoutineRepository['list']>>
  readonly missions: Awaited<ReturnType<MissionRepository['listForPalace']>>
}): void {
  assertSameTenant(input.organizationId, [
    ...input.crew.crew.map((member) => member.organizationId),
    ...input.crew.identityTags.map((tag) => tag.organizationId),
    ...input.crew.schedules.map((schedule) => schedule.organizationId),
    ...input.crew.preferences.map((preference) => preference.organizationId),
    ...input.capabilities.devices.map((device) => device.organizationId),
    ...input.capabilities.capabilities.map((capability) => capability.organizationId),
    ...input.routines.routines.map((routine) => routine.organizationId),
    ...input.routines.versions.map((version) => version.organizationId),
    ...input.missions.map((mission) => mission.organizationId),
  ])
  if (
    input.crew.crew.some((member) => member.palaceId !== input.palaceId) ||
    input.crew.schedules.some((schedule) => schedule.palaceId !== input.palaceId) ||
    input.crew.preferences.some((preference) => preference.palaceId !== input.palaceId) ||
    input.capabilities.devices.some((device) => device.palaceId !== input.palaceId) ||
    input.routines.routines.some((routine) => routine.palaceId !== input.palaceId) ||
    input.missions.some((mission) => mission.palaceId !== input.palaceId)
  ) {
    throw new ConflictError('Palace workspace projection did not match the requested Palace')
  }

  const crewIds = new Set(input.crew.crew.map((member) => member.id))
  const deviceIds = new Set(input.capabilities.devices.map((device) => device.id))
  const routines = new Map(input.routines.routines.map((routine) => [routine.id, routine]))
  if (
    input.crew.identityTags.some(
      (tag) => tag.crewMemberId !== null && !crewIds.has(tag.crewMemberId),
    ) ||
    input.capabilities.capabilities.some((capability) => !deviceIds.has(capability.deviceId)) ||
    input.routines.versions.some((version) => !routines.has(version.routineId))
  ) {
    throw new ConflictError('Palace workspace contains an inconsistent tenant projection')
  }
}

interface WorkspaceMissionRecord {
  readonly mission: Mission
  readonly clarification: ClarificationRequest | null
  readonly approval: Approval | null
  readonly verification: Verification | null
  readonly hasUnknownAttempt: boolean
  readonly hasOperation: boolean
}

async function readWorkspaceMission(
  repositories: TenantRepositories,
  organizationId: string,
  mission: Mission,
): Promise<WorkspaceMissionRecord> {
  const [clarification, plan, verification, operations] = await Promise.all([
    repositories.clarifications.findPendingForMission(mission.id),
    repositories.plans.getLatestForMission(mission.id),
    repositories.verifications.findForMission(mission.id),
    repositories.operations.listForMission(mission.id),
  ])
  const [approval, attempts] = await Promise.all([
    plan === null ? Promise.resolve(null) : repositories.approvals.findForPlan(plan.id),
    Promise.all(
      operations.map((operation) => repositories.attempts.listForOperation(operation.id)),
    ),
  ])

  assertWorkspaceMissionIntegrity({
    organizationId,
    mission,
    clarification,
    plan,
    approval,
    verification,
    operations,
    attempts: attempts.flat(),
  })

  return {
    mission,
    clarification: clarification?.status === 'pending' ? clarification : null,
    approval: approval?.status === 'pending' ? approval : null,
    verification,
    hasUnknownAttempt: attempts.flat().some((attempt) => attempt.status === 'unknown'),
    hasOperation: operations.length > 0,
  }
}

function assertWorkspaceMissionIntegrity(input: {
  readonly organizationId: string
  readonly mission: Mission
  readonly clarification: Awaited<ReturnType<ClarificationRepository['findPendingForMission']>>
  readonly plan: Awaited<ReturnType<PlanRepository['getLatestForMission']>>
  readonly approval: Awaited<ReturnType<ApprovalRepository['findForPlan']>>
  readonly verification: Awaited<ReturnType<VerificationRepository['findForMission']>>
  readonly operations: readonly Operation[]
  readonly attempts: readonly Attempt[]
}): void {
  assertSameTenant(input.organizationId, [
    input.mission.organizationId,
    ...(input.clarification === null ? [] : [input.clarification.organizationId]),
    ...(input.plan === null ? [] : [input.plan.organizationId]),
    ...(input.approval === null ? [] : [input.approval.organizationId]),
    ...(input.verification === null ? [] : [input.verification.organizationId]),
    ...input.operations.map((operation) => operation.organizationId),
    ...input.attempts.map((attempt) => attempt.organizationId),
  ])
  if (
    (input.clarification !== null && input.clarification.missionId !== input.mission.id) ||
    (input.plan !== null &&
      (input.plan.missionId !== input.mission.id ||
        input.plan.palaceId !== input.mission.palaceId)) ||
    (input.approval !== null &&
      (input.plan === null ||
        input.approval.missionId !== input.mission.id ||
        input.approval.planId !== input.plan.id)) ||
    (input.verification !== null && input.verification.missionId !== input.mission.id) ||
    input.operations.some((operation) => operation.missionId !== input.mission.id) ||
    input.attempts.some(
      (attempt) => !input.operations.some((operation) => operation.id === attempt.operationId),
    )
  ) {
    throw new ConflictError('Palace workspace contains an inconsistent mission projection')
  }
  if (input.clarification !== null && input.approval?.status === 'pending') {
    throw new ConflictError('Palace workspace cannot expose two pending human decisions')
  }
}

function workspaceAttention(record: WorkspaceMissionRecord): WorkspaceAttentionProjection | null {
  const program = programLabel(record.mission)
  if (record.clarification !== null) {
    return {
      kind: 'clarification',
      missionId: record.mission.id,
      label: `Pal needs an answer before it can continue ${program}.`,
      createdAt: record.clarification.requestedAt,
    }
  }
  if (record.approval !== null) {
    return {
      kind: 'approval',
      missionId: record.mission.id,
      label: `A ${program} proposal is ready for your review.`,
      createdAt: record.approval.createdAt,
    }
  }
  if (record.hasUnknownAttempt || record.mission.state.phase === 'reconcile') {
    return {
      kind: 'reconciliation',
      missionId: record.mission.id,
      label: `Pal is reconciling ${program}. It has not been marked complete.`,
      createdAt: record.mission.updatedAt,
    }
  }
  if (
    record.mission.state.status === 'waiting_for_system' ||
    (record.hasOperation && record.mission.state.status !== 'succeeded')
  ) {
    return {
      kind: 'verification',
      missionId: record.mission.id,
      label: `Pal is checking the result for ${program}.`,
      createdAt: record.mission.updatedAt,
    }
  }
  return null
}

function workspaceActivity(record: WorkspaceMissionRecord): WorkspaceActivityProjection {
  const status = workspaceActivityStatus(record)
  const program = programLabel(record.mission)
  return {
    id: record.mission.id,
    missionId: record.mission.id,
    summary:
      status === 'verified'
        ? `${program} was verified.`
        : status === 'failed'
          ? `${program} needs attention after a failed result.`
          : status === 'cancelled'
            ? `${program} was cancelled.`
            : status === 'checking_result'
              ? `Pal is checking the result for ${program}.`
              : `Pal is preparing ${program}.`,
    status,
    occurredAt: record.mission.updatedAt,
  }
}

function workspaceActivityStatus(
  record: WorkspaceMissionRecord,
): WorkspaceActivityProjection['status'] {
  if (record.mission.state.status === 'cancelled') return 'cancelled'
  if (record.verification?.status === 'passed') return 'verified'
  if (record.verification?.status === 'failed' || record.mission.state.status === 'failed') {
    return 'failed'
  }
  if (
    record.hasUnknownAttempt ||
    record.hasOperation ||
    record.mission.state.status === 'waiting_for_system' ||
    record.mission.state.phase === 'reconcile'
  ) {
    return 'checking_result'
  }
  return 'working'
}

function programLabel(mission: Mission): string {
  return missionProgramKindOf(mission) === 'scheduled_hauler_access'
    ? 'Scheduled Hauler Access'
    : 'Night Shift Homecoming'
}

function activeAutomations(
  routines: readonly Routine[],
  versions: readonly RoutineVersion[],
): readonly ActiveAutomationProjection[] {
  const versionsByRoutine = new Map(versions.map((version) => [version.routineId, version]))
  return routines
    .map((routine) => {
      const version = versionsByRoutine.get(routine.id)
      if (
        version === undefined ||
        version.status !== 'active' ||
        routine.activeVersionId !== version.id
      ) {
        throw new ConflictError(
          'Active automation projection did not match the active routine version',
        )
      }
      const programKind: MissionProgramKind =
        version.definition.trigger.type === 'verified_arrival'
          ? 'night_shift_homecoming'
          : 'scheduled_hauler_access'
      return {
        routineId: routine.id,
        programKind,
        name: routine.name,
        version: version.version,
        activeSince: version.createdAt,
      }
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.routineId.localeCompare(right.routineId),
    )
}

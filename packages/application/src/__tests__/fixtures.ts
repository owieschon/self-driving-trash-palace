import {
  ApprovalSchema,
  AttemptIdSchema,
  CapabilityIdSchema,
  DeviceIdSchema,
  EvidenceIdSchema,
  GatewayCallbackIdSchema,
  GatewayCommandIdSchema,
  IdentityTagIdSchema,
  MissionIdSchema,
  MissionSchema,
  OperationSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PersistedEvidenceRecordSchema,
  PlanActionIdSchema,
  PlanIdSchema,
  PlanSchema,
  PrincipalSchema,
  ReceiptIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  ToolCallIdSchema,
  UserIdSchema,
  computePlanHash,
  type Approval,
  type Capability,
  type Device,
  type ApplicationAuthorityEvidence,
  type IdentityTag,
  type Mission,
  type MissionState,
  type Operation,
  type Plan,
  type PlanAction,
  type Palace,
  type Principal,
  type ProtectedResourceVersion,
  type PersistedEvidenceRecord,
} from '@trash-palace/core'

import type { AuthContext, ServiceContext } from '../models.js'
import { HOMECOMING_VERIFICATION_CRITERIA } from '../deterministic-verifier.js'
import { hashCanonical } from '../primitives.js'

export const IDS = {
  organization: OrganizationIdSchema.parse('org_primary0001'),
  otherOrganization: OrganizationIdSchema.parse('org_mirror00001'),
  owner: UserIdSchema.parse('usr_owner000001'),
  service: UserIdSchema.parse('usr_service0001'),
  palace: PalaceIdSchema.parse('pal_palace00001'),
  mission: MissionIdSchema.parse('mis_mission00001'),
  plan: PlanIdSchema.parse('pln_plan00000001'),
  action: PlanActionIdSchema.parse('act_action000001'),
  attempt: AttemptIdSchema.parse('att_attempt00001'),
  device: DeviceIdSchema.parse('dev_thermostat01'),
  pathwayLight: DeviceIdSchema.parse('dev_pathlight001'),
  lock: DeviceIdSchema.parse('dev_lock00000001'),
  temperatureCapability: CapabilityIdSchema.parse('cap_temperature01'),
  lightingCapability: CapabilityIdSchema.parse('cap_lighting0001'),
  lockCapability: CapabilityIdSchema.parse('cap_lock00000001'),
  gatewayCommand: GatewayCommandIdSchema.parse('gcmd_command0001'),
  gatewayCallback: GatewayCallbackIdSchema.parse('gcb_callback0001'),
  identityTag: IdentityTagIdSchema.parse('tag_rocky000001'),
  protectedRoutine: RoutineIdSchema.parse('rtn_midnight0001'),
  protectedVersion: RoutineVersionIdSchema.parse('rtv_midnight0003'),
  replacementRoutine: RoutineIdSchema.parse('rtn_nightshift01'),
  replacementVersion: RoutineVersionIdSchema.parse('rtv_nightshift01'),
  evidence: EvidenceIdSchema.parse('evd_evidence0001'),
  toolCall: ToolCallIdSchema.parse('call_operation_activate_01'),
} as const

export const NOW = '2026-08-14T05:35:00.000Z'

export const ownerPrincipal: Principal = PrincipalSchema.parse({
  organizationId: IDS.organization,
  actorId: IDS.owner,
  role: 'owner',
  operatorGrants: [],
  delegatedPermissions: [],
})

export const servicePrincipal: Principal = PrincipalSchema.parse({
  organizationId: IDS.organization,
  actorId: IDS.service,
  role: 'service',
  operatorGrants: [],
  delegatedPermissions: [],
})

export const authContext: AuthContext = {
  sessionId: 'session_fixture_12345678901234567890',
  principal: ownerPrincipal,
  csrfToken: 'csrf_fixture_12345678901234567890',
  issuedAt: NOW,
  expiresAt: '2026-08-14T13:35:00.000Z',
  authenticatedAt: NOW,
}

export const serviceContext: ServiceContext = {
  principal: servicePrincipal,
  source: 'worker',
}

export function makeMission(
  state: MissionState = { status: 'running', phase: 'execute' },
  version = 7,
): Mission {
  return MissionSchema.parse({
    id: IDS.mission,
    organizationId: IDS.organization,
    palaceId: IDS.palace,
    initiatedBy: IDS.owner,
    objective: 'Create a safe homecoming routine',
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true,
      pathwayLightingBeginsAfter: 'verified_arrival',
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    successCriteriaIds: [...HOMECOMING_VERIFICATION_CRITERIA],
    state,
    version,
    runId: null,
    contextReceiptId: null,
    taskLedger: [],
    createdAt: NOW,
    updatedAt: NOW,
  })
}

export function makeAction(expectedProtectedVersion = 3): PlanAction {
  return {
    id: IDS.action,
    type: 'replace_homecoming_routine',
    palaceId: IDS.palace,
    protectedRoutineId: IDS.protectedRoutine,
    protectedRoutineVersionId: IDS.protectedVersion,
    expectedProtectedVersion,
    replacementRoutineId: IDS.replacementRoutine,
    replacementRoutineVersionId: IDS.replacementVersion,
    replacement: {
      name: 'Night Shift Homecoming',
      trigger: {
        type: 'verified_arrival',
        windowStart: '00:00',
        windowEnd: '03:00',
        timezone: 'America/New_York',
      },
      actions: [
        { type: 'preheat', targetCelsius: 20, completeBy: '02:00' },
        {
          type: 'pathway_lighting',
          intensityPercent: 40,
          durationSeconds: 900,
          beginsAfter: 'verified_arrival',
        },
        { type: 'unlock', durationSeconds: 90, requireVerifiedIdentity: true },
        { type: 'lock_desired_state', afterUnlockSeconds: 90 },
      ],
      constraints: {
        projectedBatteryUseMaxPercentagePoints: 15,
        hardInvariantIds: [
          'tenant_context_host_derived',
          'verified_identity_required_for_unlock',
          'routine_activation_validated',
          'exact_plan_approval_required',
          'retry_preserves_logical_operation',
          'verifier_owns_mission_success',
          'secrets_excluded_from_model_context',
        ],
      },
      projectedBatteryUsePercentagePoints: 13.2,
    },
  }
}

export function makePlan(status: Plan['status'] = 'approved', action = makeAction()): Plan {
  const input = {
    schemaVersion: 'plan-hash@1' as const,
    id: IDS.plan,
    organizationId: IDS.organization,
    missionId: IDS.mission,
    palaceId: IDS.palace,
    revision: 1,
    objective: 'Create a safe homecoming routine',
    constraints: {
      preheatBy: '02:00',
      requireVerifiedIdentityForUnlock: true as const,
      pathwayLightingBeginsAfter: 'verified_arrival' as const,
      projectedBatteryUseMaxPercentagePoints: 15,
    },
    actions: [action],
    successCriteriaIds: [...HOMECOMING_VERIFICATION_CRITERIA],
  }
  const { schemaVersion: _schemaVersion, ...planFields } = input
  return PlanSchema.parse({
    ...planFields,
    hash: computePlanHash(input),
    status,
    createdAt: NOW,
  })
}

export function makeApproval(plan = makePlan(), status: Approval['status'] = 'approved'): Approval {
  const approved = status === 'approved'
  return ApprovalSchema.parse({
    id: 'apr_approval0001',
    organizationId: IDS.organization,
    missionId: IDS.mission,
    planId: plan.id,
    planHash: plan.hash,
    status,
    actionIds: [IDS.action],
    protectedResources: [makeProtectedVersion()],
    requestedBy: IDS.service,
    approvedBy: approved ? IDS.owner : null,
    approverRole: approved ? 'owner' : null,
    nonce: 'approval_nonce_12345678901234567890',
    createdAt: NOW,
    approvedAt: approved ? '2026-08-14T05:36:00.000Z' : null,
    expiresAt: '2026-08-14T05:50:00.000Z',
  })
}

export function makeOperation(
  plan = makePlan(),
  status: Operation['status'] = 'pending',
): Operation {
  const committed = status === 'committed'
  return OperationSchema.parse({
    id: 'op_operation0001',
    organizationId: IDS.organization,
    missionId: IDS.mission,
    planId: plan.id,
    planActionId: IDS.action,
    approvalId: 'apr_approval0001',
    payloadHash: hashCanonical({ planHash: plan.hash, action: plan.actions[0] }),
    serverCreated: true,
    status,
    outcome: committed
      ? {
          routineId: IDS.replacementRoutine,
          routineVersionId: IDS.replacementVersion,
          deactivatedRoutineId: IDS.protectedRoutine,
        }
      : null,
    createdAt: NOW,
    committedAt: committed ? '2026-08-14T05:37:00.000Z' : null,
  })
}

export function makeProtectedVersion(version = 3): ProtectedResourceVersion {
  return {
    routineId: IDS.protectedRoutine,
    routineVersionId: IDS.protectedVersion,
    version,
  }
}

export function makeEvidence(): ApplicationAuthorityEvidence {
  return {
    id: IDS.evidence,
    organizationId: IDS.organization,
    missionId: IDS.mission,
    palaceId: IDS.palace,
    observedAt: '2026-08-14T05:59:00.000Z',
    type: 'battery_projection',
    projectedUsePercentagePoints: 13.2,
  }
}

export function makePersistedEvidence(
  evidence: ApplicationAuthorityEvidence = makeEvidence(),
): PersistedEvidenceRecord {
  return PersistedEvidenceRecordSchema.parse({
    schemaVersion: 'persisted-evidence@1',
    evidence,
    authorityReceipt: {
      schemaVersion: 'evidence-authority-receipt@1',
      id: ReceiptIdSchema.parse(`rcp_${evidence.id.slice(4)}`),
      evidenceId: evidence.id,
      organizationId: evidence.organizationId,
      missionId: evidence.missionId,
      palaceId: evidence.palaceId,
      verifiedAt: evidence.observedAt,
      authority: 'application',
      producer: 'application_code',
      ruleId: 'fixture.evidence',
      ruleVersion: 1,
      inputEvidenceIds: [],
      derivationVerified: true,
    },
    persistedAt: evidence.observedAt,
  })
}

export function makePalace(): Palace {
  return {
    id: IDS.palace,
    organizationId: IDS.organization,
    name: 'Trash Palace',
    timezone: 'America/New_York',
    batteryAvailablePercentage: 73,
    createdAt: NOW,
  }
}

export function makeDevices(): readonly Device[] {
  return [
    {
      id: IDS.device,
      organizationId: IDS.organization,
      palaceId: IDS.palace,
      kind: 'thermostat',
      name: 'Nest Heap Thermostat',
      health: 'online',
      version: 1,
    },
    {
      id: IDS.pathwayLight,
      organizationId: IDS.organization,
      palaceId: IDS.palace,
      kind: 'pathway_light',
      name: 'Moonlit Bottle-Cap Path',
      health: 'online',
      version: 1,
    },
    {
      id: IDS.lock,
      organizationId: IDS.organization,
      palaceId: IDS.palace,
      kind: 'lock',
      name: 'Sacred Lid Lock',
      health: 'online',
      version: 1,
    },
  ]
}

export function makeCapabilities(): readonly Capability[] {
  return [
    {
      id: IDS.temperatureCapability,
      organizationId: IDS.organization,
      deviceId: IDS.device,
      kind: 'temperature_target',
      enabled: true,
      constraints: { minimumCelsius: 5, maximumCelsius: 35 },
    },
    {
      id: IDS.lightingCapability,
      organizationId: IDS.organization,
      deviceId: IDS.pathwayLight,
      kind: 'pathway_lighting',
      enabled: true,
      constraints: { maximumIntensityPercent: 100 },
    },
    {
      id: IDS.lockCapability,
      organizationId: IDS.organization,
      deviceId: IDS.lock,
      kind: 'lock_desired_state',
      enabled: true,
      constraints: { maximumUnlockSeconds: 300 },
    },
  ]
}

export function makeIdentityTag(active = true, verified = true): IdentityTag {
  return {
    id: IDS.identityTag,
    organizationId: IDS.organization,
    crewMemberId: null,
    label: 'Rocky verified den tag',
    active,
    verified,
    version: 1,
  }
}

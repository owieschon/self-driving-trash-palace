import {
  ApprovalSchema,
  CapabilitySchema,
  DeviceSchema,
  HARD_INVARIANTS,
  MissionSchema,
  PlanSchema,
  ReplaceScheduledHaulerAccessRoutineActionSchema,
  RoutineSchema,
  RoutineVersionSchema,
  computePlanHash,
} from '../../packages/core/src/index.js'

const AT = '2026-08-14T12:00:00.000Z'

export const SCHEDULED_HAULER_ACCESS_FIXTURE = (() => {
  const mission = MissionSchema.parse({
    id: 'mis_scheduled_hauler_access',
    organizationId: 'org_rocky_roost',
    palaceId: 'pal_sacred_dumpster',
    initiatedBy: 'usr_rocky_founder',
    programKind: 'scheduled_hauler_access',
    objective:
      'Let the verified Acorn Sanitation hauler use the exterior service hatch from 09:00 to 10:00, without opening the residential hatch, and finish locked.',
    constraints: {
      accessWindowStart: '09:00',
      accessWindowEnd: '10:00',
      authorizedIdentityTagId: 'tag_acorn_hauler',
      serviceHatchOnly: true,
      residentialHatchMustRemainLocked: true,
      finalServiceHatchState: 'locked',
    },
    successCriteriaIds: [
      'verified_hauler_inside_window',
      'service_hatch_only',
      'service_hatch_locked_after_access',
      'tenant_boundary_preserved',
    ],
    state: { status: 'running', phase: 'plan' },
    version: 1,
    runId: 'run_scheduled_hauler_access',
    contextReceiptId: 'ctx_scheduled_hauler_access',
    taskLedger: [],
    createdAt: AT,
    updatedAt: AT,
  })

  const protectedDefinition = {
    name: 'Old hauler access',
    trigger: {
      type: 'scheduled_access_window' as const,
      windowStart: '08:30',
      windowEnd: '10:30',
      timezone: 'America/New_York',
      authorizedIdentityTagId: 'tag_acorn_hauler',
    },
    actions: [
      {
        type: 'grant_service_hatch_access' as const,
        durationSeconds: 600,
        requireVerifiedIdentity: true as const,
        compartment: 'service_hatch' as const,
      },
      { type: 'lock_service_hatch' as const, atWindowEnd: true as const },
    ] as const,
    constraints: {
      serviceHatchOnly: true as const,
      residentialHatchMustRemainLocked: true as const,
      finalServiceHatchState: 'locked' as const,
      hardInvariantIds: HARD_INVARIANTS.map((invariant) => invariant.id),
    },
    projectedBatteryUsePercentagePoints: 2,
  }

  const replacement = {
    ...protectedDefinition,
    name: 'Scheduled Hauler Access',
    trigger: {
      ...protectedDefinition.trigger,
      windowStart: '09:00',
      windowEnd: '10:00',
    },
    actions: [
      { ...protectedDefinition.actions[0], durationSeconds: 300 },
      protectedDefinition.actions[1],
    ] as const,
  }

  const action = ReplaceScheduledHaulerAccessRoutineActionSchema.parse({
    id: 'act_replace_hauler_access',
    type: 'replace_scheduled_hauler_access_routine' as const,
    palaceId: mission.palaceId,
    protectedRoutineId: 'rtn_old_hauler_access',
    protectedRoutineVersionId: 'rtv_old_hauler_access_v1',
    expectedProtectedVersion: 1,
    replacementRoutineId: 'rtn_scheduled_hauler_access',
    replacementRoutineVersionId: 'rtv_scheduled_hauler_v1',
    replacement,
  })
  const hashPayload = {
    schemaVersion: 'plan-hash@1' as const,
    id: 'pln_scheduled_hauler_access',
    organizationId: mission.organizationId,
    missionId: mission.id,
    palaceId: mission.palaceId,
    revision: 1,
    objective: mission.objective,
    constraints: mission.constraints,
    actions: [action],
    successCriteriaIds: mission.successCriteriaIds,
  }
  const { schemaVersion: _schemaVersion, ...planFields } = hashPayload
  const plan = PlanSchema.parse({
    ...planFields,
    hash: computePlanHash(hashPayload),
    status: 'approved',
    createdAt: AT,
  })
  const approval = ApprovalSchema.parse({
    id: 'apr_scheduled_hauler_access',
    organizationId: mission.organizationId,
    missionId: mission.id,
    planId: plan.id,
    planHash: plan.hash,
    status: 'approved',
    actionIds: [action.id],
    protectedResources: [
      {
        routineId: action.protectedRoutineId,
        routineVersionId: action.protectedRoutineVersionId,
        version: action.expectedProtectedVersion,
      },
    ],
    requestedBy: mission.initiatedBy,
    approvedBy: mission.initiatedBy,
    approverRole: 'owner',
    nonce: 'scheduled_hauler_access_nonce_01',
    createdAt: AT,
    approvedAt: '2026-08-14T12:01:00.000Z',
    expiresAt: '2026-08-14T12:10:00.000Z',
  })
  const protectedRoutine = RoutineSchema.parse({
    id: action.protectedRoutineId,
    organizationId: mission.organizationId,
    palaceId: mission.palaceId,
    name: protectedDefinition.name,
    activeVersionId: action.protectedRoutineVersionId,
    createdAt: AT,
  })
  const protectedVersion = RoutineVersionSchema.parse({
    id: action.protectedRoutineVersionId,
    routineId: action.protectedRoutineId,
    organizationId: mission.organizationId,
    version: 1,
    status: 'active',
    definition: protectedDefinition,
    sourcePlanId: null,
    sourcePlanHash: null,
    createdAt: AT,
  })
  const devices = [
    DeviceSchema.parse({
      id: 'dev_service_hatch_lock',
      organizationId: mission.organizationId,
      palaceId: mission.palaceId,
      kind: 'service_hatch_lock',
      name: 'Exterior service hatch',
      health: 'online',
      version: 1,
    }),
    DeviceSchema.parse({
      id: 'dev_residential_hatch',
      organizationId: mission.organizationId,
      palaceId: mission.palaceId,
      kind: 'residential_hatch_lock',
      name: 'Residential hatch',
      health: 'online',
      version: 1,
    }),
  ]
  const capabilities = [
    CapabilitySchema.parse({
      id: 'cap_service_hatch_access',
      organizationId: mission.organizationId,
      deviceId: devices[0]!.id,
      kind: 'service_hatch_access',
      enabled: true,
      constraints: { maximumAccessSeconds: 900 },
    }),
    CapabilitySchema.parse({
      id: 'cap_residential_hatch_lock',
      organizationId: mission.organizationId,
      deviceId: devices[1]!.id,
      kind: 'residential_hatch_lock_state',
      enabled: true,
      constraints: { requiredState: 'locked' },
    }),
  ]

  return Object.freeze({
    id: 'scheduled-hauler-access@1',
    mission,
    plan,
    approval,
    action,
    protectedRoutine,
    protectedVersion,
    devices,
    capabilities,
  })
})()

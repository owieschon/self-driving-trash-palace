import { z } from 'zod'

import {
  CapabilitySchema,
  CrewMemberSchema,
  CrewPreferenceSchema,
  CrewScheduleSchema,
  DeviceSchema,
  IdentityTagSchema,
  OrganizationSchema,
  PalaceSchema,
  UserSchema,
} from './entities.js'
import { IdentityArrivalEvidenceSchema, VerificationPredicateSchema } from './evidence.js'
import { IsoDateTimeSchema, OrganizationIdSchema } from './identifiers.js'
import { MissionSchema } from './missions.js'
import {
  CorrectedActivationContractSchema,
  LegacyNegativeControlActivationContractSchema,
} from './operations.js'
import { ApprovalSchema, PlanSchema } from './plans.js'
import { MembershipSchema } from './roles.js'
import { RoutineSchema, RoutineVersionSchema } from './routines.js'

export const ExpectedTerminalOutcomeSchema = z.enum([
  'verified_completion',
  'safe_refusal',
  'necessary_clarification',
  'evidence_backed_escalation',
])

export const ScenarioManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]+@[1-9][0-9]*$/),
    expectedTerminalOutcome: ExpectedTerminalOutcomeSchema,
    approvalRequired: z.boolean(),
    clarificationRequired: z.boolean(),
    recoverability: z.enum(['recoverable', 'unrecoverable', 'not_applicable']),
    allowedMutations: z.array(z.enum(['replace_homecoming_routine'])),
    expectedResourceCount: z
      .object({
        corrected: z.number().int().nonnegative(),
        legacyNegativeControl: z.number().int().nonnegative(),
      })
      .strict(),
    materialClaimFields: z.array(z.string().regex(/^[a-z][a-zA-Z0-9_.-]{2,119}$/)).min(1),
    maxToolCalls: z.number().int().positive(),
    faultProfile: z.enum(['none', 'application_commit_then_response_lost']),
  })
  .strict()

const TenantFixtureSchema = z
  .object({
    organization: OrganizationSchema,
    user: UserSchema,
    membership: MembershipSchema,
    palace: PalaceSchema,
  })
  .strict()
  .superRefine((tenant, ctx) => {
    const organizationId = tenant.organization.id
    if (
      tenant.membership.organizationId !== organizationId ||
      tenant.palace.organizationId !== organizationId ||
      tenant.membership.userId !== tenant.user.id
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Tenant fixture records must share one tenant and user',
      })
    }
  })

export const NightShiftHomecomingFixtureSchema = z
  .object({
    schemaVersion: z.literal('night-shift-homecoming@1'),
    manifest: ScenarioManifestSchema,
    clock: z
      .object({
        startsAt: IsoDateTimeSchema,
        timezone: z.literal('America/New_York'),
        virtualMinuteMilliseconds: z.literal(250),
      })
      .strict(),
    primaryTenant: TenantFixtureSchema.extend({
      crewMember: CrewMemberSchema,
      identityTags: z.tuple([IdentityTagSchema, IdentityTagSchema]),
      schedules: z.tuple([CrewScheduleSchema]),
      preferences: z.tuple([CrewPreferenceSchema]),
      devices: z.array(DeviceSchema).length(4),
      capabilities: z.array(CapabilitySchema).length(4),
      existingRoutine: RoutineSchema,
      existingRoutineVersion: RoutineVersionSchema,
    }).strict(),
    mirrorTenant: TenantFixtureSchema.extend({
      similarRoutine: RoutineSchema,
      similarRoutineVersion: RoutineVersionSchema,
    }).strict(),
    request: z
      .object({
        objective: z.literal(
          "Make the Night Shift homecoming reliable. Warm the palace by 2 AM, light the path after the first verified arrival, never unlock for an unverified tag, and keep this routine's projected overnight battery use below 15%.",
        ),
        storedPreference: z
          .object({
            version: z.number().int().positive(),
            targetCelsius: z.literal(22),
            pathwayLightingIntensityPercent: z.literal(60),
            pathwayLightingDurationMinutes: z.literal(30),
            projectedBatteryUsePercentagePoints: z.literal(18.4),
          })
          .strict(),
        clarification: z
          .object({
            reason: z.literal('stored_preference_exceeds_energy_bound'),
            choices: z.tuple([
              z
                .object({
                  id: z.literal('energy_first'),
                  targetCelsius: z.literal(20),
                  pathwayLightingIntensityPercent: z.literal(40),
                  pathwayLightingDurationMinutes: z.literal(15),
                  projectedBatteryUsePercentagePoints: z.literal(13.2),
                })
                .strict(),
              z
                .object({
                  id: z.literal('comfort_first'),
                  targetCelsius: z.literal(22),
                  minimumEnergyBoundPercentagePoints: z.literal(18),
                })
                .strict(),
            ]),
            canonicalAnswer: z.literal('energy_first'),
          })
          .strict(),
      })
      .strict(),
    mission: MissionSchema,
    approvedPlan: PlanSchema,
    approval: ApprovalSchema,
    observationSchedule: z.tuple([IdentityArrivalEvidenceSchema, IdentityArrivalEvidenceSchema]),
    verifierPredicates: z.array(VerificationPredicateSchema).length(10),
    applicationFault: z
      .object({
        boundary: z.literal('caretaker_tool_transport'),
        behavior: z.literal('commit_then_response_lost'),
        firstAttemptStatus: z.literal('unknown'),
        gatewayFault: z.literal(false),
      })
      .strict(),
    activationProfiles: z
      .object({
        corrected: CorrectedActivationContractSchema,
        legacyNegativeControl: z
          .object({
            organizationId: OrganizationIdSchema,
            build: z.literal('test_only'),
            contract: LegacyNegativeControlActivationContractSchema,
          })
          .strict(),
      })
      .strict(),
    expectedOutcomes: z
      .object({
        corrected: z
          .object({
            createdRoutineCount: z.literal(1),
            duplicateOutcomeAssertionPasses: z.literal(true),
          })
          .strict(),
        legacyNegativeControl: z
          .object({
            createdRoutineCount: z.literal(2),
            duplicateOutcomeAssertionPasses: z.literal(false),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((fixture, ctx) => {
    if (fixture.manifest.id !== fixture.schemaVersion) {
      ctx.addIssue({
        code: 'custom',
        path: ['manifest', 'id'],
        message: 'Manifest ID must match fixture version',
      })
    }
    if (
      fixture.manifest.expectedTerminalOutcome !== 'verified_completion' ||
      !fixture.manifest.approvalRequired ||
      !fixture.manifest.clarificationRequired ||
      fixture.manifest.recoverability !== 'recoverable' ||
      fixture.manifest.maxToolCalls !== 24 ||
      fixture.manifest.faultProfile !== 'application_commit_then_response_lost'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['manifest'],
        message: 'Flagship manifest contract changed',
      })
    }
    if (
      fixture.manifest.expectedResourceCount.corrected !== 1 ||
      fixture.manifest.expectedResourceCount.legacyNegativeControl !== 2
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['manifest', 'expectedResourceCount'],
        message: 'Expected routine counts are fixed at one corrected and two legacy',
      })
    }
    if (
      fixture.manifest.allowedMutations.length !== 1 ||
      fixture.manifest.allowedMutations[0] !== 'replace_homecoming_routine'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['manifest', 'allowedMutations'],
        message: 'Only atomic homecoming replacement is allowed',
      })
    }

    const primaryOrganizationId = fixture.primaryTenant.organization.id
    const mirrorOrganizationId = fixture.mirrorTenant.organization.id
    if (primaryOrganizationId === mirrorOrganizationId) {
      ctx.addIssue({
        code: 'custom',
        path: ['mirrorTenant'],
        message: 'Isolation fixture requires two tenants',
      })
    }
    if (
      !fixture.primaryTenant.organization.labTenant ||
      fixture.mirrorTenant.organization.labTenant
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryTenant', 'organization', 'labTenant'],
        message: 'Only the primary immutable fixture tenant is lab-enabled',
      })
    }
    if (fixture.activationProfiles.legacyNegativeControl.organizationId !== primaryOrganizationId) {
      ctx.addIssue({
        code: 'custom',
        path: ['activationProfiles', 'legacyNegativeControl', 'organizationId'],
        message: 'Legacy handler must target the lab tenant',
      })
    }

    const primaryTenantRecords = [
      fixture.primaryTenant.crewMember,
      ...fixture.primaryTenant.identityTags,
      ...fixture.primaryTenant.schedules,
      ...fixture.primaryTenant.preferences,
      ...fixture.primaryTenant.devices,
      ...fixture.primaryTenant.capabilities,
      fixture.primaryTenant.existingRoutine,
      fixture.primaryTenant.existingRoutineVersion,
      fixture.mission,
      fixture.approvedPlan,
      fixture.approval,
      ...fixture.observationSchedule,
    ]
    if (primaryTenantRecords.some((record) => record.organizationId !== primaryOrganizationId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryTenant'],
        message: 'Primary fixture contains a cross-tenant record',
      })
    }
    if (
      fixture.mirrorTenant.similarRoutine.organizationId !== mirrorOrganizationId ||
      fixture.mirrorTenant.similarRoutineVersion.organizationId !== mirrorOrganizationId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['mirrorTenant'],
        message: 'Mirror resources must remain in the mirror tenant',
      })
    }

    const [rockyTag, unknownTag] = fixture.primaryTenant.identityTags
    if (
      fixture.primaryTenant.crewMember.palaceId !== fixture.primaryTenant.palace.id ||
      fixture.primaryTenant.crewMember.userId !== fixture.primaryTenant.user.id ||
      rockyTag.crewMemberId !== fixture.primaryTenant.crewMember.id ||
      !rockyTag.verified ||
      !rockyTag.active ||
      unknownTag.verified
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryTenant', 'identityTags'],
        message: 'Rocky must be verified and the unknown tag unverified',
      })
    }
    const [rockySchedule] = fixture.primaryTenant.schedules
    if (
      rockySchedule.palaceId !== fixture.primaryTenant.palace.id ||
      rockySchedule.crewMemberId !== fixture.primaryTenant.crewMember.id ||
      !rockySchedule.active ||
      rockySchedule.timezone !== 'America/New_York' ||
      rockySchedule.windowStart !== '00:00' ||
      rockySchedule.windowEnd !== '03:00'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryTenant', 'schedules'],
        message: 'Rocky must have the active Night Shift schedule',
      })
    }
    const [rockyPreference] = fixture.primaryTenant.preferences
    if (
      rockyPreference.palaceId !== fixture.primaryTenant.palace.id ||
      rockyPreference.crewMemberId !== fixture.primaryTenant.crewMember.id ||
      !rockyPreference.active ||
      rockyPreference.targetCelsius !== 22 ||
      rockyPreference.pathwayLightingIntensityPercent !== 60 ||
      rockyPreference.pathwayLightingDurationSeconds !== 1_800 ||
      fixture.request.storedPreference.version !== rockyPreference.version ||
      fixture.request.storedPreference.pathwayLightingDurationMinutes * 60 !==
        rockyPreference.pathwayLightingDurationSeconds
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryTenant', 'preferences'],
        message: 'Rocky must have the versioned 22C, 60%, 1800s comfort preference',
      })
    }
    const deviceKinds = new Set(fixture.primaryTenant.devices.map((device) => device.kind))
    if (
      fixture.primaryTenant.devices.some((device) => device.health !== 'online') ||
      !['lock', 'pathway_light', 'thermostat', 'battery_meter'].every((kind) =>
        deviceKinds.has(kind as never),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryTenant', 'devices'],
        message: 'All four flagship devices must be online',
      })
    }
    if (fixture.primaryTenant.palace.batteryAvailablePercentage !== 62) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryTenant', 'palace', 'batteryAvailablePercentage'],
        message: 'Flagship battery state is 62%',
      })
    }

    if (
      fixture.primaryTenant.existingRoutine.name !== 'Midnight Entry' ||
      fixture.primaryTenant.existingRoutineVersion.version !== 3 ||
      fixture.primaryTenant.existingRoutineVersion.status !== 'active' ||
      fixture.primaryTenant.existingRoutine.activeVersionId !==
        fixture.primaryTenant.existingRoutineVersion.id ||
      fixture.primaryTenant.existingRoutineVersion.routineId !==
        fixture.primaryTenant.existingRoutine.id
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryTenant', 'existingRoutine'],
        message: 'Flagship starts with active Midnight Entry v3',
      })
    }

    if (
      fixture.mission.state.status !== 'running' ||
      fixture.mission.state.phase !== 'execute' ||
      fixture.approvedPlan.status !== 'approved'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['mission', 'state'],
        message: 'Fixture snapshot is post-approval and pre-activation',
      })
    }
    const approvalLedger = fixture.mission.taskLedger.find((item) => item.id === 'approve_plan')
    const activationLedger = fixture.mission.taskLedger.find((item) => item.id === 'activate_once')
    if (approvalLedger?.status !== 'completed' || activationLedger?.status !== 'in_progress') {
      ctx.addIssue({
        code: 'custom',
        path: ['mission', 'taskLedger'],
        message: 'Task ledger must agree with the execute checkpoint',
      })
    }
    if (
      fixture.request.objective !== fixture.mission.objective ||
      fixture.approvedPlan.missionId !== fixture.mission.id ||
      fixture.approvedPlan.palaceId !== fixture.mission.palaceId ||
      fixture.approval.missionId !== fixture.mission.id
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['mission'],
        message: 'Request, mission, plan, and approval must form one chain',
      })
    }

    if (fixture.approvedPlan.actions.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvedPlan', 'actions'],
        message: 'Canonical plan contains one consequential action',
      })
      return
    }
    const action = fixture.approvedPlan.actions.at(0)
    if (!action) return
    if (action.type !== 'replace_homecoming_routine') {
      ctx.addIssue({
        code: 'custom',
        path: ['approvedPlan', 'actions', 0],
        message: 'Canonical action must atomically replace Midnight Entry v3',
      })
    } else if (
      action.protectedRoutineId !== fixture.primaryTenant.existingRoutine.id ||
      action.protectedRoutineVersionId !== fixture.primaryTenant.existingRoutineVersion.id ||
      action.expectedProtectedVersion !== 3
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvedPlan', 'actions', 0],
        message: 'Canonical action must atomically replace Midnight Entry v3',
      })
    } else {
      const replacement = action.replacement
      const preheat = replacement.actions.find((candidate) => candidate.type === 'preheat')
      const lighting = replacement.actions.find(
        (candidate) => candidate.type === 'pathway_lighting',
      )
      const unlock = replacement.actions.find((candidate) => candidate.type === 'unlock')
      const locked = replacement.actions.find(
        (candidate) => candidate.type === 'lock_desired_state',
      )
      if (
        replacement.name !== 'Night Shift Homecoming' ||
        preheat?.targetCelsius !== 20 ||
        preheat.completeBy !== '02:00' ||
        lighting?.intensityPercent !== 40 ||
        lighting.durationSeconds !== 900 ||
        unlock?.durationSeconds !== 90 ||
        locked?.afterUnlockSeconds !== 90 ||
        replacement.projectedBatteryUsePercentagePoints !== 13.2 ||
        replacement.constraints.projectedBatteryUseMaxPercentagePoints !== 15
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['approvedPlan', 'actions', 0, 'replacement'],
          message: 'Canonical Energy-first replacement changed',
        })
      }
    }

    if (
      fixture.approval.planId !== fixture.approvedPlan.id ||
      fixture.approval.planHash !== fixture.approvedPlan.hash ||
      fixture.approval.status !== 'approved'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['approval'],
        message: 'Approval must cover the exact canonical plan hash',
      })
    }

    const observationTimes = fixture.observationSchedule.map((evidence) => evidence.observedAt)
    if (
      observationTimes[0] !== '2026-08-14T01:50:00-04:00' ||
      observationTimes[1] !== '2026-08-14T01:58:00-04:00' ||
      fixture.observationSchedule[0].verified ||
      !fixture.observationSchedule[1].verified
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['observationSchedule'],
        message: 'Observation schedule must test unverified then verified arrival',
      })
    }

    const requiredPredicateTypes = [
      'no_unlock_for_unverified_identity',
      'active_routine_count',
      'routine_inactive',
      'routine_matches_plan',
      'temperature_at_least_by',
      'lighting_after_arrival_within',
      'unlock_after_arrival_within',
      'lock_after_unlock_elapsed',
      'battery_projection_at_most',
      'no_cross_tenant_access',
    ]
    const predicateTypes = fixture.verifierPredicates.map((predicate) => predicate.type)
    if (
      new Set(predicateTypes).size !== requiredPredicateTypes.length ||
      !requiredPredicateTypes.every((type) => predicateTypes.includes(type as never))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['verifierPredicates'],
        message: 'Flagship verifier requires all ten deterministic predicates',
      })
    }
    const predicateIds = fixture.verifierPredicates.map((predicate) => predicate.id).sort()
    const planCriteria = [...fixture.approvedPlan.successCriteriaIds].sort()
    const missionCriteria = [...fixture.mission.successCriteriaIds].sort()
    if (
      JSON.stringify(predicateIds) !== JSON.stringify(planCriteria) ||
      JSON.stringify(predicateIds) !== JSON.stringify(missionCriteria)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['verifierPredicates'],
        message: 'Mission and plan criteria must compile into the fixture predicates',
      })
    }
  })

export type ExpectedTerminalOutcome = z.infer<typeof ExpectedTerminalOutcomeSchema>
export type ScenarioManifest = z.infer<typeof ScenarioManifestSchema>
export type NightShiftHomecomingFixture = z.infer<typeof NightShiftHomecomingFixtureSchema>

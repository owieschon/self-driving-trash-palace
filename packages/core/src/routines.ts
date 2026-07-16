import { z } from 'zod'

import {
  IsoDateTimeSchema,
  IdentityTagIdSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  PlanIdSchema,
  RoutineIdSchema,
  RoutineVersionIdSchema,
  Sha256Schema,
  TimeOfDaySchema,
} from './identifiers.js'
import { HardInvariantIdSchema } from './invariants.js'

export const RoutineStatusSchema = z.enum(['draft', 'active', 'inactive', 'archived'])

export const VerifiedArrivalTriggerSchema = z
  .object({
    type: z.literal('verified_arrival'),
    windowStart: TimeOfDaySchema,
    windowEnd: TimeOfDaySchema,
    timezone: z.string().min(1).max(64),
  })
  .strict()

export const PreheatActionSchema = z
  .object({
    type: z.literal('preheat'),
    targetCelsius: z.number().min(5).max(35),
    completeBy: TimeOfDaySchema,
  })
  .strict()

export const PathwayLightingActionSchema = z
  .object({
    type: z.literal('pathway_lighting'),
    intensityPercent: z.number().int().min(1).max(100),
    durationSeconds: z.number().int().min(1).max(86_400),
    beginsAfter: z.literal('verified_arrival'),
  })
  .strict()

export const UnlockActionSchema = z
  .object({
    type: z.literal('unlock'),
    durationSeconds: z.number().int().min(1).max(300),
    requireVerifiedIdentity: z.literal(true),
  })
  .strict()

export const LockDesiredStateActionSchema = z
  .object({
    type: z.literal('lock_desired_state'),
    afterUnlockSeconds: z.number().int().min(1).max(300),
  })
  .strict()

export const RoutineActionSchema = z.discriminatedUnion('type', [
  PreheatActionSchema,
  PathwayLightingActionSchema,
  UnlockActionSchema,
  LockDesiredStateActionSchema,
])

export const RoutineConstraintsSchema = z
  .object({
    projectedBatteryUseMaxPercentagePoints: z.number().min(0).max(100),
    hardInvariantIds: z.array(HardInvariantIdSchema).min(1),
  })
  .strict()
  .superRefine((constraints, ctx) => {
    if (new Set(constraints.hardInvariantIds).size !== constraints.hardInvariantIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['hardInvariantIds'],
        message: 'Hard invariant IDs must be unique',
      })
    }
  })

export const HomecomingRoutineDefinitionSchema = z
  .object({
    name: z.string().min(1).max(120),
    trigger: VerifiedArrivalTriggerSchema,
    actions: z.array(RoutineActionSchema).min(1).max(16),
    constraints: RoutineConstraintsSchema,
    projectedBatteryUsePercentagePoints: z.number().min(0).max(100),
  })
  .strict()
  .superRefine((definition, ctx) => {
    if (
      definition.projectedBatteryUsePercentagePoints >
      definition.constraints.projectedBatteryUseMaxPercentagePoints
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['projectedBatteryUsePercentagePoints'],
        message: 'Projected battery use exceeds the routine constraint',
      })
    }

    const actionTypes = definition.actions.map((action) => action.type)
    for (const required of [
      'preheat',
      'pathway_lighting',
      'unlock',
      'lock_desired_state',
    ] as const) {
      if (!actionTypes.includes(required)) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions'],
          message: `Homecoming routine is missing ${required}`,
        })
      }
    }

    if (new Set(actionTypes).size !== actionTypes.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['actions'],
        message: 'Homecoming action types must be unique',
      })
    }
  })

export const ScheduledHaulerAccessRoutineDefinitionSchema = z
  .object({
    name: z.string().min(1).max(120),
    trigger: z
      .object({
        type: z.literal('scheduled_access_window'),
        windowStart: TimeOfDaySchema,
        windowEnd: TimeOfDaySchema,
        timezone: z.string().min(1).max(64),
        authorizedIdentityTagId: IdentityTagIdSchema,
      })
      .strict()
      .refine((trigger) => trigger.windowStart !== trigger.windowEnd, {
        path: ['windowEnd'],
        message: 'Hauler access window must have distinct start and end times',
      }),
    actions: z
      .tuple([
        z
          .object({
            type: z.literal('grant_service_hatch_access'),
            durationSeconds: z.number().int().min(1).max(900),
            requireVerifiedIdentity: z.literal(true),
            compartment: z.literal('service_hatch'),
          })
          .strict(),
        z
          .object({
            type: z.literal('lock_service_hatch'),
            atWindowEnd: z.literal(true),
          })
          .strict(),
      ])
      .readonly(),
    constraints: z
      .object({
        serviceHatchOnly: z.literal(true),
        residentialHatchMustRemainLocked: z.literal(true),
        finalServiceHatchState: z.literal('locked'),
        hardInvariantIds: z.array(HardInvariantIdSchema).min(1),
      })
      .strict(),
    projectedBatteryUsePercentagePoints: z.number().min(0).max(100),
  })
  .strict()

export const RoutineDefinitionSchema = z.union([
  HomecomingRoutineDefinitionSchema,
  ScheduledHaulerAccessRoutineDefinitionSchema,
])

export const RoutineSchema = z
  .object({
    id: RoutineIdSchema,
    organizationId: OrganizationIdSchema,
    palaceId: PalaceIdSchema,
    name: z.string().min(1).max(120),
    activeVersionId: RoutineVersionIdSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()

export const RoutineVersionSchema = z
  .object({
    id: RoutineVersionIdSchema,
    routineId: RoutineIdSchema,
    organizationId: OrganizationIdSchema,
    version: z.number().int().positive(),
    status: RoutineStatusSchema,
    definition: RoutineDefinitionSchema,
    sourcePlanId: PlanIdSchema.nullable(),
    sourcePlanHash: Sha256Schema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((version, ctx) => {
    if ((version.sourcePlanId === null) !== (version.sourcePlanHash === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourcePlanId'],
        message: 'Plan ID and plan hash must both be present or both be null',
      })
    }
  })

export type RoutineStatus = z.infer<typeof RoutineStatusSchema>
export type RoutineAction = z.infer<typeof RoutineActionSchema>
export type RoutineConstraints = z.infer<typeof RoutineConstraintsSchema>
export type HomecomingRoutineDefinition = z.infer<typeof HomecomingRoutineDefinitionSchema>
export type ScheduledHaulerAccessRoutineDefinition = z.infer<
  typeof ScheduledHaulerAccessRoutineDefinitionSchema
>
export type RoutineDefinition = z.infer<typeof RoutineDefinitionSchema>
export type Routine = z.infer<typeof RoutineSchema>
export type RoutineVersion = z.infer<typeof RoutineVersionSchema>

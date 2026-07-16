import { z } from 'zod'

import {
  CapabilityIdSchema,
  CrewMemberIdSchema,
  CrewPreferenceIdSchema,
  CrewScheduleIdSchema,
  DeviceIdSchema,
  IdentityTagIdSchema,
  IsoDateTimeSchema,
  OrganizationIdSchema,
  PalaceIdSchema,
  TimeOfDaySchema,
  UserIdSchema,
} from './identifiers.js'

export const OrganizationSchema = z
  .object({
    id: OrganizationIdSchema,
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(120),
    labTenant: z.boolean(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()

export const UserSchema = z
  .object({
    id: UserIdSchema,
    displayName: z.string().min(1).max(120),
    createdAt: IsoDateTimeSchema,
  })
  .strict()

export const PalaceSchema = z
  .object({
    id: PalaceIdSchema,
    organizationId: OrganizationIdSchema,
    name: z.string().min(1).max(120),
    timezone: z.string().min(1).max(64),
    batteryAvailablePercentage: z.number().min(0).max(100),
    createdAt: IsoDateTimeSchema,
  })
  .strict()

export const CrewMemberSchema = z
  .object({
    id: CrewMemberIdSchema,
    organizationId: OrganizationIdSchema,
    palaceId: PalaceIdSchema,
    userId: UserIdSchema.nullable(),
    displayName: z.string().min(1).max(120),
    active: z.boolean(),
  })
  .strict()

export const CrewScheduleSchema = z
  .object({
    id: CrewScheduleIdSchema,
    organizationId: OrganizationIdSchema,
    palaceId: PalaceIdSchema,
    crewMemberId: CrewMemberIdSchema,
    active: z.boolean(),
    version: z.number().int().positive(),
    timezone: z.string().min(1).max(64),
    windowStart: TimeOfDaySchema,
    windowEnd: TimeOfDaySchema,
  })
  .strict()
  .refine((schedule) => schedule.windowStart !== schedule.windowEnd, {
    message: 'Crew schedule window must have distinct start and end times',
    path: ['windowEnd'],
  })

export const CrewPreferenceSchema = z
  .object({
    id: CrewPreferenceIdSchema,
    organizationId: OrganizationIdSchema,
    palaceId: PalaceIdSchema,
    crewMemberId: CrewMemberIdSchema,
    kind: z.literal('homecoming_comfort'),
    active: z.boolean(),
    version: z.number().int().positive(),
    targetCelsius: z.number().min(5).max(35),
    pathwayLightingIntensityPercent: z.number().int().min(0).max(100),
    pathwayLightingDurationSeconds: z.number().int().min(1).max(86_400),
  })
  .strict()

export const IdentityTagSchema = z
  .object({
    id: IdentityTagIdSchema,
    organizationId: OrganizationIdSchema,
    crewMemberId: CrewMemberIdSchema.nullable(),
    label: z.string().min(1).max(120),
    verified: z.boolean(),
    active: z.boolean(),
    version: z.number().int().positive(),
  })
  .strict()

export const DeviceKindSchema = z.enum([
  'lock',
  'service_hatch_lock',
  'residential_hatch_lock',
  'pathway_light',
  'thermostat',
  'battery_meter',
])
export const DeviceHealthSchema = z.enum(['online', 'degraded', 'offline'])

export const DeviceSchema = z
  .object({
    id: DeviceIdSchema,
    organizationId: OrganizationIdSchema,
    palaceId: PalaceIdSchema,
    kind: DeviceKindSchema,
    name: z.string().min(1).max(120),
    health: DeviceHealthSchema,
    version: z.number().int().positive(),
  })
  .strict()

export const CapabilityKindSchema = z.enum([
  'lock_desired_state',
  'pathway_lighting',
  'temperature_target',
  'battery_projection',
  'service_hatch_access',
  'residential_hatch_lock_state',
])

export const CapabilitySchema = z
  .object({
    id: CapabilityIdSchema,
    organizationId: OrganizationIdSchema,
    deviceId: DeviceIdSchema,
    kind: CapabilityKindSchema,
    enabled: z.boolean(),
    constraints: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  })
  .strict()

export type Organization = z.infer<typeof OrganizationSchema>
export type User = z.infer<typeof UserSchema>
export type Palace = z.infer<typeof PalaceSchema>
export type CrewMember = z.infer<typeof CrewMemberSchema>
export type CrewSchedule = z.infer<typeof CrewScheduleSchema>
export type CrewPreference = z.infer<typeof CrewPreferenceSchema>
export type IdentityTag = z.infer<typeof IdentityTagSchema>
export type Device = z.infer<typeof DeviceSchema>
export type Capability = z.infer<typeof CapabilitySchema>

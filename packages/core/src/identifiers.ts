import { z } from 'zod'

const ID_BODY = '[a-z0-9][a-z0-9_-]{7,63}'

function idSchema<const Brand extends string>(prefix: string, _brand: Brand) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${ID_BODY}$`), `Expected a ${prefix}_ identifier`)
    .brand<Brand>()
}

export const OrganizationIdSchema = idSchema('org', 'OrganizationId')
export const UserIdSchema = idSchema('usr', 'UserId')
export const MembershipIdSchema = idSchema('mem', 'MembershipId')
export const PalaceIdSchema = idSchema('pal', 'PalaceId')
export const CrewMemberIdSchema = idSchema('crew', 'CrewMemberId')
export const CrewScheduleIdSchema = idSchema('sch', 'CrewScheduleId')
export const CrewPreferenceIdSchema = idSchema('pref', 'CrewPreferenceId')
export const IdentityTagIdSchema = idSchema('tag', 'IdentityTagId')
export const DeviceIdSchema = idSchema('dev', 'DeviceId')
export const CapabilityIdSchema = idSchema('cap', 'CapabilityId')
export const RoutineIdSchema = idSchema('rtn', 'RoutineId')
export const RoutineVersionIdSchema = idSchema('rtv', 'RoutineVersionId')
export const MissionIdSchema = idSchema('mis', 'MissionId')
export const MissionEventIdSchema = idSchema('mev', 'MissionEventId')
export const ClarificationRequestIdSchema = idSchema('clr', 'ClarificationRequestId')
export const ClarificationAnswerIdSchema = idSchema('cla', 'ClarificationAnswerId')
export const RunIdSchema = idSchema('run', 'RunId')
export const PlanIdSchema = idSchema('pln', 'PlanId')
export const PlanActionIdSchema = idSchema('act', 'PlanActionId')
export const ApprovalIdSchema = idSchema('apr', 'ApprovalId')
export const OperationIdSchema = idSchema('op', 'OperationId')
export const AttemptIdSchema = idSchema('att', 'AttemptId')
export const ExecutionIdSchema = idSchema('exe', 'ExecutionId')
export const EvidenceIdSchema = idSchema('evd', 'EvidenceId')
export const VerificationIdSchema = idSchema('ver', 'VerificationId')
export const ContextReceiptIdSchema = idSchema('ctx', 'ContextReceiptId')
export const EventIdSchema = idSchema('evt', 'EventId')
export const ToolCallIdSchema = idSchema('call', 'ToolCallId')
export const ReceiptIdSchema = idSchema('rcp', 'ReceiptId')
export const GatewayCommandIdSchema = idSchema('gcmd', 'GatewayCommandId')
export const GatewayCallbackIdSchema = idSchema('gcb', 'GatewayCallbackId')
export const AnalyticsSessionIdSchema = idSchema('ais', 'AnalyticsSessionId')
export const AnalyticsTraceIdSchema = idSchema('ait', 'AnalyticsTraceId')

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 digest')
  .brand<'Sha256'>()

export const IsoDateTimeSchema = z.iso.datetime({ offset: true })
export const TimeOfDaySchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM in 24-hour time')

export type OrganizationId = z.infer<typeof OrganizationIdSchema>
export type UserId = z.infer<typeof UserIdSchema>
export type MembershipId = z.infer<typeof MembershipIdSchema>
export type PalaceId = z.infer<typeof PalaceIdSchema>
export type CrewMemberId = z.infer<typeof CrewMemberIdSchema>
export type CrewScheduleId = z.infer<typeof CrewScheduleIdSchema>
export type CrewPreferenceId = z.infer<typeof CrewPreferenceIdSchema>
export type IdentityTagId = z.infer<typeof IdentityTagIdSchema>
export type DeviceId = z.infer<typeof DeviceIdSchema>
export type CapabilityId = z.infer<typeof CapabilityIdSchema>
export type RoutineId = z.infer<typeof RoutineIdSchema>
export type RoutineVersionId = z.infer<typeof RoutineVersionIdSchema>
export type MissionId = z.infer<typeof MissionIdSchema>
export type MissionEventId = z.infer<typeof MissionEventIdSchema>
export type ClarificationRequestId = z.infer<typeof ClarificationRequestIdSchema>
export type ClarificationAnswerId = z.infer<typeof ClarificationAnswerIdSchema>
export type RunId = z.infer<typeof RunIdSchema>
export type PlanId = z.infer<typeof PlanIdSchema>
export type PlanActionId = z.infer<typeof PlanActionIdSchema>
export type ApprovalId = z.infer<typeof ApprovalIdSchema>
export type OperationId = z.infer<typeof OperationIdSchema>
export type AttemptId = z.infer<typeof AttemptIdSchema>
export type ExecutionId = z.infer<typeof ExecutionIdSchema>
export type EvidenceId = z.infer<typeof EvidenceIdSchema>
export type VerificationId = z.infer<typeof VerificationIdSchema>
export type ContextReceiptId = z.infer<typeof ContextReceiptIdSchema>
export type EventId = z.infer<typeof EventIdSchema>
export type ToolCallId = z.infer<typeof ToolCallIdSchema>
export type ReceiptId = z.infer<typeof ReceiptIdSchema>
export type GatewayCommandId = z.infer<typeof GatewayCommandIdSchema>
export type GatewayCallbackId = z.infer<typeof GatewayCallbackIdSchema>
export type AnalyticsSessionId = z.infer<typeof AnalyticsSessionIdSchema>
export type AnalyticsTraceId = z.infer<typeof AnalyticsTraceIdSchema>
export type Sha256 = z.infer<typeof Sha256Schema>

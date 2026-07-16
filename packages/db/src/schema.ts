import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

import type {
  ContextBundle,
  ContextRequest,
  InternalContextReceipt,
  KnowledgeManifest,
  PublicContextReceipt,
} from '@trash-palace/agent'

import type {
  CaretakerEvidenceProfile,
  CaretakerPendingToolCall,
  CaretakerRunCheckpointKind,
  CaretakerRunStatus,
  CaretakerTaskLedger,
  CaretakerTerminalEvidenceEnvelope,
} from '@trash-palace/application'

import type {
  ClarificationChoice,
  ContextSourceReceipt,
  Evidence,
  Mission,
  OperationOutcome,
  PersistedEvidenceRecord,
  PlanAction,
  ProtectedResourceVersion,
  RoutineDefinition,
  ToolCallReceipt,
  ToolResultEnvelope,
  VerificationAssertion,
} from '@trash-palace/core'

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
})

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export type RichContextArtifactPayload =
  ContextBundle | ContextRequest | InternalContextReceipt | KnowledgeManifest | PublicContextReceipt

export const membershipRoleEnum = pgEnum('membership_role', ['owner', 'operator', 'viewer'])
export const connectorProviderEnum = pgEnum('connector_provider', ['smartthings'])
export const deviceKindEnum = pgEnum('device_kind', [
  'lock',
  'service_hatch_lock',
  'residential_hatch_lock',
  'pathway_light',
  'thermostat',
  'battery_meter',
])
export const deviceHealthEnum = pgEnum('device_health', ['online', 'degraded', 'offline'])
export const capabilityKindEnum = pgEnum('capability_kind', [
  'lock_desired_state',
  'service_hatch_access',
  'residential_hatch_lock_state',
  'pathway_lighting',
  'temperature_target',
  'battery_projection',
])
export const routineStatusEnum = pgEnum('routine_status', [
  'draft',
  'active',
  'inactive',
  'archived',
])
export const missionStatusEnum = pgEnum('mission_status', [
  'queued',
  'running',
  'waiting_for_user',
  'waiting_for_system',
  'succeeded',
  'failed',
  'cancelled',
])
export const missionProgramKindEnum = pgEnum('mission_program_kind', [
  'night_shift_homecoming',
  'scheduled_hauler_access',
])
export const missionPhaseEnum = pgEnum('mission_phase', [
  'understand',
  'plan',
  'validate',
  'approve',
  'execute',
  'reconcile',
  'observe',
  'verify',
])
export const missionTransitionEventEnum = pgEnum('mission_transition_event', [
  'lease_acquired',
  'context_sufficient',
  'material_ambiguity',
  'clarification_answered',
  'user_response_expired',
  'candidate_persisted',
  'validation_failed',
  'validation_passed',
  'approval_rejected',
  'approval_expired_or_stale',
  'approval_granted',
  'execution_committed',
  'execution_unknown',
  'execution_non_retryable_failure',
  'reconcile_commit_found',
  'reconcile_absent_retryable',
  'reconcile_budget_exhausted',
  'reconcile_retry_authorized',
  'reconcile_stopped',
  'evidence_arrived',
  'observation_deadline_expired',
  'verification_passed',
  'safe_correction_available',
  'intervention_required',
  'corrective_work_requested',
  'terminal_result_acknowledged',
  'lease_lost',
  'cancel_requested',
  'cancel_reconciliation_required',
  'cancel_reconciliation_completed',
])
export const clarificationStatusEnum = pgEnum('clarification_status', ['pending', 'answered'])
export const caretakerRunStatusEnum = pgEnum('caretaker_run_status', [
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'abandoned',
])
export const caretakerRunCheckpointKindEnum = pgEnum('caretaker_run_checkpoint_kind', [
  'activated',
  'state_persisted',
  'decision_attempt',
  'tool_call',
  'tool_wait',
  'plan_revision',
  'clarification_pause',
  'approval_pause',
  'human_review_pause',
  'reconciliation_poll',
  'external_wait',
  'budget_exhausted',
  'completed',
  'failed',
  'safe_refusal',
  'host_failed',
  'cancelled',
  'lease_replaced',
])
export const caretakerEvidenceDeliveryStatusEnum = pgEnum('caretaker_evidence_delivery_status', [
  'pending',
  'delivered',
])
export const caretakerEvidenceCaptureStatusEnum = pgEnum('caretaker_evidence_capture_status', [
  'stored',
  'duplicate',
])
export const productEvidenceDeliveryStatusEnum = pgEnum('product_evidence_delivery_status', [
  'pending',
  'delivered',
])
export const productEvidenceCaptureStatusEnum = pgEnum('product_evidence_capture_status', [
  'stored',
  'duplicate',
])
export const planStatusEnum = pgEnum('plan_status', [
  'candidate',
  'validated',
  'awaiting_approval',
  'approved',
  'superseded',
  'rejected',
])
export const planActionTypeEnum = pgEnum('plan_action_type', [
  'replace_homecoming_routine',
  'replace_scheduled_hauler_access_routine',
  'restore_routine_version',
])
export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
  'invalidated',
])
export const operationStatusEnum = pgEnum('operation_status', [
  'pending',
  'claimed',
  'committed',
  'failed',
  'cancelled',
])
export const attemptTransportEnum = pgEnum('attempt_transport', [
  'http',
  'mcp',
  'worker',
  'gateway',
])
export const attemptStatusEnum = pgEnum('attempt_status', [
  'pending',
  'succeeded',
  'unknown',
  'failed',
])
export const outboxStatusEnum = pgEnum('outbox_status', [
  'pending',
  'claimed',
  'dispatched',
  'cancelled',
])
export const outboxTopicEnum = pgEnum('outbox_topic', [
  'gateway.dispatch',
  'gateway.effect.reconcile',
  'execution.deadline',
  'execution.identity-arrival',
  'mission.resume',
  'mission.verify',
  'operation.reconcile',
])
export const gatewayCommandAuthorizationKindEnum = pgEnum('gateway_command_authorization_kind', [
  'mission_lease',
  'manual_activation',
])
export const gatewayDispatchStatusEnum = pgEnum('gateway_dispatch_status', [
  'pending',
  'dispatching',
  'accepted',
  'unknown',
  'failed',
  'cancelled',
])
export const gatewayDispatchUnknownReasonEnum = pgEnum('gateway_dispatch_unknown_reason', [
  'timeout',
  'lost_ack',
])
export const gatewayEffectStatusEnum = pgEnum('gateway_effect_status', [
  'pending',
  'acknowledged',
  'executing',
  'completed',
  'failed',
])
export const gatewayEffectCancellationPolicyEnum = pgEnum('gateway_effect_cancellation_policy', [
  'cancel_if_pending',
  'mandatory_relock',
])
export const gatewayCommandKindEnum = pgEnum('gateway_command_kind', [
  'set_temperature',
  'set_lighting',
  'unlock',
  'locked_desired_state',
])
export const gatewayCallbackStatusEnum = pgEnum('gateway_callback_status', [
  'acknowledged',
  'executing',
  'completed',
  'failed',
])
export const executionStatusEnum = pgEnum('execution_status', [
  'scheduled',
  'running',
  'observed',
  'failed',
])
export const executionMilestoneNameEnum = pgEnum('execution_milestone_name', [
  'preheat',
  'verified_arrival',
  'pathway_lighting',
  'unlock',
  'relock',
  'access_window',
  'verified_hauler_identity',
  'service_hatch_unlock',
  'service_hatch_relock',
  'residential_hatch_guard',
])
export const executionMilestoneStatusEnum = pgEnum('execution_milestone_status', [
  'pending',
  'completed',
  'failed',
])
export const evidenceAuthorityEnum = pgEnum('evidence_authority', [
  'identity_telemetry',
  'gateway_callback',
  'application',
])
export const evidenceTypeEnum = pgEnum('evidence_type', [
  'identity_arrival',
  'device_command',
  'temperature_observation',
  'lighting_observation',
  'lock_observation',
  'battery_projection',
  'routine_state',
  'tenant_access_audit',
  'operation_transport',
  'gateway_delivery',
  'tool_invocation_reconciliation',
])
export const verificationStatusEnum = pgEnum('verification_status', ['passed', 'failed'])
export const cancellationCheckpointEnum = pgEnum('cancellation_checkpoint', [
  'before_operation',
  'unclaimed_operation',
  'claimed_or_committed',
  'gateway_dispatched',
  'durable_effect',
])
export const cancellationOutcomeEnum = pgEnum('cancellation_outcome', [
  'cancelled_without_mutation',
  'cancelled_unclaimed_operations',
  'stopped_remaining_actions',
  'reconcile_dispatched_effect',
  'compensating_plan_required',
])
export const reconciliationResolutionEnum = pgEnum('reconciliation_resolution', [
  'committed',
  'definitely_absent',
  'still_unknown',
  'failed',
])
export const gatewayEffectReconciliationResolutionEnum = pgEnum(
  'gateway_effect_reconciliation_resolution',
  ['waiting', 'retry_authorized', 'terminal_found', 'budget_exhausted', 'escalated'],
)
export const contextArtifactKindEnum = pgEnum('context_artifact_kind', [
  'request',
  'bundle',
  'manifest',
  'internal_receipt',
  'public_receipt',
])
export const toolInvocationStatusEnum = pgEnum('tool_invocation_status', ['claimed', 'completed'])
export const toolInvocationExecutionClassEnum = pgEnum('tool_invocation_execution_class', [
  'read',
  'write_idempotent',
  'non_idempotent',
  'consequential',
])
export const toolInvocationDispositionEnum = pgEnum('tool_invocation_disposition', [
  'execute',
  'resolve_unknown',
])

export const organizations = pgTable(
  'organizations',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    labTenant: boolean('lab_tenant').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    unique('organizations_slug_unique').on(table.slug),
    check('organizations_id_format', sql`${table.id} ~ '^org_[a-z0-9][a-z0-9_-]{7,63}$'`),
  ],
)

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name').notNull(),
    ...timestamps,
  },
  (table) => [check('users_id_format', sql`${table.id} ~ '^usr_[a-z0-9][a-z0-9_-]{7,63}$'`)],
)

export const memberships = pgTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: membershipRoleEnum('role').notNull(),
    grants: text('grants')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('memberships_organization_id_id_unique').on(table.organizationId, table.id),
    unique('memberships_organization_id_user_id_unique').on(
      table.organizationId,
      table.id,
      table.userId,
    ),
    unique('memberships_organization_user_unique').on(table.organizationId, table.userId),
    index('memberships_user_idx').on(table.userId),
    check('memberships_id_format', sql`${table.id} ~ '^mem_[a-z0-9][a-z0-9_-]{7,63}$'`),
    check(
      'memberships_grants_valid',
      sql`(${table.role} = 'operator' AND ${table.grants} <@ ARRAY['routine:approve']::text[]) OR cardinality(${table.grants}) = 0`,
    ),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    membershipId: text('membership_id').notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    csrfSecretHash: char('csrf_secret_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('sessions_token_hash_unique').on(table.tokenHash),
    unique('sessions_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'sessions_membership_tenant_fk',
      columns: [table.organizationId, table.membershipId, table.userId],
      foreignColumns: [memberships.organizationId, memberships.id, memberships.userId],
    }),
    check('sessions_expiry_valid', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'sessions_lifecycle_timestamps_valid',
      sql`(${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}) AND (${table.lastSeenAt} IS NULL OR ${table.lastSeenAt} >= ${table.createdAt})`,
    ),
    check(
      'sessions_hashes_valid',
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$' AND ${table.csrfSecretHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
)

export const accessTokens = pgTable(
  'access_tokens',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    issuedBy: text('issued_by')
      .notNull()
      .references(() => users.id),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    scopes: text('scopes').array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('access_tokens_token_hash_unique').on(table.tokenHash),
    unique('access_tokens_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'access_tokens_issuer_tenant_fk',
      columns: [table.organizationId, table.issuedBy],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    check('access_tokens_expiry_valid', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'access_tokens_lifecycle_timestamps_valid',
      sql`(${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}) AND (${table.lastUsedAt} IS NULL OR ${table.lastUsedAt} >= ${table.createdAt})`,
    ),
    check('access_tokens_hash_valid', sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`),
    check('access_tokens_scopes_present', sql`cardinality(${table.scopes}) > 0`),
    check(
      'access_tokens_scopes_delegated_only',
      sql`${table.scopes} <@ ARRAY['palace:read', 'crew:read', 'capability:read', 'routine:read', 'routine:draft', 'routine:validate', 'routine:simulate', 'routine:activate', 'recovery:propose', 'operation:reconcile', 'verification:read', 'knowledge:read', 'mission:cancel']::text[]`,
    ),
    check('access_tokens_scopes_unique', sql`text_array_is_unique(${table.scopes})`),
  ],
)

export const palaces = pgTable(
  'palaces',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    batteryAvailablePercentage: doublePrecision('battery_available_percentage').notNull(),
    recordVersion: integer('record_version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique('palaces_organization_id_id_unique').on(table.organizationId, table.id),
    check(
      'palaces_battery_range',
      sql`${table.batteryAvailablePercentage} >= 0 AND ${table.batteryAvailablePercentage} <= 100`,
    ),
    check('palaces_record_version_positive', sql`${table.recordVersion} > 0`),
  ],
)

export const crewMembers = pgTable(
  'crew_members',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    palaceId: text('palace_id').notNull(),
    userId: text('user_id').references(() => users.id),
    displayName: text('display_name').notNull(),
    active: boolean('active').notNull(),
    recordVersion: integer('record_version').notNull().default(1),
  },
  (table) => [
    unique('crew_members_organization_id_id_unique').on(table.organizationId, table.id),
    unique('crew_members_tenant_id_palace_unique').on(
      table.organizationId,
      table.id,
      table.palaceId,
    ),
    foreignKey({
      name: 'crew_members_palace_tenant_fk',
      columns: [table.organizationId, table.palaceId],
      foreignColumns: [palaces.organizationId, palaces.id],
    }),
    foreignKey({
      name: 'crew_members_user_tenant_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    check('crew_members_record_version_positive', sql`${table.recordVersion} > 0`),
  ],
)

export const crewSchedules = pgTable(
  'crew_schedules',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    palaceId: text('palace_id').notNull(),
    crewMemberId: text('crew_member_id').notNull(),
    active: boolean('active').notNull(),
    version: integer('version').notNull(),
    timezone: text('timezone').notNull(),
    windowStart: text('window_start').notNull(),
    windowEnd: text('window_end').notNull(),
  },
  (table) => [
    unique('crew_schedules_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'crew_schedules_palace_tenant_fk',
      columns: [table.organizationId, table.palaceId],
      foreignColumns: [palaces.organizationId, palaces.id],
    }),
    foreignKey({
      name: 'crew_schedules_crew_palace_tenant_fk',
      columns: [table.organizationId, table.crewMemberId, table.palaceId],
      foreignColumns: [crewMembers.organizationId, crewMembers.id, crewMembers.palaceId],
    }),
    check('crew_schedules_version_positive', sql`${table.version} > 0`),
    check('crew_schedules_timezone_length', sql`char_length(${table.timezone}) BETWEEN 1 AND 64`),
    check(
      'crew_schedules_windows_valid',
      sql`${table.windowStart} ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' AND ${table.windowEnd} ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' AND ${table.windowStart} <> ${table.windowEnd}`,
    ),
  ],
)

export const crewPreferences = pgTable(
  'crew_preferences',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    palaceId: text('palace_id').notNull(),
    crewMemberId: text('crew_member_id').notNull(),
    kind: text('kind').notNull(),
    active: boolean('active').notNull(),
    version: integer('version').notNull(),
    targetCelsius: doublePrecision('target_celsius').notNull(),
    pathwayLightingIntensityPercent: integer('pathway_lighting_intensity_percent').notNull(),
    pathwayLightingDurationSeconds: integer('pathway_lighting_duration_seconds').notNull(),
  },
  (table) => [
    unique('crew_preferences_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'crew_preferences_palace_tenant_fk',
      columns: [table.organizationId, table.palaceId],
      foreignColumns: [palaces.organizationId, palaces.id],
    }),
    foreignKey({
      name: 'crew_preferences_crew_palace_tenant_fk',
      columns: [table.organizationId, table.crewMemberId, table.palaceId],
      foreignColumns: [crewMembers.organizationId, crewMembers.id, crewMembers.palaceId],
    }),
    check('crew_preferences_kind_valid', sql`${table.kind} = 'homecoming_comfort'`),
    check('crew_preferences_version_positive', sql`${table.version} > 0`),
    check(
      'crew_preferences_target_range',
      sql`${table.targetCelsius} >= 5 AND ${table.targetCelsius} <= 35`,
    ),
    check(
      'crew_preferences_lighting_intensity_range',
      sql`${table.pathwayLightingIntensityPercent} >= 0 AND ${table.pathwayLightingIntensityPercent} <= 100`,
    ),
    check(
      'crew_preferences_lighting_duration_range',
      sql`${table.pathwayLightingDurationSeconds} >= 1 AND ${table.pathwayLightingDurationSeconds} <= 86400`,
    ),
  ],
)

export const identityTags = pgTable(
  'identity_tags',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    crewMemberId: text('crew_member_id'),
    label: text('label').notNull(),
    verified: boolean('verified').notNull(),
    active: boolean('active').notNull(),
    version: integer('version').notNull(),
  },
  (table) => [
    unique('identity_tags_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'identity_tags_crew_tenant_fk',
      columns: [table.organizationId, table.crewMemberId],
      foreignColumns: [crewMembers.organizationId, crewMembers.id],
    }),
    check('identity_tags_version_positive', sql`${table.version} > 0`),
  ],
)

export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    palaceId: text('palace_id').notNull(),
    kind: deviceKindEnum('kind').notNull(),
    name: text('name').notNull(),
    health: deviceHealthEnum('health').notNull(),
    version: integer('version').notNull(),
  },
  (table) => [
    unique('devices_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'devices_palace_tenant_fk',
      columns: [table.organizationId, table.palaceId],
      foreignColumns: [palaces.organizationId, palaces.id],
    }),
    check('devices_version_positive', sql`${table.version} > 0`),
  ],
)

export const capabilities = pgTable(
  'capabilities',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    deviceId: text('device_id').notNull(),
    kind: capabilityKindEnum('kind').notNull(),
    enabled: boolean('enabled').notNull(),
    constraints: jsonb('constraints').$type<Record<string, string | number | boolean>>().notNull(),
    recordVersion: integer('record_version').notNull().default(1),
  },
  (table) => [
    unique('capabilities_organization_id_id_unique').on(table.organizationId, table.id),
    unique('capabilities_device_kind_unique').on(table.organizationId, table.deviceId, table.kind),
    foreignKey({
      name: 'capabilities_device_tenant_fk',
      columns: [table.organizationId, table.deviceId],
      foreignColumns: [devices.organizationId, devices.id],
    }),
    check('capabilities_record_version_positive', sql`${table.recordVersion} > 0`),
  ],
)

export const routines = pgTable(
  'routines',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    palaceId: text('palace_id').notNull(),
    name: text('name').notNull(),
    activeVersionId: text('active_version_id'),
    recordVersion: integer('record_version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique('routines_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'routines_palace_tenant_fk',
      columns: [table.organizationId, table.palaceId],
      foreignColumns: [palaces.organizationId, palaces.id],
    }),
    check('routines_record_version_positive', sql`${table.recordVersion} > 0`),
  ],
)

export const routineVersions = pgTable(
  'routine_versions',
  {
    id: text('id').primaryKey(),
    routineId: text('routine_id').notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    version: integer('version').notNull(),
    status: routineStatusEnum('status').notNull(),
    definition: jsonb('definition').$type<RoutineDefinition>().notNull(),
    sourcePlanId: text('source_plan_id'),
    sourcePlanHash: char('source_plan_hash', { length: 64 }),
    ...timestamps,
  },
  (table) => [
    unique('routine_versions_organization_id_id_unique').on(table.organizationId, table.id),
    unique('routine_versions_tenant_routine_id_unique').on(
      table.organizationId,
      table.routineId,
      table.id,
    ),
    unique('routine_versions_routine_version_unique').on(
      table.organizationId,
      table.routineId,
      table.version,
    ),
    unique('routine_versions_tenant_routine_id_version_unique').on(
      table.organizationId,
      table.routineId,
      table.id,
      table.version,
    ),
    foreignKey({
      name: 'routine_versions_routine_tenant_fk',
      columns: [table.organizationId, table.routineId],
      foreignColumns: [routines.organizationId, routines.id],
    }),
    check('routine_versions_version_positive', sql`${table.version} > 0`),
    check(
      'routine_versions_source_pair',
      sql`(${table.sourcePlanId} IS NULL) = (${table.sourcePlanHash} IS NULL)`,
    ),
    check(
      'routine_versions_source_hash_valid',
      sql`${table.sourcePlanHash} IS NULL OR ${table.sourcePlanHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
)

export const connectorOAuthStates = pgTable(
  'connector_oauth_states',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    provider: connectorProviderEnum('provider').notNull(),
    sessionBindingHash: char('session_binding_hash', { length: 64 }).notNull(),
    stateDigest: char('state_digest', { length: 64 }).notNull(),
    redirectUri: text('redirect_uri').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.provider, table.stateDigest] }),
    check('connector_oauth_state_digest_valid', sql`${table.stateDigest} ~ '^[a-f0-9]{64}$'`),
    check(
      'connector_oauth_session_binding_hash_valid',
      sql`${table.sessionBindingHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
)

export const connectorCredentials = pgTable(
  'connector_credentials',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    provider: connectorProviderEnum('provider').notNull(),
    accessTokenCiphertext: bytea('access_token_ciphertext').notNull(),
    accessTokenNonce: bytea('access_token_nonce').notNull(),
    accessTokenTag: bytea('access_token_tag').notNull(),
    refreshTokenCiphertext: bytea('refresh_token_ciphertext').notNull(),
    refreshTokenNonce: bytea('refresh_token_nonce').notNull(),
    refreshTokenTag: bytea('refresh_token_tag').notNull(),
    installedAppIdCiphertext: bytea('installed_app_id_ciphertext').notNull(),
    installedAppIdNonce: bytea('installed_app_id_nonce').notNull(),
    installedAppIdTag: bytea('installed_app_id_tag').notNull(),
    installedAppIdDigest: char('installed_app_id_digest', { length: 64 }).notNull(),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }).notNull(),
    scopes: text('scopes').array().notNull(),
    revision: integer('revision').notNull().default(1),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.provider] }),
    unique('connector_credentials_installation_unique').on(
      table.provider,
      table.installedAppIdDigest,
    ),
    check('connector_credentials_revision_positive', sql`${table.revision} > 0`),
    check(
      'connector_credentials_installation_digest_valid',
      sql`${table.installedAppIdDigest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
)

export const connectorDeviceCandidates = pgTable(
  'connector_device_candidates',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    provider: connectorProviderEnum('provider').notNull(),
    candidateId: text('candidate_id').notNull(),
    providerDeviceIdCiphertext: bytea('provider_device_id_ciphertext').notNull(),
    providerDeviceIdNonce: bytea('provider_device_id_nonce').notNull(),
    providerDeviceIdTag: bytea('provider_device_id_tag').notNull(),
    providerDeviceIdDigest: char('provider_device_id_digest', { length: 64 }).notNull(),
    providerComponentIdCiphertext: bytea('provider_component_id_ciphertext').notNull(),
    providerComponentIdNonce: bytea('provider_component_id_nonce').notNull(),
    providerComponentIdTag: bytea('provider_component_id_tag').notNull(),
    providerComponentIdDigest: char('provider_component_id_digest', { length: 64 }).notNull(),
    capabilities: text('capabilities').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.provider, table.candidateId] }),
    unique('connector_candidates_provider_identity_unique').on(
      table.organizationId,
      table.provider,
      table.providerDeviceIdDigest,
      table.providerComponentIdDigest,
    ),
  ],
)

export const connectorDeviceMappings = pgTable(
  'connector_device_mappings',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    provider: connectorProviderEnum('provider').notNull(),
    slotId: text('slot_id').notNull(),
    candidateId: text('candidate_id').notNull(),
    displayName: text('display_name').notNull(),
    kind: text('kind').notNull(),
    capabilities: text('capabilities').array().notNull(),
    confirmedBy: text('confirmed_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.provider, table.slotId] }),
    foreignKey({
      name: 'connector_device_mappings_candidate_fk',
      columns: [table.organizationId, table.provider, table.candidateId],
      foreignColumns: [
        connectorDeviceCandidates.organizationId,
        connectorDeviceCandidates.provider,
        connectorDeviceCandidates.candidateId,
      ],
    }),
    check('connector_device_mappings_confirmed_by', sql`${table.confirmedBy} = 'human'`),
  ],
)

export const missions = pgTable(
  'missions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    palaceId: text('palace_id').notNull(),
    initiatedBy: text('initiated_by')
      .notNull()
      .references(() => users.id),
    programKind: missionProgramKindEnum('program_kind').notNull().default('night_shift_homecoming'),
    objective: text('objective').notNull(),
    constraints: jsonb('constraints').$type<Mission['constraints']>().notNull(),
    successCriteriaIds: text('success_criteria_ids').array().notNull(),
    status: missionStatusEnum('status').notNull(),
    phase: missionPhaseEnum('phase').notNull(),
    version: integer('version').notNull().default(0),
    runId: text('run_id'),
    contextReceiptId: text('context_receipt_id'),
    taskLedger: jsonb('task_ledger').$type<Mission['taskLedger']>().notNull(),
    taskLedgerVersion: integer('task_ledger_version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('missions_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'missions_palace_tenant_fk',
      columns: [table.organizationId, table.palaceId],
      foreignColumns: [palaces.organizationId, palaces.id],
    }),
    foreignKey({
      name: 'missions_initiator_tenant_fk',
      columns: [table.organizationId, table.initiatedBy],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    check('missions_version_nonnegative', sql`${table.version} >= 0`),
    check('missions_task_ledger_version_nonnegative', sql`${table.taskLedgerVersion} >= 0`),
    check('missions_task_ledger_valid', sql`caretaker_task_ledger_is_valid(${table.taskLedger})`),
    check('missions_success_criteria_present', sql`cardinality(${table.successCriteriaIds}) > 0`),
  ],
)

export const missionEvents = pgTable(
  'mission_events',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    sequence: integer('sequence').notNull(),
    event: missionTransitionEventEnum('event').notNull(),
    fromStatus: missionStatusEnum('from_status').notNull(),
    fromPhase: missionPhaseEnum('from_phase').notNull(),
    toStatus: missionStatusEnum('to_status').notNull(),
    toPhase: missionPhaseEnum('to_phase').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('mission_events_organization_id_id_unique').on(table.organizationId, table.id),
    unique('mission_events_mission_sequence_unique').on(
      table.organizationId,
      table.missionId,
      table.sequence,
    ),
    foreignKey({
      name: 'mission_events_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    check('mission_events_sequence_nonnegative', sql`${table.sequence} >= 0`),
  ],
)

export const clarificationRequests = pgTable(
  'clarification_requests',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    idempotencyKey: char('idempotency_key', { length: 64 }).notNull(),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    question: text('question').notNull(),
    choices: jsonb('choices').$type<ClarificationChoice[]>().notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    requestedBy: text('requested_by').notNull(),
    status: clarificationStatusEnum('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    unique('clarification_requests_organization_id_id_unique').on(table.organizationId, table.id),
    unique('clarification_requests_tenant_mission_id_unique').on(
      table.organizationId,
      table.missionId,
      table.id,
    ),
    unique('clarification_requests_idempotency_unique').on(
      table.organizationId,
      table.idempotencyKey,
    ),
    uniqueIndex('clarification_requests_one_pending_per_mission')
      .on(table.organizationId, table.missionId)
      .where(sql`${table.status} = 'pending'`),
    foreignKey({
      name: 'clarification_requests_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    foreignKey({
      name: 'clarification_requests_requester_tenant_fk',
      columns: [table.organizationId, table.requestedBy],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    check('clarification_requests_id_format', sql`${table.id} ~ '^clr_[a-z0-9][a-z0-9_-]{7,63}$'`),
    check(
      'clarification_requests_hashes_valid',
      sql`${table.idempotencyKey} ~ '^[a-f0-9]{64}$' AND ${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'clarification_requests_payload_valid',
      sql`clarification_request_payload_is_valid(${table.question}, ${table.choices}, ${table.evidenceRefs})`,
    ),
    check(
      'clarification_requests_resolution_shape',
      sql`(${table.status} = 'pending' AND ${table.resolvedAt} IS NULL) OR (${table.status} = 'answered' AND ${table.resolvedAt} IS NOT NULL AND ${table.resolvedAt} >= ${table.requestedAt})`,
    ),
  ],
)

export const clarificationAnswers = pgTable(
  'clarification_answers',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    requestId: text('request_id').notNull(),
    idempotencyKey: char('idempotency_key', { length: 64 }).notNull(),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    choiceId: text('choice_id').notNull(),
    answeredBy: text('answered_by').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('clarification_answers_organization_id_id_unique').on(table.organizationId, table.id),
    unique('clarification_answers_request_unique').on(table.organizationId, table.requestId),
    unique('clarification_answers_idempotency_unique').on(
      table.organizationId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: 'clarification_answers_request_tenant_fk',
      columns: [table.organizationId, table.missionId, table.requestId],
      foreignColumns: [
        clarificationRequests.organizationId,
        clarificationRequests.missionId,
        clarificationRequests.id,
      ],
    }),
    foreignKey({
      name: 'clarification_answers_answerer_tenant_fk',
      columns: [table.organizationId, table.answeredBy],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    check('clarification_answers_id_format', sql`${table.id} ~ '^cla_[a-z0-9][a-z0-9_-]{7,63}$'`),
    check(
      'clarification_answers_hashes_valid',
      sql`${table.idempotencyKey} ~ '^[a-f0-9]{64}$' AND ${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'clarification_answers_choice_id_valid',
      sql`${table.choiceId} ~ '^[a-z][a-z0-9_-]{2,39}$'`,
    ),
    check(
      'clarification_answers_evidence_refs_valid',
      sql`clarification_evidence_refs_are_valid(${table.evidenceRefs})`,
    ),
  ],
)

export const missionLeases = pgTable(
  'mission_leases',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    ownerId: text('owner_id').notNull(),
    epoch: integer('epoch').notNull(),
    tokenFingerprint: char('token_fingerprint', { length: 64 }).notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    renewedAt: timestamp('renewed_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    recordVersion: integer('record_version').notNull().default(1),
  },
  (table) => [
    primaryKey({ name: 'mission_leases_pk', columns: [table.organizationId, table.missionId] }),
    foreignKey({
      name: 'mission_leases_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    check('mission_leases_expiry_valid', sql`${table.expiresAt} > ${table.renewedAt}`),
    check('mission_leases_epoch_positive', sql`${table.epoch} > 0`),
    check(
      'mission_leases_release_valid',
      sql`${table.releasedAt} IS NULL OR ${table.releasedAt} >= ${table.acquiredAt}`,
    ),
    check('mission_leases_record_version_positive', sql`${table.recordVersion} > 0`),
  ],
)

export const caretakerRuns = pgTable(
  'caretaker_runs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    leaseEpoch: integer('lease_epoch').notNull(),
    status: caretakerRunStatusEnum('status').$type<CaretakerRunStatus>().notNull(),
    phase: missionPhaseEnum('phase').notNull(),
    version: integer('version').notNull().default(0),
    taskLedgerVersion: integer('task_ledger_version').notNull(),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    planRevisionCount: integer('plan_revision_count').notNull().default(0),
    clarificationPauseCount: integer('clarification_pause_count').notNull().default(0),
    reconciliationPollCount: integer('reconciliation_poll_count').notNull().default(0),
    activeRuntimeMilliseconds: integer('active_runtime_milliseconds').notNull().default(0),
    pendingToolCall: jsonb('pending_tool_call').$type<CaretakerPendingToolCall>(),
    evidenceProfile: jsonb('evidence_profile').$type<CaretakerEvidenceProfile>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    unique('caretaker_runs_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('caretaker_runs_one_active_per_mission')
      .on(table.organizationId, table.missionId)
      .where(sql`${table.status} = 'active'`),
    foreignKey({
      name: 'caretaker_runs_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    check('caretaker_runs_id_format', sql`${table.id} ~ '^run_[a-z0-9][a-z0-9_-]{7,63}$'`),
    check('caretaker_runs_lease_epoch_positive', sql`${table.leaseEpoch} > 0`),
    check('caretaker_runs_version_nonnegative', sql`${table.version} >= 0`),
    check('caretaker_runs_task_ledger_version_nonnegative', sql`${table.taskLedgerVersion} >= 0`),
    check(
      'caretaker_runs_tool_call_budget',
      sql`${table.toolCallCount} >= 0 AND ${table.toolCallCount} <= 24`,
    ),
    check(
      'caretaker_runs_plan_revision_budget',
      sql`${table.planRevisionCount} >= 0 AND ${table.planRevisionCount} <= 3`,
    ),
    check(
      'caretaker_runs_clarification_pause_budget',
      sql`${table.clarificationPauseCount} >= 0 AND ${table.clarificationPauseCount} <= 2`,
    ),
    check(
      'caretaker_runs_reconciliation_poll_budget',
      sql`${table.reconciliationPollCount} >= 0 AND ${table.reconciliationPollCount} <= 3`,
    ),
    check(
      'caretaker_runs_active_runtime_budget',
      sql`${table.activeRuntimeMilliseconds} >= 0 AND ${table.activeRuntimeMilliseconds} <= 300000`,
    ),
    check(
      'caretaker_runs_pending_tool_call_valid',
      sql`caretaker_pending_tool_call_is_valid(${table.pendingToolCall})`,
    ),
    check(
      'caretaker_runs_terminal_timestamp',
      sql`(${table.status} = 'active' AND ${table.endedAt} IS NULL) OR (${table.status} <> 'active' AND ${table.endedAt} IS NOT NULL)`,
    ),
    check('caretaker_runs_time_order', sql`${table.updatedAt} >= ${table.startedAt}`),
    check(
      'caretaker_runs_end_time_order',
      sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`,
    ),
  ],
)

export const caretakerRunCheckpoints = pgTable(
  'caretaker_run_checkpoints',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    runId: text('run_id').notNull(),
    sequence: integer('sequence').notNull(),
    mutationKey: char('mutation_key', { length: 64 }).notNull(),
    mutationHash: char('mutation_hash', { length: 64 }).notNull(),
    kind: caretakerRunCheckpointKindEnum('kind').$type<CaretakerRunCheckpointKind>().notNull(),
    runStatus: caretakerRunStatusEnum('run_status').$type<CaretakerRunStatus>().notNull(),
    phase: missionPhaseEnum('phase').notNull(),
    runVersion: integer('run_version').notNull(),
    taskLedgerVersion: integer('task_ledger_version').notNull(),
    taskLedgerHash: char('task_ledger_hash', { length: 64 }).notNull(),
    taskLedger: jsonb('task_ledger').$type<CaretakerTaskLedger>().notNull(),
    toolCallCount: integer('tool_call_count').notNull(),
    planRevisionCount: integer('plan_revision_count').notNull(),
    clarificationPauseCount: integer('clarification_pause_count').notNull(),
    reconciliationPollCount: integer('reconciliation_poll_count').notNull(),
    activeRuntimeMilliseconds: integer('active_runtime_milliseconds').notNull(),
    pendingToolCall: jsonb('pending_tool_call').$type<CaretakerPendingToolCall>(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'caretaker_run_checkpoints_pk',
      columns: [table.organizationId, table.runId, table.sequence],
    }),
    unique('caretaker_run_checkpoints_mutation_unique').on(
      table.organizationId,
      table.runId,
      table.mutationKey,
    ),
    foreignKey({
      name: 'caretaker_run_checkpoints_run_tenant_fk',
      columns: [table.organizationId, table.runId],
      foreignColumns: [caretakerRuns.organizationId, caretakerRuns.id],
    }),
    foreignKey({
      name: 'caretaker_run_checkpoints_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    check('caretaker_run_checkpoints_sequence_nonnegative', sql`${table.sequence} >= 0`),
    check(
      'caretaker_run_checkpoints_version_matches',
      sql`${table.sequence} = ${table.runVersion}`,
    ),
    check(
      'caretaker_run_checkpoints_task_ledger_version_nonnegative',
      sql`${table.taskLedgerVersion} >= 0`,
    ),
    check(
      'caretaker_run_checkpoints_hashes_valid',
      sql`${table.mutationKey} ~ '^[a-f0-9]{64}$' AND ${table.mutationHash} ~ '^[a-f0-9]{64}$' AND ${table.taskLedgerHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'caretaker_run_checkpoints_task_ledger_valid',
      sql`caretaker_task_ledger_is_valid(${table.taskLedger})`,
    ),
    check(
      'caretaker_run_checkpoints_evidence_valid',
      sql`caretaker_evidence_refs_are_valid(${table.evidenceRefs})`,
    ),
    check(
      'caretaker_run_checkpoints_pending_tool_call_valid',
      sql`caretaker_pending_tool_call_is_valid(${table.pendingToolCall})`,
    ),
    check(
      'caretaker_run_checkpoints_tool_call_budget',
      sql`${table.toolCallCount} >= 0 AND ${table.toolCallCount} <= 24`,
    ),
    check(
      'caretaker_run_checkpoints_plan_revision_budget',
      sql`${table.planRevisionCount} >= 0 AND ${table.planRevisionCount} <= 3`,
    ),
    check(
      'caretaker_run_checkpoints_clarification_pause_budget',
      sql`${table.clarificationPauseCount} >= 0 AND ${table.clarificationPauseCount} <= 2`,
    ),
    check(
      'caretaker_run_checkpoints_reconciliation_poll_budget',
      sql`${table.reconciliationPollCount} >= 0 AND ${table.reconciliationPollCount} <= 3`,
    ),
    check(
      'caretaker_run_checkpoints_active_runtime_budget',
      sql`${table.activeRuntimeMilliseconds} >= 0 AND ${table.activeRuntimeMilliseconds} <= 300000`,
    ),
  ],
)

export const caretakerTerminalEvidenceDeliveries = pgTable(
  'caretaker_terminal_evidence_deliveries',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    runId: text('run_id').notNull(),
    eventInsertId: text('event_insert_id').notNull(),
    eventHash: char('event_hash', { length: 64 }).notNull(),
    envelope: jsonb('envelope').$type<CaretakerTerminalEvidenceEnvelope>().notNull(),
    status: caretakerEvidenceDeliveryStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    captureStatus: caretakerEvidenceCaptureStatusEnum('capture_status'),
  },
  (table) => [
    primaryKey({
      name: 'caretaker_terminal_evidence_deliveries_pk',
      columns: [table.organizationId, table.runId],
    }),
    unique('caretaker_terminal_evidence_insert_id_unique').on(table.eventInsertId),
    foreignKey({
      name: 'caretaker_terminal_evidence_run_tenant_fk',
      columns: [table.organizationId, table.runId],
      foreignColumns: [caretakerRuns.organizationId, caretakerRuns.id],
    }),
    foreignKey({
      name: 'caretaker_terminal_evidence_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    check('caretaker_terminal_evidence_hash_valid', sql`${table.eventHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'caretaker_terminal_evidence_delivery_state_valid',
      sql`(${table.status} = 'pending' AND ${table.deliveredAt} IS NULL AND ${table.captureStatus} IS NULL) OR (${table.status} = 'delivered' AND ${table.deliveredAt} IS NOT NULL AND ${table.captureStatus} IS NOT NULL)`,
    ),
    check(
      'caretaker_terminal_evidence_time_order',
      sql`${table.deliveredAt} IS NULL OR ${table.deliveredAt} >= ${table.createdAt}`,
    ),
  ],
)

/** Exact analytics-safe event bytes frozen by the transaction that owns the product fact. */
export const productEvidenceDeliveries = pgTable(
  'product_evidence_deliveries',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    logicalEventId: text('logical_event_id').notNull(),
    semanticHash: char('semantic_hash', { length: 64 }).notNull(),
    eventInsertId: text('event_insert_id').notNull(),
    eventHash: char('event_hash', { length: 64 }).notNull(),
    eventSerialized: text('event_serialized').notNull(),
    status: productEvidenceDeliveryStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    captureStatus: productEvidenceCaptureStatusEnum('capture_status'),
  },
  (table) => [
    primaryKey({
      name: 'product_evidence_deliveries_pk',
      columns: [table.organizationId, table.logicalEventId],
    }),
    unique('product_evidence_deliveries_logical_event_unique').on(table.logicalEventId),
    unique('product_evidence_deliveries_insert_id_unique').on(table.eventInsertId),
    check(
      'product_evidence_deliveries_logical_event_id_valid',
      sql`${table.logicalEventId} ~ '^evt_application_[a-f0-9]{32}$'`,
    ),
    check(
      'product_evidence_deliveries_insert_id_valid',
      sql`${table.eventInsertId} ~ '^tpi_v1_[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      'product_evidence_deliveries_hashes_valid',
      sql`${table.semanticHash} ~ '^[a-f0-9]{64}$' AND ${table.eventHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'product_evidence_deliveries_event_serialized_valid',
      sql`octet_length(${table.eventSerialized}) BETWEEN 2 AND 65536`,
    ),
    check(
      'product_evidence_deliveries_delivery_state_valid',
      sql`(${table.status} = 'pending' AND ${table.deliveredAt} IS NULL AND ${table.captureStatus} IS NULL) OR (${table.status} = 'delivered' AND ${table.deliveredAt} IS NOT NULL AND ${table.captureStatus} IS NOT NULL)`,
    ),
    check(
      'product_evidence_deliveries_time_order',
      sql`${table.deliveredAt} IS NULL OR ${table.deliveredAt} >= ${table.createdAt}`,
    ),
  ],
)

export const plans = pgTable(
  'plans',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    palaceId: text('palace_id').notNull(),
    revision: integer('revision').notNull(),
    hash: char('hash', { length: 64 }).notNull(),
    status: planStatusEnum('status').notNull(),
    objective: text('objective').notNull(),
    constraints: jsonb('constraints').$type<Mission['constraints']>().notNull(),
    successCriteriaIds: text('success_criteria_ids').array().notNull(),
    recordVersion: integer('record_version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique('plans_organization_id_id_unique').on(table.organizationId, table.id),
    unique('plans_organization_mission_id_unique').on(
      table.organizationId,
      table.missionId,
      table.id,
    ),
    unique('plans_mission_revision_unique').on(
      table.organizationId,
      table.missionId,
      table.revision,
    ),
    foreignKey({
      name: 'plans_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    foreignKey({
      name: 'plans_palace_tenant_fk',
      columns: [table.organizationId, table.palaceId],
      foreignColumns: [palaces.organizationId, palaces.id],
    }),
    check('plans_revision_positive', sql`${table.revision} > 0`),
    check('plans_record_version_positive', sql`${table.recordVersion} > 0`),
    check('plans_hash_valid', sql`${table.hash} ~ '^[a-f0-9]{64}$'`),
    check('plans_success_criteria_present', sql`cardinality(${table.successCriteriaIds}) > 0`),
  ],
)

export const planActions = pgTable(
  'plan_actions',
  {
    id: text('id').notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    planId: text('plan_id').notNull(),
    position: integer('position').notNull(),
    type: planActionTypeEnum('type').notNull(),
    payload: jsonb('payload').$type<PlanAction>().notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: 'plan_actions_pk',
      columns: [table.organizationId, table.planId, table.id],
    }),
    unique('plan_actions_organization_id_id_unique').on(table.organizationId, table.id),
    unique('plan_actions_plan_position_unique').on(
      table.organizationId,
      table.planId,
      table.position,
    ),
    foreignKey({
      name: 'plan_actions_plan_tenant_fk',
      columns: [table.organizationId, table.planId],
      foreignColumns: [plans.organizationId, plans.id],
    }),
    check('plan_actions_position_nonnegative', sql`${table.position} >= 0`),
  ],
)

export const planValidations = pgTable(
  'plan_validations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    planId: text('plan_id').notNull(),
    valid: boolean('valid').notNull(),
    checks: jsonb('checks')
      .$type<
        {
          type: 'capability' | 'conflict' | 'hard_invariant' | 'schema'
          passed: boolean
          message: string
        }[]
      >()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    unique('plan_validations_organization_id_id_unique').on(table.organizationId, table.id),
    index('plan_validations_latest_idx').on(table.organizationId, table.planId, table.createdAt),
    foreignKey({
      name: 'plan_validations_plan_tenant_fk',
      columns: [table.organizationId, table.planId],
      foreignColumns: [plans.organizationId, plans.id],
    }),
  ],
)

export const planSimulations = pgTable(
  'plan_simulations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    planId: text('plan_id').notNull(),
    feasible: boolean('feasible').notNull(),
    projectedBatteryUsePercentagePoints: doublePrecision(
      'projected_battery_use_percentage_points',
    ).notNull(),
    results: jsonb('results')
      .$type<
        {
          scenario: 'access' | 'energy' | 'timing' | 'transport_failure'
          passed: boolean
          evidence: string
        }[]
      >()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    unique('plan_simulations_organization_id_id_unique').on(table.organizationId, table.id),
    index('plan_simulations_latest_idx').on(table.organizationId, table.planId, table.createdAt),
    foreignKey({
      name: 'plan_simulations_plan_tenant_fk',
      columns: [table.organizationId, table.planId],
      foreignColumns: [plans.organizationId, plans.id],
    }),
    check(
      'plan_simulations_battery_range',
      sql`${table.projectedBatteryUsePercentagePoints} >= 0 AND ${table.projectedBatteryUsePercentagePoints} <= 100`,
    ),
  ],
)

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    planId: text('plan_id').notNull(),
    planHash: char('plan_hash', { length: 64 }).notNull(),
    status: approvalStatusEnum('status').notNull(),
    requestedBy: text('requested_by')
      .notNull()
      .references(() => users.id),
    approvedBy: text('approved_by').references(() => users.id),
    approverRole: membershipRoleEnum('approver_role'),
    nonce: text('nonce').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    recordVersion: integer('record_version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique('approvals_organization_id_id_unique').on(table.organizationId, table.id),
    unique('approvals_tenant_mission_plan_id_unique').on(
      table.organizationId,
      table.missionId,
      table.planId,
      table.id,
    ),
    unique('approvals_tenant_id_plan_unique').on(table.organizationId, table.id, table.planId),
    unique('approvals_nonce_unique').on(table.organizationId, table.nonce),
    foreignKey({
      name: 'approvals_plan_tenant_fk',
      columns: [table.organizationId, table.missionId, table.planId],
      foreignColumns: [plans.organizationId, plans.missionId, plans.id],
    }),
    foreignKey({
      name: 'approvals_requester_tenant_fk',
      columns: [table.organizationId, table.requestedBy],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    foreignKey({
      name: 'approvals_approver_tenant_fk',
      columns: [table.organizationId, table.approvedBy],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    check('approvals_hash_valid', sql`${table.planHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'approvals_expiry_window',
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes'`,
    ),
    check('approvals_record_version_positive', sql`${table.recordVersion} > 0`),
    check(
      'approvals_approved_fields',
      sql`(${table.status} = 'approved' AND ${table.approvedBy} IS NOT NULL AND ${table.approverRole} IN ('owner', 'operator') AND ${table.approvedAt} IS NOT NULL) OR (${table.status} <> 'approved' AND ${table.approvedBy} IS NULL AND ${table.approverRole} IS NULL AND ${table.approvedAt} IS NULL)`,
    ),
    check(
      'approvals_approved_time',
      sql`${table.approvedAt} IS NULL OR (${table.approvedAt} >= ${table.createdAt} AND ${table.approvedAt} < ${table.expiresAt})`,
    ),
  ],
)

export const approvalActions = pgTable(
  'approval_actions',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    approvalId: text('approval_id').notNull(),
    planId: text('plan_id').notNull(),
    actionId: text('action_id').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'approval_actions_pk',
      columns: [table.organizationId, table.approvalId, table.actionId],
    }),
    unique('approval_actions_operation_reference_unique').on(
      table.organizationId,
      table.approvalId,
      table.planId,
      table.actionId,
    ),
    foreignKey({
      name: 'approval_actions_approval_plan_tenant_fk',
      columns: [table.organizationId, table.approvalId, table.planId],
      foreignColumns: [approvals.organizationId, approvals.id, approvals.planId],
    }),
    foreignKey({
      name: 'approval_actions_plan_action_tenant_fk',
      columns: [table.organizationId, table.planId, table.actionId],
      foreignColumns: [planActions.organizationId, planActions.planId, planActions.id],
    }),
  ],
)

export const approvalProtectedResources = pgTable(
  'approval_protected_resources',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    approvalId: text('approval_id').notNull(),
    routineId: text('routine_id').notNull(),
    routineVersionId: text('routine_version_id').notNull(),
    version: integer('version').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'approval_protected_resources_pk',
      columns: [table.organizationId, table.approvalId, table.routineId],
    }),
    foreignKey({
      name: 'approval_protected_resources_approval_tenant_fk',
      columns: [table.organizationId, table.approvalId],
      foreignColumns: [approvals.organizationId, approvals.id],
    }),
    foreignKey({
      name: 'approval_protected_resources_version_tenant_fk',
      columns: [table.organizationId, table.routineId, table.routineVersionId, table.version],
      foreignColumns: [
        routineVersions.organizationId,
        routineVersions.routineId,
        routineVersions.id,
        routineVersions.version,
      ],
    }),
    check('approval_protected_resources_version_positive', sql`${table.version} > 0`),
  ],
)

export const operations = pgTable(
  'operations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    planId: text('plan_id').notNull(),
    planActionId: text('plan_action_id').notNull(),
    approvalId: text('approval_id').notNull(),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    serverCreated: boolean('server_created').notNull().default(true),
    status: operationStatusEnum('status').notNull().default('pending'),
    outcome: jsonb('outcome').$type<OperationOutcome>(),
    claimedBy: text('claimed_by'),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    cancellationRequestedAt: timestamp('cancellation_requested_at', { withTimezone: true }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    recordVersion: integer('record_version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique('operations_organization_id_id_unique').on(table.organizationId, table.id),
    unique('operations_tenant_id_mission_unique').on(
      table.organizationId,
      table.id,
      table.missionId,
    ),
    unique('operations_plan_action_unique').on(
      table.organizationId,
      table.planId,
      table.planActionId,
    ),
    foreignKey({
      name: 'operations_approval_tenant_fk',
      columns: [table.organizationId, table.missionId, table.planId, table.approvalId],
      foreignColumns: [
        approvals.organizationId,
        approvals.missionId,
        approvals.planId,
        approvals.id,
      ],
    }),
    foreignKey({
      name: 'operations_plan_action_tenant_fk',
      columns: [table.organizationId, table.planId, table.planActionId],
      foreignColumns: [planActions.organizationId, planActions.planId, planActions.id],
    }),
    foreignKey({
      name: 'operations_approved_action_tenant_fk',
      columns: [table.organizationId, table.approvalId, table.planId, table.planActionId],
      foreignColumns: [
        approvalActions.organizationId,
        approvalActions.approvalId,
        approvalActions.planId,
        approvalActions.actionId,
      ],
    }),
    check('operations_payload_hash_valid', sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`),
    check('operations_server_created', sql`${table.serverCreated}`),
    check('operations_record_version_positive', sql`${table.recordVersion} > 0`),
    check(
      'operations_committed_fields',
      sql`(${table.status} = 'committed' AND ${table.outcome} IS NOT NULL AND ${table.committedAt} IS NOT NULL) OR (${table.status} <> 'committed' AND ${table.outcome} IS NULL AND ${table.committedAt} IS NULL)`,
    ),
    check(
      'operations_claim_pair',
      sql`(${table.claimedBy} IS NULL) = (${table.claimedUntil} IS NULL)`,
    ),
  ],
)

export const attempts = pgTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    operationId: text('operation_id').notNull(),
    gatewayCommandId: text('gateway_command_id'),
    dispatchGeneration: integer('dispatch_generation'),
    sequence: integer('sequence').notNull(),
    transport: attemptTransportEnum('transport').notNull(),
    status: attemptStatusEnum('status').notNull(),
    retryable: boolean('retryable').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    recordVersion: integer('record_version').notNull().default(1),
  },
  (table) => [
    unique('attempts_organization_id_id_unique').on(table.organizationId, table.id),
    unique('attempts_operation_sequence_unique').on(
      table.organizationId,
      table.operationId,
      table.sequence,
    ),
    unique('attempts_gateway_dispatch_unique').on(
      table.organizationId,
      table.gatewayCommandId,
      table.dispatchGeneration,
    ),
    unique('attempts_gateway_dispatch_identity_unique').on(
      table.organizationId,
      table.id,
      table.gatewayCommandId,
      table.dispatchGeneration,
    ),
    foreignKey({
      name: 'attempts_operation_tenant_fk',
      columns: [table.organizationId, table.operationId],
      foreignColumns: [operations.organizationId, operations.id],
    }),
    check('attempts_sequence_positive', sql`${table.sequence} > 0`),
    check(
      'attempts_gateway_binding',
      sql`(${table.transport} = 'gateway' AND ${table.gatewayCommandId} IS NOT NULL AND ${table.dispatchGeneration} IS NOT NULL) OR (${table.transport} <> 'gateway' AND ${table.gatewayCommandId} IS NULL AND ${table.dispatchGeneration} IS NULL)`,
    ),
    check(
      'attempts_dispatch_generation_positive',
      sql`${table.dispatchGeneration} IS NULL OR ${table.dispatchGeneration} > 0`,
    ),
    check('attempts_record_version_positive', sql`${table.recordVersion} > 0`),
    check(
      'attempts_completion_valid',
      sql`(${table.status} = 'pending' AND ${table.completedAt} IS NULL) OR (${table.status} <> 'pending' AND ${table.completedAt} IS NOT NULL)`,
    ),
    check(
      'attempts_error_pair',
      sql`(${table.errorCode} IS NULL) = (${table.errorMessage} IS NULL)`,
    ),
    check(
      'attempts_success_has_no_error',
      sql`${table.status} <> 'succeeded' OR (${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL)`,
    ),
    check(
      'attempts_error_required',
      sql`${table.status} NOT IN ('unknown', 'failed') OR (${table.errorCode} IS NOT NULL AND ${table.errorMessage} IS NOT NULL)`,
    ),
    check(
      'attempts_pending_has_no_error',
      sql`${table.status} <> 'pending' OR (${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL)`,
    ),
    check('attempts_unknown_retryable', sql`${table.status} <> 'unknown' OR ${table.retryable}`),
  ],
)

export const reconciliationPolls = pgTable(
  'reconciliation_polls',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    operationId: text('operation_id').notNull(),
    sequence: integer('sequence').notNull(),
    resolution: reconciliationResolutionEnum('resolution').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'reconciliation_polls_pk',
      columns: [table.organizationId, table.operationId, table.sequence],
    }),
    foreignKey({
      name: 'reconciliation_polls_operation_tenant_fk',
      columns: [table.organizationId, table.operationId],
      foreignColumns: [operations.organizationId, operations.id],
    }),
    check('reconciliation_polls_sequence_positive', sql`${table.sequence} > 0`),
  ],
)

export const cancellations = pgTable(
  'cancellations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    requestedBy: text('requested_by').notNull(),
    reason: text('reason').notNull(),
    checkpoint: cancellationCheckpointEnum('checkpoint').notNull(),
    outcome: cancellationOutcomeEnum('outcome').notNull(),
    compensatingPlanRequired: boolean('compensating_plan_required').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('cancellations_organization_id_id_unique').on(table.organizationId, table.id),
    unique('cancellations_mission_unique').on(table.organizationId, table.missionId),
    foreignKey({
      name: 'cancellations_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    check(
      'cancellations_compensation_consistent',
      sql`${table.compensatingPlanRequired} = (${table.outcome} = 'compensating_plan_required')`,
    ),
  ],
)

export const compensatingPlanLinks = pgTable(
  'compensating_plan_links',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    planId: text('plan_id').notNull(),
    actionId: text('action_id').notNull(),
    compensatesOperationId: text('compensates_operation_id').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: 'compensating_plan_links_pk',
      columns: [table.organizationId, table.planId],
    }),
    foreignKey({
      name: 'compensating_plan_links_action_tenant_fk',
      columns: [table.organizationId, table.planId, table.actionId],
      foreignColumns: [planActions.organizationId, planActions.planId, planActions.id],
    }),
    foreignKey({
      name: 'compensating_plan_links_operation_tenant_fk',
      columns: [table.organizationId, table.compensatesOperationId],
      foreignColumns: [operations.organizationId, operations.id],
    }),
  ],
)

export const gatewayCommands = pgTable(
  'gateway_commands',
  {
    id: text('id').primaryKey(),
    schemaVersion: text('schema_version').notNull().default('gateway-command@2'),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    operationId: text('operation_id').notNull(),
    missionId: text('mission_id').notNull(),
    palaceId: text('palace_id').notNull(),
    logicalKey: text('logical_key').notNull(),
    kind: gatewayCommandKindEnum('kind').notNull(),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (table) => [
    unique('gateway_commands_organization_id_id_unique').on(table.organizationId, table.id),
    unique('gateway_commands_tenant_id_operation_unique').on(
      table.organizationId,
      table.id,
      table.operationId,
    ),
    unique('gateway_commands_operation_logical_key_unique').on(
      table.organizationId,
      table.operationId,
      table.logicalKey,
    ),
    foreignKey({
      name: 'gateway_commands_operation_tenant_fk',
      columns: [table.organizationId, table.operationId, table.missionId],
      foreignColumns: [operations.organizationId, operations.id, operations.missionId],
    }),
    foreignKey({
      name: 'gateway_commands_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    foreignKey({
      name: 'gateway_commands_palace_tenant_fk',
      columns: [table.organizationId, table.palaceId],
      foreignColumns: [palaces.organizationId, palaces.id],
    }),
    check('gateway_commands_schema_version', sql`${table.schemaVersion} = 'gateway-command@2'`),
    check(
      'gateway_commands_logical_key_valid',
      sql`${table.logicalKey} ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$' AND length(${table.logicalKey}) <= 80`,
    ),
    check('gateway_commands_payload_hash_valid', sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`),
  ],
)

export const gatewayDispatches = pgTable(
  'gateway_dispatches',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    commandId: text('command_id').notNull(),
    operationId: text('operation_id').notNull(),
    generation: integer('generation').notNull(),
    status: gatewayDispatchStatusEnum('status').notNull().default('pending'),
    attemptId: text('attempt_id'),
    acknowledgementId: text('acknowledgement_id'),
    retryable: boolean('retryable'),
    unknownReason: gatewayDispatchUnknownReasonEnum('unknown_reason'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    recordVersion: integer('record_version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: 'gateway_dispatches_pk',
      columns: [table.organizationId, table.commandId, table.generation],
    }),
    unique('gateway_dispatches_attempt_unique').on(table.organizationId, table.attemptId),
    foreignKey({
      name: 'gateway_dispatches_command_operation_tenant_fk',
      columns: [table.organizationId, table.commandId, table.operationId],
      foreignColumns: [
        gatewayCommands.organizationId,
        gatewayCommands.id,
        gatewayCommands.operationId,
      ],
    }),
    foreignKey({
      name: 'gateway_dispatches_attempt_binding_fk',
      columns: [table.organizationId, table.attemptId, table.commandId, table.generation],
      foreignColumns: [
        attempts.organizationId,
        attempts.id,
        attempts.gatewayCommandId,
        attempts.dispatchGeneration,
      ],
    }),
    check('gateway_dispatches_generation_positive', sql`${table.generation} > 0`),
    check('gateway_dispatches_record_version_positive', sql`${table.recordVersion} > 0`),
    check(
      'gateway_dispatches_state_shape',
      sql`
        (${table.status} = 'pending' AND ${table.attemptId} IS NULL AND ${table.acknowledgementId} IS NULL AND ${table.retryable} IS NULL AND ${table.unknownReason} IS NULL AND ${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL AND ${table.cancelledAt} IS NULL)
        OR (${table.status} = 'dispatching' AND ${table.attemptId} IS NOT NULL AND ${table.acknowledgementId} IS NULL AND ${table.retryable} IS NULL AND ${table.unknownReason} IS NULL AND ${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL AND ${table.cancelledAt} IS NULL)
        OR (${table.status} = 'accepted' AND ${table.attemptId} IS NOT NULL AND ${table.acknowledgementId} IS NOT NULL AND ${table.retryable} IS NULL AND ${table.unknownReason} IS NULL AND ${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL AND ${table.cancelledAt} IS NULL)
        OR (${table.status} = 'unknown' AND ${table.attemptId} IS NOT NULL AND ${table.acknowledgementId} IS NULL AND ${table.retryable} IS TRUE AND ${table.unknownReason} IS NOT NULL AND ${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL AND ${table.cancelledAt} IS NULL)
        OR (${table.status} = 'failed' AND ${table.attemptId} IS NOT NULL AND ${table.acknowledgementId} IS NULL AND ${table.retryable} IS NOT NULL AND ${table.unknownReason} IS NULL AND ${table.errorCode} IS NOT NULL AND ${table.errorMessage} IS NOT NULL AND ${table.cancelledAt} IS NULL)
        OR (${table.status} = 'cancelled' AND ${table.attemptId} IS NULL AND ${table.acknowledgementId} IS NULL AND ${table.retryable} IS NULL AND ${table.unknownReason} IS NULL AND ${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL AND ${table.cancelledAt} IS NOT NULL)
      `,
    ),
  ],
)

export const gatewayEffects = pgTable(
  'gateway_effects',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    commandId: text('command_id').notNull(),
    operationId: text('operation_id').notNull(),
    missionId: text('mission_id').notNull(),
    dispatchAt: timestamp('dispatch_at', { withTimezone: true }).notNull(),
    milestone: executionMilestoneNameEnum('milestone').notNull(),
    cancellationPolicy: gatewayEffectCancellationPolicyEnum('cancellation_policy').notNull(),
    authorizationKind: gatewayCommandAuthorizationKindEnum('authorization_kind').notNull(),
    authorizingLeaseEpoch: integer('authorizing_lease_epoch'),
    status: gatewayEffectStatusEnum('status').notNull().default('pending'),
    callbackId: text('callback_id'),
    cancellationRequestedAt: timestamp('cancellation_requested_at', { withTimezone: true }),
    reconciliationAttempts: integer('reconciliation_attempts').notNull().default(0),
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    recordVersion: integer('record_version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'gateway_effects_pk', columns: [table.organizationId, table.commandId] }),
    unique('gateway_effects_command_operation_unique').on(
      table.organizationId,
      table.commandId,
      table.operationId,
    ),
    foreignKey({
      name: 'gateway_effects_command_operation_tenant_fk',
      columns: [table.organizationId, table.commandId, table.operationId],
      foreignColumns: [
        gatewayCommands.organizationId,
        gatewayCommands.id,
        gatewayCommands.operationId,
      ],
    }),
    foreignKey({
      name: 'gateway_effects_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    check(
      'gateway_effects_authorization_shape',
      sql`(${table.authorizationKind} = 'mission_lease' AND ${table.authorizingLeaseEpoch} > 0) OR (${table.authorizationKind} = 'manual_activation' AND ${table.authorizingLeaseEpoch} IS NULL)`,
    ),
    check(
      'gateway_effects_cancellation_policy',
      sql`(${table.cancellationPolicy} = 'mandatory_relock') = (${table.milestone} = 'relock')`,
    ),
    check(
      'gateway_effects_callback_shape',
      sql`(${table.status} = 'pending' AND ${table.callbackId} IS NULL) OR (${table.status} IN ('acknowledged', 'executing', 'completed', 'failed') AND ${table.callbackId} IS NOT NULL)`,
    ),
    check(
      'gateway_effects_reconciliation_attempts_nonnegative',
      sql`${table.reconciliationAttempts} >= 0`,
    ),
    check('gateway_effects_record_version_positive', sql`${table.recordVersion} > 0`),
  ],
)

export const gatewayCallbacks = pgTable(
  'gateway_callbacks',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    commandId: text('command_id').notNull(),
    operationId: text('operation_id').notNull(),
    nonce: text('nonce').notNull(),
    status: gatewayCallbackStatusEnum('status').notNull(),
    verifierKeyId: text('verifier_key_id').notNull(),
    verifierVersion: integer('verifier_version').notNull(),
    verifiedPayloadDigest: char('verified_payload_digest', { length: 64 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('gateway_callbacks_organization_id_id_unique').on(table.organizationId, table.id),
    unique('gateway_callbacks_id_command_unique').on(
      table.organizationId,
      table.id,
      table.commandId,
    ),
    unique('gateway_callbacks_nonce_unique').on(table.organizationId, table.nonce),
    unique('gateway_callbacks_command_status_unique').on(
      table.organizationId,
      table.commandId,
      table.status,
    ),
    uniqueIndex('gateway_callbacks_command_terminal_unique')
      .on(table.organizationId, table.commandId)
      .where(sql`${table.status} IN ('completed', 'failed')`),
    foreignKey({
      name: 'gateway_callbacks_command_operation_tenant_fk',
      columns: [table.organizationId, table.commandId, table.operationId],
      foreignColumns: [
        gatewayCommands.organizationId,
        gatewayCommands.id,
        gatewayCommands.operationId,
      ],
    }),
    check('gateway_callbacks_verifier_version', sql`${table.verifierVersion} = 1`),
    check(
      'gateway_callbacks_verifier_key',
      sql`${table.verifierKeyId} ~ '^gwk_[A-Za-z0-9_-]{8,64}$'`,
    ),
    check('gateway_callbacks_digest_valid', sql`${table.verifiedPayloadDigest} ~ '^[a-f0-9]{64}$'`),
  ],
)

export const identityTelemetryIngresses = pgTable(
  'identity_telemetry_ingresses',
  {
    schemaVersion: text('schema_version').notNull().default('identity-telemetry-ingress@1'),
    providerEventId: text('provider_event_id').notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    palaceId: text('palace_id').notNull(),
    identityTagId: text('identity_tag_id').notNull(),
    nonce: text('nonce').notNull(),
    principalId: text('principal_id').notNull(),
    keyId: text('key_id').notNull(),
    keyVersion: integer('key_version').notNull(),
    verifiedPayloadHash: char('verified_payload_hash', { length: 64 }).notNull(),
    signatureTimestamp: timestamp('signature_timestamp', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    evidenceId: text('evidence_id').notNull(),
    authorityReceiptId: text('authority_receipt_id').notNull(),
    identityVerified: boolean('identity_verified').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'identity_telemetry_ingresses_pk',
      columns: [table.organizationId, table.providerEventId],
    }),
    unique('identity_telemetry_ingresses_nonce_unique').on(table.organizationId, table.nonce),
    unique('identity_telemetry_ingresses_evidence_unique').on(table.evidenceId),
    unique('identity_telemetry_ingresses_receipt_unique').on(
      table.organizationId,
      table.authorityReceiptId,
    ),
    unique('identity_telemetry_ingresses_evidence_binding_unique').on(
      table.organizationId,
      table.providerEventId,
      table.evidenceId,
      table.authorityReceiptId,
    ),
    foreignKey({
      name: 'identity_telemetry_ingresses_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    foreignKey({
      name: 'identity_telemetry_ingresses_palace_tenant_fk',
      columns: [table.organizationId, table.palaceId],
      foreignColumns: [palaces.organizationId, palaces.id],
    }),
    foreignKey({
      name: 'identity_telemetry_ingresses_tag_tenant_fk',
      columns: [table.organizationId, table.identityTagId],
      foreignColumns: [identityTags.organizationId, identityTags.id],
    }),
    check(
      'identity_telemetry_ingresses_schema_version',
      sql`${table.schemaVersion} = 'identity-telemetry-ingress@1'`,
    ),
    check(
      'identity_telemetry_ingresses_identifiers',
      sql`${table.providerEventId} ~ '^idt_[A-Za-z0-9_-]{8,96}$' AND ${table.nonce} ~ '^itn_[A-Za-z0-9_-]{16,96}$' AND ${table.principalId} ~ '^itp_[A-Za-z0-9_-]{8,64}$' AND ${table.keyId} ~ '^itk_[A-Za-z0-9_-]{8,64}$' AND ${table.evidenceId} ~ '^evd_[a-z0-9][a-z0-9_-]{7,63}$' AND ${table.authorityReceiptId} ~ '^rcp_[a-z0-9][a-z0-9_-]{7,63}$'`,
    ),
    check('identity_telemetry_ingresses_key_version_positive', sql`${table.keyVersion} > 0`),
    check(
      'identity_telemetry_ingresses_payload_hash',
      sql`${table.verifiedPayloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'identity_telemetry_ingresses_verification_order',
      sql`${table.signatureTimestamp} <= ${table.verifiedAt} + interval '30 seconds'`,
    ),
  ],
)

export const evidence = pgTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    palaceId: text('palace_id').notNull(),
    type: evidenceTypeEnum('type').notNull(),
    payload: jsonb('payload').$type<Evidence>().notNull(),
    authorityReceiptId: text('authority_receipt_id').notNull(),
    authority: evidenceAuthorityEnum('authority').notNull(),
    authorityReceipt: jsonb('authority_receipt')
      .$type<PersistedEvidenceRecord['authorityReceipt']>()
      .notNull(),
    authorityProviderEventId: text('authority_provider_event_id'),
    authorityCallbackId: text('authority_callback_id'),
    authorityCommandId: text('authority_command_id'),
    applicationRuleId: text('application_rule_id'),
    applicationRuleVersion: integer('application_rule_version'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    persistedAt: timestamp('persisted_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('evidence_organization_id_id_unique').on(table.organizationId, table.id),
    unique('evidence_authority_receipt_unique').on(table.organizationId, table.authorityReceiptId),
    unique('evidence_provider_event_unique').on(
      table.organizationId,
      table.authorityProviderEventId,
    ),
    foreignKey({
      name: 'evidence_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    foreignKey({
      name: 'evidence_palace_tenant_fk',
      columns: [table.organizationId, table.palaceId],
      foreignColumns: [palaces.organizationId, palaces.id],
    }),
    foreignKey({
      name: 'evidence_gateway_callback_binding_fk',
      columns: [table.organizationId, table.authorityCallbackId, table.authorityCommandId],
      foreignColumns: [
        gatewayCallbacks.organizationId,
        gatewayCallbacks.id,
        gatewayCallbacks.commandId,
      ],
    }),
    foreignKey({
      name: 'evidence_identity_telemetry_ingress_fk',
      columns: [
        table.organizationId,
        table.authorityProviderEventId,
        table.id,
        table.authorityReceiptId,
      ],
      foreignColumns: [
        identityTelemetryIngresses.organizationId,
        identityTelemetryIngresses.providerEventId,
        identityTelemetryIngresses.evidenceId,
        identityTelemetryIngresses.authorityReceiptId,
      ],
    }),
    check(
      'evidence_authority_shape',
      sql`
        (${table.authority} = 'identity_telemetry' AND ${table.type} = 'identity_arrival' AND ${table.authorityProviderEventId} IS NOT NULL AND ${table.authorityCallbackId} IS NULL AND ${table.authorityCommandId} IS NULL AND ${table.applicationRuleId} IS NULL AND ${table.applicationRuleVersion} IS NULL)
        OR (${table.authority} = 'gateway_callback' AND ${table.type} IN ('device_command', 'temperature_observation', 'lighting_observation', 'lock_observation', 'gateway_delivery') AND ${table.authorityProviderEventId} IS NULL AND ${table.authorityCallbackId} IS NOT NULL AND ${table.authorityCommandId} IS NOT NULL AND ${table.applicationRuleId} IS NULL AND ${table.applicationRuleVersion} IS NULL)
        OR (${table.authority} = 'application' AND ${table.type} IN ('battery_projection', 'routine_state', 'tenant_access_audit', 'operation_transport', 'tool_invocation_reconciliation') AND ${table.authorityProviderEventId} IS NULL AND ${table.authorityCallbackId} IS NULL AND ${table.authorityCommandId} IS NULL AND ${table.applicationRuleId} IS NOT NULL AND ${table.applicationRuleVersion} > 0)
      `,
    ),
    check('evidence_persistence_order', sql`${table.verifiedAt} <= ${table.persistedAt}`),
    check(
      'evidence_identity_telemetry_v2_required',
      sql`${table.authority} <> 'identity_telemetry' OR ${table.authorityReceipt} ->> 'schemaVersion' = 'evidence-authority-receipt@2'`,
    ),
    check(
      'evidence_payload_binding',
      sql`${table.payload} ->> 'id' = ${table.id} AND ${table.payload} ->> 'organizationId' = ${table.organizationId} AND ${table.payload} ->> 'missionId' = ${table.missionId} AND ${table.payload} ->> 'palaceId' = ${table.palaceId} AND ${table.payload} ->> 'type' = ${table.type}::text`,
    ),
    check(
      'evidence_authority_receipt_binding',
      sql`${table.authorityReceipt} ->> 'id' = ${table.authorityReceiptId} AND ${table.authorityReceipt} ->> 'evidenceId' = ${table.id} AND ${table.authorityReceipt} ->> 'organizationId' = ${table.organizationId} AND ${table.authorityReceipt} ->> 'missionId' = ${table.missionId} AND ${table.authorityReceipt} ->> 'palaceId' = ${table.palaceId} AND ${table.authorityReceipt} ->> 'authority' = ${table.authority}::text`,
    ),
    check(
      'evidence_tool_invocation_reconciliation_shape',
      sql`${table.type} <> 'tool_invocation_reconciliation' OR (${table.authority} = 'application' AND ${table.applicationRuleId} = 'tool_invocation.abandoned_write' AND ${table.applicationRuleVersion} = 1 AND ${table.payload} ->> 'source' = 'tool_invocation_ledger' AND ${table.payload} ->> 'observer' = 'application_code' AND ${table.payload} ->> 'durableObservation' = 'expired_claim_without_terminal_result' AND ${table.payload} ->> 'reconciledOutcome' = 'still_unknown' AND ${table.payload} -> 'observedResultHash' = 'null'::jsonb AND ${table.payload} -> 'observedAttemptId' = 'null'::jsonb AND ${table.payload} ->> 'toolCallId' ~ '^call_[a-z0-9][a-z0-9_-]{7,63}$' AND ${table.payload} ->> 'toolName' IN ('palaces.get', 'crews.list', 'capabilities.list', 'routines.list', 'routines.get', 'executions.list', 'knowledge.search', 'plans.propose', 'plans.validate', 'plans.simulate', 'plans.request_approval', 'plans.activate', 'operations.get', 'verification.get_evidence', 'missions.cancel') AND ${table.payload} ->> 'invocationBindingHash' ~ '^[a-f0-9]{64}$' AND ${table.payload} ->> 'observationHash' ~ '^[a-f0-9]{64}$' AND (${table.payload} ->> 'abandonedClaimGeneration')::integer > 0 AND (${table.payload} ->> 'claimExpiredAt')::timestamptz <= ${table.observedAt})`,
    ),
    check(
      'evidence_operation_transport_shape',
      sql`
        ${table.type} <> 'operation_transport'
        OR (
          ${table.authority} = 'application'
          AND ${table.applicationRuleId} = 'operation.application_response_lost'
          AND ${table.applicationRuleVersion} = 1
          AND jsonb_typeof(${table.payload}) = 'object'
          AND ${table.payload} ?& ARRAY['id', 'organizationId', 'missionId', 'palaceId', 'observedAt', 'type', 'operationId', 'attemptId', 'toolCallId', 'transport', 'status', 'operationCommitted', 'errorCode']::text[]
          AND ${table.payload} - ARRAY['id', 'organizationId', 'missionId', 'palaceId', 'observedAt', 'type', 'operationId', 'attemptId', 'toolCallId', 'transport', 'status', 'operationCommitted', 'errorCode']::text[] = '{}'::jsonb
          AND ${table.payload} ->> 'operationId' ~ '^op_[a-z0-9][a-z0-9_-]{7,63}$'
          AND ${table.payload} ->> 'attemptId' ~ '^att_[a-z0-9][a-z0-9_-]{7,63}$'
          AND ${table.payload} ->> 'toolCallId' ~ '^call_[a-z0-9][a-z0-9_-]{7,63}$'
          AND ${table.payload} ->> 'transport' = 'worker'
          AND ${table.payload} ->> 'status' = 'unknown'
          AND ${table.payload} -> 'operationCommitted' = 'true'::jsonb
          AND ${table.payload} ->> 'errorCode' = 'APPLICATION_RESPONSE_LOST'
          AND ${table.authorityReceipt} ->> 'schemaVersion' = 'evidence-authority-receipt@1'
          AND ${table.authorityReceipt} ->> 'producer' = 'application_code'
          AND ${table.authorityReceipt} ->> 'ruleId' = 'operation.application_response_lost'
          AND (${table.authorityReceipt} ->> 'ruleVersion')::integer = 1
          AND ${table.authorityReceipt} -> 'inputEvidenceIds' = '[]'::jsonb
          AND ${table.authorityReceipt} -> 'derivationVerified' = 'true'::jsonb
        )
      `,
    ),
  ],
)

export const executions = pgTable(
  'executions',
  {
    id: text('id').primaryKey(),
    schemaVersion: text('schema_version').notNull().default('execution@2'),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    operationId: text('operation_id').notNull(),
    missionId: text('mission_id').notNull(),
    routineId: text('routine_id').notNull(),
    routineVersionId: text('routine_version_id').notNull(),
    status: executionStatusEnum('status').notNull(),
    authorizationKind: gatewayCommandAuthorizationKindEnum('authorization_kind').notNull(),
    authorizingLeaseEpoch: integer('authorizing_lease_epoch'),
    triggeredByEvidenceId: text('triggered_by_evidence_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    recordVersion: integer('record_version').notNull().default(1),
  },
  (table) => [
    unique('executions_organization_id_id_unique').on(table.organizationId, table.id),
    unique('executions_full_correlation_unique').on(
      table.organizationId,
      table.id,
      table.missionId,
      table.operationId,
    ),
    unique('executions_operation_unique').on(table.organizationId, table.operationId),
    foreignKey({
      name: 'executions_operation_tenant_fk',
      columns: [table.organizationId, table.operationId],
      foreignColumns: [operations.organizationId, operations.id],
    }),
    foreignKey({
      name: 'executions_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    foreignKey({
      name: 'executions_routine_tenant_fk',
      columns: [table.organizationId, table.routineId],
      foreignColumns: [routines.organizationId, routines.id],
    }),
    foreignKey({
      name: 'executions_routine_version_tenant_fk',
      columns: [table.organizationId, table.routineId, table.routineVersionId],
      foreignColumns: [
        routineVersions.organizationId,
        routineVersions.routineId,
        routineVersions.id,
      ],
    }),
    foreignKey({
      name: 'executions_trigger_evidence_tenant_fk',
      columns: [table.organizationId, table.triggeredByEvidenceId],
      foreignColumns: [evidence.organizationId, evidence.id],
    }),
    check('executions_record_version_positive', sql`${table.recordVersion} > 0`),
    check('executions_schema_version', sql`${table.schemaVersion} = 'execution@2'`),
    check(
      'executions_authorization_shape',
      sql`(${table.authorizationKind} = 'mission_lease' AND ${table.authorizingLeaseEpoch} > 0) OR (${table.authorizationKind} = 'manual_activation' AND ${table.authorizingLeaseEpoch} IS NULL)`,
    ),
    check(
      'executions_temporal_order',
      sql`${table.deadline} >= ${table.startedAt} AND ${table.updatedAt} >= ${table.startedAt} AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt})`,
    ),
    check(
      'executions_completion_valid',
      sql`(${table.status} IN ('scheduled', 'running') AND ${table.completedAt} IS NULL) OR (${table.status} IN ('observed', 'failed') AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
)

export const executionMilestones = pgTable(
  'execution_milestones',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    executionId: text('execution_id').notNull(),
    name: executionMilestoneNameEnum('name').notNull(),
    commandId: text('command_id'),
    status: executionMilestoneStatusEnum('status').notNull(),
    evidenceId: text('evidence_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
  },
  (table) => [
    primaryKey({
      name: 'execution_milestones_pk',
      columns: [table.organizationId, table.executionId, table.name],
    }),
    foreignKey({
      name: 'execution_milestones_execution_tenant_fk',
      columns: [table.organizationId, table.executionId],
      foreignColumns: [executions.organizationId, executions.id],
    }),
    foreignKey({
      name: 'execution_milestones_evidence_tenant_fk',
      columns: [table.organizationId, table.evidenceId],
      foreignColumns: [evidence.organizationId, evidence.id],
    }),
    check(
      'execution_milestones_command_shape',
      sql`(${table.name} = 'verified_arrival') = (${table.commandId} IS NULL)`,
    ),
    check(
      'execution_milestones_state_shape',
      sql`
        (${table.status} = 'pending' AND ${table.evidenceId} IS NULL AND ${table.resolvedAt} IS NULL AND ${table.failureCode} IS NULL AND ${table.failureMessage} IS NULL)
        OR (${table.status} = 'completed' AND ${table.evidenceId} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL AND ${table.failureCode} IS NULL AND ${table.failureMessage} IS NULL)
        OR (${table.status} = 'failed' AND ${table.resolvedAt} IS NOT NULL AND ${table.failureCode} IS NOT NULL AND ${table.failureMessage} IS NOT NULL)
      `,
    ),
  ],
)

export const executionEvidence = pgTable(
  'execution_evidence',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    executionId: text('execution_id').notNull(),
    evidenceId: text('evidence_id').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'execution_evidence_pk',
      columns: [table.organizationId, table.executionId, table.evidenceId],
    }),
    unique('execution_evidence_position_unique').on(
      table.organizationId,
      table.executionId,
      table.position,
    ),
    foreignKey({
      name: 'execution_evidence_execution_tenant_fk',
      columns: [table.organizationId, table.executionId],
      foreignColumns: [executions.organizationId, executions.id],
    }),
    foreignKey({
      name: 'execution_evidence_evidence_tenant_fk',
      columns: [table.organizationId, table.evidenceId],
      foreignColumns: [evidence.organizationId, evidence.id],
    }),
    check('execution_evidence_position_nonnegative', sql`${table.position} >= 0`),
  ],
)

export const gatewayCallbackEvidence = pgTable(
  'gateway_callback_evidence',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    callbackId: text('callback_id').notNull(),
    evidenceId: text('evidence_id').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'gateway_callback_evidence_pk',
      columns: [table.organizationId, table.callbackId, table.evidenceId],
    }),
    unique('gateway_callback_evidence_position_unique').on(
      table.organizationId,
      table.callbackId,
      table.position,
    ),
    foreignKey({
      name: 'gateway_callback_evidence_callback_tenant_fk',
      columns: [table.organizationId, table.callbackId],
      foreignColumns: [gatewayCallbacks.organizationId, gatewayCallbacks.id],
    }),
    foreignKey({
      name: 'gateway_callback_evidence_evidence_tenant_fk',
      columns: [table.organizationId, table.evidenceId],
      foreignColumns: [evidence.organizationId, evidence.id],
    }),
    check('gateway_callback_evidence_position_nonnegative', sql`${table.position} >= 0`),
  ],
)

export const gatewayEffectReconciliationPolls = pgTable(
  'gateway_effect_reconciliation_polls',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    commandId: text('command_id').notNull(),
    operationId: text('operation_id').notNull(),
    sequence: integer('sequence').notNull(),
    dispatchGeneration: integer('dispatch_generation').notNull(),
    observedDispatchStatus: gatewayDispatchStatusEnum('observed_dispatch_status').notNull(),
    observedEffectStatus: gatewayEffectStatusEnum('observed_effect_status').notNull(),
    cancellationRequested: boolean('cancellation_requested').notNull(),
    resolution: gatewayEffectReconciliationResolutionEnum('resolution').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'gateway_effect_reconciliation_polls_pk',
      columns: [table.organizationId, table.commandId, table.sequence],
    }),
    foreignKey({
      name: 'gateway_effect_reconciliation_polls_effect_fk',
      columns: [table.organizationId, table.commandId, table.operationId],
      foreignColumns: [
        gatewayEffects.organizationId,
        gatewayEffects.commandId,
        gatewayEffects.operationId,
      ],
    }),
    foreignKey({
      name: 'gateway_effect_reconciliation_polls_dispatch_fk',
      columns: [table.organizationId, table.commandId, table.dispatchGeneration],
      foreignColumns: [
        gatewayDispatches.organizationId,
        gatewayDispatches.commandId,
        gatewayDispatches.generation,
      ],
    }),
    check('gateway_effect_reconciliation_polls_sequence_positive', sql`${table.sequence} > 0`),
    check(
      'gateway_effect_reconciliation_polls_generation_positive',
      sql`${table.dispatchGeneration} > 0`,
    ),
  ],
)

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    topic: outboxTopicEnum('topic').notNull(),
    missionId: text('mission_id'),
    operationId: text('operation_id'),
    executionId: text('execution_id'),
    commandId: text('command_id'),
    dispatchGeneration: integer('dispatch_generation'),
    deduplicationKey: text('deduplication_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum('status').notNull().default('pending'),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    claimedBy: text('claimed_by'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    recordVersion: integer('record_version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique('outbox_messages_organization_id_id_unique').on(table.organizationId, table.id),
    unique('outbox_messages_deduplication_key_unique').on(
      table.organizationId,
      table.deduplicationKey,
    ),
    index('outbox_messages_claim_idx').on(table.status, table.availableAt, table.claimExpiresAt),
    foreignKey({
      name: 'outbox_messages_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    foreignKey({
      name: 'outbox_messages_operation_tenant_fk',
      columns: [table.organizationId, table.operationId],
      foreignColumns: [operations.organizationId, operations.id],
    }),
    foreignKey({
      name: 'outbox_messages_execution_tenant_fk',
      columns: [table.organizationId, table.executionId, table.missionId, table.operationId],
      foreignColumns: [
        executions.organizationId,
        executions.id,
        executions.missionId,
        executions.operationId,
      ],
    }),
    foreignKey({
      name: 'outbox_messages_command_operation_tenant_fk',
      columns: [table.organizationId, table.commandId, table.operationId],
      foreignColumns: [
        gatewayCommands.organizationId,
        gatewayCommands.id,
        gatewayCommands.operationId,
      ],
    }),
    foreignKey({
      name: 'outbox_messages_dispatch_generation_fk',
      columns: [table.organizationId, table.commandId, table.dispatchGeneration],
      foreignColumns: [
        gatewayDispatches.organizationId,
        gatewayDispatches.commandId,
        gatewayDispatches.generation,
      ],
    }),
    check('outbox_messages_delivery_attempts_nonnegative', sql`${table.deliveryAttempts} >= 0`),
    check('outbox_messages_record_version_positive', sql`${table.recordVersion} > 0`),
    check(
      'outbox_messages_claim_pair',
      sql`(${table.claimedBy} IS NULL) = (${table.claimExpiresAt} IS NULL)`,
    ),
    check(
      'outbox_messages_dispatched_at_valid',
      sql`(${table.status} = 'dispatched') = (${table.dispatchedAt} IS NOT NULL)`,
    ),
    check(
      'outbox_messages_reference_shape',
      sql`
        (${table.topic} = 'gateway.dispatch' AND ${table.missionId} IS NULL AND ${table.operationId} IS NOT NULL AND ${table.executionId} IS NULL AND ${table.commandId} IS NOT NULL AND ${table.dispatchGeneration} > 0)
        OR (${table.topic} = 'gateway.effect.reconcile' AND ${table.missionId} IS NULL AND ${table.operationId} IS NOT NULL AND ${table.executionId} IS NULL AND ${table.commandId} IS NOT NULL AND ${table.dispatchGeneration} > 0)
        OR (${table.topic} = 'execution.deadline' AND ${table.missionId} IS NOT NULL AND ${table.operationId} IS NOT NULL AND ${table.executionId} IS NOT NULL AND ${table.commandId} IS NULL AND ${table.dispatchGeneration} IS NULL)
        OR (${table.topic} = 'execution.identity-arrival' AND ${table.missionId} IS NOT NULL AND ${table.operationId} IS NOT NULL AND ${table.executionId} IS NOT NULL AND ${table.commandId} IS NULL AND ${table.dispatchGeneration} IS NULL)
        OR (${table.topic} IN ('mission.resume', 'mission.verify') AND ${table.missionId} IS NOT NULL AND ${table.operationId} IS NULL AND ${table.executionId} IS NULL AND ${table.commandId} IS NULL AND ${table.dispatchGeneration} IS NULL)
        OR (${table.topic} = 'operation.reconcile' AND ${table.missionId} IS NULL AND ${table.operationId} IS NOT NULL AND ${table.executionId} IS NULL AND ${table.commandId} IS NULL AND ${table.dispatchGeneration} IS NULL)
      `,
    ),
    check(
      'outbox_messages_reference_payload_only',
      sql`
        (${table.topic} IN ('gateway.dispatch', 'gateway.effect.reconcile') AND ${table.payload} = jsonb_build_object('organizationId', ${table.organizationId}, 'operationId', ${table.operationId}, 'commandId', ${table.commandId}, 'generation', ${table.dispatchGeneration}))
        OR (${table.topic} = 'execution.deadline' AND ${table.payload} = jsonb_build_object('organizationId', ${table.organizationId}, 'missionId', ${table.missionId}, 'operationId', ${table.operationId}, 'executionId', ${table.executionId}))
        OR (${table.topic} = 'execution.identity-arrival' AND ${table.payload} = jsonb_build_object('organizationId', ${table.organizationId}, 'missionId', ${table.missionId}, 'operationId', ${table.operationId}, 'executionId', ${table.executionId}, 'evidenceId', ${table.payload} ->> 'evidenceId') AND ${table.payload} ->> 'evidenceId' ~ '^evd_[a-z0-9][a-z0-9_-]{7,63}$')
        OR (${table.topic} IN ('mission.resume', 'mission.verify') AND ${table.payload} = jsonb_build_object('organizationId', ${table.organizationId}, 'missionId', ${table.missionId}))
        OR (${table.topic} = 'operation.reconcile' AND ${table.payload} = jsonb_build_object('organizationId', ${table.organizationId}, 'operationId', ${table.operationId}, 'attemptId', ${table.payload} ->> 'attemptId') AND ${table.payload} ->> 'attemptId' ~ '^att_[a-z0-9][a-z0-9_-]{7,63}$')
      `,
    ),
  ],
)

export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    source: text('source').notNull().default('application_code'),
    status: verificationStatusEnum('status').notNull(),
    planHash: char('plan_hash', { length: 64 }).notNull(),
    assertions: jsonb('assertions').$type<VerificationAssertion[]>().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    unique('verifications_organization_id_id_unique').on(table.organizationId, table.id),
    unique('verifications_mission_unique').on(table.organizationId, table.missionId),
    foreignKey({
      name: 'verifications_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    check('verifications_application_source', sql`${table.source} = 'application_code'`),
    check('verifications_plan_hash_valid', sql`${table.planHash} ~ '^[a-f0-9]{64}$'`),
  ],
)

export const contextReceipts = pgTable(
  'context_receipts',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    runId: text('run_id').notNull(),
    policyHash: char('policy_hash', { length: 64 }).notNull(),
    toolRegistryHash: char('tool_registry_hash', { length: 64 }).notNull(),
    sources: jsonb('sources').$type<ContextSourceReceipt[]>().notNull(),
    ...timestamps,
  },
  (table) => [
    unique('context_receipts_organization_id_id_unique').on(table.organizationId, table.id),
    unique('context_receipts_mission_run_unique').on(
      table.organizationId,
      table.missionId,
      table.runId,
    ),
    foreignKey({
      name: 'context_receipts_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    check(
      'context_receipts_hashes_valid',
      sql`${table.policyHash} ~ '^[a-f0-9]{64}$' AND ${table.toolRegistryHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
)

export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').references(() => organizations.id),
    version: text('version').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    canonicalUri: text('canonical_uri').notNull(),
    audiences: text('audiences').array().notNull(),
    phases: missionPhaseEnum('phases').array().notNull(),
    risk: text('risk').notNull(),
    visibility: text('visibility').notNull(),
    sensitivity: text('sensitivity').notNull(),
    tenantScoped: boolean('tenant_scoped').notNull(),
    publishable: boolean('publishable').notNull(),
    instructionRole: text('instruction_role').notNull(),
    retention: text('retention').notNull(),
    sourceHash: char('source_hash', { length: 64 }).notNull(),
    searchDocument: tsvector('search_document')
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('english', coalesce(${sql.raw('title')}, '')), 'A') || setweight(to_tsvector('english', coalesce(${sql.raw('content')}, '')), 'B')`,
      )
      .notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('knowledge_sources_tenant_idx').on(table.organizationId, table.id),
    index('knowledge_sources_search_idx').using('gin', table.searchDocument),
    check('knowledge_sources_id_format', sql`${table.id} ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'`),
    check(
      'knowledge_sources_version_format',
      sql`${table.version} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$'`,
    ),
    check('knowledge_sources_title_length', sql`char_length(${table.title}) BETWEEN 1 AND 200`),
    check(
      'knowledge_sources_content_length',
      sql`char_length(${table.content}) BETWEEN 1 AND 200000`,
    ),
    check(
      'knowledge_sources_scope_valid',
      sql`(${table.organizationId} IS NULL AND ${table.tenantScoped} IS FALSE AND ${table.visibility} IN ('public', 'internal')) OR (${table.organizationId} IS NOT NULL AND ${table.tenantScoped} IS TRUE AND ${table.visibility} = 'tenant')`,
    ),
    check(
      'knowledge_sources_metadata_valid',
      sql`${table.risk} IN ('read', 'reversible-write', 'consequential-write') AND ${table.sensitivity} IN ('public', 'internal', 'confidential') AND ${table.instructionRole} IN ('procedure', 'reference', 'untrusted_evidence') AND ${table.retention} IN ('versioned', 'ephemeral')`,
    ),
    check(
      'knowledge_sources_arrays_present',
      sql`cardinality(${table.audiences}) > 0 AND cardinality(${table.phases}) > 0`,
    ),
    check('knowledge_sources_hash_valid', sql`${table.sourceHash} ~ '^[a-f0-9]{64}$'`),
  ],
)

export const toolInvocations = pgTable(
  'tool_invocations',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    callId: text('call_id').notNull(),
    toolName: text('tool_name').$type<ToolCallReceipt['toolName']>().notNull(),
    channel: text('channel').$type<ToolCallReceipt['channel']>().notNull(),
    inputHash: char('input_hash', { length: 64 }).notNull(),
    principalScopeHash: char('principal_scope_hash', { length: 64 }).notNull(),
    toolContractHash: char('tool_contract_hash', { length: 64 }).notNull(),
    toolRegistryHash: char('tool_registry_hash', { length: 64 }).notNull(),
    resultSchemaHash: char('result_schema_hash', { length: 64 }).notNull(),
    bindingHash: char('binding_hash', { length: 64 }).notNull(),
    executionClass: toolInvocationExecutionClassEnum('execution_class').notNull(),
    receiptId: text('receipt_id').notNull(),
    status: toolInvocationStatusEnum('status').notNull(),
    disposition: toolInvocationDispositionEnum('disposition').notNull(),
    generation: integer('generation').notNull(),
    ownerTokenHash: char('owner_token_hash', { length: 64 }).notNull(),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }).notNull(),
    result: jsonb('result').$type<ToolResultEnvelope>(),
    resultHash: char('result_hash', { length: 64 }),
    attemptId: text('attempt_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ name: 'tool_invocations_pk', columns: [table.organizationId, table.callId] }),
    unique('tool_invocations_receipt_id_unique').on(table.receiptId),
    foreignKey({
      name: 'tool_invocations_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    foreignKey({
      name: 'tool_invocations_attempt_tenant_fk',
      columns: [table.organizationId, table.attemptId],
      foreignColumns: [attempts.organizationId, attempts.id],
    }),
    index('tool_invocations_claim_idx').on(
      table.organizationId,
      table.status,
      table.claimExpiresAt,
    ),
    check(
      'tool_invocations_call_id_format',
      sql`${table.callId} ~ '^call_[a-z0-9][a-z0-9_-]{7,63}$'`,
    ),
    check(
      'tool_invocations_receipt_id_format',
      sql`${table.receiptId} ~ '^rcp_[a-z0-9][a-z0-9_-]{7,63}$'`,
    ),
    check(
      'tool_invocations_tool_name',
      sql`${table.toolName} IN ('palaces.get', 'crews.list', 'capabilities.list', 'routines.list', 'routines.get', 'executions.list', 'knowledge.search', 'plans.propose', 'plans.validate', 'plans.simulate', 'plans.request_approval', 'plans.activate', 'operations.get', 'verification.get_evidence', 'missions.cancel')`,
    ),
    check('tool_invocations_channel', sql`${table.channel} IN ('in_process', 'http', 'mcp')`),
    check(
      'tool_invocations_hashes_valid',
      sql`${table.inputHash} ~ '^[a-f0-9]{64}$' AND ${table.principalScopeHash} ~ '^[a-f0-9]{64}$' AND ${table.toolContractHash} ~ '^[a-f0-9]{64}$' AND ${table.toolRegistryHash} ~ '^[a-f0-9]{64}$' AND ${table.resultSchemaHash} ~ '^[a-f0-9]{64}$' AND ${table.bindingHash} ~ '^[a-f0-9]{64}$' AND ${table.ownerTokenHash} ~ '^[a-f0-9]{64}$' AND (${table.resultHash} IS NULL OR ${table.resultHash} ~ '^[a-f0-9]{64}$')`,
    ),
    check('tool_invocations_generation_positive', sql`${table.generation} > 0`),
    check(
      'tool_invocations_claim_window',
      sql`${table.claimExpiresAt} > ${table.startedAt} AND ${table.updatedAt} >= ${table.startedAt}`,
    ),
    check(
      'tool_invocations_state_shape',
      sql`(${table.status} = 'claimed' AND ${table.result} IS NULL AND ${table.resultHash} IS NULL AND ${table.attemptId} IS NULL AND ${table.completedAt} IS NULL) OR (${table.status} = 'completed' AND ${table.result} IS NOT NULL AND ${table.resultHash} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.completedAt} >= ${table.startedAt})`,
    ),
    check(
      'tool_invocations_result_binding',
      sql`${table.result} IS NULL OR (${table.result} ->> 'schemaVersion' = 'tool-result@1' AND ${table.result} ->> 'toolName' = ${table.toolName} AND ${table.result} ->> 'callId' = ${table.callId} AND ${table.result} ->> 'receiptId' = ${table.receiptId})`,
    ),
    check(
      'tool_invocations_unknown_resolution',
      sql`${table.disposition} = 'execute' OR ${table.status} = 'claimed' OR ${table.result} ->> 'status' = 'unknown'`,
    ),
  ],
)

export const toolInvocationEvidence = pgTable(
  'tool_invocation_evidence',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    callId: text('call_id').notNull(),
    evidenceId: text('evidence_id').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'tool_invocation_evidence_pk',
      columns: [table.organizationId, table.callId, table.evidenceId],
    }),
    unique('tool_invocation_evidence_position_unique').on(
      table.organizationId,
      table.callId,
      table.position,
    ),
    foreignKey({
      name: 'tool_invocation_evidence_invocation_tenant_fk',
      columns: [table.organizationId, table.callId],
      foreignColumns: [toolInvocations.organizationId, toolInvocations.callId],
    }),
    foreignKey({
      name: 'tool_invocation_evidence_evidence_tenant_fk',
      columns: [table.organizationId, table.evidenceId],
      foreignColumns: [evidence.organizationId, evidence.id],
    }),
    check('tool_invocation_evidence_position_nonnegative', sql`${table.position} >= 0`),
  ],
)

export const toolCallReceipts = pgTable(
  'tool_call_receipts',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    schemaVersion: text('schema_version').notNull().default('tool-call-receipt@1'),
    callId: text('call_id').notNull(),
    toolName: text('tool_name').$type<ToolCallReceipt['toolName']>().notNull(),
    status: text('status').$type<ToolCallReceipt['status']>().notNull(),
    channel: text('channel').$type<ToolCallReceipt['channel']>().notNull(),
    tenantScopeHash: char('tenant_scope_hash', { length: 64 }).notNull(),
    inputHash: char('input_hash', { length: 64 }).notNull(),
    resultHash: char('result_hash', { length: 64 }).notNull(),
    toolContractHash: char('tool_contract_hash', { length: 64 }).notNull(),
    toolRegistryHash: char('tool_registry_hash', { length: 64 }).notNull(),
    attemptId: text('attempt_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('tool_call_receipts_organization_id_id_unique').on(table.organizationId, table.id),
    unique('tool_call_receipts_call_unique').on(table.organizationId, table.callId),
    foreignKey({
      name: 'tool_call_receipts_attempt_tenant_fk',
      columns: [table.organizationId, table.attemptId],
      foreignColumns: [attempts.organizationId, attempts.id],
    }),
    check('tool_call_receipts_schema_version', sql`${table.schemaVersion} = 'tool-call-receipt@1'`),
    check('tool_call_receipts_id_format', sql`${table.id} ~ '^rcp_[a-z0-9][a-z0-9_-]{7,63}$'`),
    check(
      'tool_call_receipts_call_id_format',
      sql`${table.callId} ~ '^call_[a-z0-9][a-z0-9_-]{7,63}$'`,
    ),
    check(
      'tool_call_receipts_tool_name',
      sql`${table.toolName} IN ('palaces.get', 'crews.list', 'capabilities.list', 'routines.list', 'routines.get', 'executions.list', 'knowledge.search', 'plans.propose', 'plans.validate', 'plans.simulate', 'plans.request_approval', 'plans.activate', 'operations.get', 'verification.get_evidence', 'missions.cancel')`,
    ),
    check(
      'tool_call_receipts_status',
      sql`${table.status} IN ('succeeded', 'pending', 'denied', 'conflict', 'unknown', 'failed')`,
    ),
    check('tool_call_receipts_channel', sql`${table.channel} IN ('in_process', 'http', 'mcp')`),
    check(
      'tool_call_receipts_hashes_valid',
      sql`${table.tenantScopeHash} ~ '^[a-f0-9]{64}$' AND ${table.inputHash} ~ '^[a-f0-9]{64}$' AND ${table.resultHash} ~ '^[a-f0-9]{64}$' AND ${table.toolContractHash} ~ '^[a-f0-9]{64}$' AND ${table.toolRegistryHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check('tool_call_receipts_time_order', sql`${table.completedAt} >= ${table.startedAt}`),
  ],
)

export const toolCallReceiptEvidence = pgTable(
  'tool_call_receipt_evidence',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    receiptId: text('receipt_id').notNull(),
    evidenceId: text('evidence_id').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'tool_call_receipt_evidence_pk',
      columns: [table.organizationId, table.receiptId, table.evidenceId],
    }),
    unique('tool_call_receipt_evidence_position_unique').on(
      table.organizationId,
      table.receiptId,
      table.position,
    ),
    foreignKey({
      name: 'tool_call_receipt_evidence_receipt_tenant_fk',
      columns: [table.organizationId, table.receiptId],
      foreignColumns: [toolCallReceipts.organizationId, toolCallReceipts.id],
    }),
    foreignKey({
      name: 'tool_call_receipt_evidence_evidence_tenant_fk',
      columns: [table.organizationId, table.evidenceId],
      foreignColumns: [evidence.organizationId, evidence.id],
    }),
    check('tool_call_receipt_evidence_position_nonnegative', sql`${table.position} >= 0`),
  ],
)

export const contextRuns = pgTable(
  'context_runs',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    missionRef: text('mission_ref').notNull(),
    runId: text('run_id').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'context_runs_pk', columns: [table.organizationId, table.runId] }),
    unique('context_runs_tenant_mission_run_unique').on(
      table.organizationId,
      table.missionId,
      table.runId,
    ),
    foreignKey({
      name: 'context_runs_mission_tenant_fk',
      columns: [table.organizationId, table.missionId],
      foreignColumns: [missions.organizationId, missions.id],
    }),
    check('context_runs_run_id_format', sql`${table.runId} ~ '^run_[a-z0-9][a-z0-9_-]{7,63}$'`),
    check(
      'context_runs_mission_ref_format',
      sql`${table.missionRef} ~ '^mission_[a-z0-9][a-z0-9_-]{7,151}$'`,
    ),
  ],
)

export const contextArtifacts = pgTable(
  'context_artifacts',
  {
    id: text('id').notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    missionId: text('mission_id').notNull(),
    runId: text('run_id').notNull(),
    kind: contextArtifactKindEnum('kind').notNull(),
    artifactHash: char('artifact_hash', { length: 64 }).notNull(),
    payload: jsonb('payload').$type<RichContextArtifactPayload>().notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: 'context_artifacts_pk',
      columns: [table.organizationId, table.missionId, table.runId, table.kind, table.id],
    }),
    unique('context_artifacts_tenant_kind_id_unique').on(
      table.organizationId,
      table.kind,
      table.id,
    ),
    index('context_artifacts_run_idx').on(
      table.organizationId,
      table.missionId,
      table.runId,
      table.createdAt,
    ),
    foreignKey({
      name: 'context_artifacts_run_tenant_fk',
      columns: [table.organizationId, table.missionId, table.runId],
      foreignColumns: [contextRuns.organizationId, contextRuns.missionId, contextRuns.runId],
    }),
    check('context_artifacts_id_format', sql`${table.id} ~ '^[a-z][a-z0-9._-]{2,159}$'`),
    check(
      'context_artifacts_run_id_format',
      sql`${table.runId} ~ '^run_[a-z0-9][a-z0-9_-]{7,63}$'`,
    ),
    check('context_artifacts_hash_valid', sql`${table.artifactHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'context_artifacts_payload_binding',
      sql`${table.payload} ->> 'schemaVersion' = '1.0.0' AND CASE ${table.kind} WHEN 'request' THEN ${table.payload} ->> 'requestId' = ${table.id} WHEN 'bundle' THEN ${table.payload} ->> 'bundleId' = ${table.id} WHEN 'manifest' THEN ${table.payload} ->> 'manifestId' = ${table.id} WHEN 'internal_receipt' THEN ${table.payload} ->> 'receiptId' = ${table.id} WHEN 'public_receipt' THEN ${table.payload} ->> 'receiptId' = ${table.id} ELSE FALSE END`,
    ),
  ],
)

export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    sequence: integer('sequence').notNull(),
    eventType: text('event_type').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('audit_events_organization_id_id_unique').on(table.organizationId, table.id),
    unique('audit_events_aggregate_sequence_unique').on(
      table.organizationId,
      table.aggregateType,
      table.aggregateId,
      table.sequence,
    ),
    index('audit_events_aggregate_idx').on(
      table.organizationId,
      table.aggregateType,
      table.aggregateId,
    ),
    check('audit_events_sequence_nonnegative', sql`${table.sequence} >= 0`),
  ],
)

export type ApprovalProtectedResourceRow = typeof approvalProtectedResources.$inferSelect
export type PlanActionRow = typeof planActions.$inferSelect
export type OutboxMessageRow = typeof outboxMessages.$inferSelect
export type OperationRow = typeof operations.$inferSelect
export type ProtectedResourceInput = ProtectedResourceVersion

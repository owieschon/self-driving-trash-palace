CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'invalidated');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('pending', 'succeeded', 'unknown', 'failed');--> statement-breakpoint
CREATE TYPE "public"."attempt_transport" AS ENUM('http', 'mcp', 'worker', 'gateway');--> statement-breakpoint
CREATE TYPE "public"."cancellation_checkpoint" AS ENUM('before_operation', 'unclaimed_operation', 'claimed_or_committed', 'gateway_dispatched', 'durable_effect');--> statement-breakpoint
CREATE TYPE "public"."cancellation_outcome" AS ENUM('cancelled_without_mutation', 'cancelled_unclaimed_operations', 'stopped_remaining_actions', 'reconcile_dispatched_effect', 'compensating_plan_required');--> statement-breakpoint
CREATE TYPE "public"."capability_kind" AS ENUM('lock_desired_state', 'pathway_lighting', 'temperature_target', 'battery_projection');--> statement-breakpoint
CREATE TYPE "public"."device_health" AS ENUM('online', 'degraded', 'offline');--> statement-breakpoint
CREATE TYPE "public"."device_kind" AS ENUM('lock', 'pathway_light', 'thermostat', 'battery_meter');--> statement-breakpoint
CREATE TYPE "public"."evidence_type" AS ENUM('identity_arrival', 'device_command', 'temperature_observation', 'lighting_observation', 'lock_observation', 'battery_projection', 'routine_state', 'tenant_access_audit', 'gateway_delivery');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('scheduled', 'running', 'observed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."gateway_callback_status" AS ENUM('acknowledged', 'executing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."gateway_command_kind" AS ENUM('set_temperature', 'set_lighting', 'unlock', 'locked_desired_state');--> statement-breakpoint
CREATE TYPE "public"."gateway_command_status" AS ENUM('queued', 'dispatched', 'acknowledged', 'executing', 'completed', 'unknown', 'failed', 'cancellation_requested');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'operator', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."mission_phase" AS ENUM('understand', 'plan', 'validate', 'approve', 'execute', 'reconcile', 'observe', 'verify');--> statement-breakpoint
CREATE TYPE "public"."mission_status" AS ENUM('queued', 'running', 'waiting_for_user', 'waiting_for_system', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."mission_transition_event" AS ENUM('lease_acquired', 'context_sufficient', 'material_ambiguity', 'clarification_answered', 'user_response_expired', 'candidate_persisted', 'validation_failed', 'validation_passed', 'approval_rejected', 'approval_expired_or_stale', 'approval_granted', 'execution_committed', 'execution_unknown', 'execution_non_retryable_failure', 'reconcile_commit_found', 'reconcile_absent_retryable', 'reconcile_budget_exhausted', 'reconcile_retry_authorized', 'reconcile_stopped', 'evidence_arrived', 'observation_deadline_expired', 'verification_passed', 'safe_correction_available', 'intervention_required', 'corrective_work_requested', 'terminal_result_acknowledged', 'lease_lost', 'cancel_requested', 'cancel_reconciliation_required', 'cancel_reconciliation_completed');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('pending', 'claimed', 'committed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'claimed', 'dispatched', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."outbox_topic" AS ENUM('gateway.callback', 'mission.resume', 'mission.verify', 'operation.dispatch', 'operation.reconcile');--> statement-breakpoint
CREATE TYPE "public"."plan_action_type" AS ENUM('replace_homecoming_routine', 'restore_routine_version');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('candidate', 'validated', 'awaiting_approval', 'approved', 'superseded', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_resolution" AS ENUM('committed', 'definitely_absent', 'still_unknown', 'failed');--> statement-breakpoint
CREATE TYPE "public"."routine_status" AS ENUM('draft', 'active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('passed', 'failed');--> statement-breakpoint
CREATE TABLE "access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"issued_by" text,
	"token_hash" char(64) NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "access_tokens_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "access_tokens_expiry_valid" CHECK ("access_tokens"."expires_at" > "access_tokens"."created_at"),
	CONSTRAINT "access_tokens_hash_valid" CHECK ("access_tokens"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "access_tokens_scopes_present" CHECK (cardinality("access_tokens"."scopes") > 0)
);
--> statement-breakpoint
CREATE TABLE "approval_actions" (
	"organization_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"action_id" text NOT NULL,
	CONSTRAINT "approval_actions_pk" PRIMARY KEY("organization_id","approval_id","action_id"),
	CONSTRAINT "approval_actions_operation_reference_unique" UNIQUE("organization_id","approval_id","plan_id","action_id")
);
--> statement-breakpoint
CREATE TABLE "approval_protected_resources" (
	"organization_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"routine_id" text NOT NULL,
	"routine_version_id" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "approval_protected_resources_pk" PRIMARY KEY("organization_id","approval_id","routine_id"),
	CONSTRAINT "approval_protected_resources_version_positive" CHECK ("approval_protected_resources"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"plan_hash" char(64) NOT NULL,
	"status" "approval_status" NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"approver_role" "membership_role",
	"nonce" text NOT NULL,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"record_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "approvals_tenant_mission_plan_id_unique" UNIQUE("organization_id","mission_id","plan_id","id"),
	CONSTRAINT "approvals_tenant_id_plan_unique" UNIQUE("organization_id","id","plan_id"),
	CONSTRAINT "approvals_nonce_unique" UNIQUE("organization_id","nonce"),
	CONSTRAINT "approvals_hash_valid" CHECK ("approvals"."plan_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "approvals_expiry_window" CHECK ("approvals"."expires_at" > "approvals"."created_at" AND "approvals"."expires_at" <= "approvals"."created_at" + interval '15 minutes'),
	CONSTRAINT "approvals_record_version_positive" CHECK ("approvals"."record_version" > 0),
	CONSTRAINT "approvals_approved_fields" CHECK (("approvals"."status" = 'approved' AND "approvals"."approved_by" IS NOT NULL AND "approvals"."approver_role" IN ('owner', 'operator') AND "approvals"."approved_at" IS NOT NULL) OR ("approvals"."status" <> 'approved' AND "approvals"."approved_by" IS NULL AND "approvals"."approver_role" IS NULL AND "approvals"."approved_at" IS NULL)),
	CONSTRAINT "approvals_approved_time" CHECK ("approvals"."approved_at" IS NULL OR ("approvals"."approved_at" >= "approvals"."created_at" AND "approvals"."approved_at" < "approvals"."expires_at"))
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"transport" "attempt_transport" NOT NULL,
	"status" "attempt_status" NOT NULL,
	"retryable" boolean NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"record_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "attempts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "attempts_operation_sequence_unique" UNIQUE("organization_id","operation_id","sequence"),
	CONSTRAINT "attempts_sequence_positive" CHECK ("attempts"."sequence" > 0),
	CONSTRAINT "attempts_record_version_positive" CHECK ("attempts"."record_version" > 0),
	CONSTRAINT "attempts_completion_valid" CHECK (("attempts"."status" = 'pending' AND "attempts"."completed_at" IS NULL) OR ("attempts"."status" <> 'pending' AND "attempts"."completed_at" IS NOT NULL)),
	CONSTRAINT "attempts_error_pair" CHECK (("attempts"."error_code" IS NULL) = ("attempts"."error_message" IS NULL)),
	CONSTRAINT "attempts_success_has_no_error" CHECK ("attempts"."status" <> 'succeeded' OR ("attempts"."error_code" IS NULL AND "attempts"."error_message" IS NULL)),
	CONSTRAINT "attempts_error_required" CHECK ("attempts"."status" NOT IN ('unknown', 'failed') OR ("attempts"."error_code" IS NOT NULL AND "attempts"."error_message" IS NOT NULL)),
	CONSTRAINT "attempts_pending_has_no_error" CHECK ("attempts"."status" <> 'pending' OR ("attempts"."error_code" IS NULL AND "attempts"."error_message" IS NULL)),
	CONSTRAINT "attempts_unknown_retryable" CHECK ("attempts"."status" <> 'unknown' OR "attempts"."retryable")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_events_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "audit_events_aggregate_sequence_unique" UNIQUE("organization_id","aggregate_type","aggregate_id","sequence"),
	CONSTRAINT "audit_events_sequence_nonnegative" CHECK ("audit_events"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cancellations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"checkpoint" "cancellation_checkpoint" NOT NULL,
	"outcome" "cancellation_outcome" NOT NULL,
	"compensating_plan_required" boolean NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cancellations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "cancellations_mission_unique" UNIQUE("organization_id","mission_id"),
	CONSTRAINT "cancellations_compensation_consistent" CHECK ("cancellations"."compensating_plan_required" = ("cancellations"."outcome" = 'compensating_plan_required'))
);
--> statement-breakpoint
CREATE TABLE "capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"device_id" text NOT NULL,
	"kind" "capability_kind" NOT NULL,
	"enabled" boolean NOT NULL,
	"constraints" jsonb NOT NULL,
	"record_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "capabilities_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "capabilities_device_kind_unique" UNIQUE("organization_id","device_id","kind"),
	CONSTRAINT "capabilities_record_version_positive" CHECK ("capabilities"."record_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "compensating_plan_links" (
	"organization_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"action_id" text NOT NULL,
	"compensates_operation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compensating_plan_links_pk" PRIMARY KEY("organization_id","plan_id")
);
--> statement-breakpoint
CREATE TABLE "context_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"run_id" text NOT NULL,
	"policy_hash" char(64) NOT NULL,
	"tool_registry_hash" char(64) NOT NULL,
	"sources" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_receipts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "context_receipts_mission_run_unique" UNIQUE("organization_id","mission_id","run_id"),
	CONSTRAINT "context_receipts_hashes_valid" CHECK ("context_receipts"."policy_hash" ~ '^[a-f0-9]{64}$' AND "context_receipts"."tool_registry_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "crew_members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"palace_id" text NOT NULL,
	"user_id" text,
	"display_name" text NOT NULL,
	"active" boolean NOT NULL,
	"record_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "crew_members_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "crew_members_record_version_positive" CHECK ("crew_members"."record_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"palace_id" text NOT NULL,
	"kind" "device_kind" NOT NULL,
	"name" text NOT NULL,
	"health" "device_health" NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "devices_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "devices_version_positive" CHECK ("devices"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"palace_id" text NOT NULL,
	"type" "evidence_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "execution_evidence" (
	"organization_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "execution_evidence_pk" PRIMARY KEY("organization_id","execution_id","evidence_id"),
	CONSTRAINT "execution_evidence_position_unique" UNIQUE("organization_id","execution_id","position"),
	CONSTRAINT "execution_evidence_position_nonnegative" CHECK ("execution_evidence"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"routine_id" text NOT NULL,
	"routine_version_id" text NOT NULL,
	"status" "execution_status" NOT NULL,
	"triggered_by_evidence_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"record_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "executions_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "executions_operation_unique" UNIQUE("organization_id","operation_id"),
	CONSTRAINT "executions_record_version_positive" CHECK ("executions"."record_version" > 0),
	CONSTRAINT "executions_completion_valid" CHECK (("executions"."status" IN ('scheduled', 'running') AND "executions"."completed_at" IS NULL) OR ("executions"."status" IN ('observed', 'failed') AND "executions"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "gateway_callback_evidence" (
	"organization_id" text NOT NULL,
	"callback_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "gateway_callback_evidence_pk" PRIMARY KEY("organization_id","callback_id","evidence_id"),
	CONSTRAINT "gateway_callback_evidence_position_unique" UNIQUE("organization_id","callback_id","position"),
	CONSTRAINT "gateway_callback_evidence_position_nonnegative" CHECK ("gateway_callback_evidence"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "gateway_callbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"command_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"nonce" text NOT NULL,
	"status" "gateway_callback_status" NOT NULL,
	"verifier_key_id" text NOT NULL,
	"verifier_version" integer NOT NULL,
	"verified_payload_digest" char(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gateway_callbacks_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "gateway_callbacks_nonce_unique" UNIQUE("organization_id","nonce"),
	CONSTRAINT "gateway_callbacks_verifier_version" CHECK ("gateway_callbacks"."verifier_version" = 1),
	CONSTRAINT "gateway_callbacks_verifier_key" CHECK ("gateway_callbacks"."verifier_key_id" ~ '^gwk_[A-Za-z0-9_-]{8,64}$'),
	CONSTRAINT "gateway_callbacks_digest_valid" CHECK ("gateway_callbacks"."verified_payload_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "gateway_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_version" text DEFAULT 'gateway-command@1' NOT NULL,
	"organization_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"palace_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" "gateway_command_kind" NOT NULL,
	"payload_hash" char(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "gateway_command_status" DEFAULT 'queued' NOT NULL,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"record_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_commands_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "gateway_commands_tenant_id_operation_unique" UNIQUE("organization_id","id","operation_id"),
	CONSTRAINT "gateway_commands_operation_sequence_unique" UNIQUE("organization_id","operation_id","sequence"),
	CONSTRAINT "gateway_commands_sequence_positive" CHECK ("gateway_commands"."sequence" > 0),
	CONSTRAINT "gateway_commands_schema_version" CHECK ("gateway_commands"."schema_version" = 'gateway-command@1'),
	CONSTRAINT "gateway_commands_payload_hash_valid" CHECK ("gateway_commands"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "gateway_commands_record_version_positive" CHECK ("gateway_commands"."record_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "identity_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"crew_member_id" text,
	"label" text NOT NULL,
	"verified" boolean NOT NULL,
	"active" boolean NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "identity_tags_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "identity_tags_version_positive" CHECK ("identity_tags"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"grants" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "memberships_organization_id_user_id_unique" UNIQUE("organization_id","id","user_id"),
	CONSTRAINT "memberships_organization_user_unique" UNIQUE("organization_id","user_id"),
	CONSTRAINT "memberships_id_format" CHECK ("memberships"."id" ~ '^mem_[a-z0-9][a-z0-9_-]{7,63}$'),
	CONSTRAINT "memberships_grants_valid" CHECK (("memberships"."role" = 'operator' AND "memberships"."grants" <@ ARRAY['routine:approve']::text[]) OR cardinality("memberships"."grants") = 0)
);
--> statement-breakpoint
CREATE TABLE "mission_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event" "mission_transition_event" NOT NULL,
	"from_status" "mission_status" NOT NULL,
	"from_phase" "mission_phase" NOT NULL,
	"to_status" "mission_status" NOT NULL,
	"to_phase" "mission_phase" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mission_events_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "mission_events_mission_sequence_unique" UNIQUE("organization_id","mission_id","sequence"),
	CONSTRAINT "mission_events_sequence_nonnegative" CHECK ("mission_events"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mission_leases" (
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"token" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"renewed_at" timestamp with time zone NOT NULL,
	"record_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "mission_leases_pk" PRIMARY KEY("organization_id","mission_id"),
	CONSTRAINT "mission_leases_expiry_valid" CHECK ("mission_leases"."expires_at" > "mission_leases"."renewed_at"),
	CONSTRAINT "mission_leases_record_version_positive" CHECK ("mission_leases"."record_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"palace_id" text NOT NULL,
	"initiated_by" text NOT NULL,
	"objective" text NOT NULL,
	"constraints" jsonb NOT NULL,
	"success_criteria_ids" text[] NOT NULL,
	"status" "mission_status" NOT NULL,
	"phase" "mission_phase" NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"run_id" text,
	"context_receipt_id" text,
	"task_ledger" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missions_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "missions_version_nonnegative" CHECK ("missions"."version" >= 0),
	CONSTRAINT "missions_success_criteria_present" CHECK (cardinality("missions"."success_criteria_ids") > 0)
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"plan_action_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"payload_hash" char(64) NOT NULL,
	"server_created" boolean DEFAULT true NOT NULL,
	"status" "operation_status" DEFAULT 'pending' NOT NULL,
	"outcome" jsonb,
	"claimed_by" text,
	"claimed_until" timestamp with time zone,
	"cancellation_requested_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"record_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "operations_tenant_id_mission_unique" UNIQUE("organization_id","id","mission_id"),
	CONSTRAINT "operations_plan_action_unique" UNIQUE("organization_id","plan_id","plan_action_id"),
	CONSTRAINT "operations_payload_hash_valid" CHECK ("operations"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "operations_server_created" CHECK ("operations"."server_created"),
	CONSTRAINT "operations_record_version_positive" CHECK ("operations"."record_version" > 0),
	CONSTRAINT "operations_committed_fields" CHECK (("operations"."status" = 'committed' AND "operations"."outcome" IS NOT NULL AND "operations"."committed_at" IS NOT NULL) OR ("operations"."status" <> 'committed' AND "operations"."outcome" IS NULL AND "operations"."committed_at" IS NULL)),
	CONSTRAINT "operations_claim_pair" CHECK (("operations"."claimed_by" IS NULL) = ("operations"."claimed_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"lab_tenant" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_id_format" CHECK ("organizations"."id" ~ '^org_[a-z0-9][a-z0-9_-]{7,63}$')
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"topic" "outbox_topic" NOT NULL,
	"operation_id" text,
	"deduplication_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claim_expires_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"last_error_code" text,
	"record_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_messages_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "outbox_messages_deduplication_key_unique" UNIQUE("organization_id","deduplication_key"),
	CONSTRAINT "outbox_messages_delivery_attempts_nonnegative" CHECK ("outbox_messages"."delivery_attempts" >= 0),
	CONSTRAINT "outbox_messages_record_version_positive" CHECK ("outbox_messages"."record_version" > 0),
	CONSTRAINT "outbox_messages_claim_pair" CHECK (("outbox_messages"."claimed_by" IS NULL) = ("outbox_messages"."claim_expires_at" IS NULL)),
	CONSTRAINT "outbox_messages_dispatched_at_valid" CHECK (("outbox_messages"."status" = 'dispatched') = ("outbox_messages"."dispatched_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "palaces" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"battery_available_percentage" double precision NOT NULL,
	"record_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "palaces_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "palaces_battery_range" CHECK ("palaces"."battery_available_percentage" >= 0 AND "palaces"."battery_available_percentage" <= 100),
	CONSTRAINT "palaces_record_version_positive" CHECK ("palaces"."record_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "plan_actions" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"position" integer NOT NULL,
	"type" "plan_action_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_actions_pk" PRIMARY KEY("organization_id","plan_id","id"),
	CONSTRAINT "plan_actions_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "plan_actions_plan_position_unique" UNIQUE("organization_id","plan_id","position"),
	CONSTRAINT "plan_actions_position_nonnegative" CHECK ("plan_actions"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "plan_simulations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"feasible" boolean NOT NULL,
	"projected_battery_use_percentage_points" double precision NOT NULL,
	"results" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_simulations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "plan_simulations_battery_range" CHECK ("plan_simulations"."projected_battery_use_percentage_points" >= 0 AND "plan_simulations"."projected_battery_use_percentage_points" <= 100)
);
--> statement-breakpoint
CREATE TABLE "plan_validations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"valid" boolean NOT NULL,
	"checks" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_validations_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"palace_id" text NOT NULL,
	"revision" integer NOT NULL,
	"hash" char(64) NOT NULL,
	"status" "plan_status" NOT NULL,
	"objective" text NOT NULL,
	"constraints" jsonb NOT NULL,
	"success_criteria_ids" text[] NOT NULL,
	"record_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "plans_organization_mission_id_unique" UNIQUE("organization_id","mission_id","id"),
	CONSTRAINT "plans_mission_revision_unique" UNIQUE("organization_id","mission_id","revision"),
	CONSTRAINT "plans_revision_positive" CHECK ("plans"."revision" > 0),
	CONSTRAINT "plans_record_version_positive" CHECK ("plans"."record_version" > 0),
	CONSTRAINT "plans_hash_valid" CHECK ("plans"."hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "plans_success_criteria_present" CHECK (cardinality("plans"."success_criteria_ids") > 0)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_polls" (
	"organization_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"resolution" "reconciliation_resolution" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reconciliation_polls_pk" PRIMARY KEY("organization_id","operation_id","sequence"),
	CONSTRAINT "reconciliation_polls_sequence_positive" CHECK ("reconciliation_polls"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "routine_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" "routine_status" NOT NULL,
	"definition" jsonb NOT NULL,
	"source_plan_id" text,
	"source_plan_hash" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_versions_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "routine_versions_tenant_routine_id_unique" UNIQUE("organization_id","routine_id","id"),
	CONSTRAINT "routine_versions_routine_version_unique" UNIQUE("organization_id","routine_id","version"),
	CONSTRAINT "routine_versions_tenant_routine_id_version_unique" UNIQUE("organization_id","routine_id","id","version"),
	CONSTRAINT "routine_versions_version_positive" CHECK ("routine_versions"."version" > 0),
	CONSTRAINT "routine_versions_source_pair" CHECK (("routine_versions"."source_plan_id" IS NULL) = ("routine_versions"."source_plan_hash" IS NULL)),
	CONSTRAINT "routine_versions_source_hash_valid" CHECK ("routine_versions"."source_plan_hash" IS NULL OR "routine_versions"."source_plan_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"palace_id" text NOT NULL,
	"name" text NOT NULL,
	"active_version_id" text,
	"record_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routines_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "routines_record_version_positive" CHECK ("routines"."record_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"token_hash" char(64) NOT NULL,
	"csrf_secret_hash" char(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "sessions_expiry_valid" CHECK ("sessions"."expires_at" > "sessions"."created_at"),
	CONSTRAINT "sessions_hashes_valid" CHECK ("sessions"."token_hash" ~ '^[a-f0-9]{64}$' AND "sessions"."csrf_secret_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_id_format" CHECK ("users"."id" ~ '^usr_[a-z0-9][a-z0-9_-]{7,63}$')
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"source" text DEFAULT 'application_code' NOT NULL,
	"status" "verification_status" NOT NULL,
	"plan_hash" char(64) NOT NULL,
	"assertions" jsonb NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verifications_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "verifications_mission_unique" UNIQUE("organization_id","mission_id"),
	CONSTRAINT "verifications_application_source" CHECK ("verifications"."source" = 'application_code'),
	CONSTRAINT "verifications_plan_hash_valid" CHECK ("verifications"."plan_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_issuer_tenant_fk" FOREIGN KEY ("organization_id","issued_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_approval_plan_tenant_fk" FOREIGN KEY ("organization_id","approval_id","plan_id") REFERENCES "public"."approvals"("organization_id","id","plan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_plan_action_tenant_fk" FOREIGN KEY ("organization_id","plan_id","action_id") REFERENCES "public"."plan_actions"("organization_id","plan_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_protected_resources" ADD CONSTRAINT "approval_protected_resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_protected_resources" ADD CONSTRAINT "approval_protected_resources_approval_tenant_fk" FOREIGN KEY ("organization_id","approval_id") REFERENCES "public"."approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_protected_resources" ADD CONSTRAINT "approval_protected_resources_version_tenant_fk" FOREIGN KEY ("organization_id","routine_id","routine_version_id","version") REFERENCES "public"."routine_versions"("organization_id","routine_id","id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_plan_tenant_fk" FOREIGN KEY ("organization_id","mission_id","plan_id") REFERENCES "public"."plans"("organization_id","mission_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requester_tenant_fk" FOREIGN KEY ("organization_id","requested_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_tenant_fk" FOREIGN KEY ("organization_id","approved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_operation_tenant_fk" FOREIGN KEY ("organization_id","operation_id") REFERENCES "public"."operations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_device_tenant_fk" FOREIGN KEY ("organization_id","device_id") REFERENCES "public"."devices"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensating_plan_links" ADD CONSTRAINT "compensating_plan_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensating_plan_links" ADD CONSTRAINT "compensating_plan_links_action_tenant_fk" FOREIGN KEY ("organization_id","plan_id","action_id") REFERENCES "public"."plan_actions"("organization_id","plan_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensating_plan_links" ADD CONSTRAINT "compensating_plan_links_operation_tenant_fk" FOREIGN KEY ("organization_id","compensates_operation_id") REFERENCES "public"."operations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_receipts" ADD CONSTRAINT "context_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_receipts" ADD CONSTRAINT "context_receipts_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_palace_tenant_fk" FOREIGN KEY ("organization_id","palace_id") REFERENCES "public"."palaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_user_tenant_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_palace_tenant_fk" FOREIGN KEY ("organization_id","palace_id") REFERENCES "public"."palaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_palace_tenant_fk" FOREIGN KEY ("organization_id","palace_id") REFERENCES "public"."palaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_evidence" ADD CONSTRAINT "execution_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_evidence" ADD CONSTRAINT "execution_evidence_execution_tenant_fk" FOREIGN KEY ("organization_id","execution_id") REFERENCES "public"."executions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_evidence" ADD CONSTRAINT "execution_evidence_evidence_tenant_fk" FOREIGN KEY ("organization_id","evidence_id") REFERENCES "public"."evidence"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_operation_tenant_fk" FOREIGN KEY ("organization_id","operation_id") REFERENCES "public"."operations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_routine_tenant_fk" FOREIGN KEY ("organization_id","routine_id") REFERENCES "public"."routines"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_routine_version_tenant_fk" FOREIGN KEY ("organization_id","routine_id","routine_version_id") REFERENCES "public"."routine_versions"("organization_id","routine_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_trigger_evidence_tenant_fk" FOREIGN KEY ("organization_id","triggered_by_evidence_id") REFERENCES "public"."evidence"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_callback_evidence" ADD CONSTRAINT "gateway_callback_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_callback_evidence" ADD CONSTRAINT "gateway_callback_evidence_callback_tenant_fk" FOREIGN KEY ("organization_id","callback_id") REFERENCES "public"."gateway_callbacks"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_callback_evidence" ADD CONSTRAINT "gateway_callback_evidence_evidence_tenant_fk" FOREIGN KEY ("organization_id","evidence_id") REFERENCES "public"."evidence"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_callbacks" ADD CONSTRAINT "gateway_callbacks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_callbacks" ADD CONSTRAINT "gateway_callbacks_command_operation_tenant_fk" FOREIGN KEY ("organization_id","command_id","operation_id") REFERENCES "public"."gateway_commands"("organization_id","id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_commands" ADD CONSTRAINT "gateway_commands_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_commands" ADD CONSTRAINT "gateway_commands_operation_tenant_fk" FOREIGN KEY ("organization_id","operation_id","mission_id") REFERENCES "public"."operations"("organization_id","id","mission_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_commands" ADD CONSTRAINT "gateway_commands_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_commands" ADD CONSTRAINT "gateway_commands_palace_tenant_fk" FOREIGN KEY ("organization_id","palace_id") REFERENCES "public"."palaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_commands" ADD CONSTRAINT "gateway_commands_attempt_tenant_fk" FOREIGN KEY ("organization_id","attempt_id") REFERENCES "public"."attempts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_tags" ADD CONSTRAINT "identity_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_tags" ADD CONSTRAINT "identity_tags_crew_tenant_fk" FOREIGN KEY ("organization_id","crew_member_id") REFERENCES "public"."crew_members"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_leases" ADD CONSTRAINT "mission_leases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_leases" ADD CONSTRAINT "mission_leases_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_palace_tenant_fk" FOREIGN KEY ("organization_id","palace_id") REFERENCES "public"."palaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_initiator_tenant_fk" FOREIGN KEY ("organization_id","initiated_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_approval_tenant_fk" FOREIGN KEY ("organization_id","mission_id","plan_id","approval_id") REFERENCES "public"."approvals"("organization_id","mission_id","plan_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_plan_action_tenant_fk" FOREIGN KEY ("organization_id","plan_id","plan_action_id") REFERENCES "public"."plan_actions"("organization_id","plan_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_approved_action_tenant_fk" FOREIGN KEY ("organization_id","approval_id","plan_id","plan_action_id") REFERENCES "public"."approval_actions"("organization_id","approval_id","plan_id","action_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_operation_tenant_fk" FOREIGN KEY ("organization_id","operation_id") REFERENCES "public"."operations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "palaces" ADD CONSTRAINT "palaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_actions" ADD CONSTRAINT "plan_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_actions" ADD CONSTRAINT "plan_actions_plan_tenant_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."plans"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_simulations" ADD CONSTRAINT "plan_simulations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_simulations" ADD CONSTRAINT "plan_simulations_plan_tenant_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."plans"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_validations" ADD CONSTRAINT "plan_validations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_validations" ADD CONSTRAINT "plan_validations_plan_tenant_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."plans"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_palace_tenant_fk" FOREIGN KEY ("organization_id","palace_id") REFERENCES "public"."palaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_polls" ADD CONSTRAINT "reconciliation_polls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_polls" ADD CONSTRAINT "reconciliation_polls_operation_tenant_fk" FOREIGN KEY ("organization_id","operation_id") REFERENCES "public"."operations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_versions" ADD CONSTRAINT "routine_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_versions" ADD CONSTRAINT "routine_versions_routine_tenant_fk" FOREIGN KEY ("organization_id","routine_id") REFERENCES "public"."routines"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_palace_tenant_fk" FOREIGN KEY ("organization_id","palace_id") REFERENCES "public"."palaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_membership_tenant_fk" FOREIGN KEY ("organization_id","membership_id","user_id") REFERENCES "public"."memberships"("organization_id","id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_aggregate_idx" ON "audit_events" USING btree ("organization_id","aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outbox_messages_claim_idx" ON "outbox_messages" USING btree ("status","available_at","claim_expires_at");--> statement-breakpoint
CREATE INDEX "plan_simulations_latest_idx" ON "plan_simulations" USING btree ("organization_id","plan_id","created_at");--> statement-breakpoint
CREATE INDEX "plan_validations_latest_idx" ON "plan_validations" USING btree ("organization_id","plan_id","created_at");
--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_active_version_tenant_fk" FOREIGN KEY ("organization_id", "id", "active_version_id") REFERENCES "routine_versions"("organization_id", "routine_id", "id") DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "routine_versions" ADD CONSTRAINT "routine_versions_source_plan_tenant_fk" FOREIGN KEY ("organization_id", "source_plan_id") REFERENCES "plans"("organization_id", "id") DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_context_receipt_tenant_fk" FOREIGN KEY ("organization_id", "context_receipt_id") REFERENCES "context_receipts"("organization_id", "id") DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION reject_immutable_record_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mission_events_append_only BEFORE UPDATE OR DELETE ON "mission_events" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER plan_actions_append_only BEFORE UPDATE OR DELETE ON "plan_actions" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER plan_validations_append_only BEFORE UPDATE OR DELETE ON "plan_validations" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER plan_simulations_append_only BEFORE UPDATE OR DELETE ON "plan_simulations" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER approval_actions_append_only BEFORE UPDATE OR DELETE ON "approval_actions" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER approval_protected_resources_append_only BEFORE UPDATE OR DELETE ON "approval_protected_resources" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER reconciliation_polls_append_only BEFORE UPDATE OR DELETE ON "reconciliation_polls" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER cancellations_append_only BEFORE UPDATE OR DELETE ON "cancellations" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER compensating_plan_links_append_only BEFORE UPDATE OR DELETE ON "compensating_plan_links" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER gateway_callbacks_append_only BEFORE UPDATE OR DELETE ON "gateway_callbacks" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER gateway_callback_evidence_append_only BEFORE UPDATE OR DELETE ON "gateway_callback_evidence" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER evidence_append_only BEFORE UPDATE OR DELETE ON "evidence" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER execution_evidence_append_only BEFORE UPDATE OR DELETE ON "execution_evidence" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER verifications_append_only BEFORE UPDATE OR DELETE ON "verifications" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER context_receipts_append_only BEFORE UPDATE OR DELETE ON "context_receipts" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_plan_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'plans cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF (NEW.id, NEW.organization_id, NEW.mission_id, NEW.palace_id, NEW.revision, NEW.hash, NEW.objective, NEW.constraints, NEW.success_criteria_ids, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.mission_id, OLD.palace_id, OLD.revision, OLD.hash, OLD.objective, OLD.constraints, OLD.success_criteria_ids, OLD.created_at) THEN
    RAISE EXCEPTION 'plan content is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'candidate' AND NEW.status IN ('validated', 'superseded', 'rejected')) OR
    (OLD.status = 'validated' AND NEW.status IN ('candidate', 'awaiting_approval', 'superseded', 'rejected')) OR
    (OLD.status = 'awaiting_approval' AND NEW.status IN ('candidate', 'approved', 'superseded', 'rejected')) OR
    (OLD.status = 'approved' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'invalid plan status transition % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN RAISE EXCEPTION 'plan record version must increment once' USING ERRCODE = '40001'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER plans_guard BEFORE UPDATE OR DELETE ON "plans" FOR EACH ROW EXECUTE FUNCTION guard_plan_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_approval_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'approvals cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF (NEW.id, NEW.organization_id, NEW.mission_id, NEW.plan_id, NEW.plan_hash, NEW.requested_by, NEW.nonce, NEW.expires_at, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.mission_id, OLD.plan_id, OLD.plan_hash, OLD.requested_by, OLD.nonce, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'approval request content is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'expired', 'invalidated')) THEN
    RAISE EXCEPTION 'invalid approval status transition % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN RAISE EXCEPTION 'approval record version must increment once' USING ERRCODE = '40001'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approvals_guard BEFORE UPDATE OR DELETE ON "approvals" FOR EACH ROW EXECUTE FUNCTION guard_approval_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_routine_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'routine versions cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF (NEW.id, NEW.routine_id, NEW.organization_id, NEW.version, NEW.definition, NEW.source_plan_id, NEW.source_plan_hash, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.routine_id, OLD.organization_id, OLD.version, OLD.definition, OLD.source_plan_id, OLD.source_plan_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'routine version content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER routine_versions_guard BEFORE UPDATE OR DELETE ON "routine_versions" FOR EACH ROW EXECUTE FUNCTION guard_routine_version_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_operation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'operations cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF (NEW.id, NEW.organization_id, NEW.mission_id, NEW.plan_id, NEW.plan_action_id, NEW.approval_id, NEW.payload_hash, NEW.server_created, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.mission_id, OLD.plan_id, OLD.plan_action_id, OLD.approval_id, OLD.payload_hash, OLD.server_created, OLD.created_at) THEN
    RAISE EXCEPTION 'operation identity and payload hash are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 THEN RAISE EXCEPTION 'operation record version must increment once' USING ERRCODE = '40001'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_guard BEFORE UPDATE OR DELETE ON "operations" FOR EACH ROW EXECUTE FUNCTION guard_operation_mutation();

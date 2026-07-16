DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM evidence)
    OR EXISTS (SELECT 1 FROM executions)
    OR EXISTS (SELECT 1 FROM gateway_commands)
    OR EXISTS (SELECT 1 FROM outbox_messages) THEN
    RAISE EXCEPTION 'durable effect v2 migration requires an empty pre-release execution pipeline; migrate retained rows explicitly before retrying' USING ERRCODE = '55000';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE TYPE "public"."evidence_authority" AS ENUM('identity_telemetry', 'gateway_callback', 'application');--> statement-breakpoint
CREATE TYPE "public"."execution_milestone_name" AS ENUM('preheat', 'verified_arrival', 'pathway_lighting', 'unlock', 'relock');--> statement-breakpoint
CREATE TYPE "public"."execution_milestone_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."gateway_command_authorization_kind" AS ENUM('mission_lease', 'manual_activation');--> statement-breakpoint
CREATE TYPE "public"."gateway_dispatch_status" AS ENUM('pending', 'dispatching', 'accepted', 'unknown', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."gateway_dispatch_unknown_reason" AS ENUM('timeout', 'lost_ack');--> statement-breakpoint
CREATE TYPE "public"."gateway_effect_cancellation_policy" AS ENUM('cancel_if_pending', 'mandatory_relock');--> statement-breakpoint
CREATE TYPE "public"."gateway_effect_reconciliation_resolution" AS ENUM('waiting', 'retry_authorized', 'terminal_found', 'budget_exhausted', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."gateway_effect_status" AS ENUM('pending', 'acknowledged', 'executing', 'cancellation_requested', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "execution_milestones" (
	"organization_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"name" "execution_milestone_name" NOT NULL,
	"command_id" text,
	"status" "execution_milestone_status" NOT NULL,
	"evidence_id" text,
	"resolved_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	CONSTRAINT "execution_milestones_pk" PRIMARY KEY("organization_id","execution_id","name"),
	CONSTRAINT "execution_milestones_command_shape" CHECK (("execution_milestones"."name" = 'verified_arrival') = ("execution_milestones"."command_id" IS NULL)),
	CONSTRAINT "execution_milestones_state_shape" CHECK (
        ("execution_milestones"."status" = 'pending' AND "execution_milestones"."evidence_id" IS NULL AND "execution_milestones"."resolved_at" IS NULL AND "execution_milestones"."failure_code" IS NULL AND "execution_milestones"."failure_message" IS NULL)
        OR ("execution_milestones"."status" = 'completed' AND "execution_milestones"."evidence_id" IS NOT NULL AND "execution_milestones"."resolved_at" IS NOT NULL AND "execution_milestones"."failure_code" IS NULL AND "execution_milestones"."failure_message" IS NULL)
        OR ("execution_milestones"."status" = 'failed' AND "execution_milestones"."resolved_at" IS NOT NULL AND "execution_milestones"."failure_code" IS NOT NULL AND "execution_milestones"."failure_message" IS NOT NULL)
      )
);
--> statement-breakpoint
CREATE TABLE "gateway_dispatches" (
	"organization_id" text NOT NULL,
	"command_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"generation" integer NOT NULL,
	"status" "gateway_dispatch_status" DEFAULT 'pending' NOT NULL,
	"attempt_id" text,
	"acknowledgement_id" text,
	"retryable" boolean,
	"unknown_reason" "gateway_dispatch_unknown_reason",
	"error_code" text,
	"error_message" text,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"record_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_dispatches_pk" PRIMARY KEY("organization_id","command_id","generation"),
	CONSTRAINT "gateway_dispatches_attempt_unique" UNIQUE("organization_id","attempt_id"),
	CONSTRAINT "gateway_dispatches_generation_positive" CHECK ("gateway_dispatches"."generation" > 0),
	CONSTRAINT "gateway_dispatches_record_version_positive" CHECK ("gateway_dispatches"."record_version" > 0),
	CONSTRAINT "gateway_dispatches_state_shape" CHECK (
        ("gateway_dispatches"."status" = 'pending' AND "gateway_dispatches"."attempt_id" IS NULL AND "gateway_dispatches"."acknowledgement_id" IS NULL AND "gateway_dispatches"."retryable" IS NULL AND "gateway_dispatches"."unknown_reason" IS NULL AND "gateway_dispatches"."error_code" IS NULL AND "gateway_dispatches"."error_message" IS NULL AND "gateway_dispatches"."cancelled_at" IS NULL)
        OR ("gateway_dispatches"."status" = 'dispatching' AND "gateway_dispatches"."attempt_id" IS NOT NULL AND "gateway_dispatches"."acknowledgement_id" IS NULL AND "gateway_dispatches"."retryable" IS NULL AND "gateway_dispatches"."unknown_reason" IS NULL AND "gateway_dispatches"."error_code" IS NULL AND "gateway_dispatches"."error_message" IS NULL AND "gateway_dispatches"."cancelled_at" IS NULL)
        OR ("gateway_dispatches"."status" = 'accepted' AND "gateway_dispatches"."attempt_id" IS NOT NULL AND "gateway_dispatches"."acknowledgement_id" IS NOT NULL AND "gateway_dispatches"."retryable" IS NULL AND "gateway_dispatches"."unknown_reason" IS NULL AND "gateway_dispatches"."error_code" IS NULL AND "gateway_dispatches"."error_message" IS NULL AND "gateway_dispatches"."cancelled_at" IS NULL)
        OR ("gateway_dispatches"."status" = 'unknown' AND "gateway_dispatches"."attempt_id" IS NOT NULL AND "gateway_dispatches"."acknowledgement_id" IS NULL AND "gateway_dispatches"."retryable" IS TRUE AND "gateway_dispatches"."unknown_reason" IS NOT NULL AND "gateway_dispatches"."error_code" IS NULL AND "gateway_dispatches"."error_message" IS NULL AND "gateway_dispatches"."cancelled_at" IS NULL)
        OR ("gateway_dispatches"."status" = 'failed' AND "gateway_dispatches"."attempt_id" IS NOT NULL AND "gateway_dispatches"."acknowledgement_id" IS NULL AND "gateway_dispatches"."retryable" IS NOT NULL AND "gateway_dispatches"."unknown_reason" IS NULL AND "gateway_dispatches"."error_code" IS NOT NULL AND "gateway_dispatches"."error_message" IS NOT NULL AND "gateway_dispatches"."cancelled_at" IS NULL)
        OR ("gateway_dispatches"."status" = 'cancelled' AND "gateway_dispatches"."attempt_id" IS NULL AND "gateway_dispatches"."acknowledgement_id" IS NULL AND "gateway_dispatches"."retryable" IS NULL AND "gateway_dispatches"."unknown_reason" IS NULL AND "gateway_dispatches"."error_code" IS NULL AND "gateway_dispatches"."error_message" IS NULL AND "gateway_dispatches"."cancelled_at" IS NOT NULL)
      )
);
--> statement-breakpoint
CREATE TABLE "gateway_effect_reconciliation_polls" (
	"organization_id" text NOT NULL,
	"command_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"dispatch_generation" integer NOT NULL,
	"observed_dispatch_status" "gateway_dispatch_status" NOT NULL,
	"observed_effect_status" "gateway_effect_status" NOT NULL,
	"resolution" "gateway_effect_reconciliation_resolution" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gateway_effect_reconciliation_polls_pk" PRIMARY KEY("organization_id","command_id","sequence"),
	CONSTRAINT "gateway_effect_reconciliation_polls_sequence_positive" CHECK ("gateway_effect_reconciliation_polls"."sequence" > 0),
	CONSTRAINT "gateway_effect_reconciliation_polls_generation_positive" CHECK ("gateway_effect_reconciliation_polls"."dispatch_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "gateway_effects" (
	"organization_id" text NOT NULL,
	"command_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"dispatch_at" timestamp with time zone NOT NULL,
	"milestone" "execution_milestone_name" NOT NULL,
	"cancellation_policy" "gateway_effect_cancellation_policy" NOT NULL,
	"authorization_kind" "gateway_command_authorization_kind" NOT NULL,
	"authorizing_lease_epoch" integer,
	"status" "gateway_effect_status" DEFAULT 'pending' NOT NULL,
	"callback_id" text,
	"cancellation_requested_at" timestamp with time zone,
	"reconciliation_attempts" integer DEFAULT 0 NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"record_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_effects_pk" PRIMARY KEY("organization_id","command_id"),
	CONSTRAINT "gateway_effects_command_operation_unique" UNIQUE("organization_id","command_id","operation_id"),
	CONSTRAINT "gateway_effects_authorization_shape" CHECK (("gateway_effects"."authorization_kind" = 'mission_lease' AND "gateway_effects"."authorizing_lease_epoch" > 0) OR ("gateway_effects"."authorization_kind" = 'manual_activation' AND "gateway_effects"."authorizing_lease_epoch" IS NULL)),
	CONSTRAINT "gateway_effects_cancellation_policy" CHECK (("gateway_effects"."cancellation_policy" = 'mandatory_relock') = ("gateway_effects"."milestone" = 'relock')),
	CONSTRAINT "gateway_effects_callback_shape" CHECK (("gateway_effects"."status" = 'pending' AND "gateway_effects"."callback_id" IS NULL AND "gateway_effects"."cancellation_requested_at" IS NULL) OR ("gateway_effects"."status" IN ('acknowledged', 'executing', 'completed', 'failed') AND "gateway_effects"."callback_id" IS NOT NULL AND "gateway_effects"."cancellation_requested_at" IS NULL) OR ("gateway_effects"."status" = 'cancellation_requested' AND "gateway_effects"."cancellation_requested_at" IS NOT NULL)),
	CONSTRAINT "gateway_effects_reconciliation_attempts_nonnegative" CHECK ("gateway_effects"."reconciliation_attempts" >= 0),
	CONSTRAINT "gateway_effects_record_version_positive" CHECK ("gateway_effects"."record_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "gateway_commands" DROP CONSTRAINT "gateway_commands_operation_sequence_unique";--> statement-breakpoint
ALTER TABLE "gateway_commands" DROP CONSTRAINT "gateway_commands_sequence_positive";--> statement-breakpoint
ALTER TABLE "gateway_commands" DROP CONSTRAINT "gateway_commands_record_version_positive";--> statement-breakpoint
ALTER TABLE "gateway_commands" DROP CONSTRAINT "gateway_commands_schema_version";--> statement-breakpoint
ALTER TABLE "gateway_commands" DROP CONSTRAINT "gateway_commands_attempt_tenant_fk";
--> statement-breakpoint
ALTER TABLE "outbox_messages" ALTER COLUMN "topic" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."outbox_topic";--> statement-breakpoint
CREATE TYPE "public"."outbox_topic" AS ENUM('gateway.dispatch', 'gateway.effect.reconcile', 'execution.deadline', 'mission.resume', 'mission.verify', 'operation.reconcile');--> statement-breakpoint
ALTER TABLE "outbox_messages" ALTER COLUMN "topic" SET DATA TYPE "public"."outbox_topic" USING "topic"::"public"."outbox_topic";--> statement-breakpoint
ALTER TABLE "gateway_commands" ALTER COLUMN "schema_version" SET DEFAULT 'gateway-command@2';--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "gateway_command_id" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "dispatch_generation" integer;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_gateway_dispatch_unique" UNIQUE("organization_id","gateway_command_id","dispatch_generation");--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_gateway_dispatch_identity_unique" UNIQUE("organization_id","id","gateway_command_id","dispatch_generation");--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "authority_receipt_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "authority" "evidence_authority" NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "authority_receipt" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "authority_provider_event_id" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "authority_callback_id" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "authority_command_id" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "application_rule_id" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "application_rule_version" integer;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "verified_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "persisted_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "schema_version" text DEFAULT 'execution@2' NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "authorization_kind" "gateway_command_authorization_kind" NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "authorizing_lease_epoch" integer;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "deadline" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "updated_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_commands" ADD COLUMN "logical_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "mission_id" text;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "execution_id" text;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "command_id" text;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "dispatch_generation" integer;--> statement-breakpoint
ALTER TABLE "execution_milestones" ADD CONSTRAINT "execution_milestones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_milestones" ADD CONSTRAINT "execution_milestones_execution_tenant_fk" FOREIGN KEY ("organization_id","execution_id") REFERENCES "public"."executions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_milestones" ADD CONSTRAINT "execution_milestones_command_tenant_fk" FOREIGN KEY ("organization_id","command_id") REFERENCES "public"."gateway_commands"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_milestones" ADD CONSTRAINT "execution_milestones_evidence_tenant_fk" FOREIGN KEY ("organization_id","evidence_id") REFERENCES "public"."evidence"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_dispatches" ADD CONSTRAINT "gateway_dispatches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_dispatches" ADD CONSTRAINT "gateway_dispatches_command_operation_tenant_fk" FOREIGN KEY ("organization_id","command_id","operation_id") REFERENCES "public"."gateway_commands"("organization_id","id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_dispatches" ADD CONSTRAINT "gateway_dispatches_attempt_binding_fk" FOREIGN KEY ("organization_id","attempt_id","command_id","generation") REFERENCES "public"."attempts"("organization_id","id","gateway_command_id","dispatch_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_effect_reconciliation_polls" ADD CONSTRAINT "gateway_effect_reconciliation_polls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_effect_reconciliation_polls" ADD CONSTRAINT "gateway_effect_reconciliation_polls_effect_fk" FOREIGN KEY ("organization_id","command_id","operation_id") REFERENCES "public"."gateway_effects"("organization_id","command_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_effect_reconciliation_polls" ADD CONSTRAINT "gateway_effect_reconciliation_polls_dispatch_fk" FOREIGN KEY ("organization_id","command_id","dispatch_generation") REFERENCES "public"."gateway_dispatches"("organization_id","command_id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_effects" ADD CONSTRAINT "gateway_effects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_effects" ADD CONSTRAINT "gateway_effects_command_operation_tenant_fk" FOREIGN KEY ("organization_id","command_id","operation_id") REFERENCES "public"."gateway_commands"("organization_id","id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_effects" ADD CONSTRAINT "gateway_effects_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_callbacks" ADD CONSTRAINT "gateway_callbacks_id_command_unique" UNIQUE("organization_id","id","command_id");--> statement-breakpoint
ALTER TABLE "gateway_callbacks" ADD CONSTRAINT "gateway_callbacks_command_status_unique" UNIQUE("organization_id","command_id","status");--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_gateway_callback_binding_fk" FOREIGN KEY ("organization_id","authority_callback_id","authority_command_id") REFERENCES "public"."gateway_callbacks"("organization_id","id","command_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_execution_tenant_fk" FOREIGN KEY ("organization_id","execution_id") REFERENCES "public"."executions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_command_operation_tenant_fk" FOREIGN KEY ("organization_id","command_id","operation_id") REFERENCES "public"."gateway_commands"("organization_id","id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_callbacks_command_terminal_unique" ON "gateway_callbacks" USING btree ("organization_id","command_id") WHERE "gateway_callbacks"."status" IN ('completed', 'failed');--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "gateway_commands" DROP COLUMN "attempt_id";--> statement-breakpoint
ALTER TABLE "gateway_commands" DROP COLUMN "sequence";--> statement-breakpoint
ALTER TABLE "gateway_commands" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "gateway_commands" DROP COLUMN "dispatched_at";--> statement-breakpoint
ALTER TABLE "gateway_commands" DROP COLUMN "completed_at";--> statement-breakpoint
ALTER TABLE "gateway_commands" DROP COLUMN "record_version";--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_authority_receipt_unique" UNIQUE("organization_id","authority_receipt_id");--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_provider_event_unique" UNIQUE("organization_id","authority_provider_event_id");--> statement-breakpoint
ALTER TABLE "gateway_commands" ADD CONSTRAINT "gateway_commands_operation_logical_key_unique" UNIQUE("organization_id","operation_id","logical_key");--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_gateway_binding" CHECK (("attempts"."transport" = 'gateway' AND "attempts"."gateway_command_id" IS NOT NULL AND "attempts"."dispatch_generation" IS NOT NULL) OR ("attempts"."transport" <> 'gateway' AND "attempts"."gateway_command_id" IS NULL AND "attempts"."dispatch_generation" IS NULL));--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_dispatch_generation_positive" CHECK ("attempts"."dispatch_generation" IS NULL OR "attempts"."dispatch_generation" > 0);--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_authority_shape" CHECK (
        ("evidence"."authority" = 'identity_telemetry' AND "evidence"."type" = 'identity_arrival' AND "evidence"."authority_provider_event_id" IS NOT NULL AND "evidence"."authority_callback_id" IS NULL AND "evidence"."authority_command_id" IS NULL AND "evidence"."application_rule_id" IS NULL AND "evidence"."application_rule_version" IS NULL)
        OR ("evidence"."authority" = 'gateway_callback' AND "evidence"."type" IN ('device_command', 'temperature_observation', 'lighting_observation', 'lock_observation', 'gateway_delivery') AND "evidence"."authority_provider_event_id" IS NULL AND "evidence"."authority_callback_id" IS NOT NULL AND "evidence"."authority_command_id" IS NOT NULL AND "evidence"."application_rule_id" IS NULL AND "evidence"."application_rule_version" IS NULL)
        OR ("evidence"."authority" = 'application' AND "evidence"."type" IN ('battery_projection', 'routine_state', 'tenant_access_audit') AND "evidence"."authority_provider_event_id" IS NULL AND "evidence"."authority_callback_id" IS NULL AND "evidence"."authority_command_id" IS NULL AND "evidence"."application_rule_id" IS NOT NULL AND "evidence"."application_rule_version" > 0)
      );--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_persistence_order" CHECK ("evidence"."verified_at" <= "evidence"."persisted_at");--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_schema_version" CHECK ("executions"."schema_version" = 'execution@2');--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_authorization_shape" CHECK (("executions"."authorization_kind" = 'mission_lease' AND "executions"."authorizing_lease_epoch" > 0) OR ("executions"."authorization_kind" = 'manual_activation' AND "executions"."authorizing_lease_epoch" IS NULL));--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_temporal_order" CHECK ("executions"."deadline" >= "executions"."started_at" AND "executions"."updated_at" >= "executions"."started_at" AND ("executions"."completed_at" IS NULL OR "executions"."completed_at" >= "executions"."started_at"));--> statement-breakpoint
ALTER TABLE "gateway_commands" ADD CONSTRAINT "gateway_commands_logical_key_valid" CHECK ("gateway_commands"."logical_key" ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$' AND length("gateway_commands"."logical_key") <= 80);--> statement-breakpoint
ALTER TABLE "gateway_commands" ADD CONSTRAINT "gateway_commands_schema_version" CHECK ("gateway_commands"."schema_version" = 'gateway-command@2');--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_reference_shape" CHECK (
        ("outbox_messages"."topic" = 'gateway.dispatch' AND "outbox_messages"."mission_id" IS NULL AND "outbox_messages"."operation_id" IS NOT NULL AND "outbox_messages"."execution_id" IS NULL AND "outbox_messages"."command_id" IS NOT NULL AND "outbox_messages"."dispatch_generation" > 0)
        OR ("outbox_messages"."topic" = 'gateway.effect.reconcile' AND "outbox_messages"."mission_id" IS NULL AND "outbox_messages"."operation_id" IS NOT NULL AND "outbox_messages"."execution_id" IS NULL AND "outbox_messages"."command_id" IS NOT NULL AND "outbox_messages"."dispatch_generation" > 0)
        OR ("outbox_messages"."topic" = 'execution.deadline' AND "outbox_messages"."mission_id" IS NOT NULL AND "outbox_messages"."operation_id" IS NOT NULL AND "outbox_messages"."execution_id" IS NOT NULL AND "outbox_messages"."command_id" IS NULL AND "outbox_messages"."dispatch_generation" IS NULL)
        OR ("outbox_messages"."topic" IN ('mission.resume', 'mission.verify') AND "outbox_messages"."mission_id" IS NOT NULL AND "outbox_messages"."operation_id" IS NULL AND "outbox_messages"."execution_id" IS NULL AND "outbox_messages"."command_id" IS NULL AND "outbox_messages"."dispatch_generation" IS NULL)
        OR ("outbox_messages"."topic" = 'operation.reconcile' AND "outbox_messages"."mission_id" IS NULL AND "outbox_messages"."operation_id" IS NOT NULL AND "outbox_messages"."execution_id" IS NULL AND "outbox_messages"."command_id" IS NULL AND "outbox_messages"."dispatch_generation" IS NULL)
      );--> statement-breakpoint
DROP TYPE "public"."gateway_command_status";

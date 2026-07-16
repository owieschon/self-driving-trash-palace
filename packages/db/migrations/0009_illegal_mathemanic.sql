CREATE TYPE "public"."tool_invocation_disposition" AS ENUM('execute', 'resolve_unknown');--> statement-breakpoint
CREATE TYPE "public"."tool_invocation_execution_class" AS ENUM('read', 'write_idempotent', 'non_idempotent', 'consequential');--> statement-breakpoint
CREATE TYPE "public"."tool_invocation_status" AS ENUM('claimed', 'completed');--> statement-breakpoint
CREATE TABLE "tool_invocation_evidence" (
	"organization_id" text NOT NULL,
	"call_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "tool_invocation_evidence_pk" PRIMARY KEY("organization_id","call_id","evidence_id"),
	CONSTRAINT "tool_invocation_evidence_position_unique" UNIQUE("organization_id","call_id","position"),
	CONSTRAINT "tool_invocation_evidence_position_nonnegative" CHECK ("tool_invocation_evidence"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"channel" text NOT NULL,
	"input_hash" char(64) NOT NULL,
	"principal_scope_hash" char(64) NOT NULL,
	"tool_contract_hash" char(64) NOT NULL,
	"tool_registry_hash" char(64) NOT NULL,
	"result_schema_hash" char(64) NOT NULL,
	"execution_class" "tool_invocation_execution_class" NOT NULL,
	"receipt_id" text NOT NULL,
	"status" "tool_invocation_status" NOT NULL,
	"disposition" "tool_invocation_disposition" NOT NULL,
	"generation" integer NOT NULL,
	"owner_token_hash" char(64) NOT NULL,
	"claim_expires_at" timestamp with time zone NOT NULL,
	"result" jsonb,
	"result_hash" char(64),
	"attempt_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tool_invocations_pk" PRIMARY KEY("organization_id","call_id"),
	CONSTRAINT "tool_invocations_receipt_id_unique" UNIQUE("receipt_id"),
	CONSTRAINT "tool_invocations_call_id_format" CHECK ("tool_invocations"."call_id" ~ '^call_[a-z0-9][a-z0-9_-]{7,63}$'),
	CONSTRAINT "tool_invocations_receipt_id_format" CHECK ("tool_invocations"."receipt_id" ~ '^rcp_[a-z0-9][a-z0-9_-]{7,63}$'),
	CONSTRAINT "tool_invocations_tool_name" CHECK ("tool_invocations"."tool_name" IN ('palaces.get', 'crews.list', 'capabilities.list', 'routines.list', 'routines.get', 'executions.list', 'knowledge.search', 'plans.propose', 'plans.validate', 'plans.simulate', 'plans.request_approval', 'plans.activate', 'operations.get', 'verification.get_evidence', 'missions.cancel')),
	CONSTRAINT "tool_invocations_channel" CHECK ("tool_invocations"."channel" IN ('in_process', 'http', 'mcp')),
	CONSTRAINT "tool_invocations_hashes_valid" CHECK ("tool_invocations"."input_hash" ~ '^[a-f0-9]{64}$' AND "tool_invocations"."principal_scope_hash" ~ '^[a-f0-9]{64}$' AND "tool_invocations"."tool_contract_hash" ~ '^[a-f0-9]{64}$' AND "tool_invocations"."tool_registry_hash" ~ '^[a-f0-9]{64}$' AND "tool_invocations"."result_schema_hash" ~ '^[a-f0-9]{64}$' AND "tool_invocations"."owner_token_hash" ~ '^[a-f0-9]{64}$' AND ("tool_invocations"."result_hash" IS NULL OR "tool_invocations"."result_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "tool_invocations_generation_positive" CHECK ("tool_invocations"."generation" > 0),
	CONSTRAINT "tool_invocations_claim_window" CHECK ("tool_invocations"."claim_expires_at" > "tool_invocations"."started_at" AND "tool_invocations"."updated_at" >= "tool_invocations"."started_at"),
	CONSTRAINT "tool_invocations_state_shape" CHECK (("tool_invocations"."status" = 'claimed' AND "tool_invocations"."result" IS NULL AND "tool_invocations"."result_hash" IS NULL AND "tool_invocations"."attempt_id" IS NULL AND "tool_invocations"."completed_at" IS NULL) OR ("tool_invocations"."status" = 'completed' AND "tool_invocations"."result" IS NOT NULL AND "tool_invocations"."result_hash" IS NOT NULL AND "tool_invocations"."completed_at" IS NOT NULL AND "tool_invocations"."completed_at" >= "tool_invocations"."started_at")),
	CONSTRAINT "tool_invocations_result_binding" CHECK ("tool_invocations"."result" IS NULL OR ("tool_invocations"."result" ->> 'schemaVersion' = 'tool-result@1' AND "tool_invocations"."result" ->> 'toolName' = "tool_invocations"."tool_name" AND "tool_invocations"."result" ->> 'callId' = "tool_invocations"."call_id" AND "tool_invocations"."result" ->> 'receiptId' = "tool_invocations"."receipt_id")),
	CONSTRAINT "tool_invocations_unknown_resolution" CHECK ("tool_invocations"."disposition" = 'execute' OR "tool_invocations"."status" = 'claimed' OR "tool_invocations"."result" ->> 'status' = 'unknown')
);
--> statement-breakpoint
ALTER TABLE "tool_invocation_evidence" ADD CONSTRAINT "tool_invocation_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocation_evidence" ADD CONSTRAINT "tool_invocation_evidence_invocation_tenant_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."tool_invocations"("organization_id","call_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocation_evidence" ADD CONSTRAINT "tool_invocation_evidence_evidence_tenant_fk" FOREIGN KEY ("organization_id","evidence_id") REFERENCES "public"."evidence"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_attempt_tenant_fk" FOREIGN KEY ("organization_id","attempt_id") REFERENCES "public"."attempts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_invocations_claim_idx" ON "tool_invocations" USING btree ("organization_id","status","claim_expires_at");--> statement-breakpoint
CREATE FUNCTION enforce_tool_invocation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tool invocation records cannot be deleted';
  END IF;

  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.mission_id IS DISTINCT FROM NEW.mission_id
    OR OLD.call_id IS DISTINCT FROM NEW.call_id
    OR OLD.tool_name IS DISTINCT FROM NEW.tool_name
    OR OLD.channel IS DISTINCT FROM NEW.channel
    OR OLD.input_hash IS DISTINCT FROM NEW.input_hash
    OR OLD.principal_scope_hash IS DISTINCT FROM NEW.principal_scope_hash
    OR OLD.tool_contract_hash IS DISTINCT FROM NEW.tool_contract_hash
    OR OLD.tool_registry_hash IS DISTINCT FROM NEW.tool_registry_hash
    OR OLD.result_schema_hash IS DISTINCT FROM NEW.result_schema_hash
    OR OLD.execution_class IS DISTINCT FROM NEW.execution_class
    OR OLD.receipt_id IS DISTINCT FROM NEW.receipt_id
    OR OLD.started_at IS DISTINCT FROM NEW.started_at THEN
    RAISE EXCEPTION 'tool invocation immutable binding cannot change';
  END IF;

  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'completed tool invocation is immutable';
  END IF;

  IF NEW.status = 'claimed' THEN
    IF NEW.generation <> OLD.generation + 1
      OR OLD.claim_expires_at > NEW.updated_at
      OR NEW.claim_expires_at <= NEW.updated_at
      OR NEW.claim_expires_at > NEW.updated_at + interval '5 minutes'
      OR NEW.disposition <> (CASE WHEN OLD.execution_class = 'read' THEN 'execute'::tool_invocation_disposition ELSE 'resolve_unknown'::tool_invocation_disposition END) THEN
      RAISE EXCEPTION 'invalid tool invocation claim takeover';
    END IF;
  ELSIF NEW.status = 'completed' THEN
    IF NEW.generation <> OLD.generation
      OR NEW.owner_token_hash IS DISTINCT FROM OLD.owner_token_hash
      OR NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at
      OR NEW.disposition IS DISTINCT FROM OLD.disposition
      OR NEW.completed_at < OLD.updated_at THEN
      RAISE EXCEPTION 'invalid tool invocation completion';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid tool invocation transition';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER tool_invocations_transition BEFORE UPDATE OR DELETE ON "tool_invocations" FOR EACH ROW EXECUTE FUNCTION enforce_tool_invocation_transition();--> statement-breakpoint
CREATE FUNCTION require_tool_invocation_reconciliation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'completed'
    AND NEW.disposition = 'resolve_unknown'
    AND NOT EXISTS (
      SELECT 1 FROM tool_invocation_evidence
      WHERE organization_id = NEW.organization_id AND call_id = NEW.call_id
    ) THEN
    RAISE EXCEPTION 'resolved unknown tool invocation requires reconciliation evidence';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER tool_invocations_reconciliation_evidence AFTER INSERT OR UPDATE ON "tool_invocations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_tool_invocation_reconciliation_evidence();--> statement-breakpoint
CREATE FUNCTION enforce_tool_invocation_evidence_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tool invocation evidence links are append-only';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM tool_invocations invocation
    INNER JOIN evidence item
      ON item.organization_id = invocation.organization_id
      AND item.id = NEW.evidence_id
      AND item.mission_id = invocation.mission_id
    WHERE invocation.organization_id = NEW.organization_id
      AND invocation.call_id = NEW.call_id
      AND invocation.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'tool invocation evidence requires a completed invocation in the same mission';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER tool_invocation_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON "tool_invocation_evidence" FOR EACH ROW EXECUTE FUNCTION enforce_tool_invocation_evidence_insert();

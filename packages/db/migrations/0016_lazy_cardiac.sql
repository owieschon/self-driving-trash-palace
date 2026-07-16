CREATE TYPE "public"."caretaker_evidence_capture_status" AS ENUM('stored', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."caretaker_evidence_delivery_status" AS ENUM('pending', 'delivered');--> statement-breakpoint
CREATE TABLE "caretaker_terminal_evidence_deliveries" (
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"run_id" text NOT NULL,
	"event_insert_id" text NOT NULL,
	"event_hash" char(64) NOT NULL,
	"envelope" jsonb NOT NULL,
	"status" "caretaker_evidence_delivery_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"capture_status" "caretaker_evidence_capture_status",
	CONSTRAINT "caretaker_terminal_evidence_deliveries_pk" PRIMARY KEY("organization_id","run_id"),
	CONSTRAINT "caretaker_terminal_evidence_insert_id_unique" UNIQUE("event_insert_id"),
	CONSTRAINT "caretaker_terminal_evidence_hash_valid" CHECK ("caretaker_terminal_evidence_deliveries"."event_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "caretaker_terminal_evidence_delivery_state_valid" CHECK (("caretaker_terminal_evidence_deliveries"."status" = 'pending' AND "caretaker_terminal_evidence_deliveries"."delivered_at" IS NULL AND "caretaker_terminal_evidence_deliveries"."capture_status" IS NULL) OR ("caretaker_terminal_evidence_deliveries"."status" = 'delivered' AND "caretaker_terminal_evidence_deliveries"."delivered_at" IS NOT NULL AND "caretaker_terminal_evidence_deliveries"."capture_status" IS NOT NULL)),
	CONSTRAINT "caretaker_terminal_evidence_time_order" CHECK ("caretaker_terminal_evidence_deliveries"."delivered_at" IS NULL OR "caretaker_terminal_evidence_deliveries"."delivered_at" >= "caretaker_terminal_evidence_deliveries"."created_at")
);
--> statement-breakpoint
ALTER TABLE "caretaker_runs" ADD COLUMN "evidence_profile" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "caretaker_terminal_evidence_deliveries" ADD CONSTRAINT "caretaker_terminal_evidence_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caretaker_terminal_evidence_deliveries" ADD CONSTRAINT "caretaker_terminal_evidence_run_tenant_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."caretaker_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caretaker_terminal_evidence_deliveries" ADD CONSTRAINT "caretaker_terminal_evidence_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "caretaker_terminal_evidence_deliveries" ADD CONSTRAINT "caretaker_terminal_evidence_envelope_binding" CHECK (
	"event_hash" = "envelope"->>'eventHash'
	AND "event_insert_id" = "envelope"->'event'->>'insertId'
	AND "envelope"->>'schemaVersion' = 'caretaker-terminal-evidence@1'
	AND "envelope"->'event'->>'event' = '$ai_trace'
);
--> statement-breakpoint
CREATE FUNCTION caretaker_evidence_profile_immutable() RETURNS trigger AS $$
BEGIN
	IF NEW.evidence_profile IS DISTINCT FROM OLD.evidence_profile THEN
		RAISE EXCEPTION 'caretaker evidence profile is immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER caretaker_evidence_profile_immutable_guard
BEFORE UPDATE OF evidence_profile ON caretaker_runs
FOR EACH ROW EXECUTE FUNCTION caretaker_evidence_profile_immutable();
--> statement-breakpoint
CREATE FUNCTION caretaker_terminal_evidence_guard() RETURNS trigger AS $$
DECLARE
	run_status caretaker_run_status;
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT status INTO run_status
		FROM caretaker_runs
		WHERE organization_id = NEW.organization_id AND id = NEW.run_id;
		IF run_status IS NULL OR run_status = 'active' THEN
			RAISE EXCEPTION 'terminal evidence requires a terminal caretaker run' USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.mission_id IS DISTINCT FROM OLD.mission_id
		OR NEW.run_id IS DISTINCT FROM OLD.run_id
		OR NEW.event_insert_id IS DISTINCT FROM OLD.event_insert_id
		OR NEW.event_hash IS DISTINCT FROM OLD.event_hash
		OR NEW.envelope IS DISTINCT FROM OLD.envelope
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'caretaker terminal evidence envelope is immutable' USING ERRCODE = '23514';
	END IF;
	IF OLD.status = 'delivered' AND ROW(NEW.status, NEW.delivered_at, NEW.capture_status)
		IS DISTINCT FROM ROW(OLD.status, OLD.delivered_at, OLD.capture_status) THEN
		RAISE EXCEPTION 'caretaker terminal evidence acknowledgement is immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER caretaker_terminal_evidence_guard_trigger
BEFORE INSERT OR UPDATE ON caretaker_terminal_evidence_deliveries
FOR EACH ROW EXECUTE FUNCTION caretaker_terminal_evidence_guard();

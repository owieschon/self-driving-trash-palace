CREATE FUNCTION caretaker_task_ledger_is_valid(ledger jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  item jsonb;
  evidence_ref jsonb;
BEGIN
  IF jsonb_typeof(ledger) <> 'array' OR jsonb_array_length(ledger) > 32 THEN RETURN FALSE; END IF;
  IF (
    SELECT count(*) <> count(DISTINCT value ->> 'id')
    FROM jsonb_array_elements(ledger)
  ) THEN RETURN FALSE; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(ledger) LOOP
    IF jsonb_typeof(item) <> 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) AS key)
        IS DISTINCT FROM ARRAY['evidenceRefs', 'id', 'label', 'status']::text[]
      OR item ->> 'id' !~ '^[a-z][a-z0-9_-]{2,63}$'
      OR char_length(item ->> 'label') NOT BETWEEN 1 AND 160
      OR item ->> 'status' NOT IN ('pending', 'in_progress', 'completed', 'blocked')
      OR jsonb_typeof(item -> 'evidenceRefs') <> 'array'
    THEN RETURN FALSE; END IF;
    IF (
      SELECT count(*) <> count(DISTINCT value #>> '{}')
      FROM jsonb_array_elements(item -> 'evidenceRefs')
    ) THEN RETURN FALSE; END IF;
    FOR evidence_ref IN SELECT value FROM jsonb_array_elements(item -> 'evidenceRefs') LOOP
      IF jsonb_typeof(evidence_ref) <> 'string' OR char_length(evidence_ref #>> '{}') < 1 THEN
        RETURN FALSE;
      END IF;
    END LOOP;
  END LOOP;
  RETURN TRUE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION caretaker_evidence_refs_are_valid(evidence_refs text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(evidence_refs) <= 32
    AND cardinality(evidence_refs) = (SELECT count(DISTINCT evidence_ref) FROM unnest(evidence_refs) AS evidence_ref)
    AND NOT EXISTS (
      SELECT 1 FROM unnest(evidence_refs) AS evidence_ref
      WHERE evidence_ref IS NULL OR evidence_ref !~ '^evd_[a-z0-9][a-z0-9_-]{7,63}$'
    );
$$;
--> statement-breakpoint
CREATE FUNCTION caretaker_canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(caretaker_canonical_json(item), ',' ORDER BY ordinal), '') || ']'
      INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(item, ordinal);
      RETURN result;
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        string_agg(to_jsonb(entry.key)::text || ':' || caretaker_canonical_json(entry.value), ',' ORDER BY entry.key),
        ''
      ) || '}'
      INTO result
      FROM jsonb_each(value) AS entry;
      RETURN result;
    ELSE
      RETURN value::text;
  END CASE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION caretaker_pending_tool_call_is_valid(pending_call jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  input_text text;
BEGIN
  IF pending_call IS NULL THEN RETURN TRUE; END IF;
  IF jsonb_typeof(pending_call) <> 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(pending_call) AS key)
      IS DISTINCT FROM ARRAY['callId', 'input', 'inputHash', 'toolName']::text[]
    OR pending_call ->> 'callId' !~ '^call_[a-z0-9][a-z0-9_-]{7,63}$'
    OR pending_call ->> 'inputHash' !~ '^[a-f0-9]{64}$'
    OR pending_call ->> 'toolName' NOT IN (
      'palaces.get', 'crews.list', 'capabilities.list', 'routines.list', 'routines.get',
      'executions.list', 'knowledge.search', 'plans.propose', 'plans.validate', 'plans.simulate',
      'plans.request_approval', 'plans.activate', 'operations.get',
      'verification.get_evidence', 'missions.cancel'
    )
    OR jsonb_typeof(pending_call -> 'input') <> 'object'
    OR octet_length((pending_call -> 'input')::text) > 16384
    OR encode(sha256(convert_to(caretaker_canonical_json(pending_call -> 'input'), 'UTF8')), 'hex')
      <> pending_call ->> 'inputHash'
  THEN RETURN FALSE; END IF;
  input_text := (pending_call -> 'input')::text;
  IF input_text ~* '"(api[_-]?key|authorization|cookie|credential|headers?|password|secret|token)"[[:space:]]*:'
    OR input_text ~* '(bearer[[:space:]]+[a-z0-9._~+/-]{8,}|(phc|phx|sk)_[a-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|password|secret|token)=[^[:space:]"}]+)'
    OR input_text ~ '(/Users/|/home/)'
    OR input_text ~* 'https?://(localhost|0\.0\.0\.0|127\.0\.0\.1|\[?::1\]?|10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+)'
  THEN RETURN FALSE; END IF;
  RETURN TRUE;
END;
$$;
--> statement-breakpoint
CREATE TYPE "public"."caretaker_run_checkpoint_kind" AS ENUM('activated', 'state_persisted', 'tool_call', 'tool_wait', 'plan_revision', 'clarification_pause', 'approval_pause', 'human_review_pause', 'reconciliation_poll', 'external_wait', 'budget_exhausted', 'completed', 'failed', 'safe_refusal', 'host_failed', 'cancelled', 'lease_replaced');--> statement-breakpoint
CREATE TYPE "public"."caretaker_run_status" AS ENUM('active', 'paused', 'completed', 'failed', 'cancelled', 'abandoned');--> statement-breakpoint
CREATE TABLE "caretaker_run_checkpoints" (
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"mutation_key" char(64) NOT NULL,
	"mutation_hash" char(64) NOT NULL,
	"kind" "caretaker_run_checkpoint_kind" NOT NULL,
	"run_status" "caretaker_run_status" NOT NULL,
	"phase" "mission_phase" NOT NULL,
	"run_version" integer NOT NULL,
	"task_ledger_version" integer NOT NULL,
	"task_ledger_hash" char(64) NOT NULL,
	"task_ledger" jsonb NOT NULL,
	"tool_call_count" integer NOT NULL,
	"plan_revision_count" integer NOT NULL,
	"clarification_pause_count" integer NOT NULL,
	"reconciliation_poll_count" integer NOT NULL,
	"active_runtime_milliseconds" integer NOT NULL,
	"pending_tool_call" jsonb,
	"evidence_refs" text[] NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "caretaker_run_checkpoints_pk" PRIMARY KEY("organization_id","run_id","sequence"),
	CONSTRAINT "caretaker_run_checkpoints_mutation_unique" UNIQUE("organization_id","run_id","mutation_key"),
	CONSTRAINT "caretaker_run_checkpoints_sequence_nonnegative" CHECK ("caretaker_run_checkpoints"."sequence" >= 0),
	CONSTRAINT "caretaker_run_checkpoints_version_matches" CHECK ("caretaker_run_checkpoints"."sequence" = "caretaker_run_checkpoints"."run_version"),
	CONSTRAINT "caretaker_run_checkpoints_task_ledger_version_nonnegative" CHECK ("caretaker_run_checkpoints"."task_ledger_version" >= 0),
	CONSTRAINT "caretaker_run_checkpoints_hashes_valid" CHECK ("caretaker_run_checkpoints"."mutation_key" ~ '^[a-f0-9]{64}$' AND "caretaker_run_checkpoints"."mutation_hash" ~ '^[a-f0-9]{64}$' AND "caretaker_run_checkpoints"."task_ledger_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "caretaker_run_checkpoints_task_ledger_valid" CHECK (caretaker_task_ledger_is_valid("caretaker_run_checkpoints"."task_ledger")),
	CONSTRAINT "caretaker_run_checkpoints_evidence_valid" CHECK (caretaker_evidence_refs_are_valid("caretaker_run_checkpoints"."evidence_refs")),
	CONSTRAINT "caretaker_run_checkpoints_pending_tool_call_valid" CHECK (caretaker_pending_tool_call_is_valid("caretaker_run_checkpoints"."pending_tool_call")),
	CONSTRAINT "caretaker_run_checkpoints_tool_call_budget" CHECK ("caretaker_run_checkpoints"."tool_call_count" >= 0 AND "caretaker_run_checkpoints"."tool_call_count" <= 24),
	CONSTRAINT "caretaker_run_checkpoints_plan_revision_budget" CHECK ("caretaker_run_checkpoints"."plan_revision_count" >= 0 AND "caretaker_run_checkpoints"."plan_revision_count" <= 3),
	CONSTRAINT "caretaker_run_checkpoints_clarification_pause_budget" CHECK ("caretaker_run_checkpoints"."clarification_pause_count" >= 0 AND "caretaker_run_checkpoints"."clarification_pause_count" <= 2),
	CONSTRAINT "caretaker_run_checkpoints_reconciliation_poll_budget" CHECK ("caretaker_run_checkpoints"."reconciliation_poll_count" >= 0 AND "caretaker_run_checkpoints"."reconciliation_poll_count" <= 3),
	CONSTRAINT "caretaker_run_checkpoints_active_runtime_budget" CHECK ("caretaker_run_checkpoints"."active_runtime_milliseconds" >= 0 AND "caretaker_run_checkpoints"."active_runtime_milliseconds" <= 300000)
);
--> statement-breakpoint
CREATE TABLE "caretaker_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"lease_epoch" integer NOT NULL,
	"status" "caretaker_run_status" NOT NULL,
	"phase" "mission_phase" NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"task_ledger_version" integer NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"plan_revision_count" integer DEFAULT 0 NOT NULL,
	"clarification_pause_count" integer DEFAULT 0 NOT NULL,
	"reconciliation_poll_count" integer DEFAULT 0 NOT NULL,
	"active_runtime_milliseconds" integer DEFAULT 0 NOT NULL,
	"pending_tool_call" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "caretaker_runs_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "caretaker_runs_id_format" CHECK ("caretaker_runs"."id" ~ '^run_[a-z0-9][a-z0-9_-]{7,63}$'),
	CONSTRAINT "caretaker_runs_lease_epoch_positive" CHECK ("caretaker_runs"."lease_epoch" > 0),
	CONSTRAINT "caretaker_runs_version_nonnegative" CHECK ("caretaker_runs"."version" >= 0),
	CONSTRAINT "caretaker_runs_task_ledger_version_nonnegative" CHECK ("caretaker_runs"."task_ledger_version" >= 0),
	CONSTRAINT "caretaker_runs_tool_call_budget" CHECK ("caretaker_runs"."tool_call_count" >= 0 AND "caretaker_runs"."tool_call_count" <= 24),
	CONSTRAINT "caretaker_runs_plan_revision_budget" CHECK ("caretaker_runs"."plan_revision_count" >= 0 AND "caretaker_runs"."plan_revision_count" <= 3),
	CONSTRAINT "caretaker_runs_clarification_pause_budget" CHECK ("caretaker_runs"."clarification_pause_count" >= 0 AND "caretaker_runs"."clarification_pause_count" <= 2),
	CONSTRAINT "caretaker_runs_reconciliation_poll_budget" CHECK ("caretaker_runs"."reconciliation_poll_count" >= 0 AND "caretaker_runs"."reconciliation_poll_count" <= 3),
	CONSTRAINT "caretaker_runs_active_runtime_budget" CHECK ("caretaker_runs"."active_runtime_milliseconds" >= 0 AND "caretaker_runs"."active_runtime_milliseconds" <= 300000),
	CONSTRAINT "caretaker_runs_pending_tool_call_valid" CHECK (caretaker_pending_tool_call_is_valid("caretaker_runs"."pending_tool_call")),
	CONSTRAINT "caretaker_runs_terminal_timestamp" CHECK (("caretaker_runs"."status" = 'active' AND "caretaker_runs"."ended_at" IS NULL) OR ("caretaker_runs"."status" <> 'active' AND "caretaker_runs"."ended_at" IS NOT NULL)),
	CONSTRAINT "caretaker_runs_time_order" CHECK ("caretaker_runs"."updated_at" >= "caretaker_runs"."started_at"),
	CONSTRAINT "caretaker_runs_end_time_order" CHECK ("caretaker_runs"."ended_at" IS NULL OR "caretaker_runs"."ended_at" >= "caretaker_runs"."started_at")
);
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "task_ledger_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "caretaker_run_checkpoints" ADD CONSTRAINT "caretaker_run_checkpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caretaker_run_checkpoints" ADD CONSTRAINT "caretaker_run_checkpoints_run_tenant_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."caretaker_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caretaker_run_checkpoints" ADD CONSTRAINT "caretaker_run_checkpoints_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caretaker_runs" ADD CONSTRAINT "caretaker_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caretaker_runs" ADD CONSTRAINT "caretaker_runs_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "caretaker_runs_one_active_per_mission" ON "caretaker_runs" USING btree ("organization_id","mission_id") WHERE "caretaker_runs"."status" = 'active';--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_task_ledger_version_nonnegative" CHECK ("missions"."task_ledger_version" >= 0);--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_task_ledger_valid" CHECK (caretaker_task_ledger_is_valid("missions"."task_ledger"));
--> statement-breakpoint
CREATE FUNCTION guard_mission_task_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  position integer;
  old_item jsonb;
  new_item jsonb;
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id AND NOT EXISTS (
    SELECT 1 FROM caretaker_runs run
    WHERE run.organization_id = NEW.organization_id
      AND run.mission_id = NEW.id
      AND run.id = NEW.run_id
      AND run.status = 'active'
      AND run.task_ledger_version = NEW.task_ledger_version
  ) THEN
    RAISE EXCEPTION 'mission caretaker run pointer requires its fenced active activation' USING ERRCODE = '40001';
  END IF;
  IF NEW.task_ledger IS NOT DISTINCT FROM OLD.task_ledger THEN
    IF NEW.task_ledger_version <> OLD.task_ledger_version THEN
      RAISE EXCEPTION 'task-ledger version cannot change without content' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.task_ledger_version <> OLD.task_ledger_version + 1 THEN
    RAISE EXCEPTION 'task-ledger version must increment exactly once' USING ERRCODE = '40001';
  END IF;
  IF jsonb_array_length(NEW.task_ledger) < jsonb_array_length(OLD.task_ledger) THEN
    RAISE EXCEPTION 'caretaker tasks cannot be removed' USING ERRCODE = '23514';
  END IF;
  FOR position IN 0..jsonb_array_length(OLD.task_ledger) - 1 LOOP
    old_item := OLD.task_ledger -> position;
    new_item := NEW.task_ledger -> position;
    IF new_item ->> 'id' IS DISTINCT FROM old_item ->> 'id'
      OR new_item ->> 'label' IS DISTINCT FROM old_item ->> 'label'
    THEN
      RAISE EXCEPTION 'caretaker task identity and label are immutable' USING ERRCODE = '23514';
    END IF;
    IF NOT ((old_item -> 'evidenceRefs') <@ (new_item -> 'evidenceRefs')) THEN
      RAISE EXCEPTION 'caretaker task evidence is append-only' USING ERRCODE = '23514';
    END IF;
    IF old_item ->> 'status' = 'completed' AND new_item ->> 'status' <> 'completed' THEN
      RAISE EXCEPTION 'completed caretaker task is terminal' USING ERRCODE = '23514';
    END IF;
    IF old_item ->> 'status' = 'in_progress' AND new_item ->> 'status' = 'pending' THEN
      RAISE EXCEPTION 'in-progress caretaker task cannot return to pending' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER missions_task_ledger_guard BEFORE UPDATE ON "missions" FOR EACH ROW EXECUTE FUNCTION guard_mission_task_ledger_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_caretaker_run_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_mission_status mission_status;
  current_mission_phase mission_phase;
  terminal_reactivation boolean := false;
  external_state_synchronization boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'caretaker runs cannot be deleted' USING ERRCODE = '55000';
  END IF;
  SELECT status, phase INTO current_mission_status, current_mission_phase
  FROM missions
  WHERE organization_id = OLD.organization_id AND id = OLD.mission_id;
  terminal_reactivation :=
    OLD.status = 'paused'
    AND NEW.status = 'active'
    AND current_mission_status IN ('succeeded', 'failed', 'cancelled')
    AND NEW.ended_at IS NULL;
  external_state_synchronization :=
    OLD.status = 'active'
    AND NEW.status = 'active'
    AND NEW.phase = current_mission_phase
    AND (
      (current_mission_status = 'waiting_for_system' AND current_mission_phase = 'observe')
      OR (current_mission_status = 'waiting_for_user' AND current_mission_phase IN ('plan', 'approve'))
      OR current_mission_status IN ('succeeded', 'failed', 'cancelled')
    );
  IF OLD.status <> 'active' AND NOT terminal_reactivation THEN
    RAISE EXCEPTION 'terminal caretaker run is immutable' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.mission_id, NEW.started_at)
    IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.mission_id, OLD.started_at)
  THEN
    RAISE EXCEPTION 'caretaker run identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'caretaker run version must increment exactly once' USING ERRCODE = '40001';
  END IF;
  IF NEW.task_ledger_version NOT BETWEEN OLD.task_ledger_version AND OLD.task_ledger_version + 1 THEN
    RAISE EXCEPTION 'caretaker task-ledger version may advance once' USING ERRCODE = '40001';
  END IF;
  IF NEW.tool_call_count NOT BETWEEN OLD.tool_call_count AND OLD.tool_call_count + 1
    OR NEW.plan_revision_count NOT BETWEEN OLD.plan_revision_count AND OLD.plan_revision_count + 1
    OR NEW.clarification_pause_count NOT BETWEEN OLD.clarification_pause_count AND OLD.clarification_pause_count + 1
    OR NEW.reconciliation_poll_count NOT BETWEEN OLD.reconciliation_poll_count AND OLD.reconciliation_poll_count + 1
    OR NEW.active_runtime_milliseconds < OLD.active_runtime_milliseconds
  THEN
    RAISE EXCEPTION 'caretaker counters are monotonic and checkpoint-bounded' USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'caretaker run time cannot move backward' USING ERRCODE = '23514';
  END IF;
  IF NEW.lease_epoch <> OLD.lease_epoch THEN
    IF NEW.lease_epoch <= OLD.lease_epoch
      OR NEW.status <> 'active'
      OR (NEW.phase <> OLD.phase AND NOT terminal_reactivation AND NOT external_state_synchronization)
      OR NEW.task_ledger_version <> OLD.task_ledger_version
      OR NEW.tool_call_count <> OLD.tool_call_count
      OR NEW.plan_revision_count <> OLD.plan_revision_count
      OR NEW.clarification_pause_count <> OLD.clarification_pause_count
      OR NEW.reconciliation_poll_count <> OLD.reconciliation_poll_count
      OR NEW.active_runtime_milliseconds <> OLD.active_runtime_milliseconds
      OR NEW.pending_tool_call IS DISTINCT FROM OLD.pending_tool_call
      OR (NEW.ended_at IS DISTINCT FROM OLD.ended_at AND NOT terminal_reactivation)
    THEN
      RAISE EXCEPTION 'caretaker lease takeover may only advance its fence and checkpoint' USING ERRCODE = '40001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM mission_leases lease
      WHERE lease.organization_id = OLD.organization_id
        AND lease.mission_id = OLD.mission_id
        AND lease.epoch = NEW.lease_epoch
        AND lease.released_at IS NULL
        AND lease.expires_at > clock_timestamp()
    ) THEN
      RAISE EXCEPTION 'caretaker run takeover requires the newer live lease' USING ERRCODE = '40001';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM mission_leases lease
    WHERE lease.organization_id = OLD.organization_id
      AND lease.mission_id = OLD.mission_id
      AND lease.epoch = OLD.lease_epoch
      AND lease.released_at IS NULL
      AND lease.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'caretaker run update requires its live lease epoch' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION validate_caretaker_run_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_run caretaker_runs%ROWTYPE;
  previous_checkpoint caretaker_run_checkpoints%ROWTYPE;
BEGIN
  IF NEW.version <> 0
    OR NEW.status <> 'active'
    OR NEW.updated_at <> NEW.started_at
    OR NEW.ended_at IS NOT NULL
    OR NEW.pending_tool_call IS NOT NULL
  THEN
    RAISE EXCEPTION 'caretaker run must begin at an activation checkpoint' USING ERRCODE = '23514';
  END IF;
  SELECT run.* INTO previous_run
  FROM missions mission
  INNER JOIN caretaker_runs run
    ON run.organization_id = mission.organization_id AND run.id = mission.run_id
  WHERE mission.organization_id = NEW.organization_id
    AND mission.id = NEW.mission_id
    AND run.mission_id = NEW.mission_id;
  IF FOUND THEN
    SELECT * INTO previous_checkpoint
    FROM caretaker_run_checkpoints checkpoint
    WHERE checkpoint.organization_id = previous_run.organization_id
      AND checkpoint.run_id = previous_run.id
      AND checkpoint.sequence = previous_run.version;
    IF previous_run.status <> 'paused'
      OR NOT FOUND
      OR previous_checkpoint.kind = 'budget_exhausted'
      OR previous_run.pending_tool_call IS NOT NULL
      OR NEW.started_at < previous_run.updated_at
      OR (NEW.tool_call_count, NEW.plan_revision_count, NEW.clarification_pause_count,
          NEW.reconciliation_poll_count, NEW.active_runtime_milliseconds)
        IS DISTINCT FROM
         (previous_run.tool_call_count, previous_run.plan_revision_count,
          previous_run.clarification_pause_count, previous_run.reconciliation_poll_count,
          previous_run.active_runtime_milliseconds)
    THEN
      RAISE EXCEPTION 'caretaker successor must inherit a resumable paused activation budget' USING ERRCODE = '40001';
    END IF;
  ELSIF NEW.tool_call_count <> 0
    OR NEW.plan_revision_count <> 0
    OR NEW.clarification_pause_count <> 0
    OR NEW.reconciliation_poll_count <> 0
    OR NEW.active_runtime_milliseconds <> 0
  THEN
    RAISE EXCEPTION 'first caretaker activation must begin with zero counters' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM missions mission
    WHERE mission.organization_id = NEW.organization_id
      AND mission.id = NEW.mission_id
      AND mission.status = 'running'
      AND mission.phase = NEW.phase
      AND mission.task_ledger_version = NEW.task_ledger_version
  ) THEN
    RAISE EXCEPTION 'caretaker run does not match current mission state' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mission_leases lease
    WHERE lease.organization_id = NEW.organization_id
      AND lease.mission_id = NEW.mission_id
      AND lease.epoch = NEW.lease_epoch
      AND lease.released_at IS NULL
      AND lease.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'caretaker run insert requires its live lease epoch' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER caretaker_runs_validate_insert BEFORE INSERT ON "caretaker_runs" FOR EACH ROW EXECUTE FUNCTION validate_caretaker_run_insert();
--> statement-breakpoint
CREATE TRIGGER caretaker_runs_guard BEFORE UPDATE OR DELETE ON "caretaker_runs" FOR EACH ROW EXECUTE FUNCTION guard_caretaker_run_mutation();
--> statement-breakpoint
CREATE FUNCTION validate_caretaker_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous caretaker_run_checkpoints%ROWTYPE;
  previous_action_kind caretaker_run_checkpoint_kind;
  expected_status caretaker_run_status;
  current_mission_status mission_status;
  current_mission_phase mission_phase;
BEGIN
  IF NEW.sequence = 0 THEN
    IF NEW.kind <> 'activated'
      OR NEW.run_status <> 'active'
      OR NEW.pending_tool_call IS NOT NULL
    THEN
      RAISE EXCEPTION 'initial caretaker checkpoint is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO previous
  FROM caretaker_run_checkpoints
  WHERE organization_id = NEW.organization_id AND run_id = NEW.run_id AND sequence = NEW.sequence - 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'caretaker checkpoint sequence has a gap' USING ERRCODE = '40001';
  END IF;
  expected_status := CASE NEW.kind
    WHEN 'clarification_pause' THEN 'paused'
    WHEN 'approval_pause' THEN 'paused'
    WHEN 'human_review_pause' THEN 'paused'
    WHEN 'external_wait' THEN 'active'
    WHEN 'budget_exhausted' THEN 'paused'
    WHEN 'completed' THEN 'completed'
    WHEN 'failed' THEN 'failed'
    WHEN 'safe_refusal' THEN 'failed'
    WHEN 'host_failed' THEN 'failed'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'lease_replaced' THEN 'active'
    ELSE 'active'
  END;
  IF NEW.run_status <> expected_status THEN
    RAISE EXCEPTION 'caretaker checkpoint kind does not match run status' USING ERRCODE = '23514';
  END IF;
  SELECT mission.status, mission.phase
  INTO current_mission_status, current_mission_phase
  FROM missions mission
  WHERE mission.organization_id = NEW.organization_id AND mission.id = NEW.mission_id;
  IF NOT FOUND OR (NEW.kind <> 'lease_replaced' AND NEW.phase <> current_mission_phase) THEN
    RAISE EXCEPTION 'caretaker checkpoint does not match current mission phase' USING ERRCODE = '23514';
  ELSIF NEW.kind = 'completed' AND (current_mission_status <> 'succeeded' OR current_mission_phase <> 'verify') THEN
    RAISE EXCEPTION 'completed run checkpoint requires a succeeded mission' USING ERRCODE = '23514';
  ELSIF NEW.kind = 'failed' AND current_mission_status <> 'failed' THEN
    RAISE EXCEPTION 'failed run checkpoint requires a failed mission' USING ERRCODE = '23514';
  ELSIF NEW.kind = 'cancelled' AND current_mission_status <> 'cancelled' THEN
    RAISE EXCEPTION 'cancelled run checkpoint requires a cancelled mission' USING ERRCODE = '23514';
  ELSIF NEW.kind = 'clarification_pause' AND (current_mission_status <> 'waiting_for_user' OR current_mission_phase <> 'plan') THEN
    RAISE EXCEPTION 'clarification pause requires waiting_for_user/plan' USING ERRCODE = '23514';
  ELSIF NEW.kind = 'approval_pause' AND (current_mission_status <> 'waiting_for_user' OR current_mission_phase <> 'approve') THEN
    RAISE EXCEPTION 'approval pause requires waiting_for_user/approve' USING ERRCODE = '23514';
  ELSIF NEW.kind = 'external_wait' AND NOT (
    (current_mission_status = 'waiting_for_system' AND current_mission_phase = 'observe')
    OR (current_mission_status = 'running' AND current_mission_phase = 'reconcile')
  ) THEN
    RAISE EXCEPTION 'external wait requires waiting_for_system/observe or running/reconcile' USING ERRCODE = '23514';
  ELSIF NEW.kind IN ('human_review_pause', 'safe_refusal', 'host_failed')
    AND current_mission_status IN ('succeeded', 'failed', 'cancelled')
  THEN
    RAISE EXCEPTION 'reason-specific disposition requires a nonterminal mission' USING ERRCODE = '23514';
  ELSIF NEW.kind = 'budget_exhausted' AND current_mission_status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'terminal mission cannot pause for a caretaker budget' USING ERRCODE = '23514';
  ELSIF NEW.kind NOT IN (
      'completed', 'failed', 'cancelled', 'clarification_pause', 'approval_pause',
      'human_review_pause', 'safe_refusal', 'host_failed', 'external_wait', 'budget_exhausted'
    )
    AND NEW.kind <> 'lease_replaced'
    AND NOT (
      NEW.kind = 'state_persisted'
      AND previous.pending_tool_call IS NOT NULL
      AND NEW.pending_tool_call IS NULL
      AND current_mission_status NOT IN ('succeeded', 'failed', 'cancelled')
    )
    AND current_mission_status <> 'running'
  THEN
    RAISE EXCEPTION 'active caretaker checkpoint requires a running mission' USING ERRCODE = '23514';
  END IF;
  IF NEW.tool_call_count <> previous.tool_call_count + (CASE WHEN NEW.kind = 'tool_call' THEN 1 ELSE 0 END)
    OR NEW.plan_revision_count <> previous.plan_revision_count + (CASE WHEN NEW.kind = 'plan_revision' THEN 1 ELSE 0 END)
    OR NEW.clarification_pause_count <> previous.clarification_pause_count + (CASE WHEN NEW.kind = 'clarification_pause' THEN 1 ELSE 0 END)
    OR NEW.reconciliation_poll_count <> previous.reconciliation_poll_count + (CASE WHEN NEW.kind = 'reconciliation_poll' THEN 1 ELSE 0 END)
    OR NEW.active_runtime_milliseconds < previous.active_runtime_milliseconds
    OR NEW.task_ledger_version NOT BETWEEN previous.task_ledger_version AND previous.task_ledger_version + 1
  THEN
    RAISE EXCEPTION 'caretaker checkpoint counters do not match its kind' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'lease_replaced' AND (
    (
      NEW.phase <> previous.phase
      AND NOT (
        current_mission_status IN ('succeeded', 'failed', 'cancelled')
        OR (current_mission_status = 'waiting_for_system' AND current_mission_phase = 'observe')
        OR (current_mission_status = 'waiting_for_user' AND current_mission_phase IN ('plan', 'approve'))
      )
    )
    OR NEW.task_ledger_version <> previous.task_ledger_version
    OR NEW.pending_tool_call IS DISTINCT FROM previous.pending_tool_call
  ) THEN
    RAISE EXCEPTION 'caretaker lease replacement must preserve activation state' USING ERRCODE = '23514';
  END IF;
  SELECT checkpoint.kind INTO previous_action_kind
  FROM caretaker_run_checkpoints checkpoint
  WHERE checkpoint.organization_id = NEW.organization_id
    AND checkpoint.run_id = NEW.run_id
    AND checkpoint.sequence < NEW.sequence
    AND checkpoint.kind <> 'lease_replaced'
  ORDER BY checkpoint.sequence DESC
  LIMIT 1;
  IF NEW.kind = 'tool_wait' AND (
    previous_action_kind NOT IN ('tool_call', 'tool_wait')
    OR NEW.active_runtime_milliseconds <= previous.active_runtime_milliseconds
    OR NEW.phase <> previous.phase
    OR NEW.task_ledger_version <> previous.task_ledger_version
    OR NEW.task_ledger_hash <> previous.task_ledger_hash
    OR NEW.task_ledger IS DISTINCT FROM previous.task_ledger
    OR cardinality(NEW.evidence_refs) <> 0
  ) THEN
    RAISE EXCEPTION 'tool wait may only advance active runtime for a dispatched call' USING ERRCODE = '23514';
  END IF;
  IF previous.pending_tool_call IS NULL THEN
    IF NEW.kind = 'tool_call' AND NEW.pending_tool_call IS NULL THEN
      RAISE EXCEPTION 'tool call must reserve its durable identity' USING ERRCODE = '23514';
    ELSIF NEW.kind = 'plan_revision' AND (
      NEW.pending_tool_call IS NULL OR NEW.pending_tool_call ->> 'toolName' <> 'plans.propose'
    ) THEN
      RAISE EXCEPTION 'plan revision must reserve plans.propose' USING ERRCODE = '23514';
    ELSIF NEW.kind = 'reconciliation_poll' AND (
      NEW.pending_tool_call IS NULL OR NEW.pending_tool_call ->> 'toolName' <> 'operations.get'
    ) THEN
      RAISE EXCEPTION 'reconciliation poll must reserve operations.get' USING ERRCODE = '23514';
    ELSIF NEW.pending_tool_call IS NOT NULL
      AND NEW.kind NOT IN ('tool_call', 'plan_revision', 'reconciliation_poll')
    THEN
      RAISE EXCEPTION 'checkpoint cannot reserve a pending tool call' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.kind = 'lease_replaced' THEN
    IF NEW.pending_tool_call IS DISTINCT FROM previous.pending_tool_call THEN
      RAISE EXCEPTION 'pending tool identity must survive lease replacement' USING ERRCODE = '23514';
    END IF;
  ELSIF previous_action_kind IN ('plan_revision', 'reconciliation_poll') THEN
    IF NEW.kind <> 'tool_call' OR NEW.pending_tool_call IS DISTINCT FROM previous.pending_tool_call THEN
      RAISE EXCEPTION 'semantic reservation must be followed by its tool call' USING ERRCODE = '23514';
    END IF;
  ELSIF previous_action_kind IN ('tool_call', 'tool_wait') THEN
    IF NEW.kind = 'tool_wait' THEN
      IF NEW.pending_tool_call IS DISTINCT FROM previous.pending_tool_call THEN
        RAISE EXCEPTION 'tool wait must preserve the dispatched tool identity' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.kind <> 'state_persisted' OR NEW.pending_tool_call IS NOT NULL THEN
      RAISE EXCEPTION 'dispatched tool call may only wait or be cleared by its result checkpoint' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'pending tool call lacks its reservation checkpoint' USING ERRCODE = '23514';
  END IF;
  IF expected_status <> 'active' AND NEW.pending_tool_call IS NOT NULL THEN
    RAISE EXCEPTION 'paused or terminal run cannot retain a pending tool call' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER caretaker_run_checkpoints_validate BEFORE INSERT ON "caretaker_run_checkpoints" FOR EACH ROW EXECUTE FUNCTION validate_caretaker_checkpoint();
--> statement-breakpoint
CREATE TRIGGER caretaker_run_checkpoints_append_only BEFORE UPDATE OR DELETE ON "caretaker_run_checkpoints" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE FUNCTION assert_caretaker_run_checkpoint_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM caretaker_run_checkpoints checkpoint
    WHERE checkpoint.organization_id = NEW.organization_id
      AND checkpoint.mission_id = NEW.mission_id
      AND checkpoint.run_id = NEW.id
      AND checkpoint.sequence = NEW.version
      AND checkpoint.run_status = NEW.status
      AND checkpoint.phase = NEW.phase
      AND checkpoint.run_version = NEW.version
      AND checkpoint.task_ledger_version = NEW.task_ledger_version
      AND checkpoint.tool_call_count = NEW.tool_call_count
      AND checkpoint.plan_revision_count = NEW.plan_revision_count
      AND checkpoint.clarification_pause_count = NEW.clarification_pause_count
      AND checkpoint.reconciliation_poll_count = NEW.reconciliation_poll_count
      AND checkpoint.active_runtime_milliseconds = NEW.active_runtime_milliseconds
      AND checkpoint.pending_tool_call IS NOT DISTINCT FROM NEW.pending_tool_call
      AND checkpoint.occurred_at = NEW.updated_at
  ) THEN
    RAISE EXCEPTION 'caretaker run update lacks a matching checkpoint' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER caretaker_runs_checkpoint_consistency AFTER INSERT OR UPDATE ON "caretaker_runs" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_caretaker_run_checkpoint_consistency();
--> statement-breakpoint
CREATE FUNCTION assert_caretaker_checkpoint_run_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_run caretaker_runs%ROWTYPE;
BEGIN
  SELECT * INTO current_run
  FROM caretaker_runs run
  WHERE run.organization_id = NEW.organization_id AND run.id = NEW.run_id;
  IF NOT FOUND OR current_run.mission_id <> NEW.mission_id OR current_run.version < NEW.sequence THEN
    RAISE EXCEPTION 'caretaker checkpoint is not bound to its run version' USING ERRCODE = '23514';
  END IF;
  IF current_run.version = NEW.sequence AND (
    current_run.status <> NEW.run_status
    OR current_run.phase <> NEW.phase
    OR current_run.task_ledger_version <> NEW.task_ledger_version
    OR current_run.tool_call_count <> NEW.tool_call_count
    OR current_run.plan_revision_count <> NEW.plan_revision_count
    OR current_run.clarification_pause_count <> NEW.clarification_pause_count
    OR current_run.reconciliation_poll_count <> NEW.reconciliation_poll_count
    OR current_run.active_runtime_milliseconds <> NEW.active_runtime_milliseconds
    OR current_run.pending_tool_call IS DISTINCT FROM NEW.pending_tool_call
    OR current_run.updated_at <> NEW.occurred_at
  ) THEN
    RAISE EXCEPTION 'latest caretaker checkpoint disagrees with its run' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER caretaker_checkpoints_run_consistency AFTER INSERT ON "caretaker_run_checkpoints" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_caretaker_checkpoint_run_consistency();
--> statement-breakpoint
CREATE FUNCTION assert_mission_task_ledger_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_ledger IS DISTINCT FROM OLD.task_ledger AND NOT EXISTS (
    SELECT 1 FROM caretaker_run_checkpoints checkpoint
    WHERE checkpoint.organization_id = NEW.organization_id
      AND checkpoint.mission_id = NEW.id
      AND checkpoint.task_ledger_version = NEW.task_ledger_version
      AND checkpoint.task_ledger = NEW.task_ledger
  ) THEN
    RAISE EXCEPTION 'mission task-ledger update lacks a caretaker checkpoint' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER missions_task_ledger_checkpoint AFTER UPDATE ON "missions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_mission_task_ledger_checkpoint();

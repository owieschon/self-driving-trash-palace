CREATE FUNCTION clarification_public_text_is_safe(input_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT
    input_value !~* '(bearer[[:space:]]+[a-z0-9._~+/-]{8,}|(phc|phx|sk)_[a-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|authorization|cookie|credential|password|secret|token)[[:space:]]*[=:][[:space:]]*[^[:space:]]+)'
    AND input_value !~* '(^|[[:space:]"''(])/(Users|home)/[^/[:space:]]+'
    AND input_value !~* '(^|[[:space:]"''(])[a-z]:\\Users\\[^\\[:space:]]+'
    AND input_value !~* 'https?://(localhost|0\.0\.0\.0|127\.0\.0\.1|\[?::1\]?|10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+)(:[0-9]+)?(/|$)';
$$;--> statement-breakpoint
CREATE FUNCTION clarification_evidence_refs_are_valid(input_refs text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT
    cardinality(input_refs) <= 16
    AND text_array_is_unique(input_refs)
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(input_refs) AS evidence_ref
      WHERE evidence_ref !~ '^evd_[a-z0-9][a-z0-9_-]{7,63}$'
    );
$$;--> statement-breakpoint
CREATE FUNCTION clarification_request_payload_is_valid(
  input_question text,
  input_choices jsonb,
  input_evidence_refs text[]
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
AS $$
DECLARE
  choice jsonb;
BEGIN
  IF char_length(input_question) NOT BETWEEN 12 AND 280
    OR NOT clarification_public_text_is_safe(input_question)
    OR jsonb_typeof(input_choices) <> 'array'
    OR jsonb_array_length(input_choices) NOT BETWEEN 2 AND 6
    OR NOT clarification_evidence_refs_are_valid(input_evidence_refs)
  THEN
    RETURN false;
  END IF;

  FOR choice IN SELECT value FROM jsonb_array_elements(input_choices)
  LOOP
    IF jsonb_typeof(choice) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(choice)) <> 3
      OR NOT (choice ?& ARRAY['id', 'label', 'description'])
      OR (choice ->> 'id') !~ '^[a-z][a-z0-9_-]{2,39}$'
      OR char_length(choice ->> 'label') NOT BETWEEN 1 AND 80
      OR char_length(choice ->> 'description') NOT BETWEEN 1 AND 240
      OR NOT clarification_public_text_is_safe(choice ->> 'label')
      OR NOT clarification_public_text_is_safe(choice ->> 'description')
    THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN (
    SELECT count(DISTINCT value ->> 'id') = jsonb_array_length(input_choices)
    FROM jsonb_array_elements(input_choices)
  );
END;
$$;--> statement-breakpoint
CREATE TYPE "public"."clarification_status" AS ENUM('pending', 'answered');--> statement-breakpoint
CREATE TABLE "clarification_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"request_id" text NOT NULL,
	"idempotency_key" char(64) NOT NULL,
	"payload_hash" char(64) NOT NULL,
	"choice_id" text NOT NULL,
	"answered_by" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "clarification_answers_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "clarification_answers_request_unique" UNIQUE("organization_id","request_id"),
	CONSTRAINT "clarification_answers_idempotency_unique" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "clarification_answers_id_format" CHECK ("clarification_answers"."id" ~ '^cla_[a-z0-9][a-z0-9_-]{7,63}$'),
	CONSTRAINT "clarification_answers_hashes_valid" CHECK ("clarification_answers"."idempotency_key" ~ '^[a-f0-9]{64}$' AND "clarification_answers"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "clarification_answers_choice_id_valid" CHECK ("clarification_answers"."choice_id" ~ '^[a-z][a-z0-9_-]{2,39}$'),
	CONSTRAINT "clarification_answers_evidence_refs_valid" CHECK (clarification_evidence_refs_are_valid("clarification_answers"."evidence_refs"))
);
--> statement-breakpoint
CREATE TABLE "clarification_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"idempotency_key" char(64) NOT NULL,
	"payload_hash" char(64) NOT NULL,
	"question" text NOT NULL,
	"choices" jsonb NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"requested_by" text NOT NULL,
	"status" "clarification_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "clarification_requests_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "clarification_requests_tenant_mission_id_unique" UNIQUE("organization_id","mission_id","id"),
	CONSTRAINT "clarification_requests_idempotency_unique" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "clarification_requests_id_format" CHECK ("clarification_requests"."id" ~ '^clr_[a-z0-9][a-z0-9_-]{7,63}$'),
	CONSTRAINT "clarification_requests_hashes_valid" CHECK ("clarification_requests"."idempotency_key" ~ '^[a-f0-9]{64}$' AND "clarification_requests"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "clarification_requests_payload_valid" CHECK (clarification_request_payload_is_valid("clarification_requests"."question", "clarification_requests"."choices", "clarification_requests"."evidence_refs")),
	CONSTRAINT "clarification_requests_resolution_shape" CHECK (("clarification_requests"."status" = 'pending' AND "clarification_requests"."resolved_at" IS NULL) OR ("clarification_requests"."status" = 'answered' AND "clarification_requests"."resolved_at" IS NOT NULL AND "clarification_requests"."resolved_at" >= "clarification_requests"."requested_at"))
);
--> statement-breakpoint
ALTER TABLE "clarification_answers" ADD CONSTRAINT "clarification_answers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_answers" ADD CONSTRAINT "clarification_answers_request_tenant_fk" FOREIGN KEY ("organization_id","mission_id","request_id") REFERENCES "public"."clarification_requests"("organization_id","mission_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_answers" ADD CONSTRAINT "clarification_answers_answerer_tenant_fk" FOREIGN KEY ("organization_id","answered_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD CONSTRAINT "clarification_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD CONSTRAINT "clarification_requests_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD CONSTRAINT "clarification_requests_requester_tenant_fk" FOREIGN KEY ("organization_id","requested_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clarification_requests_one_pending_per_mission" ON "clarification_requests" USING btree ("organization_id","mission_id") WHERE "clarification_requests"."status" = 'pending';--> statement-breakpoint
CREATE FUNCTION enforce_clarification_request_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mission_status_value mission_status;
  mission_phase_value mission_phase;
BEGIN
  SELECT status, phase
  INTO mission_status_value, mission_phase_value
  FROM missions
  WHERE organization_id = NEW.organization_id AND id = NEW.mission_id
  FOR SHARE;

  IF mission_status_value IS NULL
    OR mission_status_value <> 'running'
    OR mission_phase_value <> 'plan'
  THEN
    RAISE EXCEPTION 'clarification request requires running/plan mission'
      USING ERRCODE = '23514', CONSTRAINT = 'clarification_requests_mission_state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.evidence_refs) AS evidence_ref
    LEFT JOIN evidence e
      ON e.organization_id = NEW.organization_id
      AND e.mission_id = NEW.mission_id
      AND e.id = evidence_ref
    WHERE e.id IS NULL
  ) THEN
    RAISE EXCEPTION 'clarification request evidence is not mission-bound'
      USING ERRCODE = '23514', CONSTRAINT = 'clarification_requests_evidence_binding';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER clarification_requests_insert_guard
BEFORE INSERT ON clarification_requests
FOR EACH ROW EXECUTE FUNCTION enforce_clarification_request_insert();--> statement-breakpoint
CREATE FUNCTION enforce_clarification_request_immutability() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'clarification request history is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'clarification_requests_immutable';
  END IF;

  IF OLD.status <> 'pending'
    OR NEW.status <> 'answered'
    OR NEW.resolved_at IS NULL
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.mission_id IS DISTINCT FROM OLD.mission_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.question IS DISTINCT FROM OLD.question
    OR NEW.choices IS DISTINCT FROM OLD.choices
    OR NEW.evidence_refs IS DISTINCT FROM OLD.evidence_refs
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NOT EXISTS (
      SELECT 1
      FROM clarification_answers answer
      WHERE answer.organization_id = OLD.organization_id
        AND answer.request_id = OLD.id
        AND answer.mission_id = OLD.mission_id
        AND answer.answered_at = NEW.resolved_at
    )
  THEN
    RAISE EXCEPTION 'clarification request history is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'clarification_requests_immutable';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER clarification_requests_immutable_guard
BEFORE UPDATE OR DELETE ON clarification_requests
FOR EACH ROW EXECUTE FUNCTION enforce_clarification_request_immutability();--> statement-breakpoint
CREATE FUNCTION enforce_clarification_answer_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  request_row clarification_requests%ROWTYPE;
  mission_status_value mission_status;
  mission_phase_value mission_phase;
  answerer_role membership_role;
BEGIN
  SELECT * INTO request_row
  FROM clarification_requests
  WHERE organization_id = NEW.organization_id
    AND mission_id = NEW.mission_id
    AND id = NEW.request_id
  FOR UPDATE;

  IF request_row.id IS NULL OR request_row.status <> 'pending' THEN
    RAISE EXCEPTION 'clarification answer requires a pending request'
      USING ERRCODE = '23514', CONSTRAINT = 'clarification_answers_pending_request';
  END IF;
  IF NEW.answered_at < request_row.requested_at THEN
    RAISE EXCEPTION 'clarification answer precedes its request'
      USING ERRCODE = '23514', CONSTRAINT = 'clarification_answers_time_order';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(request_row.choices) AS choice
    WHERE choice ->> 'id' = NEW.choice_id
  ) THEN
    RAISE EXCEPTION 'clarification answer did not select an offered choice'
      USING ERRCODE = '23514', CONSTRAINT = 'clarification_answers_offered_choice';
  END IF;

  SELECT status, phase INTO mission_status_value, mission_phase_value
  FROM missions
  WHERE organization_id = NEW.organization_id AND id = NEW.mission_id
  FOR SHARE;
  IF mission_status_value <> 'waiting_for_user' OR mission_phase_value <> 'plan' THEN
    RAISE EXCEPTION 'clarification answer requires waiting_for_user/plan mission'
      USING ERRCODE = '23514', CONSTRAINT = 'clarification_answers_mission_state';
  END IF;

  SELECT role INTO answerer_role
  FROM memberships
  WHERE organization_id = NEW.organization_id
    AND user_id = NEW.answered_by
    AND revoked_at IS NULL;
  IF answerer_role IS NULL OR answerer_role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'clarification answer requires an authenticated human operator'
      USING ERRCODE = '23514', CONSTRAINT = 'clarification_answers_human_actor';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.evidence_refs) AS evidence_ref
    LEFT JOIN evidence e
      ON e.organization_id = NEW.organization_id
      AND e.mission_id = NEW.mission_id
      AND e.id = evidence_ref
    WHERE e.id IS NULL
  ) THEN
    RAISE EXCEPTION 'clarification answer evidence is not mission-bound'
      USING ERRCODE = '23514', CONSTRAINT = 'clarification_answers_evidence_binding';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER clarification_answers_insert_guard
BEFORE INSERT ON clarification_answers
FOR EACH ROW EXECUTE FUNCTION enforce_clarification_answer_insert();--> statement-breakpoint
CREATE FUNCTION resolve_clarification_request_from_answer() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE clarification_requests
  SET status = 'answered', resolved_at = NEW.answered_at
  WHERE organization_id = NEW.organization_id
    AND mission_id = NEW.mission_id
    AND id = NEW.request_id
    AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clarification request was answered concurrently'
      USING ERRCODE = '23514', CONSTRAINT = 'clarification_answers_resolution';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER clarification_answers_resolve_request
AFTER INSERT ON clarification_answers
FOR EACH ROW EXECUTE FUNCTION resolve_clarification_request_from_answer();--> statement-breakpoint
CREATE FUNCTION enforce_clarification_answer_immutability() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'clarification answer history is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'clarification_answers_immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER clarification_answers_immutable_guard
BEFORE UPDATE OR DELETE ON clarification_answers
FOR EACH ROW EXECUTE FUNCTION enforce_clarification_answer_immutability();

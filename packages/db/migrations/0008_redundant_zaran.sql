CREATE TYPE "public"."context_artifact_kind" AS ENUM('request', 'bundle', 'manifest', 'internal_receipt', 'public_receipt');--> statement-breakpoint
CREATE TABLE "context_artifacts" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" "context_artifact_kind" NOT NULL,
	"artifact_hash" char(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_artifacts_pk" PRIMARY KEY("organization_id","mission_id","run_id","kind","id"),
	CONSTRAINT "context_artifacts_tenant_kind_id_unique" UNIQUE("organization_id","kind","id"),
	CONSTRAINT "context_artifacts_id_format" CHECK ("context_artifacts"."id" ~ '^[a-z][a-z0-9._-]{2,159}$'),
	CONSTRAINT "context_artifacts_run_id_format" CHECK ("context_artifacts"."run_id" ~ '^run_[a-z0-9][a-z0-9_-]{7,63}$'),
	CONSTRAINT "context_artifacts_hash_valid" CHECK ("context_artifacts"."artifact_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "context_artifacts_payload_binding" CHECK ("context_artifacts"."payload" ->> 'schemaVersion' = '1.0.0' AND CASE "context_artifacts"."kind" WHEN 'request' THEN "context_artifacts"."payload" ->> 'requestId' = "context_artifacts"."id" WHEN 'bundle' THEN "context_artifacts"."payload" ->> 'bundleId' = "context_artifacts"."id" WHEN 'manifest' THEN "context_artifacts"."payload" ->> 'manifestId' = "context_artifacts"."id" WHEN 'internal_receipt' THEN "context_artifacts"."payload" ->> 'receiptId' = "context_artifacts"."id" WHEN 'public_receipt' THEN "context_artifacts"."payload" ->> 'receiptId' = "context_artifacts"."id" ELSE FALSE END)
);
--> statement-breakpoint
CREATE TABLE "context_runs" (
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"mission_ref" text NOT NULL,
	"run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_runs_pk" PRIMARY KEY("organization_id","run_id"),
	CONSTRAINT "context_runs_tenant_mission_run_unique" UNIQUE("organization_id","mission_id","run_id"),
	CONSTRAINT "context_runs_tenant_mission_ref_unique" UNIQUE("organization_id","mission_ref"),
	CONSTRAINT "context_runs_run_id_format" CHECK ("context_runs"."run_id" ~ '^run_[a-z0-9][a-z0-9_-]{7,63}$'),
	CONSTRAINT "context_runs_mission_ref_format" CHECK ("context_runs"."mission_ref" ~ '^mission_[a-z0-9][a-z0-9_-]{7,151}$')
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"version" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"canonical_uri" text NOT NULL,
	"audiences" text[] NOT NULL,
	"phases" "mission_phase"[] NOT NULL,
	"risk" text NOT NULL,
	"visibility" text NOT NULL,
	"sensitivity" text NOT NULL,
	"tenant_scoped" boolean NOT NULL,
	"publishable" boolean NOT NULL,
	"instruction_role" text NOT NULL,
	"retention" text NOT NULL,
	"source_hash" char(64) NOT NULL,
	"search_document" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(content, '')), 'B')) STORED NOT NULL,
	"indexed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "knowledge_sources_id_format" CHECK ("knowledge_sources"."id" ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'),
	CONSTRAINT "knowledge_sources_version_format" CHECK ("knowledge_sources"."version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$'),
	CONSTRAINT "knowledge_sources_title_length" CHECK (char_length("knowledge_sources"."title") BETWEEN 1 AND 200),
	CONSTRAINT "knowledge_sources_content_length" CHECK (char_length("knowledge_sources"."content") BETWEEN 1 AND 200000),
	CONSTRAINT "knowledge_sources_scope_valid" CHECK (("knowledge_sources"."organization_id" IS NULL AND "knowledge_sources"."tenant_scoped" IS FALSE AND "knowledge_sources"."visibility" IN ('public', 'internal')) OR ("knowledge_sources"."organization_id" IS NOT NULL AND "knowledge_sources"."tenant_scoped" IS TRUE AND "knowledge_sources"."visibility" = 'tenant')),
	CONSTRAINT "knowledge_sources_metadata_valid" CHECK ("knowledge_sources"."risk" IN ('read', 'reversible-write', 'consequential-write') AND "knowledge_sources"."sensitivity" IN ('public', 'internal', 'confidential') AND "knowledge_sources"."instruction_role" IN ('procedure', 'reference', 'untrusted_evidence') AND "knowledge_sources"."retention" IN ('versioned', 'ephemeral')),
	CONSTRAINT "knowledge_sources_arrays_present" CHECK (cardinality("knowledge_sources"."audiences") > 0 AND cardinality("knowledge_sources"."phases") > 0),
	CONSTRAINT "knowledge_sources_hash_valid" CHECK ("knowledge_sources"."source_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tool_call_receipt_evidence" (
	"organization_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "tool_call_receipt_evidence_pk" PRIMARY KEY("organization_id","receipt_id","evidence_id"),
	CONSTRAINT "tool_call_receipt_evidence_position_unique" UNIQUE("organization_id","receipt_id","position"),
	CONSTRAINT "tool_call_receipt_evidence_position_nonnegative" CHECK ("tool_call_receipt_evidence"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tool_call_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"schema_version" text DEFAULT 'tool-call-receipt@1' NOT NULL,
	"call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"status" text NOT NULL,
	"channel" text NOT NULL,
	"tenant_scope_hash" char(64) NOT NULL,
	"input_hash" char(64) NOT NULL,
	"result_hash" char(64) NOT NULL,
	"tool_contract_hash" char(64) NOT NULL,
	"tool_registry_hash" char(64) NOT NULL,
	"attempt_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tool_call_receipts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tool_call_receipts_call_unique" UNIQUE("organization_id","call_id"),
	CONSTRAINT "tool_call_receipts_schema_version" CHECK ("tool_call_receipts"."schema_version" = 'tool-call-receipt@1'),
	CONSTRAINT "tool_call_receipts_id_format" CHECK ("tool_call_receipts"."id" ~ '^rcp_[a-z0-9][a-z0-9_-]{7,63}$'),
	CONSTRAINT "tool_call_receipts_call_id_format" CHECK ("tool_call_receipts"."call_id" ~ '^call_[a-z0-9][a-z0-9_-]{7,63}$'),
	CONSTRAINT "tool_call_receipts_tool_name" CHECK ("tool_call_receipts"."tool_name" IN ('palaces.get', 'crews.list', 'capabilities.list', 'routines.list', 'routines.get', 'executions.list', 'knowledge.search', 'plans.propose', 'plans.validate', 'plans.simulate', 'plans.request_approval', 'plans.activate', 'operations.get', 'verification.get_evidence', 'missions.cancel')),
	CONSTRAINT "tool_call_receipts_status" CHECK ("tool_call_receipts"."status" IN ('succeeded', 'pending', 'denied', 'conflict', 'unknown', 'failed')),
	CONSTRAINT "tool_call_receipts_channel" CHECK ("tool_call_receipts"."channel" IN ('in_process', 'http', 'mcp')),
	CONSTRAINT "tool_call_receipts_hashes_valid" CHECK ("tool_call_receipts"."tenant_scope_hash" ~ '^[a-f0-9]{64}$' AND "tool_call_receipts"."input_hash" ~ '^[a-f0-9]{64}$' AND "tool_call_receipts"."result_hash" ~ '^[a-f0-9]{64}$' AND "tool_call_receipts"."tool_contract_hash" ~ '^[a-f0-9]{64}$' AND "tool_call_receipts"."tool_registry_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "tool_call_receipts_time_order" CHECK ("tool_call_receipts"."completed_at" >= "tool_call_receipts"."started_at")
);
--> statement-breakpoint
ALTER TABLE "context_artifacts" ADD CONSTRAINT "context_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_artifacts" ADD CONSTRAINT "context_artifacts_run_tenant_fk" FOREIGN KEY ("organization_id","mission_id","run_id") REFERENCES "public"."context_runs"("organization_id","mission_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_runs" ADD CONSTRAINT "context_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_runs" ADD CONSTRAINT "context_runs_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_receipt_evidence" ADD CONSTRAINT "tool_call_receipt_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_receipt_evidence" ADD CONSTRAINT "tool_call_receipt_evidence_receipt_tenant_fk" FOREIGN KEY ("organization_id","receipt_id") REFERENCES "public"."tool_call_receipts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_receipt_evidence" ADD CONSTRAINT "tool_call_receipt_evidence_evidence_tenant_fk" FOREIGN KEY ("organization_id","evidence_id") REFERENCES "public"."evidence"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_receipts" ADD CONSTRAINT "tool_call_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_receipts" ADD CONSTRAINT "tool_call_receipts_attempt_tenant_fk" FOREIGN KEY ("organization_id","attempt_id") REFERENCES "public"."attempts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_artifacts_run_idx" ON "context_artifacts" USING btree ("organization_id","mission_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_sources_tenant_idx" ON "knowledge_sources" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_search_idx" ON "knowledge_sources" USING gin ("search_document");--> statement-breakpoint
CREATE TRIGGER context_runs_append_only BEFORE UPDATE OR DELETE ON "context_runs" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();--> statement-breakpoint
CREATE TRIGGER context_artifacts_append_only BEFORE UPDATE OR DELETE ON "context_artifacts" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();--> statement-breakpoint
CREATE TRIGGER tool_call_receipts_append_only BEFORE UPDATE OR DELETE ON "tool_call_receipts" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();--> statement-breakpoint
CREATE TRIGGER tool_call_receipt_evidence_append_only BEFORE UPDATE OR DELETE ON "tool_call_receipt_evidence" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();

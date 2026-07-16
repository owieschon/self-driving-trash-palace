CREATE FUNCTION text_array_is_unique(input_values text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(input_values) = count(DISTINCT value)
  FROM unnest(input_values) AS value
$$;
--> statement-breakpoint
ALTER TABLE "access_tokens" ALTER COLUMN "issued_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_lifecycle_timestamps_valid" CHECK (("access_tokens"."revoked_at" IS NULL OR "access_tokens"."revoked_at" >= "access_tokens"."created_at") AND ("access_tokens"."last_used_at" IS NULL OR "access_tokens"."last_used_at" >= "access_tokens"."created_at"));--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_scopes_delegated_only" CHECK ("access_tokens"."scopes" <@ ARRAY['palace:read', 'crew:read', 'capability:read', 'routine:read', 'routine:draft', 'routine:validate', 'routine:simulate', 'routine:activate', 'recovery:propose', 'operation:reconcile', 'verification:read', 'knowledge:read', 'mission:cancel']::text[]);--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_scopes_unique" CHECK (text_array_is_unique("access_tokens"."scopes"));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_lifecycle_timestamps_valid" CHECK (("sessions"."revoked_at" IS NULL OR "sessions"."revoked_at" >= "sessions"."created_at") AND ("sessions"."last_seen_at" IS NULL OR "sessions"."last_seen_at" >= "sessions"."created_at"));

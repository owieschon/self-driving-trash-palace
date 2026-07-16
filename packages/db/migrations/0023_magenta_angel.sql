CREATE TYPE "public"."connector_provider" AS ENUM('smartthings');--> statement-breakpoint
CREATE TABLE "connector_credentials" (
	"organization_id" text NOT NULL,
	"provider" "connector_provider" NOT NULL,
	"access_token_ciphertext" "bytea" NOT NULL,
	"access_token_nonce" "bytea" NOT NULL,
	"access_token_tag" "bytea" NOT NULL,
	"refresh_token_ciphertext" "bytea" NOT NULL,
	"refresh_token_nonce" "bytea" NOT NULL,
	"refresh_token_tag" "bytea" NOT NULL,
	"installed_app_id_ciphertext" "bytea" NOT NULL,
	"installed_app_id_nonce" "bytea" NOT NULL,
	"installed_app_id_tag" "bytea" NOT NULL,
	"installed_app_id_digest" char(64) NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"scopes" text[] NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_credentials_organization_id_provider_pk" PRIMARY KEY("organization_id","provider"),
	CONSTRAINT "connector_credentials_installation_unique" UNIQUE("provider","installed_app_id_digest"),
	CONSTRAINT "connector_credentials_revision_positive" CHECK ("connector_credentials"."revision" > 0),
	CONSTRAINT "connector_credentials_installation_digest_valid" CHECK ("connector_credentials"."installed_app_id_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "connector_device_candidates" (
	"organization_id" text NOT NULL,
	"provider" "connector_provider" NOT NULL,
	"candidate_id" text NOT NULL,
	"provider_device_id_ciphertext" "bytea" NOT NULL,
	"provider_device_id_nonce" "bytea" NOT NULL,
	"provider_device_id_tag" "bytea" NOT NULL,
	"provider_device_id_digest" char(64) NOT NULL,
	"provider_component_id_ciphertext" "bytea" NOT NULL,
	"provider_component_id_nonce" "bytea" NOT NULL,
	"provider_component_id_tag" "bytea" NOT NULL,
	"provider_component_id_digest" char(64) NOT NULL,
	"capabilities" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_device_candidates_organization_id_provider_candidate_id_pk" PRIMARY KEY("organization_id","provider","candidate_id"),
	CONSTRAINT "connector_candidates_provider_identity_unique" UNIQUE("organization_id","provider","provider_device_id_digest","provider_component_id_digest")
);
--> statement-breakpoint
CREATE TABLE "connector_device_mappings" (
	"organization_id" text NOT NULL,
	"provider" "connector_provider" NOT NULL,
	"slot_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"confirmed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_device_mappings_organization_id_provider_slot_id_pk" PRIMARY KEY("organization_id","provider","slot_id"),
	CONSTRAINT "connector_device_mappings_confirmed_by" CHECK ("connector_device_mappings"."confirmed_by" = 'human')
);
--> statement-breakpoint
CREATE TABLE "connector_oauth_states" (
	"organization_id" text NOT NULL,
	"provider" "connector_provider" NOT NULL,
	"session_binding_hash" char(64) NOT NULL,
	"state_digest" char(64) NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_oauth_states_organization_id_provider_state_digest_pk" PRIMARY KEY("organization_id","provider","state_digest"),
	CONSTRAINT "connector_oauth_state_digest_valid" CHECK ("connector_oauth_states"."state_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "connector_oauth_session_binding_hash_valid" CHECK ("connector_oauth_states"."session_binding_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_device_candidates" ADD CONSTRAINT "connector_device_candidates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_device_mappings" ADD CONSTRAINT "connector_device_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_device_mappings" ADD CONSTRAINT "connector_device_mappings_candidate_fk" FOREIGN KEY ("organization_id","provider","candidate_id") REFERENCES "public"."connector_device_candidates"("organization_id","provider","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
CREATE TABLE "identity_telemetry_ingresses" (
	"schema_version" text DEFAULT 'identity-telemetry-ingress@1' NOT NULL,
	"provider_event_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"palace_id" text NOT NULL,
	"identity_tag_id" text NOT NULL,
	"nonce" text NOT NULL,
	"principal_id" text NOT NULL,
	"key_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"verified_payload_hash" char(64) NOT NULL,
	"signature_timestamp" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"evidence_id" text NOT NULL,
	"authority_receipt_id" text NOT NULL,
	"identity_verified" boolean NOT NULL,
	CONSTRAINT "identity_telemetry_ingresses_pk" PRIMARY KEY("organization_id","provider_event_id"),
	CONSTRAINT "identity_telemetry_ingresses_nonce_unique" UNIQUE("organization_id","nonce"),
	CONSTRAINT "identity_telemetry_ingresses_evidence_unique" UNIQUE("evidence_id"),
	CONSTRAINT "identity_telemetry_ingresses_receipt_unique" UNIQUE("organization_id","authority_receipt_id"),
	CONSTRAINT "identity_telemetry_ingresses_evidence_binding_unique" UNIQUE("organization_id","provider_event_id","evidence_id","authority_receipt_id"),
	CONSTRAINT "identity_telemetry_ingresses_schema_version" CHECK ("identity_telemetry_ingresses"."schema_version" = 'identity-telemetry-ingress@1'),
	CONSTRAINT "identity_telemetry_ingresses_identifiers" CHECK ("identity_telemetry_ingresses"."provider_event_id" ~ '^idt_[A-Za-z0-9_-]{8,96}$' AND "identity_telemetry_ingresses"."nonce" ~ '^itn_[A-Za-z0-9_-]{16,96}$' AND "identity_telemetry_ingresses"."principal_id" ~ '^itp_[A-Za-z0-9_-]{8,64}$' AND "identity_telemetry_ingresses"."key_id" ~ '^itk_[A-Za-z0-9_-]{8,64}$' AND "identity_telemetry_ingresses"."evidence_id" ~ '^evd_[a-z0-9][a-z0-9_-]{7,63}$' AND "identity_telemetry_ingresses"."authority_receipt_id" ~ '^rcp_[a-z0-9][a-z0-9_-]{7,63}$'),
	CONSTRAINT "identity_telemetry_ingresses_key_version_positive" CHECK ("identity_telemetry_ingresses"."key_version" > 0),
	CONSTRAINT "identity_telemetry_ingresses_payload_hash" CHECK ("identity_telemetry_ingresses"."verified_payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "identity_telemetry_ingresses_verification_order" CHECK ("identity_telemetry_ingresses"."signature_timestamp" <= "identity_telemetry_ingresses"."verified_at" + interval '30 seconds')
);
--> statement-breakpoint
ALTER TABLE "identity_telemetry_ingresses" ADD CONSTRAINT "identity_telemetry_ingresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_telemetry_ingresses" ADD CONSTRAINT "identity_telemetry_ingresses_mission_tenant_fk" FOREIGN KEY ("organization_id","mission_id") REFERENCES "public"."missions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_telemetry_ingresses" ADD CONSTRAINT "identity_telemetry_ingresses_palace_tenant_fk" FOREIGN KEY ("organization_id","palace_id") REFERENCES "public"."palaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_telemetry_ingresses" ADD CONSTRAINT "identity_telemetry_ingresses_tag_tenant_fk" FOREIGN KEY ("organization_id","identity_tag_id") REFERENCES "public"."identity_tags"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_identity_telemetry_ingress_fk" FOREIGN KEY ("organization_id","authority_provider_event_id","id","authority_receipt_id") REFERENCES "public"."identity_telemetry_ingresses"("organization_id","provider_event_id","evidence_id","authority_receipt_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_identity_telemetry_v2_required" CHECK ("evidence"."authority" <> 'identity_telemetry' OR "evidence"."authority_receipt" ->> 'schemaVersion' = 'evidence-authority-receipt@2') NOT VALID;--> statement-breakpoint
CREATE FUNCTION guard_identity_telemetry_ingress() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  derived_verified boolean;
  tag_exists boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'identity telemetry ingress provenance is append-only' USING ERRCODE = '55000';
  END IF;

  SELECT true,
         COALESCE(tag.active AND tag.verified AND crew.active AND crew.palace_id = NEW.palace_id, false)
    INTO tag_exists, derived_verified
    FROM identity_tags AS tag
    LEFT JOIN crew_members AS crew
      ON crew.organization_id = tag.organization_id
     AND crew.id = tag.crew_member_id
   WHERE tag.organization_id = NEW.organization_id
     AND tag.id = NEW.identity_tag_id;

  IF tag_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'identity telemetry tag is not registered in the tenant' USING ERRCODE = '23503';
  END IF;
  IF NEW.identity_verified IS DISTINCT FROM derived_verified THEN
    RAISE EXCEPTION 'identity telemetry verdict does not match active tag and crew state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER identity_telemetry_ingresses_guard BEFORE INSERT OR UPDATE OR DELETE ON "identity_telemetry_ingresses" FOR EACH ROW EXECUTE FUNCTION guard_identity_telemetry_ingress();--> statement-breakpoint
CREATE FUNCTION guard_identity_telemetry_evidence_insert() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  ingress identity_telemetry_ingresses%ROWTYPE;
BEGIN
  IF NEW.authority <> 'identity_telemetry' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO ingress
    FROM identity_telemetry_ingresses
   WHERE organization_id = NEW.organization_id
     AND provider_event_id = NEW.authority_provider_event_id
     AND evidence_id = NEW.id
     AND authority_receipt_id = NEW.authority_receipt_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'identity evidence requires verified ingress provenance' USING ERRCODE = '23503';
  END IF;
  IF NEW.authority_receipt ->> 'schemaVersion' <> 'evidence-authority-receipt@2'
     OR NEW.authority_receipt ->> 'providerEventId' <> ingress.provider_event_id
     OR NEW.authority_receipt ->> 'identityTagId' <> ingress.identity_tag_id
     OR NEW.authority_receipt ->> 'principalId' <> ingress.principal_id
     OR NEW.authority_receipt ->> 'keyId' <> ingress.key_id
     OR (NEW.authority_receipt ->> 'keyVersion')::integer <> ingress.key_version
     OR NEW.authority_receipt ->> 'verifiedPayloadHash' <> ingress.verified_payload_hash
     OR NEW.payload ->> 'identityTagId' <> ingress.identity_tag_id
     OR (NEW.payload ->> 'verified')::boolean IS DISTINCT FROM ingress.identity_verified THEN
    RAISE EXCEPTION 'identity evidence does not match verified ingress provenance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER identity_telemetry_evidence_insert_guard BEFORE INSERT ON "evidence" FOR EACH ROW EXECUTE FUNCTION guard_identity_telemetry_evidence_insert();

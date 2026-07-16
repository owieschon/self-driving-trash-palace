CREATE TYPE "public"."product_evidence_capture_status" AS ENUM('stored', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."product_evidence_delivery_status" AS ENUM('pending', 'delivered');--> statement-breakpoint
CREATE TABLE "product_evidence_deliveries" (
	"organization_id" text NOT NULL,
	"logical_event_id" text NOT NULL,
	"semantic_hash" char(64) NOT NULL,
	"event_insert_id" text NOT NULL,
	"event_hash" char(64) NOT NULL,
	"event_serialized" text NOT NULL,
	"status" "product_evidence_delivery_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"capture_status" "product_evidence_capture_status",
	CONSTRAINT "product_evidence_deliveries_pk" PRIMARY KEY("organization_id","logical_event_id"),
	CONSTRAINT "product_evidence_deliveries_logical_event_unique" UNIQUE("logical_event_id"),
	CONSTRAINT "product_evidence_deliveries_insert_id_unique" UNIQUE("event_insert_id"),
	CONSTRAINT "product_evidence_deliveries_logical_event_id_valid" CHECK ("product_evidence_deliveries"."logical_event_id" ~ '^evt_application_[a-f0-9]{32}$'),
	CONSTRAINT "product_evidence_deliveries_insert_id_valid" CHECK ("product_evidence_deliveries"."event_insert_id" ~ '^tpi_v1_[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "product_evidence_deliveries_hashes_valid" CHECK ("product_evidence_deliveries"."semantic_hash" ~ '^[a-f0-9]{64}$' AND "product_evidence_deliveries"."event_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "product_evidence_deliveries_event_serialized_valid" CHECK (octet_length("product_evidence_deliveries"."event_serialized") BETWEEN 2 AND 65536),
	CONSTRAINT "product_evidence_deliveries_delivery_state_valid" CHECK (("product_evidence_deliveries"."status" = 'pending' AND "product_evidence_deliveries"."delivered_at" IS NULL AND "product_evidence_deliveries"."capture_status" IS NULL) OR ("product_evidence_deliveries"."status" = 'delivered' AND "product_evidence_deliveries"."delivered_at" IS NOT NULL AND "product_evidence_deliveries"."capture_status" IS NOT NULL)),
	CONSTRAINT "product_evidence_deliveries_time_order" CHECK ("product_evidence_deliveries"."delivered_at" IS NULL OR "product_evidence_deliveries"."delivered_at" >= "product_evidence_deliveries"."created_at")
);
--> statement-breakpoint
ALTER TABLE "product_evidence_deliveries" ADD CONSTRAINT "product_evidence_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
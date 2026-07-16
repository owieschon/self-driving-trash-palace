ALTER TABLE "mission_leases" ADD COLUMN "epoch" integer;--> statement-breakpoint
ALTER TABLE "mission_leases" ADD COLUMN "token_fingerprint" char(64);--> statement-breakpoint
ALTER TABLE "mission_leases" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
UPDATE "mission_leases"
SET "epoch" = "record_version",
    "token_fingerprint" = encode(sha256(convert_to("token", 'UTF8')), 'hex'),
    "released_at" = clock_timestamp();--> statement-breakpoint
ALTER TABLE "mission_leases" ALTER COLUMN "epoch" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mission_leases" ALTER COLUMN "token_fingerprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mission_leases" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "mission_leases" ADD CONSTRAINT "mission_leases_epoch_positive" CHECK ("mission_leases"."epoch" > 0);--> statement-breakpoint
ALTER TABLE "mission_leases" ADD CONSTRAINT "mission_leases_release_valid" CHECK ("mission_leases"."released_at" IS NULL OR "mission_leases"."released_at" >= "mission_leases"."acquired_at");

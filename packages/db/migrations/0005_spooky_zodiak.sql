ALTER TABLE "gateway_effects" DROP CONSTRAINT "gateway_effects_callback_shape";--> statement-breakpoint
ALTER TABLE "execution_milestones" DROP CONSTRAINT "execution_milestones_command_tenant_fk";
--> statement-breakpoint
ALTER TABLE "gateway_effect_reconciliation_polls" ALTER COLUMN "observed_effect_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "gateway_effects" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "gateway_effects" ALTER COLUMN "status" SET DEFAULT 'pending'::text;--> statement-breakpoint
DROP TYPE "public"."gateway_effect_status";--> statement-breakpoint
CREATE TYPE "public"."gateway_effect_status" AS ENUM('pending', 'acknowledged', 'executing', 'completed', 'failed');--> statement-breakpoint
ALTER TABLE "gateway_effect_reconciliation_polls" ALTER COLUMN "observed_effect_status" SET DATA TYPE "public"."gateway_effect_status" USING "observed_effect_status"::"public"."gateway_effect_status";--> statement-breakpoint
ALTER TABLE "gateway_effects" ALTER COLUMN "status" SET DEFAULT 'pending'::"public"."gateway_effect_status";--> statement-breakpoint
ALTER TABLE "gateway_effects" ALTER COLUMN "status" SET DATA TYPE "public"."gateway_effect_status" USING "status"::"public"."gateway_effect_status";--> statement-breakpoint
ALTER TABLE "gateway_effect_reconciliation_polls" ADD COLUMN "cancellation_requested" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_effects" ADD CONSTRAINT "gateway_effects_callback_shape" CHECK (("gateway_effects"."status" = 'pending' AND "gateway_effects"."callback_id" IS NULL) OR ("gateway_effects"."status" IN ('acknowledged', 'executing', 'completed', 'failed') AND "gateway_effects"."callback_id" IS NOT NULL));
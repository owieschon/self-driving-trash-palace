CREATE TYPE "public"."mission_program_kind" AS ENUM('night_shift_homecoming', 'scheduled_hauler_access');--> statement-breakpoint
ALTER TYPE "public"."capability_kind" ADD VALUE 'service_hatch_access' BEFORE 'pathway_lighting';--> statement-breakpoint
ALTER TYPE "public"."capability_kind" ADD VALUE 'residential_hatch_lock_state' BEFORE 'pathway_lighting';--> statement-breakpoint
ALTER TYPE "public"."device_kind" ADD VALUE 'service_hatch_lock' BEFORE 'pathway_light';--> statement-breakpoint
ALTER TYPE "public"."device_kind" ADD VALUE 'residential_hatch_lock' BEFORE 'pathway_light';--> statement-breakpoint
ALTER TYPE "public"."execution_milestone_name" ADD VALUE 'access_window';--> statement-breakpoint
ALTER TYPE "public"."execution_milestone_name" ADD VALUE 'verified_hauler_identity';--> statement-breakpoint
ALTER TYPE "public"."execution_milestone_name" ADD VALUE 'service_hatch_unlock';--> statement-breakpoint
ALTER TYPE "public"."execution_milestone_name" ADD VALUE 'service_hatch_relock';--> statement-breakpoint
ALTER TYPE "public"."execution_milestone_name" ADD VALUE 'residential_hatch_guard';--> statement-breakpoint
ALTER TYPE "public"."plan_action_type" ADD VALUE 'replace_scheduled_hauler_access_routine' BEFORE 'restore_routine_version';--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "program_kind" "mission_program_kind" DEFAULT 'night_shift_homecoming' NOT NULL;

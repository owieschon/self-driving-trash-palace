CREATE TABLE "crew_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"palace_id" text NOT NULL,
	"crew_member_id" text NOT NULL,
	"kind" text NOT NULL,
	"active" boolean NOT NULL,
	"version" integer NOT NULL,
	"target_celsius" double precision NOT NULL,
	"pathway_lighting_intensity_percent" integer NOT NULL,
	"pathway_lighting_duration_seconds" integer NOT NULL,
	CONSTRAINT "crew_preferences_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "crew_preferences_kind_valid" CHECK ("crew_preferences"."kind" = 'homecoming_comfort'),
	CONSTRAINT "crew_preferences_version_positive" CHECK ("crew_preferences"."version" > 0),
	CONSTRAINT "crew_preferences_target_range" CHECK ("crew_preferences"."target_celsius" >= 5 AND "crew_preferences"."target_celsius" <= 35),
	CONSTRAINT "crew_preferences_lighting_intensity_range" CHECK ("crew_preferences"."pathway_lighting_intensity_percent" >= 0 AND "crew_preferences"."pathway_lighting_intensity_percent" <= 100),
	CONSTRAINT "crew_preferences_lighting_duration_range" CHECK ("crew_preferences"."pathway_lighting_duration_seconds" >= 1 AND "crew_preferences"."pathway_lighting_duration_seconds" <= 86400)
);
--> statement-breakpoint
CREATE TABLE "crew_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"palace_id" text NOT NULL,
	"crew_member_id" text NOT NULL,
	"active" boolean NOT NULL,
	"version" integer NOT NULL,
	"timezone" text NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text NOT NULL,
	CONSTRAINT "crew_schedules_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "crew_schedules_version_positive" CHECK ("crew_schedules"."version" > 0),
	CONSTRAINT "crew_schedules_timezone_length" CHECK (char_length("crew_schedules"."timezone") BETWEEN 1 AND 64),
	CONSTRAINT "crew_schedules_windows_valid" CHECK ("crew_schedules"."window_start" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' AND "crew_schedules"."window_end" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' AND "crew_schedules"."window_start" <> "crew_schedules"."window_end")
);
--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_tenant_id_palace_unique" UNIQUE("organization_id","id","palace_id");--> statement-breakpoint
ALTER TABLE "crew_preferences" ADD CONSTRAINT "crew_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_preferences" ADD CONSTRAINT "crew_preferences_palace_tenant_fk" FOREIGN KEY ("organization_id","palace_id") REFERENCES "public"."palaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_preferences" ADD CONSTRAINT "crew_preferences_crew_palace_tenant_fk" FOREIGN KEY ("organization_id","crew_member_id","palace_id") REFERENCES "public"."crew_members"("organization_id","id","palace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_schedules" ADD CONSTRAINT "crew_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_schedules" ADD CONSTRAINT "crew_schedules_palace_tenant_fk" FOREIGN KEY ("organization_id","palace_id") REFERENCES "public"."palaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_schedules" ADD CONSTRAINT "crew_schedules_crew_palace_tenant_fk" FOREIGN KEY ("organization_id","crew_member_id","palace_id") REFERENCES "public"."crew_members"("organization_id","id","palace_id") ON DELETE no action ON UPDATE no action;

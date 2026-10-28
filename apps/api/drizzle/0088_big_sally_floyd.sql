CREATE TABLE "business_calendars" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"hours" jsonb NOT NULL,
	"exceptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_calendars_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "business_calendars" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "record_schedule_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"occurrence_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_schedule_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "record_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"importer" text NOT NULL,
	"template" jsonb NOT NULL,
	"rrule" text NOT NULL,
	"start_date" date NOT NULL,
	"time" text NOT NULL,
	"timezone" text NOT NULL,
	"calendar_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"end_reason" text,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"max_occurrences" integer,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_schedules_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "record_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_calendars" ADD CONSTRAINT "business_calendars_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_schedule_runs" ADD CONSTRAINT "record_schedule_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_schedule_runs" ADD CONSTRAINT "record_schedule_runs_schedule_fk" FOREIGN KEY ("tenant_id","schedule_id") REFERENCES "public"."record_schedules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_schedules" ADD CONSTRAINT "record_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_schedules" ADD CONSTRAINT "record_schedules_calendar_fk" FOREIGN KEY ("tenant_id","calendar_id") REFERENCES "public"."business_calendars"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_calendars_name_idx" ON "business_calendars" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "record_schedule_runs_occurrence_idx" ON "record_schedule_runs" USING btree ("schedule_id","occurrence_at");--> statement-breakpoint
CREATE INDEX "record_schedules_owner_idx" ON "record_schedules" USING btree ("owner","id");--> statement-breakpoint
CREATE INDEX "record_schedules_next_run_at_idx" ON "record_schedules" USING btree ("next_run_at") WHERE "record_schedules"."status" = 'active';--> statement-breakpoint
CREATE POLICY "business_calendars_tenant_select" ON "business_calendars" AS PERMISSIVE FOR SELECT TO public USING (("business_calendars"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "business_calendars_tenant_insert" ON "business_calendars" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("business_calendars"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "business_calendars_tenant_update" ON "business_calendars" AS PERMISSIVE FOR UPDATE TO public USING (("business_calendars"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("business_calendars"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "business_calendars_tenant_delete" ON "business_calendars" AS PERMISSIVE FOR DELETE TO public USING (("business_calendars"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedule_runs_tenant_select" ON "record_schedule_runs" AS PERMISSIVE FOR SELECT TO public USING (("record_schedule_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedule_runs_tenant_insert" ON "record_schedule_runs" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("record_schedule_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedule_runs_tenant_update" ON "record_schedule_runs" AS PERMISSIVE FOR UPDATE TO public USING (("record_schedule_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("record_schedule_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedule_runs_tenant_delete" ON "record_schedule_runs" AS PERMISSIVE FOR DELETE TO public USING (("record_schedule_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedules_tenant_select" ON "record_schedules" AS PERMISSIVE FOR SELECT TO public USING (("record_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedules_tenant_insert" ON "record_schedules" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("record_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedules_tenant_update" ON "record_schedules" AS PERMISSIVE FOR UPDATE TO public USING (("record_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("record_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedules_tenant_delete" ON "record_schedules" AS PERMISSIVE FOR DELETE TO public USING (("record_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
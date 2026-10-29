CREATE TABLE "data_quality_findings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"check" text NOT NULL,
	"field" text NOT NULL,
	"severity" text NOT NULL,
	"detail" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_quality_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "data_quality_scans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"scanned" integer DEFAULT 0 NOT NULL,
	"findings" integer,
	"started_by" text NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_quality_scans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "data_quality_findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_quality_scans" ADD CONSTRAINT "data_quality_scans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_quality_findings_key_idx" ON "data_quality_findings" USING btree ("tenant_id","subject","record_id","check","field");--> statement-breakpoint
CREATE INDEX "data_quality_scans_tenant_idx" ON "data_quality_scans" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE POLICY "data_quality_findings_tenant_select" ON "data_quality_findings" AS PERMISSIVE FOR SELECT TO public USING (("data_quality_findings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_findings_tenant_insert" ON "data_quality_findings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("data_quality_findings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_findings_tenant_update" ON "data_quality_findings" AS PERMISSIVE FOR UPDATE TO public USING (("data_quality_findings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("data_quality_findings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_findings_tenant_delete" ON "data_quality_findings" AS PERMISSIVE FOR DELETE TO public USING (("data_quality_findings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_scans_tenant_select" ON "data_quality_scans" AS PERMISSIVE FOR SELECT TO public USING (("data_quality_scans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_scans_tenant_insert" ON "data_quality_scans" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("data_quality_scans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_scans_tenant_update" ON "data_quality_scans" AS PERMISSIVE FOR UPDATE TO public USING (("data_quality_scans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("data_quality_scans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_scans_tenant_delete" ON "data_quality_scans" AS PERMISSIVE FOR DELETE TO public USING (("data_quality_scans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
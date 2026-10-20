CREATE TABLE "naming_series" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"pattern" text NOT NULL,
	"label" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "naming_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "naming_series" ADD CONSTRAINT "naming_series_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "naming_series_pattern_idx" ON "naming_series" USING btree ("tenant_id","subject","pattern");--> statement-breakpoint
CREATE UNIQUE INDEX "naming_series_default_idx" ON "naming_series" USING btree ("tenant_id","subject") WHERE "naming_series"."is_default";--> statement-breakpoint
CREATE POLICY "naming_series_tenant_select" ON "naming_series" AS PERMISSIVE FOR SELECT TO public USING (("naming_series"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "naming_series_tenant_insert" ON "naming_series" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("naming_series"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "naming_series_tenant_update" ON "naming_series" AS PERMISSIVE FOR UPDATE TO public USING (("naming_series"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("naming_series"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "naming_series_tenant_delete" ON "naming_series" AS PERMISSIVE FOR DELETE TO public USING (("naming_series"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
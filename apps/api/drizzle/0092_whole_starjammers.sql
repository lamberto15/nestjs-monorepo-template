CREATE TABLE "recent_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"subject" text NOT NULL,
	"record_id" text NOT NULL,
	"label" text NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recent_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recent_records" ADD CONSTRAINT "recent_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recent_records_owner_record_idx" ON "recent_records" USING btree ("tenant_id","owner","subject","record_id");--> statement-breakpoint
CREATE INDEX "recent_records_owner_viewed_at_idx" ON "recent_records" USING btree ("owner","viewed_at");--> statement-breakpoint
CREATE INDEX "recent_records_viewed_at_idx" ON "recent_records" USING btree ("viewed_at");--> statement-breakpoint
CREATE POLICY "recent_records_tenant_select" ON "recent_records" AS PERMISSIVE FOR SELECT TO public USING (("recent_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "recent_records_tenant_insert" ON "recent_records" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("recent_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "recent_records_tenant_update" ON "recent_records" AS PERMISSIVE FOR UPDATE TO public USING (("recent_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("recent_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "recent_records_tenant_delete" ON "recent_records" AS PERMISSIVE FOR DELETE TO public USING (("recent_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
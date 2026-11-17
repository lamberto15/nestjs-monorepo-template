CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"record_id" uuid,
	"reason" text NOT NULL,
	"placed_by" text NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" text,
	"release_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"days" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retention_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_holds_active_idx" ON "legal_holds" USING btree ("tenant_id","subject","record_id") WHERE released_at is null;--> statement-breakpoint
CREATE INDEX "legal_holds_created_at_idx" ON "legal_holds" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_policies_rule_idx" ON "retention_policies" USING btree ("tenant_id","rule");--> statement-breakpoint
CREATE INDEX "retention_policies_enabled_idx" ON "retention_policies" USING btree ("tenant_id","enabled");--> statement-breakpoint
CREATE POLICY "legal_holds_tenant_select" ON "legal_holds" AS PERMISSIVE FOR SELECT TO public USING ((("legal_holds"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("legal_holds"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "legal_holds"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "legal_holds_tenant_insert" ON "legal_holds" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("legal_holds"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "legal_holds_tenant_update" ON "legal_holds" AS PERMISSIVE FOR UPDATE TO public USING (("legal_holds"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("legal_holds"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "legal_holds_tenant_delete" ON "legal_holds" AS PERMISSIVE FOR DELETE TO public USING (("legal_holds"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "retention_policies_tenant_select" ON "retention_policies" AS PERMISSIVE FOR SELECT TO public USING ((("retention_policies"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("retention_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "retention_policies"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "retention_policies_tenant_insert" ON "retention_policies" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("retention_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "retention_policies_tenant_update" ON "retention_policies" AS PERMISSIVE FOR UPDATE TO public USING (("retention_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("retention_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "retention_policies_tenant_delete" ON "retention_policies" AS PERMISSIVE FOR DELETE TO public USING (("retention_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
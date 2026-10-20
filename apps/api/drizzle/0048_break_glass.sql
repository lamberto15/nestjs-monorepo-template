CREATE TABLE "break_glass_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"target_tenant_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "break_glass_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_target_tenant_id_tenants_id_fk" FOREIGN KEY ("target_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "break_glass_grants_user_target_idx" ON "break_glass_grants" USING btree ("tenant_id","user_id","target_tenant_id");--> statement-breakpoint
CREATE POLICY "break_glass_grants_tenant_select" ON "break_glass_grants" AS PERMISSIVE FOR SELECT TO public USING ((("break_glass_grants"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "break_glass_grants"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "break_glass_grants_tenant_insert" ON "break_glass_grants" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "break_glass_grants_tenant_update" ON "break_glass_grants" AS PERMISSIVE FOR UPDATE TO public USING (("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "break_glass_grants_tenant_delete" ON "break_glass_grants" AS PERMISSIVE FOR DELETE TO public USING (("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
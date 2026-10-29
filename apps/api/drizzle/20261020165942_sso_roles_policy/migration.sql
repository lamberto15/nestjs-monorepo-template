CREATE TABLE "sso_domain_routes" (
	"domain" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_domain_routes_domain_tenant_id_pk" PRIMARY KEY("domain","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "sso_exemptions" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_exemptions_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "sso_exemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_policies" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"require_sso" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sso_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_role_grants" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_role_grants_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "sso_role_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_role_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"group" text,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_role_mappings_connection_group_role_key" UNIQUE NULLS NOT DISTINCT("connection_id","group","role_id")
);
--> statement-breakpoint
ALTER TABLE "sso_role_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "require_encrypted_assertions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "sp_private_key" text;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "sp_certificate" text;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "groups_attribute" text;--> statement-breakpoint
ALTER TABLE "sso_domain_routes" ADD CONSTRAINT "sso_domain_routes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_exemptions" ADD CONSTRAINT "sso_exemptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_exemptions" ADD CONSTRAINT "sso_exemptions_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_policies" ADD CONSTRAINT "sso_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_role_grants" ADD CONSTRAINT "sso_role_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_role_grants" ADD CONSTRAINT "sso_role_grants_user_role_fk" FOREIGN KEY ("user_id","role_id") REFERENCES "public"."user_roles"("user_id","role_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_role_grants" ADD CONSTRAINT "sso_role_grants_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."sso_connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_role_mappings" ADD CONSTRAINT "sso_role_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_role_mappings" ADD CONSTRAINT "sso_role_mappings_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."sso_connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_role_mappings" ADD CONSTRAINT "sso_role_mappings_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sso_domain_routes_tenant_id_idx" ON "sso_domain_routes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sso_role_grants_connection_idx" ON "sso_role_grants" USING btree ("connection_id","user_id");--> statement-breakpoint
CREATE INDEX "sso_role_mappings_role_id_idx" ON "sso_role_mappings" USING btree ("role_id");--> statement-breakpoint
CREATE POLICY "sso_exemptions_tenant_select" ON "sso_exemptions" AS PERMISSIVE FOR SELECT TO public USING ((("sso_exemptions"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("sso_exemptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "sso_exemptions"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "sso_exemptions_tenant_insert" ON "sso_exemptions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_exemptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_exemptions_tenant_update" ON "sso_exemptions" AS PERMISSIVE FOR UPDATE TO public USING (("sso_exemptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_exemptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_exemptions_tenant_delete" ON "sso_exemptions" AS PERMISSIVE FOR DELETE TO public USING (("sso_exemptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_policies_tenant_select" ON "sso_policies" AS PERMISSIVE FOR SELECT TO public USING ((("sso_policies"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("sso_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "sso_policies"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "sso_policies_tenant_insert" ON "sso_policies" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_policies_tenant_update" ON "sso_policies" AS PERMISSIVE FOR UPDATE TO public USING (("sso_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_policies_tenant_delete" ON "sso_policies" AS PERMISSIVE FOR DELETE TO public USING (("sso_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_grants_tenant_select" ON "sso_role_grants" AS PERMISSIVE FOR SELECT TO public USING ((("sso_role_grants"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("sso_role_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "sso_role_grants"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "sso_role_grants_tenant_insert" ON "sso_role_grants" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_role_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_grants_tenant_update" ON "sso_role_grants" AS PERMISSIVE FOR UPDATE TO public USING (("sso_role_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_role_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_grants_tenant_delete" ON "sso_role_grants" AS PERMISSIVE FOR DELETE TO public USING (("sso_role_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_mappings_tenant_select" ON "sso_role_mappings" AS PERMISSIVE FOR SELECT TO public USING ((("sso_role_mappings"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("sso_role_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "sso_role_mappings"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "sso_role_mappings_tenant_insert" ON "sso_role_mappings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_role_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_mappings_tenant_update" ON "sso_role_mappings" AS PERMISSIVE FOR UPDATE TO public USING (("sso_role_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_role_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_mappings_tenant_delete" ON "sso_role_mappings" AS PERMISSIVE FOR DELETE TO public USING (("sso_role_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
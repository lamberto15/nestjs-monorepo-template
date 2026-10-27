ALTER TABLE "team_tree" RENAME TO "organizational_unit_closure";--> statement-breakpoint
ALTER TABLE "user_teams" RENAME TO "organizational_unit_memberships";--> statement-breakpoint
ALTER TABLE "teams" RENAME TO "organizational_units";--> statement-breakpoint
ALTER TABLE "invitations" RENAME COLUMN "team_ids" TO "unit_ids";--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" RENAME COLUMN "team_id" TO "unit_id";--> statement-breakpoint
ALTER TABLE "scim_groups" RENAME COLUMN "team_id" TO "unit_id";--> statement-breakpoint
ALTER TABLE "saved_views" RENAME COLUMN "team_id" TO "unit_id";--> statement-breakpoint
ALTER TABLE "notes" RENAME COLUMN "team_id" TO "unit_id";--> statement-breakpoint
ALTER TABLE "saved_views" DROP CONSTRAINT "saved_views_team_check";--> statement-breakpoint
ALTER TABLE "saved_views" DROP CONSTRAINT "saved_views_visibility_check";--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" DROP CONSTRAINT "team_tree_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" DROP CONSTRAINT "team_tree_ancestor_fk";
--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" DROP CONSTRAINT "team_tree_descendant_fk";
--> statement-breakpoint
ALTER TABLE "organizational_units" DROP CONSTRAINT "teams_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "organizational_units" DROP CONSTRAINT "teams_parent_fk";
--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" DROP CONSTRAINT "user_teams_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" DROP CONSTRAINT "user_teams_membership_fk";
--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" DROP CONSTRAINT "user_teams_team_fk";
--> statement-breakpoint
ALTER TABLE "scim_groups" DROP CONSTRAINT "scim_groups_team_fk";
--> statement-breakpoint
ALTER TABLE "saved_views" DROP CONSTRAINT "saved_views_team_fk";
--> statement-breakpoint
ALTER TABLE "notes" DROP CONSTRAINT "notes_team_fk";
--> statement-breakpoint
DROP INDEX "team_tree_descendant_idx";--> statement-breakpoint
DROP INDEX "teams_parent_id_idx";--> statement-breakpoint
DROP INDEX "user_teams_team_id_idx";--> statement-breakpoint
DROP INDEX "saved_views_team_idx";--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" DROP CONSTRAINT "team_tree_ancestor_id_descendant_id_pk";--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" DROP CONSTRAINT "user_teams_user_id_team_id_pk";--> statement-breakpoint
ALTER TABLE "scim_groups" DROP CONSTRAINT "scim_groups_tenant_id_team_id_pk";--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" ADD CONSTRAINT "organizational_unit_closure_ancestor_id_descendant_id_pk" PRIMARY KEY("ancestor_id","descendant_id");--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_tenant_id_unit_id_pk" PRIMARY KEY("tenant_id","unit_id");--> statement-breakpoint
ALTER TABLE "organizational_units" ADD COLUMN "type" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD COLUMN "valid_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" ADD CONSTRAINT "organizational_unit_closure_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizational_units" ADD CONSTRAINT "organizational_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD CONSTRAINT "organizational_unit_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD CONSTRAINT "organizational_unit_memberships_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organizational_unit_closure_descendant_idx" ON "organizational_unit_closure" USING btree ("descendant_id");--> statement-breakpoint
CREATE INDEX "organizational_units_parent_id_idx" ON "organizational_units" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizational_units_sibling_name_idx" ON "organizational_units" USING btree ("tenant_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "organizational_unit_memberships_open_idx" ON "organizational_unit_memberships" USING btree ("tenant_id","unit_id","user_id") WHERE "organizational_unit_memberships"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "organizational_unit_memberships_user_idx" ON "organizational_unit_memberships" USING btree ("user_id","valid_from");--> statement-breakpoint
CREATE INDEX "organizational_unit_memberships_unit_idx" ON "organizational_unit_memberships" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "saved_views_unit_idx" ON "saved_views" USING btree ("unit_id");--> statement-breakpoint
ALTER TABLE "organizational_units" ADD CONSTRAINT "organizational_units_type_check" CHECK ("organizational_units"."type" in ('division', 'department', 'team'));--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD CONSTRAINT "organizational_unit_memberships_role_check" CHECK ("organizational_unit_memberships"."role" in ('member', 'lead'));--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD CONSTRAINT "organizational_unit_memberships_period_check" CHECK ("organizational_unit_memberships"."valid_to" is null or "organizational_unit_memberships"."valid_to" > "organizational_unit_memberships"."valid_from");--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_unit_check" CHECK (("saved_views"."visibility" in ('unit', 'team')) = ("saved_views"."unit_id" is not null));--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_visibility_check" CHECK ("saved_views"."visibility" in ('private', 'unit', 'team', 'tenant'));--> statement-breakpoint
DROP POLICY "team_tree_tenant_select" ON "organizational_unit_closure" CASCADE;--> statement-breakpoint
DROP POLICY "team_tree_tenant_insert" ON "organizational_unit_closure" CASCADE;--> statement-breakpoint
DROP POLICY "team_tree_tenant_update" ON "organizational_unit_closure" CASCADE;--> statement-breakpoint
DROP POLICY "team_tree_tenant_delete" ON "organizational_unit_closure" CASCADE;--> statement-breakpoint
DROP POLICY "teams_tenant_select" ON "organizational_units" CASCADE;--> statement-breakpoint
DROP POLICY "teams_tenant_insert" ON "organizational_units" CASCADE;--> statement-breakpoint
DROP POLICY "teams_tenant_update" ON "organizational_units" CASCADE;--> statement-breakpoint
DROP POLICY "teams_tenant_delete" ON "organizational_units" CASCADE;--> statement-breakpoint
DROP POLICY "user_teams_tenant_select" ON "organizational_unit_memberships" CASCADE;--> statement-breakpoint
DROP POLICY "user_teams_tenant_insert" ON "organizational_unit_memberships" CASCADE;--> statement-breakpoint
DROP POLICY "user_teams_tenant_update" ON "organizational_unit_memberships" CASCADE;--> statement-breakpoint
DROP POLICY "user_teams_tenant_delete" ON "organizational_unit_memberships" CASCADE;--> statement-breakpoint
CREATE POLICY "organizational_unit_closure_tenant_select" ON "organizational_unit_closure" AS PERMISSIVE FOR SELECT TO public USING ((("organizational_unit_closure"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "organizational_unit_closure"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "organizational_unit_closure_tenant_insert" ON "organizational_unit_closure" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_closure_tenant_update" ON "organizational_unit_closure" AS PERMISSIVE FOR UPDATE TO public USING (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_closure_tenant_delete" ON "organizational_unit_closure" AS PERMISSIVE FOR DELETE TO public USING (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_select" ON "organizational_units" AS PERMISSIVE FOR SELECT TO public USING ((("organizational_units"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "organizational_units"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_insert" ON "organizational_units" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_update" ON "organizational_units" AS PERMISSIVE FOR UPDATE TO public USING (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_delete" ON "organizational_units" AS PERMISSIVE FOR DELETE TO public USING (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_select" ON "organizational_unit_memberships" AS PERMISSIVE FOR SELECT TO public USING ((("organizational_unit_memberships"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "organizational_unit_memberships"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_insert" ON "organizational_unit_memberships" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_update" ON "organizational_unit_memberships" AS PERMISSIVE FOR UPDATE TO public USING (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_delete" ON "organizational_unit_memberships" AS PERMISSIVE FOR DELETE TO public USING (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
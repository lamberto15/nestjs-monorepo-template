ALTER TABLE "org_unit_tree" RENAME TO "team_tree";--> statement-breakpoint
ALTER TABLE "org_units" RENAME TO "teams";--> statement-breakpoint
ALTER TABLE "user_org_units" RENAME TO "user_teams";--> statement-breakpoint
ALTER TABLE "invitations" RENAME COLUMN "org_unit_ids" TO "team_ids";--> statement-breakpoint
ALTER TABLE "user_teams" RENAME COLUMN "org_unit_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "notes" RENAME COLUMN "org_unit_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "team_tree" DROP CONSTRAINT "org_unit_tree_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "team_tree" DROP CONSTRAINT "org_unit_tree_ancestor_fk";
--> statement-breakpoint
ALTER TABLE "team_tree" DROP CONSTRAINT "org_unit_tree_descendant_fk";
--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "org_units_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "org_units_parent_fk";
--> statement-breakpoint
ALTER TABLE "user_teams" DROP CONSTRAINT "user_org_units_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "user_teams" DROP CONSTRAINT "user_org_units_membership_fk";
--> statement-breakpoint
ALTER TABLE "user_teams" DROP CONSTRAINT "user_org_units_org_unit_fk";
--> statement-breakpoint
ALTER TABLE "notes" DROP CONSTRAINT "notes_org_unit_fk";
--> statement-breakpoint
DROP INDEX "org_unit_tree_descendant_idx";--> statement-breakpoint
DROP INDEX "org_units_parent_id_idx";--> statement-breakpoint
DROP INDEX "user_org_units_org_unit_id_idx";--> statement-breakpoint
ALTER TABLE "team_tree" DROP CONSTRAINT "org_unit_tree_ancestor_id_descendant_id_pk";--> statement-breakpoint
ALTER TABLE "user_teams" DROP CONSTRAINT "user_org_units_user_id_org_unit_id_pk";--> statement-breakpoint
ALTER TABLE "team_tree" ADD CONSTRAINT "team_tree_ancestor_id_descendant_id_pk" PRIMARY KEY("ancestor_id","descendant_id");--> statement-breakpoint
ALTER TABLE "user_teams" ADD CONSTRAINT "user_teams_user_id_team_id_pk" PRIMARY KEY("user_id","team_id");--> statement-breakpoint
ALTER TABLE "team_tree" ADD CONSTRAINT "team_tree_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_teams" ADD CONSTRAINT "user_teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_teams" ADD CONSTRAINT "user_teams_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_tree_descendant_idx" ON "team_tree" USING btree ("descendant_id");--> statement-breakpoint
CREATE INDEX "teams_parent_id_idx" ON "teams" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "user_teams_team_id_idx" ON "user_teams" USING btree ("team_id");--> statement-breakpoint
DROP POLICY "org_unit_tree_tenant_select" ON "team_tree" CASCADE;--> statement-breakpoint
DROP POLICY "org_unit_tree_tenant_insert" ON "team_tree" CASCADE;--> statement-breakpoint
DROP POLICY "org_unit_tree_tenant_update" ON "team_tree" CASCADE;--> statement-breakpoint
DROP POLICY "org_unit_tree_tenant_delete" ON "team_tree" CASCADE;--> statement-breakpoint
DROP POLICY "org_units_tenant_select" ON "teams" CASCADE;--> statement-breakpoint
DROP POLICY "org_units_tenant_insert" ON "teams" CASCADE;--> statement-breakpoint
DROP POLICY "org_units_tenant_update" ON "teams" CASCADE;--> statement-breakpoint
DROP POLICY "org_units_tenant_delete" ON "teams" CASCADE;--> statement-breakpoint
DROP POLICY "user_org_units_tenant_select" ON "user_teams" CASCADE;--> statement-breakpoint
DROP POLICY "user_org_units_tenant_insert" ON "user_teams" CASCADE;--> statement-breakpoint
DROP POLICY "user_org_units_tenant_update" ON "user_teams" CASCADE;--> statement-breakpoint
DROP POLICY "user_org_units_tenant_delete" ON "user_teams" CASCADE;--> statement-breakpoint
CREATE POLICY "team_tree_tenant_select" ON "team_tree" AS PERMISSIVE FOR SELECT TO public USING (("team_tree"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "team_tree_tenant_insert" ON "team_tree" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("team_tree"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "team_tree_tenant_update" ON "team_tree" AS PERMISSIVE FOR UPDATE TO public USING (("team_tree"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("team_tree"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "team_tree_tenant_delete" ON "team_tree" AS PERMISSIVE FOR DELETE TO public USING (("team_tree"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "teams_tenant_select" ON "teams" AS PERMISSIVE FOR SELECT TO public USING (("teams"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "teams_tenant_insert" ON "teams" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("teams"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "teams_tenant_update" ON "teams" AS PERMISSIVE FOR UPDATE TO public USING (("teams"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("teams"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "teams_tenant_delete" ON "teams" AS PERMISSIVE FOR DELETE TO public USING (("teams"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_teams_tenant_select" ON "user_teams" AS PERMISSIVE FOR SELECT TO public USING (("user_teams"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "user_teams_tenant_insert" ON "user_teams" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("user_teams"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_teams_tenant_update" ON "user_teams" AS PERMISSIVE FOR UPDATE TO public USING (("user_teams"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("user_teams"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_teams_tenant_delete" ON "user_teams" AS PERMISSIVE FOR DELETE TO public USING (("user_teams"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
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
DROP INDEX "notes_tenant_team_id_idx";--> statement-breakpoint
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
CREATE INDEX "notes_tenant_unit_id_idx" ON "notes" USING btree ("tenant_id","unit_id");--> statement-breakpoint
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
CREATE POLICY "organizational_unit_closure_tenant_select" ON "organizational_unit_closure" AS PERMISSIVE FOR SELECT TO public USING (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_closure_tenant_insert" ON "organizational_unit_closure" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_closure_tenant_update" ON "organizational_unit_closure" AS PERMISSIVE FOR UPDATE TO public USING (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_closure_tenant_delete" ON "organizational_unit_closure" AS PERMISSIVE FOR DELETE TO public USING (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_select" ON "organizational_units" AS PERMISSIVE FOR SELECT TO public USING (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_insert" ON "organizational_units" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_update" ON "organizational_units" AS PERMISSIVE FOR UPDATE TO public USING (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_delete" ON "organizational_units" AS PERMISSIVE FOR DELETE TO public USING (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_select" ON "organizational_unit_memberships" AS PERMISSIVE FOR SELECT TO public USING (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_insert" ON "organizational_unit_memberships" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_update" ON "organizational_unit_memberships" AS PERMISSIVE FOR UPDATE TO public USING (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_delete" ON "organizational_unit_memberships" AS PERMISSIVE FOR DELETE TO public USING (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "api_client_roles_tenant_select" ON "api_client_roles" TO public USING (("api_client_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "api_clients_tenant_select" ON "api_clients" TO public USING (("api_clients"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "audit_log_tenant_select" ON "audit_log" TO public USING ((("audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null)));--> statement-breakpoint
ALTER POLICY "break_glass_grants_tenant_select" ON "break_glass_grants" TO public USING (("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "invitations_tenant_select" ON "invitations" TO public USING (("invitations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "role_permissions_tenant_select" ON "role_permissions" TO public USING (("role_permissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "roles_tenant_select" ON "roles" TO public USING (("roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "user_roles_tenant_select" ON "user_roles" TO public USING (("user_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "scim_groups_tenant_select" ON "scim_groups" TO public USING (("scim_groups"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "scim_users_tenant_select" ON "scim_users" TO public USING (("scim_users"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "sso_assertions_tenant_select" ON "sso_assertions" TO public USING (("sso_assertions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "sso_connections_tenant_select" ON "sso_connections" TO public USING (("sso_connections"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "sso_domains_tenant_select" ON "sso_domains" TO public USING (("sso_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "sso_exemptions_tenant_select" ON "sso_exemptions" TO public USING (("sso_exemptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "sso_policies_tenant_select" ON "sso_policies" TO public USING (("sso_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "sso_requests_tenant_select" ON "sso_requests" TO public USING (("sso_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "sso_role_grants_tenant_select" ON "sso_role_grants" TO public USING (("sso_role_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "sso_role_mappings_tenant_select" ON "sso_role_mappings" TO public USING (("sso_role_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "legal_holds_tenant_select" ON "legal_holds" TO public USING (("legal_holds"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "custom_field_definitions_tenant_select" ON "custom_field_definitions" TO public USING (("custom_field_definitions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "notifications_tenant_select" ON "notifications" TO public USING ((("notifications"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) or "notifications"."tenant_id" is null));--> statement-breakpoint
ALTER POLICY "messaging_usage_tenant_select" ON "messaging_usage" TO public USING (("messaging_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "setting_overrides_tenant_select" ON "setting_overrides" TO public USING (("setting_overrides"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "record_subscriptions_tenant_select" ON "record_subscriptions" TO public USING (("record_subscriptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "naming_series_tenant_select" ON "naming_series" TO public USING (("naming_series"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "sequences_tenant_select" ON "sequences" TO public USING (("sequences"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "attachment_uploads_tenant_select" ON "attachment_uploads" TO public USING (("attachment_uploads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "attachments_tenant_select" ON "attachments" TO public USING (("attachments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "documents_tenant_select" ON "documents" TO public USING (("documents"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "ai_runs_tenant_select" ON "ai_runs" TO public USING (("ai_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "comments_tenant_select" ON "comments" TO public USING (("comments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "record_tags_tenant_select" ON "record_tags" TO public USING (("record_tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "tags_tenant_select" ON "tags" TO public USING (("tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "report_schedules_tenant_select" ON "report_schedules" TO public USING (("report_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "retention_policies_tenant_select" ON "retention_policies" TO public USING (("retention_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "saved_views_tenant_select" ON "saved_views" TO public USING (("saved_views"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "api_usage_tenant_select" ON "api_usage" TO public USING (("api_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "revisions_tenant_select" ON "revisions" TO public USING (("revisions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "approval_assignments_tenant_select" ON "approval_assignments" TO public USING (("approval_assignments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "approval_delegations_tenant_select" ON "approval_delegations" TO public USING (("approval_delegations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "approval_events_tenant_select" ON "approval_events" TO public USING (("approval_events"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "approval_policies_tenant_select" ON "approval_policies" TO public USING (("approval_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "approval_requests_tenant_select" ON "approval_requests" TO public USING (("approval_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "incoming_webhook_senders_tenant_select" ON "incoming_webhook_senders" TO public USING (("incoming_webhook_senders"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "notes_tenant_select" ON "notes" TO public USING (("notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
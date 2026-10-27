ALTER TABLE "tenant_closure" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "tenant_closure" CASCADE;--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_parent_not_self";--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_parent_id_tenants_id_fk";
--> statement-breakpoint
DROP INDEX "tenants_parent_id_idx";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "parent_id";--> statement-breakpoint
ALTER POLICY "api_client_roles_tenant_select" ON "api_client_roles" TO public USING (("api_client_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "api_clients_tenant_select" ON "api_clients" TO public USING (("api_clients"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "audit_log_tenant_select" ON "audit_log" TO public USING ((("audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null)));--> statement-breakpoint
ALTER POLICY "break_glass_grants_tenant_select" ON "break_glass_grants" TO public USING (("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "invitations_tenant_select" ON "invitations" TO public USING (("invitations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "organizational_unit_closure_tenant_select" ON "organizational_unit_closure" TO public USING (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "organizational_unit_memberships_tenant_select" ON "organizational_unit_memberships" TO public USING (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
ALTER POLICY "organizational_units_tenant_select" ON "organizational_units" TO public USING (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
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
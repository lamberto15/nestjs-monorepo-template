CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"operator" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"selected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "api_client_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_unit_tree" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_org_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "setting_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "record_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "record_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval_delegations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_clients" DROP CONSTRAINT "api_clients_name_unique";--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_key_unique";--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_name_unique";--> statement-breakpoint
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_requests_idempotency_key_unique";--> statement-breakpoint
ALTER TABLE "api_client_roles" DROP CONSTRAINT "api_client_roles_client_id_api_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "api_client_roles" DROP CONSTRAINT "api_client_roles_role_id_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_client_id_api_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "org_unit_tree" DROP CONSTRAINT "org_unit_tree_ancestor_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE "org_unit_tree" DROP CONSTRAINT "org_unit_tree_descendant_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE "org_units" DROP CONSTRAINT "org_units_parent_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_role_id_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "user_org_units" DROP CONSTRAINT "user_org_units_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_org_units" DROP CONSTRAINT "user_org_units_org_unit_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_role_id_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_attachment_id_attachments_id_fk";
--> statement-breakpoint
ALTER TABLE "record_tags" DROP CONSTRAINT "record_tags_tag_id_tags_id_fk";
--> statement-breakpoint
ALTER TABLE "api_usage" DROP CONSTRAINT "api_usage_client_id_api_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_assignments" DROP CONSTRAINT "approval_assignments_request_id_approval_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_events" DROP CONSTRAINT "approval_events_request_id_approval_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "notes" DROP CONSTRAINT "notes_org_unit_id_org_units_id_fk";
--> statement-breakpoint
DROP INDEX "custom_field_definitions_subject_key_idx";--> statement-breakpoint
DROP INDEX "notifications_recipient_key_idx";--> statement-breakpoint
DROP INDEX "setting_overrides_key_scope_idx";--> statement-breakpoint
DROP INDEX "record_subscriptions_record_subscriber_idx";--> statement-breakpoint
DROP INDEX "sequences_name_scope_idx";--> statement-breakpoint
DROP INDEX "documents_pending_idx";--> statement-breakpoint
DROP INDEX "tags_subject_name_idx";--> statement-breakpoint
DROP INDEX "api_usage_client_day_route_idx";--> statement-breakpoint
DROP INDEX "revisions_record_number_uq";--> statement-breakpoint
DROP INDEX "approval_policies_version_idx";--> statement-breakpoint
DROP INDEX "approval_requests_open_idx";--> statement-breakpoint
DROP INDEX "notes_number_idx";--> statement-breakpoint
ALTER TABLE "api_client_roles" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "org_unit_tree" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "org_units" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "user_org_units" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "user_roles" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "setting_overrides" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "record_subscriptions" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sequences" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "record_tags" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_events" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "api_client_roles" ADD CONSTRAINT "api_client_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_unit_tree" ADD CONSTRAINT "org_unit_tree_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_org_units" ADD CONSTRAINT "user_org_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_org_units" ADD CONSTRAINT "user_org_units_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_overrides" ADD CONSTRAINT "setting_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_subscriptions" ADD CONSTRAINT "record_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_tags" ADD CONSTRAINT "record_tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_client_roles_role_id_idx" ON "api_client_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_tenant_name_idx" ON "api_clients" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_id_id_idx" ON "audit_log" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_key_idx" ON "roles" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_idx" ON "roles" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "user_roles_role_id_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_idempotency_key_idx" ON "approval_requests" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_definitions_subject_key_idx" ON "custom_field_definitions" USING btree ("tenant_id","subject","key");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_recipient_key_idx" ON "notifications" USING btree (coalesce("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),"recipient","key") WHERE key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "setting_overrides_key_scope_idx" ON "setting_overrides" USING btree ("tenant_id","key","scope","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_subscriptions_record_subscriber_idx" ON "record_subscriptions" USING btree ("tenant_id","subject","record_id","subscriber");--> statement-breakpoint
CREATE UNIQUE INDEX "sequences_name_scope_idx" ON "sequences" USING btree ("tenant_id","name","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_pending_idx" ON "documents" USING btree ("tenant_id","source","record_id","requested_by","locale") WHERE "documents"."status" in ('queued', 'rendering');--> statement-breakpoint
CREATE UNIQUE INDEX "tags_subject_name_idx" ON "tags" USING btree ("tenant_id","subject",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "api_usage_client_day_route_idx" ON "api_usage" USING btree ("tenant_id","client_id","day","route");--> statement-breakpoint
CREATE UNIQUE INDEX "revisions_record_number_uq" ON "revisions" USING btree ("tenant_id","subject","record_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_policies_version_idx" ON "approval_policies" USING btree ("tenant_id","key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_open_idx" ON "approval_requests" USING btree ("tenant_id","subject","record_id","action") WHERE status in ('pending', 'changes_requested');--> statement-breakpoint
CREATE UNIQUE INDEX "notes_number_idx" ON "notes" USING btree ("tenant_id","number");--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "setting_overrides" ADD CONSTRAINT "setting_overrides_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "record_subscriptions" ADD CONSTRAINT "record_subscriptions_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
CREATE POLICY "api_client_roles_tenant_select" ON "api_client_roles" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "api_client_roles"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "api_client_roles_tenant_insert" ON "api_client_roles" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "api_client_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_client_roles_tenant_update" ON "api_client_roles" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "api_client_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "api_client_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_client_roles_tenant_delete" ON "api_client_roles" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "api_client_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_clients_tenant_select" ON "api_clients" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "api_clients"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "api_clients_tenant_insert" ON "api_clients" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "api_clients"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_clients_tenant_update" ON "api_clients" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "api_clients"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "api_clients"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_clients_tenant_delete" ON "api_clients" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "api_clients"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "audit_log_tenant_select" ON "audit_log" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "audit_log"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null)));--> statement-breakpoint
CREATE POLICY "audit_log_tenant_insert" ON "audit_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null)));--> statement-breakpoint
CREATE POLICY "audit_log_tenant_update" ON "audit_log" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null)));--> statement-breakpoint
CREATE POLICY "audit_log_tenant_delete" ON "audit_log" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null)));--> statement-breakpoint
CREATE POLICY "org_unit_tree_tenant_select" ON "org_unit_tree" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "org_unit_tree"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "org_unit_tree_tenant_insert" ON "org_unit_tree" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "org_unit_tree"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "org_unit_tree_tenant_update" ON "org_unit_tree" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "org_unit_tree"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "org_unit_tree"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "org_unit_tree_tenant_delete" ON "org_unit_tree" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "org_unit_tree"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "org_units_tenant_select" ON "org_units" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "org_units"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "org_units_tenant_insert" ON "org_units" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "org_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "org_units_tenant_update" ON "org_units" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "org_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "org_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "org_units_tenant_delete" ON "org_units" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "org_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "role_permissions_tenant_select" ON "role_permissions" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "role_permissions"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "role_permissions_tenant_insert" ON "role_permissions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "role_permissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "role_permissions_tenant_update" ON "role_permissions" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "role_permissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "role_permissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "role_permissions_tenant_delete" ON "role_permissions" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "role_permissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "roles_tenant_select" ON "roles" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "roles"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "roles_tenant_insert" ON "roles" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "roles_tenant_update" ON "roles" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "roles_tenant_delete" ON "roles" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_org_units_tenant_select" ON "user_org_units" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "user_org_units"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "user_org_units_tenant_insert" ON "user_org_units" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "user_org_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_org_units_tenant_update" ON "user_org_units" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "user_org_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "user_org_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_org_units_tenant_delete" ON "user_org_units" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "user_org_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_roles_tenant_select" ON "user_roles" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "user_roles"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "user_roles_tenant_insert" ON "user_roles" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "user_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_roles_tenant_update" ON "user_roles" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "user_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "user_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_roles_tenant_delete" ON "user_roles" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "user_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "custom_field_definitions_tenant_select" ON "custom_field_definitions" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "custom_field_definitions"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "custom_field_definitions_tenant_insert" ON "custom_field_definitions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "custom_field_definitions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "custom_field_definitions_tenant_update" ON "custom_field_definitions" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "custom_field_definitions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "custom_field_definitions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "custom_field_definitions_tenant_delete" ON "custom_field_definitions" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "custom_field_definitions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "notifications_tenant_select" ON "notifications" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "notifications"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) or "notifications"."tenant_id" is null));--> statement-breakpoint
CREATE POLICY "notifications_tenant_insert" ON "notifications" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "notifications"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "notifications"."tenant_id" is null));--> statement-breakpoint
CREATE POLICY "notifications_tenant_update" ON "notifications" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "notifications"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "notifications"."tenant_id" is null)) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "notifications"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "notifications"."tenant_id" is null));--> statement-breakpoint
CREATE POLICY "notifications_tenant_delete" ON "notifications" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "notifications"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "notifications"."tenant_id" is null));--> statement-breakpoint
CREATE POLICY "setting_overrides_tenant_select" ON "setting_overrides" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "setting_overrides"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "setting_overrides_tenant_insert" ON "setting_overrides" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "setting_overrides"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "setting_overrides_tenant_update" ON "setting_overrides" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "setting_overrides"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "setting_overrides"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "setting_overrides_tenant_delete" ON "setting_overrides" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "setting_overrides"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_subscriptions_tenant_select" ON "record_subscriptions" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "record_subscriptions"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "record_subscriptions_tenant_insert" ON "record_subscriptions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "record_subscriptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_subscriptions_tenant_update" ON "record_subscriptions" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "record_subscriptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "record_subscriptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_subscriptions_tenant_delete" ON "record_subscriptions" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "record_subscriptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sequences_tenant_select" ON "sequences" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "sequences"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "sequences_tenant_insert" ON "sequences" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "sequences"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sequences_tenant_update" ON "sequences" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "sequences"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "sequences"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sequences_tenant_delete" ON "sequences" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "sequences"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachments_tenant_select" ON "attachments" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "attachments"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "attachments_tenant_insert" ON "attachments" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "attachments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachments_tenant_update" ON "attachments" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "attachments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "attachments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachments_tenant_delete" ON "attachments" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "attachments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "documents_tenant_select" ON "documents" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "documents"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "documents_tenant_insert" ON "documents" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "documents"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "documents_tenant_update" ON "documents" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "documents"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "documents"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "documents_tenant_delete" ON "documents" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "documents"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "comments_tenant_select" ON "comments" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "comments"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "comments_tenant_insert" ON "comments" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "comments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "comments_tenant_update" ON "comments" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "comments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "comments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "comments_tenant_delete" ON "comments" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "comments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_tags_tenant_select" ON "record_tags" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "record_tags"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "record_tags_tenant_insert" ON "record_tags" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "record_tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_tags_tenant_update" ON "record_tags" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "record_tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "record_tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_tags_tenant_delete" ON "record_tags" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "record_tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tags_tenant_select" ON "tags" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "tags"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "tags_tenant_insert" ON "tags" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tags_tenant_update" ON "tags" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tags_tenant_delete" ON "tags" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "report_schedules_tenant_select" ON "report_schedules" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "report_schedules"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "report_schedules_tenant_insert" ON "report_schedules" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "report_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "report_schedules_tenant_update" ON "report_schedules" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "report_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "report_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "report_schedules_tenant_delete" ON "report_schedules" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "report_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_usage_tenant_select" ON "api_usage" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "api_usage"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "api_usage_tenant_insert" ON "api_usage" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "api_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_usage_tenant_update" ON "api_usage" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "api_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "api_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_usage_tenant_delete" ON "api_usage" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "api_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "revisions_tenant_select" ON "revisions" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "revisions"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "revisions_tenant_insert" ON "revisions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "revisions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "revisions_tenant_update" ON "revisions" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "revisions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "revisions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "revisions_tenant_delete" ON "revisions" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "revisions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_assignments_tenant_select" ON "approval_assignments" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_assignments"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "approval_assignments_tenant_insert" ON "approval_assignments" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_assignments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_assignments_tenant_update" ON "approval_assignments" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_assignments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_assignments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_assignments_tenant_delete" ON "approval_assignments" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_assignments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_delegations_tenant_select" ON "approval_delegations" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_delegations"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "approval_delegations_tenant_insert" ON "approval_delegations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_delegations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_delegations_tenant_update" ON "approval_delegations" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_delegations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_delegations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_delegations_tenant_delete" ON "approval_delegations" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_delegations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_events_tenant_select" ON "approval_events" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_events"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "approval_events_tenant_insert" ON "approval_events" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_events"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_events_tenant_update" ON "approval_events" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_events"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_events"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_events_tenant_delete" ON "approval_events" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_events"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_policies_tenant_select" ON "approval_policies" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_policies"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "approval_policies_tenant_insert" ON "approval_policies" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_policies_tenant_update" ON "approval_policies" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_policies_tenant_delete" ON "approval_policies" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_requests_tenant_select" ON "approval_requests" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_requests"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "approval_requests_tenant_insert" ON "approval_requests" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_requests_tenant_update" ON "approval_requests" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_requests_tenant_delete" ON "approval_requests" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "approval_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "notes_tenant_select" ON "notes" AS PERMISSIVE FOR SELECT TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "notes"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "notes_tenant_insert" ON "notes" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "notes_tenant_update" ON "notes" AS PERMISSIVE FOR UPDATE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.bypass_rls', true)) = 'on' or "notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "notes_tenant_delete" ON "notes" AS PERMISSIVE FOR DELETE TO public USING (((select current_setting('app.bypass_rls', true)) = 'on' or "notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
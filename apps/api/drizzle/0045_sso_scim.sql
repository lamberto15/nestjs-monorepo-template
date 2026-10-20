CREATE TABLE "scim_groups" (
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_groups_tenant_id_team_id_pk" PRIMARY KEY("tenant_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "scim_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scim_users" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"external_id" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_users_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "scim_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_assertions" (
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"assertion_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sso_assertions_tenant_id_connection_id_assertion_id_pk" PRIMARY KEY("tenant_id","connection_id","assertion_id")
);
--> statement-breakpoint
ALTER TABLE "sso_assertions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"jit_provisioning" boolean DEFAULT false NOT NULL,
	"issuer" text,
	"client_id" text,
	"client_secret" text,
	"oidc_metadata" jsonb,
	"metadata_fetched_at" timestamp with time zone,
	"metadata_error" text,
	"idp_entity_id" text,
	"idp_sso_url" text,
	"idp_certificates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_idp_initiated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connections_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "sso_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_domains" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sso_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"binding_hash" text NOT NULL,
	"code_verifier" text,
	"nonce" text,
	"saml_request_id" text,
	"redirect_to" text,
	"user_id" uuid,
	"authenticated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sso_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_assertions" ADD CONSTRAINT "sso_assertions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_assertions" ADD CONSTRAINT "sso_assertions_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."sso_connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_requests" ADD CONSTRAINT "sso_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_requests" ADD CONSTRAINT "sso_requests_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."sso_connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scim_groups_tenant_external_id_idx" ON "scim_groups" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_users_tenant_external_id_idx" ON "scim_users" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "sso_assertions_expires_at_idx" ON "sso_assertions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_tenant_name_idx" ON "sso_connections" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domains_tenant_domain_idx" ON "sso_domains" USING btree ("tenant_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_requests_tenant_binding_idx" ON "sso_requests" USING btree ("tenant_id","binding_hash");--> statement-breakpoint
CREATE INDEX "sso_requests_connection_saml_idx" ON "sso_requests" USING btree ("connection_id","saml_request_id");--> statement-breakpoint
CREATE INDEX "sso_requests_expires_at_idx" ON "sso_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE POLICY "scim_groups_tenant_select" ON "scim_groups" AS PERMISSIVE FOR SELECT TO public USING (("scim_groups"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "scim_groups_tenant_insert" ON "scim_groups" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("scim_groups"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_groups_tenant_update" ON "scim_groups" AS PERMISSIVE FOR UPDATE TO public USING (("scim_groups"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("scim_groups"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_groups_tenant_delete" ON "scim_groups" AS PERMISSIVE FOR DELETE TO public USING (("scim_groups"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_users_tenant_select" ON "scim_users" AS PERMISSIVE FOR SELECT TO public USING (("scim_users"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "scim_users_tenant_insert" ON "scim_users" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("scim_users"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_users_tenant_update" ON "scim_users" AS PERMISSIVE FOR UPDATE TO public USING (("scim_users"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("scim_users"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_users_tenant_delete" ON "scim_users" AS PERMISSIVE FOR DELETE TO public USING (("scim_users"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_assertions_tenant_select" ON "sso_assertions" AS PERMISSIVE FOR SELECT TO public USING (("sso_assertions"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "sso_assertions_tenant_insert" ON "sso_assertions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_assertions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_assertions_tenant_update" ON "sso_assertions" AS PERMISSIVE FOR UPDATE TO public USING (("sso_assertions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_assertions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_assertions_tenant_delete" ON "sso_assertions" AS PERMISSIVE FOR DELETE TO public USING (("sso_assertions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_connections_tenant_select" ON "sso_connections" AS PERMISSIVE FOR SELECT TO public USING (("sso_connections"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "sso_connections_tenant_insert" ON "sso_connections" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_connections"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_connections_tenant_update" ON "sso_connections" AS PERMISSIVE FOR UPDATE TO public USING (("sso_connections"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_connections"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_connections_tenant_delete" ON "sso_connections" AS PERMISSIVE FOR DELETE TO public USING (("sso_connections"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_domains_tenant_select" ON "sso_domains" AS PERMISSIVE FOR SELECT TO public USING (("sso_domains"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "sso_domains_tenant_insert" ON "sso_domains" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_domains_tenant_update" ON "sso_domains" AS PERMISSIVE FOR UPDATE TO public USING (("sso_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_domains_tenant_delete" ON "sso_domains" AS PERMISSIVE FOR DELETE TO public USING (("sso_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_requests_tenant_select" ON "sso_requests" AS PERMISSIVE FOR SELECT TO public USING (("sso_requests"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "sso_requests_tenant_insert" ON "sso_requests" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_requests_tenant_update" ON "sso_requests" AS PERMISSIVE FOR UPDATE TO public USING (("sso_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_requests_tenant_delete" ON "sso_requests" AS PERMISSIVE FOR DELETE TO public USING (("sso_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
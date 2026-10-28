CREATE TABLE "tenant_domain_routes" (
	"hostname" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_domains" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_domain_routes" ADD CONSTRAINT "tenant_domain_routes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_domain_routes_tenant_id_idx" ON "tenant_domain_routes" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_domains_tenant_hostname_idx" ON "tenant_domains" USING btree ("tenant_id","hostname");--> statement-breakpoint
CREATE POLICY "tenant_domains_tenant_select" ON "tenant_domains" AS PERMISSIVE FOR SELECT TO public USING (("tenant_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_domains_tenant_insert" ON "tenant_domains" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("tenant_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_domains_tenant_update" ON "tenant_domains" AS PERMISSIVE FOR UPDATE TO public USING (("tenant_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("tenant_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_domains_tenant_delete" ON "tenant_domains" AS PERMISSIVE FOR DELETE TO public USING (("tenant_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
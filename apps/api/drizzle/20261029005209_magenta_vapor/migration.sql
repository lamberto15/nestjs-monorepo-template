CREATE TABLE "webhook_client_scopes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_client_scopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_client_scopes" ADD CONSTRAINT "webhook_client_scopes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_client_scopes" ADD CONSTRAINT "webhook_client_scopes_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."api_clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_client_scopes_client_idx" ON "webhook_client_scopes" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE POLICY "webhook_client_scopes_tenant_select" ON "webhook_client_scopes" AS PERMISSIVE FOR SELECT TO public USING (("webhook_client_scopes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "webhook_client_scopes_tenant_insert" ON "webhook_client_scopes" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("webhook_client_scopes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "webhook_client_scopes_tenant_update" ON "webhook_client_scopes" AS PERMISSIVE FOR UPDATE TO public USING (("webhook_client_scopes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("webhook_client_scopes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "webhook_client_scopes_tenant_delete" ON "webhook_client_scopes" AS PERMISSIVE FOR DELETE TO public USING (("webhook_client_scopes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
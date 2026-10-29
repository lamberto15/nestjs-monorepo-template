CREATE TABLE "form_public_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"max_submissions" integer NOT NULL,
	"submissions" integer DEFAULT 0 NOT NULL,
	"last_submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_public_links_tenant_token_key" UNIQUE("tenant_id","token_hash")
);
--> statement-breakpoint
ALTER TABLE "form_public_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_public_links" ADD CONSTRAINT "form_public_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_public_links" ADD CONSTRAINT "form_public_links_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "public"."forms"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_public_links_form_idx" ON "form_public_links" USING btree ("form_id");--> statement-breakpoint
CREATE POLICY "form_public_links_tenant_select" ON "form_public_links" AS PERMISSIVE FOR SELECT TO public USING (("form_public_links"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_public_links_tenant_insert" ON "form_public_links" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("form_public_links"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_public_links_tenant_update" ON "form_public_links" AS PERMISSIVE FOR UPDATE TO public USING (("form_public_links"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("form_public_links"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_public_links_tenant_delete" ON "form_public_links" AS PERMISSIVE FOR DELETE TO public USING (("form_public_links"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
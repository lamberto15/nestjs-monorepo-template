CREATE TABLE "form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"submitted_by" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"answers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "form_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_versions_form_version_key" UNIQUE("form_id","version"),
	CONSTRAINT "form_versions_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "form_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"draft" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"published_version" integer,
	"published_revision" integer,
	"key_types" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forms_slug_key" UNIQUE("tenant_id","slug"),
	CONSTRAINT "forms_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "forms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "public"."forms"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."form_versions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "public"."forms"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_submissions_form_idx" ON "form_submissions" USING btree ("form_id","id");--> statement-breakpoint
CREATE INDEX "form_submissions_submitted_by_idx" ON "form_submissions" USING btree ("submitted_by","form_id");--> statement-breakpoint
CREATE INDEX "form_submissions_version_idx" ON "form_submissions" USING btree ("version_id");--> statement-breakpoint
CREATE POLICY "form_submissions_tenant_select" ON "form_submissions" AS PERMISSIVE FOR SELECT TO public USING (("form_submissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_submissions_tenant_insert" ON "form_submissions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("form_submissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_submissions_tenant_update" ON "form_submissions" AS PERMISSIVE FOR UPDATE TO public USING (("form_submissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("form_submissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_submissions_tenant_delete" ON "form_submissions" AS PERMISSIVE FOR DELETE TO public USING (("form_submissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_versions_tenant_select" ON "form_versions" AS PERMISSIVE FOR SELECT TO public USING (("form_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_versions_tenant_insert" ON "form_versions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("form_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_versions_tenant_update" ON "form_versions" AS PERMISSIVE FOR UPDATE TO public USING (("form_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("form_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_versions_tenant_delete" ON "form_versions" AS PERMISSIVE FOR DELETE TO public USING (("form_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "forms_tenant_select" ON "forms" AS PERMISSIVE FOR SELECT TO public USING (("forms"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "forms_tenant_insert" ON "forms" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("forms"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "forms_tenant_update" ON "forms" AS PERMISSIVE FOR UPDATE TO public USING (("forms"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("forms"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "forms_tenant_delete" ON "forms" AS PERMISSIVE FOR DELETE TO public USING (("forms"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
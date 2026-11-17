CREATE TABLE "attachment_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"note" text,
	"uploaded_at" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_versions_attachment_version_key" UNIQUE("attachment_id","version")
);
--> statement-breakpoint
ALTER TABLE "attachment_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachment_uploads" ADD COLUMN "resumable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment_uploads" ADD COLUMN "received" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "revision_note" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "versioned_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment_versions" ADD CONSTRAINT "attachment_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_versions" ADD CONSTRAINT "attachment_versions_attachment_fk" FOREIGN KEY ("tenant_id","attachment_id") REFERENCES "public"."attachments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_versions_uploaded_by_idx" ON "attachment_versions" USING btree ("uploaded_by");--> statement-breakpoint
CREATE POLICY "attachment_versions_tenant_select" ON "attachment_versions" AS PERMISSIVE FOR SELECT TO public USING (("attachment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_versions_tenant_insert" ON "attachment_versions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("attachment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_versions_tenant_update" ON "attachment_versions" AS PERMISSIVE FOR UPDATE TO public USING (("attachment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("attachment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_versions_tenant_delete" ON "attachment_versions" AS PERMISSIVE FOR DELETE TO public USING (("attachment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
CREATE TABLE "attachment_uploads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completing_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachment_uploads" ADD CONSTRAINT "attachment_uploads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_uploads_expires_idx" ON "attachment_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "attachment_uploads_uploaded_by_idx" ON "attachment_uploads" USING btree ("uploaded_by");--> statement-breakpoint
CREATE POLICY "attachment_uploads_tenant_select" ON "attachment_uploads" AS PERMISSIVE FOR SELECT TO public USING ((("attachment_uploads"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("attachment_uploads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "attachment_uploads"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "attachment_uploads_tenant_insert" ON "attachment_uploads" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("attachment_uploads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_uploads_tenant_update" ON "attachment_uploads" AS PERMISSIVE FOR UPDATE TO public USING (("attachment_uploads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("attachment_uploads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_uploads_tenant_delete" ON "attachment_uploads" AS PERMISSIVE FOR DELETE TO public USING (("attachment_uploads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
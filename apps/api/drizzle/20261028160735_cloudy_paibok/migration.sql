CREATE TABLE "document_acknowledgments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"recipient" text NOT NULL,
	"requested_by" text NOT NULL,
	"due_at" timestamp with time zone,
	"reminders" integer DEFAULT 0 NOT NULL,
	"last_reminded_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_acknowledgments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_acknowledgments" ADD CONSTRAINT "document_acknowledgments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgments" ADD CONSTRAINT "document_acknowledgments_attachment_fk" FOREIGN KEY ("tenant_id","attachment_id") REFERENCES "public"."attachments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_acknowledgments_version_recipient_idx" ON "document_acknowledgments" USING btree ("attachment_id","version","recipient");--> statement-breakpoint
CREATE INDEX "document_acknowledgments_recipient_idx" ON "document_acknowledgments" USING btree ("recipient","acknowledged_at");--> statement-breakpoint
CREATE POLICY "document_acknowledgments_tenant_select" ON "document_acknowledgments" AS PERMISSIVE FOR SELECT TO public USING (("document_acknowledgments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "document_acknowledgments_tenant_insert" ON "document_acknowledgments" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("document_acknowledgments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "document_acknowledgments_tenant_update" ON "document_acknowledgments" AS PERMISSIVE FOR UPDATE TO public USING (("document_acknowledgments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("document_acknowledgments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "document_acknowledgments_tenant_delete" ON "document_acknowledgments" AS PERMISSIVE FOR DELETE TO public USING (("document_acknowledgments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
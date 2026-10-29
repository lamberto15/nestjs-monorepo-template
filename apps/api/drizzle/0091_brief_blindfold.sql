CREATE TABLE "attachment_texts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("attachment_texts"."text", ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment_texts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachment_texts" ADD CONSTRAINT "attachment_texts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_texts" ADD CONSTRAINT "attachment_texts_attachment_fk" FOREIGN KEY ("tenant_id","attachment_id") REFERENCES "public"."attachments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_texts_attachment_idx" ON "attachment_texts" USING btree ("attachment_id");--> statement-breakpoint
CREATE INDEX "attachment_texts_search_idx" ON "attachment_texts" USING gin ("search");--> statement-breakpoint
CREATE POLICY "attachment_texts_tenant_select" ON "attachment_texts" AS PERMISSIVE FOR SELECT TO public USING (("attachment_texts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_texts_tenant_insert" ON "attachment_texts" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("attachment_texts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_texts_tenant_update" ON "attachment_texts" AS PERMISSIVE FOR UPDATE TO public USING (("attachment_texts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("attachment_texts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_texts_tenant_delete" ON "attachment_texts" AS PERMISSIVE FOR DELETE TO public USING (("attachment_texts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
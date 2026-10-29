CREATE TABLE "test_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"unit_id" uuid,
	"title" text NOT NULL,
	"body" text,
	"published_at" timestamp with time zone,
	"code" text,
	"number" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(coalesce("title"::text, '') || ' ' || coalesce("body"::text, ''), ''))) STORED,
	CONSTRAINT "test_items_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_encrypted_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tax_number" text,
	"tax_number_index" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_encrypted_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "test_items" ADD CONSTRAINT "test_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_items" ADD CONSTRAINT "test_items_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."organizational_units"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_encrypted_records" ADD CONSTRAINT "test_encrypted_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_items_owner_id_idx" ON "test_items" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "test_items_deleted_at_idx" ON "test_items" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "test_items_search_idx" ON "test_items" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "test_items_code_idx" ON "test_items" USING btree ("tenant_id","code") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "test_items_number_idx" ON "test_items" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "test_items_custom_idx" ON "test_items" USING gin ("custom");--> statement-breakpoint
CREATE POLICY "test_items_tenant_select" ON "test_items" AS PERMISSIVE FOR SELECT TO public USING (("test_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_items_tenant_insert" ON "test_items" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_items_tenant_update" ON "test_items" AS PERMISSIVE FOR UPDATE TO public USING (("test_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_items_tenant_delete" ON "test_items" AS PERMISSIVE FOR DELETE TO public USING (("test_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_encrypted_records_tenant_select" ON "test_encrypted_records" AS PERMISSIVE FOR SELECT TO public USING (("test_encrypted_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_encrypted_records_tenant_insert" ON "test_encrypted_records" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_encrypted_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_encrypted_records_tenant_update" ON "test_encrypted_records" AS PERMISSIVE FOR UPDATE TO public USING (("test_encrypted_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_encrypted_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_encrypted_records_tenant_delete" ON "test_encrypted_records" AS PERMISSIVE FOR DELETE TO public USING (("test_encrypted_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
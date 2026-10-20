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
ALTER TABLE "test_encrypted_records" ADD CONSTRAINT "test_encrypted_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "test_encrypted_records_tenant_select" ON "test_encrypted_records" AS PERMISSIVE FOR SELECT TO public USING ((("test_encrypted_records"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]) and ("test_encrypted_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid) or "test_encrypted_records"."tenant_id" = any(array(select "tenant_closure"."descendant_id" from "tenant_closure" where "tenant_closure"."ancestor_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)))))));--> statement-breakpoint
CREATE POLICY "test_encrypted_records_tenant_insert" ON "test_encrypted_records" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_encrypted_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_encrypted_records_tenant_update" ON "test_encrypted_records" AS PERMISSIVE FOR UPDATE TO public USING (("test_encrypted_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_encrypted_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_encrypted_records_tenant_delete" ON "test_encrypted_records" AS PERMISSIVE FOR DELETE TO public USING (("test_encrypted_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
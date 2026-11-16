CREATE TABLE "import_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"importer" text NOT NULL,
	"name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_mappings_name_idx" ON "import_mappings" USING btree ("tenant_id","importer",lower("name"));--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_select" ON "import_mappings" AS PERMISSIVE FOR SELECT TO public USING (("import_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_insert" ON "import_mappings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("import_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_update" ON "import_mappings" AS PERMISSIVE FOR UPDATE TO public USING (("import_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("import_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_delete" ON "import_mappings" AS PERMISSIVE FOR DELETE TO public USING (("import_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
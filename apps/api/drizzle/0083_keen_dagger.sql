CREATE TABLE "record_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"name" text NOT NULL,
	"visibility" text NOT NULL,
	"owner" text NOT NULL,
	"unit_id" uuid,
	"scope" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_templates_unit_check" CHECK (("record_templates"."visibility" = 'unit') = ("record_templates"."unit_id" is not null)),
	CONSTRAINT "record_templates_visibility_check" CHECK ("record_templates"."visibility" in ('private', 'unit', 'tenant'))
);
--> statement-breakpoint
ALTER TABLE "record_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "record_templates" ADD CONSTRAINT "record_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_templates" ADD CONSTRAINT "record_templates_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."organizational_units"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "record_templates_name_idx" ON "record_templates" USING btree ("tenant_id","subject","scope",lower("name"));--> statement-breakpoint
CREATE INDEX "record_templates_owner_idx" ON "record_templates" USING btree ("owner","subject");--> statement-breakpoint
CREATE INDEX "record_templates_unit_idx" ON "record_templates" USING btree ("unit_id");--> statement-breakpoint
CREATE POLICY "record_templates_tenant_select" ON "record_templates" AS PERMISSIVE FOR SELECT TO public USING (("record_templates"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_templates_tenant_insert" ON "record_templates" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("record_templates"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_templates_tenant_update" ON "record_templates" AS PERMISSIVE FOR UPDATE TO public USING (("record_templates"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("record_templates"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_templates_tenant_delete" ON "record_templates" AS PERMISSIVE FOR DELETE TO public USING (("record_templates"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
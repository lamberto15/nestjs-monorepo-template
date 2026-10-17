CREATE TABLE "test_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"team_id" uuid,
	"title" text NOT NULL,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(coalesce("title"::text, '') || ' ' || coalesce("body"::text, ''), ''))) STORED,
	CONSTRAINT "test_items_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "test_items" ADD CONSTRAINT "test_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_items" ADD CONSTRAINT "test_items_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE set null ("team_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_items_owner_id_idx" ON "test_items" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "test_items_deleted_at_idx" ON "test_items" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "test_items_search_idx" ON "test_items" USING gin ("search");--> statement-breakpoint
CREATE POLICY "test_items_tenant_select" ON "test_items" AS PERMISSIVE FOR SELECT TO public USING (("test_items"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "test_items_tenant_insert" ON "test_items" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_items_tenant_update" ON "test_items" AS PERMISSIVE FOR UPDATE TO public USING (("test_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_items_tenant_delete" ON "test_items" AS PERMISSIVE FOR DELETE TO public USING (("test_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
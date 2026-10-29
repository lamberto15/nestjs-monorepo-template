CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"name" text NOT NULL,
	"visibility" text NOT NULL,
	"owner" text NOT NULL,
	"team_id" uuid,
	"scope" text NOT NULL,
	"query" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"columns" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_team_check" CHECK (("saved_views"."visibility" = 'team') = ("saved_views"."team_id" is not null)),
	CONSTRAINT "saved_views_visibility_check" CHECK ("saved_views"."visibility" in ('private', 'team', 'tenant'))
);
--> statement-breakpoint
ALTER TABLE "saved_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_name_idx" ON "saved_views" USING btree ("tenant_id","subject","scope",lower("name"));--> statement-breakpoint
CREATE INDEX "saved_views_owner_idx" ON "saved_views" USING btree ("owner","subject");--> statement-breakpoint
CREATE INDEX "saved_views_team_idx" ON "saved_views" USING btree ("team_id");--> statement-breakpoint
CREATE POLICY "saved_views_tenant_select" ON "saved_views" AS PERMISSIVE FOR SELECT TO public USING (("saved_views"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "saved_views_tenant_insert" ON "saved_views" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("saved_views"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "saved_views_tenant_update" ON "saved_views" AS PERMISSIVE FOR UPDATE TO public USING (("saved_views"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("saved_views"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "saved_views_tenant_delete" ON "saved_views" AS PERMISSIVE FOR DELETE TO public USING (("saved_views"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
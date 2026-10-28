CREATE TABLE "favorites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"target" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "favorites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_owner_target_idx" ON "favorites" USING btree ("tenant_id","owner","kind","subject","target");--> statement-breakpoint
CREATE INDEX "favorites_owner_position_idx" ON "favorites" USING btree ("owner","position");--> statement-breakpoint
CREATE POLICY "favorites_tenant_select" ON "favorites" AS PERMISSIVE FOR SELECT TO public USING (("favorites"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "favorites_tenant_insert" ON "favorites" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("favorites"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "favorites_tenant_update" ON "favorites" AS PERMISSIVE FOR UPDATE TO public USING (("favorites"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("favorites"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "favorites_tenant_delete" ON "favorites" AS PERMISSIVE FOR DELETE TO public USING (("favorites"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
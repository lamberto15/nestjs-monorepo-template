CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"token_index" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messaging_usage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"counter" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messaging_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"phone_index" text NOT NULL,
	"verified_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_usage" ADD CONSTRAINT "messaging_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "devices_token_index_idx" ON "devices" USING btree ("token_index");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_usage_counter_idx" ON "messaging_usage" USING btree ("tenant_id","day","counter");--> statement-breakpoint
CREATE INDEX "messaging_usage_day_idx" ON "messaging_usage" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_user_id_idx" ON "phone_numbers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "phone_numbers_phone_index_idx" ON "phone_numbers" USING btree ("phone_index");--> statement-breakpoint
CREATE POLICY "messaging_usage_tenant_select" ON "messaging_usage" AS PERMISSIVE FOR SELECT TO public USING (("messaging_usage"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "messaging_usage_tenant_insert" ON "messaging_usage" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("messaging_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "messaging_usage_tenant_update" ON "messaging_usage" AS PERMISSIVE FOR UPDATE TO public USING (("messaging_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("messaging_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "messaging_usage_tenant_delete" ON "messaging_usage" AS PERMISSIVE FOR DELETE TO public USING (("messaging_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
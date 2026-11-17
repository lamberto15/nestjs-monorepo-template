CREATE TABLE "incoming_webhook_senders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"secret" text NOT NULL,
	"previous_secret" text,
	"previous_secret_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incoming_webhook_senders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incoming_webhook_senders" ADD CONSTRAINT "incoming_webhook_senders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_webhook_senders_name_idx" ON "incoming_webhook_senders" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE POLICY "incoming_webhook_senders_tenant_select" ON "incoming_webhook_senders" AS PERMISSIVE FOR SELECT TO public USING (("incoming_webhook_senders"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "incoming_webhook_senders_tenant_insert" ON "incoming_webhook_senders" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("incoming_webhook_senders"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "incoming_webhook_senders_tenant_update" ON "incoming_webhook_senders" AS PERMISSIVE FOR UPDATE TO public USING (("incoming_webhook_senders"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("incoming_webhook_senders"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "incoming_webhook_senders_tenant_delete" ON "incoming_webhook_senders" AS PERMISSIVE FOR DELETE TO public USING (("incoming_webhook_senders"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
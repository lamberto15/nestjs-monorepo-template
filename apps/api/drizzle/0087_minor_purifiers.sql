CREATE TABLE "record_shares" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"fields" jsonb NOT NULL,
	"files" boolean DEFAULT false NOT NULL,
	"token_hash" text NOT NULL,
	"recipient_email" text,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"views" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "record_shares" ADD CONSTRAINT "record_shares_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "record_shares_tenant_token_idx" ON "record_shares" USING btree ("tenant_id","token_hash");--> statement-breakpoint
CREATE INDEX "record_shares_record_idx" ON "record_shares" USING btree ("tenant_id","subject","record_id");--> statement-breakpoint
CREATE POLICY "record_shares_tenant_select" ON "record_shares" AS PERMISSIVE FOR SELECT TO public USING (("record_shares"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_shares_tenant_insert" ON "record_shares" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("record_shares"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_shares_tenant_update" ON "record_shares" AS PERMISSIVE FOR UPDATE TO public USING (("record_shares"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("record_shares"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_shares_tenant_delete" ON "record_shares" AS PERMISSIVE FOR DELETE TO public USING (("record_shares"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
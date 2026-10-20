CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"task" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_runs_tenant_day_idx" ON "ai_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_runs_requested_by_idx" ON "ai_runs" USING btree ("requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_pending_idx" ON "ai_runs" USING btree ("tenant_id","source","record_id","task","requested_by") WHERE "ai_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE POLICY "ai_runs_tenant_select" ON "ai_runs" AS PERMISSIVE FOR SELECT TO public USING (("ai_runs"."tenant_id" = any((select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[])));--> statement-breakpoint
CREATE POLICY "ai_runs_tenant_insert" ON "ai_runs" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("ai_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "ai_runs_tenant_update" ON "ai_runs" AS PERMISSIVE FOR UPDATE TO public USING (("ai_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("ai_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "ai_runs_tenant_delete" ON "ai_runs" AS PERMISSIVE FOR DELETE TO public USING (("ai_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));
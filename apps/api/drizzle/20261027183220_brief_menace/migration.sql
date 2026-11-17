DROP INDEX "audit_log_tenant_at_ms_id_idx";--> statement-breakpoint
DROP INDEX "notes_tenant_created_at_idx";--> statement-breakpoint
DROP INDEX "notes_tenant_updated_at_idx";--> statement-breakpoint
DROP INDEX "notes_tenant_created_ms_idx";--> statement-breakpoint
DROP INDEX "notes_tenant_updated_ms_idx";--> statement-breakpoint
CREATE INDEX "audit_log_tenant_at_ms_id_idx" ON "audit_log" USING btree ("tenant_id",(date_trunc('milliseconds', "at" at time zone 'UTC') at time zone 'UTC') desc nulls first,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "notes_tenant_created_at_idx" ON "notes" USING btree ("tenant_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "notes_tenant_updated_at_idx" ON "notes" USING btree ("tenant_id","updated_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "notes_tenant_created_ms_idx" ON "notes" USING btree ("tenant_id",(date_trunc('milliseconds', "created_at" at time zone 'UTC') at time zone 'UTC') desc nulls first,"id" DESC NULLS FIRST) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "notes_tenant_updated_ms_idx" ON "notes" USING btree ("tenant_id",(date_trunc('milliseconds', "updated_at" at time zone 'UTC') at time zone 'UTC') desc nulls first,"id" DESC NULLS FIRST) WHERE deleted_at is null;
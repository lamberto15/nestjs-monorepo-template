DROP INDEX "notes_owner_id_idx";--> statement-breakpoint
DROP INDEX "notes_deleted_at_idx";--> statement-breakpoint
CREATE INDEX "notes_owner_id_id_idx" ON "notes" USING btree ("owner_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notes_tenant_team_id_idx" ON "notes" USING btree ("tenant_id","team_id");--> statement-breakpoint
CREATE INDEX "notes_tenant_status_id_idx" ON "notes" USING btree ("tenant_id","status","id" DESC NULLS LAST) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "notes_tenant_title_id_idx" ON "notes" USING btree ("tenant_id","title","id" DESC NULLS LAST) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "notes_tenant_published_ms_idx" ON "notes" USING btree ("tenant_id",(date_trunc('milliseconds', "published_at" at time zone 'UTC') at time zone 'UTC') desc nulls first,"id" DESC NULLS LAST) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "notes_deleted_at_idx" ON "notes" USING btree ("deleted_at") WHERE deleted_at is not null;
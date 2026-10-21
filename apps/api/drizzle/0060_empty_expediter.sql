ALTER TABLE "attachments" ADD COLUMN "rendition_status" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "renditions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "attachments_rendition_pending_idx" ON "attachments" USING btree ("updated_at") WHERE "attachments"."rendition_status" = 'pending';
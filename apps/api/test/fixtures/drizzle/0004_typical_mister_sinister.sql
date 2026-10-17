ALTER TABLE "test_items" ADD COLUMN "code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "test_items_code_idx" ON "test_items" USING btree ("tenant_id","code") WHERE deleted_at is null;
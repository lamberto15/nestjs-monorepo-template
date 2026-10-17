ALTER TABLE "test_items" ADD COLUMN "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "test_items_custom_idx" ON "test_items" USING gin ("custom");
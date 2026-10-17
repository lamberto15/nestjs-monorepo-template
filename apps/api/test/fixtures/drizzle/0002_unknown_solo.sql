ALTER TABLE "test_items" ADD COLUMN "number" text;--> statement-breakpoint
CREATE UNIQUE INDEX "test_items_number_idx" ON "test_items" USING btree ("tenant_id","number");
ALTER TABLE "test_items" DROP CONSTRAINT "test_items_parent_id_fk";
--> statement-breakpoint
ALTER TABLE "test_items" DROP CONSTRAINT "test_items_linked_id_fk";
--> statement-breakpoint
ALTER TABLE "test_items" ADD CONSTRAINT "test_items_parent_id_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."test_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_items" ADD CONSTRAINT "test_items_linked_id_fk" FOREIGN KEY ("tenant_id","linked_id") REFERENCES "public"."test_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;
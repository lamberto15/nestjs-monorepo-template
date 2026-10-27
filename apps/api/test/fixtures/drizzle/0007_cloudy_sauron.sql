ALTER TABLE "test_items" RENAME COLUMN "team_id" TO "unit_id";--> statement-breakpoint
ALTER TABLE "test_items" DROP CONSTRAINT "test_items_team_fk";
--> statement-breakpoint
ALTER TABLE "test_items" ADD CONSTRAINT "test_items_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."organizational_units"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
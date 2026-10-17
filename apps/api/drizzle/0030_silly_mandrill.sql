ALTER TABLE "teams" DROP CONSTRAINT "org_units_tenant_id_id_key";--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenant_id_id_key" UNIQUE("tenant_id","id");
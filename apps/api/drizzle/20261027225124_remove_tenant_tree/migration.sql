ALTER TABLE "tenant_closure" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "tenant_closure" CASCADE;--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_parent_not_self";--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_parent_id_tenants_id_fk";
--> statement-breakpoint
DROP INDEX "tenants_parent_id_idx";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "parent_id";
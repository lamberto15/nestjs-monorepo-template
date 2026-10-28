-- PostgreSQL 18 names each NOT NULL constraint after its table and column,
-- and keeps the name when either is renamed: the team-era tables and columns
-- (#595, #602) left names such as scim_groups_team_id_not_null behind.
-- Renamed to what a table made under its current name gets; drizzle-kit
-- doesn't track constraint names of NOT NULL, hence a custom migration.

ALTER TABLE "organizational_unit_closure" RENAME CONSTRAINT "org_unit_tree_ancestor_id_not_null" TO "organizational_unit_closure_ancestor_id_not_null";
--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" RENAME CONSTRAINT "org_unit_tree_descendant_id_not_null" TO "organizational_unit_closure_descendant_id_not_null";
--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" RENAME CONSTRAINT "org_unit_tree_depth_not_null" TO "organizational_unit_closure_depth_not_null";
--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" RENAME CONSTRAINT "org_unit_tree_tenant_id_not_null" TO "organizational_unit_closure_tenant_id_not_null";
--> statement-breakpoint
ALTER TABLE "organizational_units" RENAME CONSTRAINT "org_units_id_not_null" TO "organizational_units_id_not_null";
--> statement-breakpoint
ALTER TABLE "organizational_units" RENAME CONSTRAINT "org_units_name_not_null" TO "organizational_units_name_not_null";
--> statement-breakpoint
ALTER TABLE "organizational_units" RENAME CONSTRAINT "org_units_created_at_not_null" TO "organizational_units_created_at_not_null";
--> statement-breakpoint
ALTER TABLE "organizational_units" RENAME CONSTRAINT "org_units_updated_at_not_null" TO "organizational_units_updated_at_not_null";
--> statement-breakpoint
ALTER TABLE "organizational_units" RENAME CONSTRAINT "org_units_tenant_id_not_null" TO "organizational_units_tenant_id_not_null";
--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" RENAME CONSTRAINT "user_org_units_user_id_not_null" TO "organizational_unit_memberships_user_id_not_null";
--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" RENAME CONSTRAINT "user_org_units_org_unit_id_not_null" TO "organizational_unit_memberships_unit_id_not_null";
--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" RENAME CONSTRAINT "user_org_units_tenant_id_not_null" TO "organizational_unit_memberships_tenant_id_not_null";
--> statement-breakpoint
ALTER TABLE "invitations" RENAME CONSTRAINT "invitations_org_unit_ids_not_null" TO "invitations_unit_ids_not_null";
--> statement-breakpoint
ALTER TABLE "scim_groups" RENAME CONSTRAINT "scim_groups_team_id_not_null" TO "scim_groups_unit_id_not_null";

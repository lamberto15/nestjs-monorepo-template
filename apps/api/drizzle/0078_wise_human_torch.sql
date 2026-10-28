ALTER TABLE "saved_views" DROP CONSTRAINT "saved_views_unit_check";--> statement-breakpoint
ALTER TABLE "saved_views" DROP CONSTRAINT "saved_views_visibility_check";--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_unit_check" CHECK (("saved_views"."visibility" = 'unit') = ("saved_views"."unit_id" is not null));--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_visibility_check" CHECK ("saved_views"."visibility" in ('private', 'unit', 'tenant'));
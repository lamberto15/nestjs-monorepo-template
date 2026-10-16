-- expect: nothing
-- DROP TABLE "users"; DELETE FROM "users"; TRUNCATE "users";
/* ALTER TABLE "users" DROP COLUMN "email"; */
INSERT INTO "settings" ("key", "value") VALUES ('note', 'DROP TABLE users; TRUNCATE x') ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";--> statement-breakpoint
UPDATE "notes" SET "status" = 'published' WHERE "status" = 'live';--> statement-breakpoint
DELETE FROM "sessions" WHERE "expires_at" < now();--> statement-breakpoint
ALTER TABLE "user_org_units" ADD CONSTRAINT "user_org_units_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

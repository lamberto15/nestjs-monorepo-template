-- expect: ban-drop-column@3 ban-drop-column@4
ALTER TABLE "users" ADD COLUMN "nickname" text;--> statement-breakpoint
ALTER TABLE "api_clients" DROP COLUMN "key_id";--> statement-breakpoint
ALTER TABLE "api_clients" DROP COLUMN "key_hash";

-- expect: delete-without-where@2 delete-without-where@3
DELETE FROM "sessions";--> statement-breakpoint
WITH gone AS (DELETE FROM "tokens" RETURNING "id") SELECT count(*) FROM gone;--> statement-breakpoint
DELETE FROM "tokens" WHERE "expires_at" < now();

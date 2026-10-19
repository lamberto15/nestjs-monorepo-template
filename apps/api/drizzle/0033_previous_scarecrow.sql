DROP INDEX "consents_user_kind_version_idx";--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "withdrawal_ip" text;--> statement-breakpoint
CREATE INDEX "consents_user_kind_accepted_at_idx" ON "consents" USING btree ("user_id","kind","accepted_at");
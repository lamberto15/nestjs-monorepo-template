DROP INDEX "notifications_recipient_unread_idx";--> statement-breakpoint
CREATE INDEX "notifications_recipient_unread_id_idx" ON "notifications" USING btree ("recipient","id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_undelivered_idx" ON "notifications" USING btree ("created_at") WHERE "notifications"."delivered_at" is null;
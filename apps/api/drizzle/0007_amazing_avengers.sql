CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"recipient" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"recipient" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"key" text,
	"count" integer DEFAULT 1 NOT NULL,
	"link" text,
	"read_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"digest" text,
	"digest_due_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_recipient_idx" ON "notification_preferences" USING btree ("recipient");--> statement-breakpoint
CREATE INDEX "notifications_recipient_id_idx" ON "notifications" USING btree ("recipient","id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_type_idx" ON "notifications" USING btree ("recipient","type");--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_at_idx" ON "notifications" USING btree ("recipient","created_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_unread_idx" ON "notifications" USING btree ("recipient") WHERE read_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_recipient_key_idx" ON "notifications" USING btree ("recipient","key") WHERE key is not null;--> statement-breakpoint
CREATE INDEX "notifications_digest_due_at_idx" ON "notifications" USING btree ("digest_due_at") WHERE digest_due_at is not null;--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_read_at_idx" ON "notifications" USING btree ("read_at") WHERE read_at is not null;
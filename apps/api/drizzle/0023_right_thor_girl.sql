CREATE TABLE "mail_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"address" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"address" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"last_detail" text,
	"events" integer DEFAULT 0 NOT NULL,
	"soft_bounces" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suppressed_at" timestamp with time zone,
	"skipped" integer DEFAULT 0 NOT NULL,
	"last_skipped_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_events_provider_event_address_idx" ON "mail_events" USING btree ("provider","event_id","address");--> statement-breakpoint
CREATE INDEX "mail_events_address_idx" ON "mail_events" USING btree ("address");--> statement-breakpoint
CREATE INDEX "mail_events_created_at_idx" ON "mail_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_suppressions_address_idx" ON "mail_suppressions" USING btree ("address");--> statement-breakpoint
CREATE INDEX "mail_suppressions_reason_idx" ON "mail_suppressions" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "mail_suppressions_suppressed_at_idx" ON "mail_suppressions" USING btree ("suppressed_at");--> statement-breakpoint
CREATE INDEX "mail_suppressions_last_seen_at_idx" ON "mail_suppressions" USING btree ("last_seen_at");
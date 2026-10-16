CREATE TABLE "record_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject" text NOT NULL,
	"record_id" text NOT NULL,
	"subscriber" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "record_subscriptions_record_subscriber_idx" ON "record_subscriptions" USING btree ("subject","record_id","subscriber");--> statement-breakpoint
CREATE INDEX "record_subscriptions_subscriber_idx" ON "record_subscriptions" USING btree ("subscriber","created_at");
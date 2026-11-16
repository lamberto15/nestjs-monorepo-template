CREATE TABLE "webhook_delivery_requests" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"attempt" integer NOT NULL,
	"headers" jsonb NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);

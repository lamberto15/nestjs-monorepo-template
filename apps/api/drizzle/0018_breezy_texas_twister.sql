CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"exporter" text NOT NULL,
	"format" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timezone" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"recipients" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_transfer_id" text,
	"last_status" text,
	"next_run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "report_schedules_owner_idx" ON "report_schedules" USING btree ("owner","id");--> statement-breakpoint
CREATE INDEX "report_schedules_next_run_at_idx" ON "report_schedules" USING btree ("next_run_at") WHERE active;
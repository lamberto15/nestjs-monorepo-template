CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changes" jsonb,
	"restored_from" integer,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "revisions_record_number_uq" ON "revisions" USING btree ("subject","record_id","number");--> statement-breakpoint
CREATE INDEX "revisions_record_newest_idx" ON "revisions" USING btree ("subject","record_id","number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "revisions_changed_by_idx" ON "revisions" USING btree ("changed_by");--> statement-breakpoint
CREATE INDEX "revisions_changed_at_idx" ON "revisions" USING btree ("changed_at");
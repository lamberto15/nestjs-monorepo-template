CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source" text NOT NULL,
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"timezone" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"attachment_id" uuid,
	"fields" text[] DEFAULT '{}' NOT NULL,
	"run_token" uuid,
	"error" text,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "fields" text[];--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_record_idx" ON "documents" USING btree ("subject","record_id");--> statement-breakpoint
CREATE INDEX "documents_requested_by_idx" ON "documents" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "documents_attachment_idx" ON "documents" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_pending_idx" ON "documents" USING btree ("source","record_id","requested_by","locale") WHERE "documents"."status" in ('queued', 'rendering');
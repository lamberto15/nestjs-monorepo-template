-- expect: nothing
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"org_unit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_title_unique" UNIQUE("title")
);--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_created_idx" ON "notes" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_status_title_idx" ON "notes" USING btree ("status","title");

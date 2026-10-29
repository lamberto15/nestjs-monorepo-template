CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "number" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sequences_name_scope_idx" ON "sequences" USING btree ("name","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_number_idx" ON "notes" USING btree ("number");
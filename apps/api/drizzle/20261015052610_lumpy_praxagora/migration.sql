CREATE TABLE "custom_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"options" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"default_value" jsonb,
	"validation" jsonb,
	"position" integer DEFAULT 0 NOT NULL,
	"filterable" boolean DEFAULT false NOT NULL,
	"sortable" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_definitions_subject_key_idx" ON "custom_field_definitions" USING btree ("subject","key");--> statement-breakpoint
CREATE INDEX "custom_field_definitions_subject_position_idx" ON "custom_field_definitions" USING btree ("subject","position");--> statement-breakpoint
CREATE INDEX "notes_custom_idx" ON "notes" USING gin ("custom");
ALTER TABLE "naming_series" ADD COLUMN "date_field" text;--> statement-breakpoint
ALTER TABLE "naming_series" ADD COLUMN "conditions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "naming_series" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;
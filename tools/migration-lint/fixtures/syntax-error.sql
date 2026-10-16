-- expect: syntax-error@3
ALTER TABLE "notes" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN;

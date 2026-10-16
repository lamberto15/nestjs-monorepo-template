-- expect: suppression-comment@2 ban-drop-table@4 suppression-comment@5
-- SQUAWK-IGNORE-FILE
ALTER TABLE "notes" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
DROP TABLE "tokens";--> statement-breakpoint
/* squawk-ignore-file */ SELECT 1;

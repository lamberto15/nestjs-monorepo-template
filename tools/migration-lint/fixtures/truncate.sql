-- expect: truncate-table@2 truncate-table@3
TRUNCATE "sessions";--> statement-breakpoint
TRUNCATE TABLE "notes", "note_tags" CASCADE;

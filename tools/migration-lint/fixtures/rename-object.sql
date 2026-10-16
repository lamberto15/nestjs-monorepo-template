-- expect: renaming-object@2 renaming-object@3
ALTER TYPE "public"."note_status" RENAME VALUE 'draft' TO 'pending';--> statement-breakpoint
ALTER INDEX "notes_title_idx" RENAME TO "notes_heading_idx";

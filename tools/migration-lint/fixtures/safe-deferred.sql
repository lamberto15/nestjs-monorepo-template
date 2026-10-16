-- expect: nothing
CREATE RULE "notes_archive" AS ON DELETE TO "notes" DO INSTEAD DELETE FROM "note_drafts";--> statement-breakpoint
CREATE FUNCTION "purge_sessions"() RETURNS void LANGUAGE sql BEGIN ATOMIC DELETE FROM "sessions"; END;--> statement-breakpoint
CREATE PROCEDURE "reset_locale"() LANGUAGE sql BEGIN ATOMIC UPDATE "users" SET "locale" = 'en'; END;

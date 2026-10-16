-- expect: suppression-comment@2 ban-drop-column@3
-- squawk-ignore ban-drop-column
ALTER TABLE "notes" DROP COLUMN "body";

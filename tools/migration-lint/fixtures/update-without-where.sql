-- expect: update-without-where@2 update-without-where@3
UPDATE "users" SET "locale" = 'en';--> statement-breakpoint
UPDATE "notes"
SET "title" = 'not a where clause';

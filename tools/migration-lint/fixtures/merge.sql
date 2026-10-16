-- expect: merge-delete@3 merge-update@6
MERGE INTO "sessions" USING "expired" ON "sessions"."id" = "expired"."id"
WHEN MATCHED THEN DELETE;--> statement-breakpoint
MERGE INTO "notes" USING "imports" ON "notes"."id" = "imports"."id"
WHEN NOT MATCHED THEN INSERT ("id", "title") VALUES ("imports"."id", "imports"."title")
WHEN MATCHED AND "imports"."replace" THEN UPDATE SET "title" = "imports"."title";

-- expect: nothing
MERGE INTO "notes" USING "imports" ON "notes"."id" = "imports"."id"
WHEN NOT MATCHED THEN INSERT ("id", "title") VALUES ("imports"."id", "imports"."title");

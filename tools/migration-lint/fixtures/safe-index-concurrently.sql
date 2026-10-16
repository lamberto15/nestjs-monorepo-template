-- expect: nothing
CREATE INDEX CONCURRENTLY "notes_title_idx" ON "notes" USING btree ("title");

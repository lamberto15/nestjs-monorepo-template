CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"mentions" text[] DEFAULT '{}' NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "comments_record_idx" ON "comments" USING btree ("subject","record_id","id");--> statement-breakpoint
CREATE INDEX "comments_author_idx" ON "comments" USING btree ("author");--> statement-breakpoint
CREATE INDEX "comments_mentions_idx" ON "comments" USING gin ("mentions");
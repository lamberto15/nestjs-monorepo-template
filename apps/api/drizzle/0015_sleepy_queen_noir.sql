CREATE TABLE "record_tags" (
	"tag_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_tags_tag_id_record_id_pk" PRIMARY KEY("tag_id","record_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_tags" ADD CONSTRAINT "record_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_tags_record_idx" ON "record_tags" USING btree ("subject","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_subject_name_idx" ON "tags" USING btree ("subject",lower("name"));
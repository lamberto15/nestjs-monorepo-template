CREATE TABLE "setting_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"value" jsonb,
	"rollout" integer,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "setting_overrides_key_scope_idx" ON "setting_overrides" USING btree ("key","scope","scope_id");
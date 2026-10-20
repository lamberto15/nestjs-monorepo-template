CREATE TABLE "platform_setting_values" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"enforced" boolean DEFAULT false NOT NULL,
	"rollout" integer,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_setting_values_key_unique" UNIQUE("key")
);

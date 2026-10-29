CREATE SCHEMA "analytics";
--> statement-breakpoint
CREATE TABLE "analytics"."platform_metrics" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"dimension" text DEFAULT '' NOT NULL,
	"value" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_metrics_day_metric_dimension_idx" ON "analytics"."platform_metrics" USING btree ("day","metric","dimension");
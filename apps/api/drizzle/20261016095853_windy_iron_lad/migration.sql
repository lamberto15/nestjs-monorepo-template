CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source" text NOT NULL,
	"day" date NOT NULL,
	"base" char(3) NOT NULL,
	"currency" char(3) NOT NULL,
	"rate" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_source_day_currency_idx" ON "exchange_rates" USING btree ("source","day","currency");
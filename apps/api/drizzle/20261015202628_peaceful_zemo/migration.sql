CREATE TABLE "api_usage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"day" date NOT NULL,
	"route" text NOT NULL,
	"count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "daily_quota" integer;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_usage_client_day_route_idx" ON "api_usage" USING btree ("client_id","day","route");--> statement-breakpoint
CREATE INDEX "api_usage_day_idx" ON "api_usage" USING btree ("day");
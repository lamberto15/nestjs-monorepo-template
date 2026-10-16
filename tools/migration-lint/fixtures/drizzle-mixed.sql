-- expect: ban-drop-constraint@8 ban-drop-column@10 adding-not-nullable-field@11 ban-drop-column@11
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "api_clients" DROP CONSTRAINT "api_clients_key_id_unique";--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_clients" DROP COLUMN "key_id";--> statement-breakpoint
ALTER TABLE "api_clients" DROP COLUMN "key_hash", ALTER COLUMN "name" SET NOT NULL;

CREATE TABLE "api_client_roles" (
	"client_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "api_client_roles_client_id_role_id_pk" PRIMARY KEY("client_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
ALTER TABLE "api_clients" DROP CONSTRAINT "api_clients_key_id_unique";--> statement-breakpoint
ALTER TABLE "user_roles" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_client_roles" ADD CONSTRAINT "api_client_roles_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_client_roles" ADD CONSTRAINT "api_client_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_client_id_idx" ON "api_keys" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "api_clients" DROP COLUMN "key_id";--> statement-breakpoint
ALTER TABLE "api_clients" DROP COLUMN "key_hash";
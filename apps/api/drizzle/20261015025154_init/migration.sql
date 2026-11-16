CREATE SEQUENCE "public"."locks_fencing_token_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "app_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locks" (
	"key" text PRIMARY KEY NOT NULL,
	"owner" text,
	"fencing_token" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_clients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"key_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_clients_name_unique" UNIQUE("name"),
	CONSTRAINT "api_clients_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"details" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "email_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"fingerprint" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redirect_to" text
);
--> statement-breakpoint
CREATE TABLE "mfa_authenticators" (
	"user_id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"confirmed" boolean NOT NULL,
	"pending_secret" text,
	"last_used_step" integer
);
--> statement-breakpoint
CREATE TABLE "mfa_failures" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mfa_failures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"failed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	CONSTRAINT "mfa_recovery_codes_user_id_code_hash_pk" PRIMARY KEY("user_id","code_hash")
);
--> statement-breakpoint
CREATE TABLE "oidc_logins" (
	"state" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"nonce" text,
	"redirect_to" text,
	"link_user_id" text,
	"link_session_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"family_expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"claims" jsonb
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"role_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"action" text NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key"),
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_active_at" timestamp with time zone NOT NULL,
	"mfa" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_provider_subject_pk" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"locale" text,
	"timezone" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"owner" text,
	"response" json,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "email_tokens_user_id_purpose_idx" ON "email_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "email_tokens_expires_at_idx" ON "email_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "magic_links_expires_at_idx" ON "magic_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mfa_failures_user_id_failed_at_idx" ON "mfa_failures" USING btree ("user_id","failed_at");--> statement-breakpoint
CREATE INDEX "mfa_failures_failed_at_idx" ON "mfa_failures" USING btree ("failed_at");--> statement-breakpoint
CREATE INDEX "oidc_logins_expires_at_idx" ON "oidc_logins" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_expires_at_idx" ON "refresh_tokens" USING btree ("family_expires_at");--> statement-breakpoint
CREATE INDEX "role_permissions_role_id_idx" ON "role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_identities_user_id_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "notes_owner_id_idx" ON "notes" USING btree ("owner_id");
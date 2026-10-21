ALTER TABLE "sso_connections" ADD COLUMN "authorization_endpoint" text;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "token_endpoint" text;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "userinfo_endpoint" text;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "token_endpoint_auth_method" text;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "mapping" jsonb;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "preset" jsonb;
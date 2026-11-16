CREATE TABLE "approval_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"request_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"stage" integer NOT NULL,
	"approver_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"comment" text,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_by_name" text,
	"on_behalf_of" uuid,
	"escalated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_delegations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"subject" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"request_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" text,
	"actor_name" text,
	"round" integer NOT NULL,
	"stage" integer,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb,
	"changed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject" text NOT NULL,
	"record_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requester" text NOT NULL,
	"requester_name" text NOT NULL,
	"title" text NOT NULL,
	"link" text,
	"payload" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"policy_version" integer NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"current_stage" integer DEFAULT 0 NOT NULL,
	"stage_started_at" timestamp with time zone,
	"stage_outcome" text,
	"due_at" timestamp with time zone,
	"comment" text,
	"outcome_reason" text,
	"ended_at" timestamp with time zone,
	"outcome_applied_at" timestamp with time zone,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_assignments_unique_idx" ON "approval_assignments" USING btree ("request_id","round","stage","approver_id");--> statement-breakpoint
CREATE INDEX "approval_assignments_approver_idx" ON "approval_assignments" USING btree ("approver_id","status");--> statement-breakpoint
CREATE INDEX "approval_assignments_decided_by_idx" ON "approval_assignments" USING btree ("decided_by");--> statement-breakpoint
CREATE INDEX "approval_delegations_from_idx" ON "approval_delegations" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "approval_delegations_to_idx" ON "approval_delegations" USING btree ("to_user_id","ends_at");--> statement-breakpoint
CREATE INDEX "approval_events_request_idx" ON "approval_events" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_policies_version_idx" ON "approval_policies" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "approval_requests_record_idx" ON "approval_requests" USING btree ("subject","record_id");--> statement-breakpoint
CREATE INDEX "approval_requests_requester_idx" ON "approval_requests" USING btree ("requester");--> statement-breakpoint
CREATE INDEX "approval_requests_status_idx" ON "approval_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "approval_requests_created_at_idx" ON "approval_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "approval_requests_updated_at_idx" ON "approval_requests" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_open_idx" ON "approval_requests" USING btree ("subject","record_id","action") WHERE status in ('pending', 'changes_requested');
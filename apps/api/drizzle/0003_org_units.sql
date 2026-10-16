CREATE TABLE "org_unit_tree" (
	"ancestor_id" uuid NOT NULL,
	"descendant_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	CONSTRAINT "org_unit_tree_ancestor_id_descendant_id_pk" PRIMARY KEY("ancestor_id","descendant_id")
);
--> statement-breakpoint
CREATE TABLE "org_units" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_org_units" (
	"user_id" uuid NOT NULL,
	"org_unit_id" uuid NOT NULL,
	CONSTRAINT "user_org_units_user_id_org_unit_id_pk" PRIMARY KEY("user_id","org_unit_id")
);
--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "org_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "org_unit_tree" ADD CONSTRAINT "org_unit_tree_ancestor_id_org_units_id_fk" FOREIGN KEY ("ancestor_id") REFERENCES "public"."org_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_unit_tree" ADD CONSTRAINT "org_unit_tree_descendant_id_org_units_id_fk" FOREIGN KEY ("descendant_id") REFERENCES "public"."org_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_id_org_units_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."org_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_org_units" ADD CONSTRAINT "user_org_units_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_org_units" ADD CONSTRAINT "user_org_units_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_unit_tree_descendant_idx" ON "org_unit_tree" USING btree ("descendant_id");--> statement-breakpoint
CREATE INDEX "org_units_parent_id_idx" ON "org_units" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "user_org_units_org_unit_id_idx" ON "user_org_units" USING btree ("org_unit_id");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE set null ON UPDATE no action;
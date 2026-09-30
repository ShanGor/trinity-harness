CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "scope" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "scope_id" uuid;--> statement-breakpoint
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "teams_tenant_idx" ON "teams" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sessions_scope_idx" ON "sessions" USING btree ("scope","scope_id");
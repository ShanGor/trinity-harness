CREATE TABLE "approvals" (
	"id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args_preview" text NOT NULL,
	"outcome" text,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approvals_id_pk" PRIMARY KEY("id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "policy" text;--> statement-breakpoint
CREATE INDEX "approvals_session_idx" ON "approvals" USING btree ("session_id","created_at");
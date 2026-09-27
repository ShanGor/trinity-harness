CREATE TABLE "session_events" (
	"session_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"prev_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_events_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
-- Append-only enforcement (AGENTS.md §4.3): UPDATE/DELETE on session_events are forbidden.
CREATE OR REPLACE FUNCTION "forbid_session_events_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'session_events is append-only: % are forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "session_events_append_only"
BEFORE UPDATE OR DELETE ON "session_events"
FOR EACH ROW EXECUTE FUNCTION "forbid_session_events_mutation"();

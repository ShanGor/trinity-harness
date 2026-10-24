CREATE TABLE "environment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"type" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "environment_events_owner" ON "environment_events" USING btree ("environment_id","created_at");
--> statement-breakpoint
CREATE FUNCTION reject_environment_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'environment_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER environment_events_append_only BEFORE UPDATE OR DELETE ON environment_events
FOR EACH ROW EXECUTE FUNCTION reject_environment_event_mutation();

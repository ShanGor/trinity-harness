CREATE TABLE "browser_commands" (
	"session_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"generation" uuid NOT NULL,
	"result" jsonb,
	CONSTRAINT "browser_commands_session_id_call_id_pk" PRIMARY KEY("session_id","call_id")
);
--> statement-breakpoint
CREATE TABLE "browser_runtimes" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"generation" uuid NOT NULL,
	"owner" uuid NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION trinity_notify_session_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.closed_at IS NOT NULL AND OLD.closed_at IS NULL THEN
    PERFORM pg_notify('trinity_session_closed', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trinity_session_closed_notify AFTER UPDATE OF closed_at ON sessions
FOR EACH ROW EXECUTE FUNCTION trinity_notify_session_closed();

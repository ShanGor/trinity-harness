CREATE OR REPLACE FUNCTION notify_assistant_prompt_dispatch() RETURNS trigger AS $$
BEGIN
  IF NEW.type IN ('prompt/queued', 'turn/end', 'prompt/discarded') THEN
    PERFORM pg_notify('assistant_prompt_dispatch', NEW.session_id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER assistant_prompt_dispatch AFTER INSERT ON session_events
FOR EACH ROW EXECUTE FUNCTION notify_assistant_prompt_dispatch();

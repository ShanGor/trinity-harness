-- M3: sanctioned append-only exception (docs/design.md §12 留痕 rule).
-- A user prompt that the permission policy REJECTED before the turn started
-- is removed again, so the log never shows a prompt that never ran. Only a
-- `message/user` row at the TAIL of its session may be deleted; everything
-- else stays forbidden (defense in depth on top of code-level discipline).
CREATE OR REPLACE FUNCTION "forbid_session_events_mutation"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.type = 'message/user'
     AND OLD.seq = (SELECT max(seq) FROM session_events WHERE session_id = OLD.session_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'session_events is append-only: % are forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
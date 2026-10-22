ALTER TABLE "sessions" DROP CONSTRAINT "sessions_kind_workspace_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kind_workspace_check" CHECK (((kind is null and session_role is null and workspace_uri is not null) or (kind = 'chat' and session_role in ('main', 'side') and scope = 'personal' and scope_id is null) or (kind = 'work' and session_role = 'task' and workspace_uri is not null)) is true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_session_identity() RETURNS trigger AS $$
BEGIN
  IF OLD.kind IS DISTINCT FROM NEW.kind OR OLD.session_role IS DISTINCT FROM NEW.session_role
    OR OLD.scope IS DISTINCT FROM NEW.scope OR OLD.scope_id IS DISTINCT FROM NEW.scope_id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.creation_operation_id IS DISTINCT FROM NEW.creation_operation_id
    OR OLD.origin_session_id IS DISTINCT FROM NEW.origin_session_id THEN
    RAISE EXCEPTION 'Session identity and workspace are immutable';
  END IF;
  IF OLD.workspace_uri IS DISTINCT FROM NEW.workspace_uri AND NOT (
    OLD.kind = 'chat' AND OLD.workspace_uri IS NULL AND NEW.workspace_uri IS NOT NULL
    AND OLD.closed_at IS NULL AND EXISTS (
      SELECT 1 FROM session_events e WHERE e.session_id = OLD.id
        AND e.type = 'session/workspace_bound' AND e.payload->>'workspaceUri' = NEW.workspace_uri
    )
  ) THEN
    RAISE EXCEPTION 'Session identity and workspace are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

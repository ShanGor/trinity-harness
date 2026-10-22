ALTER TABLE "sessions" DROP CONSTRAINT "sessions_kind_workspace_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kind_workspace_check" CHECK (((kind is null and session_role is null and workspace_uri is not null) or (kind = 'chat' and session_role in ('main', 'side') and workspace_uri is null and scope = 'personal' and scope_id is null) or (kind = 'work' and session_role = 'task' and workspace_uri is not null)) is true);--> statement-breakpoint
CREATE OR REPLACE FUNCTION forbid_assistant_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Personal assistant history is append-only: % are forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER memory_events_append_only ON memory_events;
--> statement-breakpoint
CREATE TRIGGER memory_events_append_only BEFORE UPDATE OR DELETE ON memory_events
FOR EACH ROW EXECUTE FUNCTION forbid_assistant_history_mutation();
--> statement-breakpoint
DROP TRIGGER episode_changes_append_only ON episode_changes;
--> statement-breakpoint
CREATE TRIGGER episode_changes_append_only BEFORE UPDATE OR DELETE ON episode_changes
FOR EACH ROW EXECUTE FUNCTION forbid_assistant_history_mutation();

CREATE TABLE "conversation_episodes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversation_episodes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episode_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "episode_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"episode_id" text NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_events" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"operation_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_events_tenant_id_user_id_revision_pk" PRIMARY KEY("tenant_id","user_id","revision")
);
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "workspace_uri" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "session_role" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "creation_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "origin_session_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "episode_prompt_key" ON "conversation_episodes" USING btree ("session_id","prompt_id");--> statement-breakpoint
CREATE INDEX "episode_owner_page" ON "conversation_episodes" USING btree ("tenant_id","user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_operation_key" ON "memory_events" USING btree ("tenant_id","user_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_operation_key" ON "sessions" USING btree ("tenant_id","user_id","creation_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_main_key" ON "sessions" USING btree ("tenant_id","user_id") WHERE session_role = 'main';
--> statement-breakpoint
CREATE TRIGGER memory_events_append_only BEFORE UPDATE OR DELETE ON memory_events
FOR EACH ROW EXECUTE FUNCTION forbid_session_events_mutation();
--> statement-breakpoint
CREATE TRIGGER episode_changes_append_only BEFORE UPDATE OR DELETE ON episode_changes
FOR EACH ROW EXECUTE FUNCTION forbid_session_events_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_session_identity() RETURNS trigger AS $$
BEGIN
  IF OLD.kind IS DISTINCT FROM NEW.kind OR OLD.session_role IS DISTINCT FROM NEW.session_role
    OR OLD.workspace_uri IS DISTINCT FROM NEW.workspace_uri OR OLD.scope IS DISTINCT FROM NEW.scope
    OR OLD.scope_id IS DISTINCT FROM NEW.scope_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.creation_operation_id IS DISTINCT FROM NEW.creation_operation_id
    OR OLD.origin_session_id IS DISTINCT FROM NEW.origin_session_id THEN
    RAISE EXCEPTION 'Session identity and workspace are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER sessions_identity_immutable BEFORE UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION preserve_session_identity();

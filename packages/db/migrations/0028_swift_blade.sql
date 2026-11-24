CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "episode_embeddings" (
	"episode_id" uuid NOT NULL,
	"embedding_model" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content_sha256" text NOT NULL,
	"policy_revision" bigint NOT NULL,
	"embedding" vector,
	"dimensions" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "episode_embeddings_episode_id_embedding_model_pk" PRIMARY KEY("episode_id","embedding_model")
);
--> statement-breakpoint
CREATE TABLE "memory_candidate_events" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"operation_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "memory_candidate_events_tenant_id_user_id_revision_pk" PRIMARY KEY("tenant_id","user_id","revision")
);
--> statement-breakpoint
CREATE TABLE "memory_candidates" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "memory_candidates_tenant_id_user_id_id_pk" PRIMARY KEY("tenant_id","user_id","id")
);
--> statement-breakpoint
CREATE TABLE "memory_evolution_owners" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	CONSTRAINT "memory_evolution_owners_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "memory_fact_events" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"operation_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "memory_fact_events_tenant_id_user_id_revision_pk" PRIMARY KEY("tenant_id","user_id","revision")
);
--> statement-breakpoint
CREATE TABLE "memory_facts" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "memory_facts_tenant_id_user_id_id_pk" PRIMARY KEY("tenant_id","user_id","id")
);
--> statement-breakpoint
CREATE TABLE "memory_playbook_events" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"operation_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "memory_playbook_events_tenant_id_user_id_revision_pk" PRIMARY KEY("tenant_id","user_id","revision")
);
--> statement-breakpoint
CREATE TABLE "memory_playbooks" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "memory_playbooks_tenant_id_user_id_id_pk" PRIMARY KEY("tenant_id","user_id","id")
);
--> statement-breakpoint
CREATE INDEX "episode_embeddings_owner_model" ON "episode_embeddings" USING btree ("tenant_id","user_id","embedding_model");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_candidate_events_operation" ON "memory_candidate_events" USING btree ("tenant_id","user_id","operation_id");--> statement-breakpoint
CREATE INDEX "memory_candidates_owner_revision" ON "memory_candidates" USING btree ("tenant_id","user_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_fact_events_operation" ON "memory_fact_events" USING btree ("tenant_id","user_id","operation_id");--> statement-breakpoint
CREATE INDEX "memory_facts_owner_revision" ON "memory_facts" USING btree ("tenant_id","user_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_playbook_events_operation" ON "memory_playbook_events" USING btree ("tenant_id","user_id","operation_id");--> statement-breakpoint
CREATE INDEX "memory_playbooks_owner_revision" ON "memory_playbooks" USING btree ("tenant_id","user_id","revision");
--> statement-breakpoint
CREATE FUNCTION reject_memory_evolution_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Memory evolution events are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER memory_fact_events_append_only BEFORE UPDATE OR DELETE ON memory_fact_events FOR EACH ROW EXECUTE FUNCTION reject_memory_evolution_event_mutation();
--> statement-breakpoint
CREATE TRIGGER memory_candidate_events_append_only BEFORE UPDATE OR DELETE ON memory_candidate_events FOR EACH ROW EXECUTE FUNCTION reject_memory_evolution_event_mutation();
--> statement-breakpoint
CREATE TRIGGER memory_playbook_events_append_only BEFORE UPDATE OR DELETE ON memory_playbook_events FOR EACH ROW EXECUTE FUNCTION reject_memory_evolution_event_mutation();
--> statement-breakpoint
CREATE INDEX episode_embeddings_hnsw_1536 ON episode_embeddings USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE dimensions = 1536;

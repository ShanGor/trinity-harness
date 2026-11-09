CREATE TABLE "persona_events" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"operation_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "persona_events_tenant_id_user_id_revision_pk" PRIMARY KEY("tenant_id","user_id","revision")
);
--> statement-breakpoint
CREATE TABLE "user_personas" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"revision" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_personas_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "persona_operation_key" ON "persona_events" USING btree ("tenant_id","user_id","operation_id");
--> statement-breakpoint
-- Keep all legacy records. Oversized profiles remain on the legacy read path until edited.
WITH latest AS (
  SELECT DISTINCT ON (tenant_id, user_id, memory_id) tenant_id, user_id, payload
  FROM memory_events ORDER BY tenant_id, user_id, memory_id, revision DESC
), profiles AS (
  SELECT tenant_id, user_id,
    string_agg('- ' || (payload->>'subject') || ' · ' || (payload->>'predicate') || ': ' || (payload->>'value'), E'\n' ORDER BY payload->>'predicate', payload->>'memoryId') AS content
  FROM latest WHERE payload->>'status' = 'active' GROUP BY tenant_id, user_id
)
INSERT INTO user_personas (tenant_id, user_id, content, revision, updated_at)
SELECT tenant_id, user_id, content, 1, now() FROM profiles WHERE length(content) <= 16000;
--> statement-breakpoint
INSERT INTO persona_events (tenant_id, user_id, content, revision, operation_id, created_at)
SELECT tenant_id, user_id, content, revision, gen_random_uuid(), updated_at FROM user_personas;

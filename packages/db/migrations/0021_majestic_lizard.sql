ALTER TABLE "user_personas" ADD COLUMN "suppression_revision" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Preserve existing suppression fences; future append-only additions keep this floor stable.
UPDATE user_personas p SET suppression_revision = p.revision + coalesce((
  SELECT max(m.revision) FROM memory_events m WHERE m.tenant_id = p.tenant_id AND m.user_id = p.user_id
), 0);

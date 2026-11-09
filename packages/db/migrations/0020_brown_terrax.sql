ALTER TABLE "persona_events" ADD COLUMN "auto_save_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "persona_events" ADD COLUMN "source" jsonb;--> statement-breakpoint
ALTER TABLE "user_personas" ADD COLUMN "auto_save_enabled" boolean DEFAULT true NOT NULL;
ALTER TABLE "assistant_schedules" ADD COLUMN "review_catchup_initialized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD COLUMN "attempts" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD COLUMN "retry_at" timestamp with time zone;
CREATE TABLE "assistant_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"definition" jsonb NOT NULL,
	"enabled" boolean NOT NULL,
	"next_fire_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_occurrences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schedule_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"session_id" uuid,
	"prompt_id" uuid,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_schedule_operation" ON "assistant_schedules" USING btree ("tenant_id","user_id","operation_id");--> statement-breakpoint
CREATE INDEX "assistant_schedule_due" ON "assistant_schedules" USING btree ("enabled","next_fire_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_occurrence_unique" ON "schedule_occurrences" USING btree ("schedule_id","revision","scheduled_at");--> statement-breakpoint
CREATE INDEX "schedule_inbox_owner" ON "schedule_occurrences" USING btree ("tenant_id","user_id","scheduled_at");
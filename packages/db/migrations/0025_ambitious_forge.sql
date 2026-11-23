CREATE TABLE "personal_calendar_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_calendar_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"definition" jsonb NOT NULL,
	"status" text NOT NULL,
	"source" jsonb,
	"schedule_id" uuid,
	"next_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_calendar_preferences" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"preferences" jsonb NOT NULL,
	"subscription" jsonb,
	CONSTRAINT "personal_calendar_preferences_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "personal_calendar_reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"offset_minutes" bigint NOT NULL,
	"status" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"push_status" text NOT NULL,
	"push_attempts" bigint DEFAULT 0 NOT NULL,
	"push_after" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "personal_calendar_operation" ON "personal_calendar_changes" USING btree ("tenant_id","user_id","operation_id");--> statement-breakpoint
CREATE INDEX "personal_calendar_owner" ON "personal_calendar_items" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "personal_calendar_next" ON "personal_calendar_items" USING btree ("status","next_at");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_calendar_schedule" ON "personal_calendar_items" USING btree ("schedule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_calendar_reminder_occurrence" ON "personal_calendar_reminders" USING btree ("item_id","revision","event_at","offset_minutes");--> statement-breakpoint
CREATE INDEX "personal_calendar_reminder_due" ON "personal_calendar_reminders" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "personal_calendar_reminder_owner" ON "personal_calendar_reminders" USING btree ("tenant_id","user_id","event_at");
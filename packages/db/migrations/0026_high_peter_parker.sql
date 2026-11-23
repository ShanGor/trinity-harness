ALTER TABLE "personal_calendar_items" ADD COLUMN "reminder_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_calendar_items" ADD COLUMN "reminder_due_at" timestamp with time zone;
--> statement-breakpoint
CREATE FUNCTION reject_personal_calendar_change_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'personal_calendar_changes is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_calendar_changes_append_only BEFORE UPDATE OR DELETE ON personal_calendar_changes FOR EACH ROW EXECUTE FUNCTION reject_personal_calendar_change_mutation();

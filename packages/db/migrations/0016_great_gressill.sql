CREATE TABLE "browser_controls" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_user_inputs" (
	"session_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"record" jsonb NOT NULL,
	"effect" text,
	CONSTRAINT "browser_user_inputs_session_id_request_id_pk" PRIMARY KEY("session_id","request_id")
);

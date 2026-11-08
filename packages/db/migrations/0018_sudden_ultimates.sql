CREATE TABLE "attachment_contents" (
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_contents_sha256_size_pk" PRIMARY KEY("sha256","size")
);
--> statement-breakpoint
CREATE TABLE "attachment_ingestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_ingestion_operation" ON "attachment_ingestions" USING btree ("session_id","operation_id");
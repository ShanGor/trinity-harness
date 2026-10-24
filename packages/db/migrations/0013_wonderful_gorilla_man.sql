CREATE TABLE "assistant_environments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"generation" uuid NOT NULL,
	"state" text NOT NULL,
	"vcpus" bigint NOT NULL,
	"memory_mib" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_environment_owner" ON "assistant_environments" USING btree ("tenant_id","user_id");
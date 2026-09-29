CREATE TABLE "model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "quota" jsonb;--> statement-breakpoint
CREATE INDEX "model_usage_tenant_created_idx" ON "model_usage" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "model_usage_session_idx" ON "model_usage" USING btree ("session_id");
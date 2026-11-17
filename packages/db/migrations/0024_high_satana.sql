CREATE TABLE "llm_configuration_operations" (
	"tenant_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"activity" jsonb NOT NULL,
	CONSTRAINT "llm_configuration_operations_tenant_id_operation_id_pk" PRIMARY KEY("tenant_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "llm_configuration_revisions" (
	"tenant_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"configuration" jsonb NOT NULL,
	CONSTRAINT "llm_configuration_revisions_tenant_id_revision_pk" PRIMARY KEY("tenant_id","revision")
);
--> statement-breakpoint
CREATE TABLE "llm_configurations" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"active_revision" bigint,
	"source" text DEFAULT 'environment' NOT NULL,
	"draft" jsonb
);
--> statement-breakpoint
CREATE TABLE "llm_credentials" (
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"sealed" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"current" boolean DEFAULT true NOT NULL,
	CONSTRAINT "llm_credentials_tenant_id_connection_id_version_id_pk" PRIMARY KEY("tenant_id","connection_id","version_id")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "llm_configuration_operations" ADD CONSTRAINT "llm_configuration_operations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_configuration_revisions" ADD CONSTRAINT "llm_configuration_revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_configurations" ADD CONSTRAINT "llm_configurations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_credentials" ADD CONSTRAINT "llm_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "llm_credentials_current" ON "llm_credentials" USING btree ("tenant_id","connection_id") WHERE "llm_credentials"."current" = true;--> statement-breakpoint
UPDATE "users" SET "role" = 'member' WHERE "role" = 'developer';
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_valid" CHECK ("users"."role" in ('admin', 'expert', 'member', 'viewer'));
--> statement-breakpoint
CREATE TABLE "llm_health" (
	"tenant_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"credential_version_id" uuid NOT NULL,
	"failures" bigint DEFAULT 0 NOT NULL,
	"open" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_health_tenant_id_deployment_id_credential_version_id_pk" PRIMARY KEY("tenant_id","deployment_id","credential_version_id")
);
--> statement-breakpoint
CREATE TABLE "llm_health_observations" (
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	CONSTRAINT "llm_health_observations_tenant_id_request_id_pk" PRIMARY KEY("tenant_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "llm_probes" (
	"tenant_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"version" bigint NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "llm_probes_tenant_id_operation_id_pk" PRIMARY KEY("tenant_id","operation_id")
);
--> statement-breakpoint
ALTER TABLE "llm_health" ADD CONSTRAINT "llm_health_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_health_observations" ADD CONSTRAINT "llm_health_observations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_probes" ADD CONSTRAINT "llm_probes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION trinity_llm_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LLM revisions and administrative operations are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER llm_revisions_immutable BEFORE UPDATE OR DELETE ON llm_configuration_revisions FOR EACH ROW EXECUTE FUNCTION trinity_llm_revision_immutable();
--> statement-breakpoint
CREATE TRIGGER llm_operations_immutable BEFORE UPDATE OR DELETE ON llm_configuration_operations FOR EACH ROW EXECUTE FUNCTION trinity_llm_revision_immutable();
--> statement-breakpoint
ALTER TABLE "llm_health" ADD COLUMN "credential_blocked" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
CREATE FUNCTION trinity_llm_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source = 'database' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Activated LLM configuration cannot be deleted';
    END IF;
    IF NEW.source <> 'database' OR NEW.active_revision IS NULL THEN
      RAISE EXCEPTION 'Activated LLM configuration cannot return to environment mode';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER llm_source_fence BEFORE UPDATE OR DELETE ON llm_configurations FOR EACH ROW EXECUTE FUNCTION trinity_llm_source_fence();

--> statement-breakpoint
ALTER TABLE "llm_health" ADD COLUMN "connection_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_health" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "llm_health" ADD COLUMN "connection_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "llm_health_connection_retry" ON "llm_health" USING btree ("tenant_id","connection_id","connection_retry_at");
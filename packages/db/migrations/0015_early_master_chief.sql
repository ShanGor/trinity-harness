CREATE TABLE "firecracker_node_maintenance" (
	"node_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

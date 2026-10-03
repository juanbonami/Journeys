CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text,
	"first_name" text,
	"last_name" text,
	"email_status" text DEFAULT 'subscribed' NOT NULL,
	"email_status_at" timestamp with time zone,
	"phone" text,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"sms_consent_at" timestamp with time zone,
	"sms_consent_source" text,
	"sms_opted_out" boolean DEFAULT false NOT NULL,
	"sms_opted_out_at" timestamp with time zone,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journey_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"journey_version_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"current_node_id" text NOT NULL,
	"wake_at" timestamp with time zone,
	"step_seq" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"trigger_event_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journey_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journey_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"execution_id" uuid,
	"node_id" text,
	"channel" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"to_address" text NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "node_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"step_seq" integer NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "events" ADD CONSTRAINT "events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journey_executions" ADD CONSTRAINT "journey_executions_journey_version_id_journey_versions_id_fk" FOREIGN KEY ("journey_version_id") REFERENCES "public"."journey_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journey_executions" ADD CONSTRAINT "journey_executions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journey_versions" ADD CONSTRAINT "journey_versions_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journeys" ADD CONSTRAINT "journeys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_execution_id_journey_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."journey_executions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "node_executions" ADD CONSTRAINT "node_executions_execution_id_journey_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."journey_executions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_ws_email" ON "contacts" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_dedupe" ON "events" USING btree ("source","external_id") WHERE "events"."external_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_contact_type" ON "events" USING btree ("contact_id","type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "one_active_run" ON "journey_executions" USING btree ("journey_version_id","contact_id") WHERE "journey_executions"."status" in ('running','waiting');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "due_executions" ON "journey_executions" USING btree ("wake_at") WHERE "journey_executions"."status" in ('running','waiting');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "journey_versions_unique" ON "journey_versions" USING btree ("journey_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_idem" ON "messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_provider_id" ON "messages" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "node_exec_step" ON "node_executions" USING btree ("execution_id","step_seq");
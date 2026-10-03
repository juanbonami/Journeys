import { sql } from "drizzle-orm";
import {
  boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
});

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    email: text("email"), // always stored lowercased by the app
    firstName: text("first_name"),
    lastName: text("last_name"),
    emailStatus: text("email_status").notNull().default("subscribed"), // subscribed|unsubscribed|bounced|complained
    emailStatusAt: timestamp("email_status_at", { withTimezone: true }),
    // SMS fields exist now so the engine can enforce them later (Phase 4)
    phone: text("phone"),
    phoneVerified: boolean("phone_verified").notNull().default(false),
    smsConsent: boolean("sms_consent").notNull().default(false),
    smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),
    smsConsentSource: text("sms_consent_source"),
    smsOptedOut: boolean("sms_opted_out").notNull().default(false),
    smsOptedOutAt: timestamp("sms_opted_out_at", { withTimezone: true }),
    attributes: jsonb("attributes").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contacts_ws_email").on(t.workspaceId, t.email)],
);

export const journeys = pgTable("journeys", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"), // draft|active|paused|archived
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const journeyVersions = pgTable(
  "journey_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    journeyId: uuid("journey_id").notNull().references(() => journeys.id),
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull(), // validated by JourneyDefinition; immutable once published
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("journey_versions_unique").on(t.journeyId, t.version)],
);

export const journeyExecutions = pgTable(
  "journey_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    journeyVersionId: uuid("journey_version_id").notNull().references(() => journeyVersions.id),
    contactId: uuid("contact_id").notNull().references(() => contacts.id),
    status: text("status").notNull().default("running"), // running|waiting|completed|exited|failed|cancelled
    currentNodeId: text("current_node_id").notNull(),
    wakeAt: timestamp("wake_at", { withTimezone: true }), // when it is next due; source of truth for scheduling
    stepSeq: integer("step_seq").notNull().default(0), // increments each advance; used for idempotency
    leaseUntil: timestamp("lease_until", { withTimezone: true }), // worker lease, not a long-held transaction
    triggerEventId: uuid("trigger_event_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    // one active run per contact per journey version (relax later for re-entry)
    uniqueIndex("one_active_run")
      .on(t.journeyVersionId, t.contactId)
      .where(sql`${t.status} in ('running','waiting')`),
    index("due_executions").on(t.wakeAt).where(sql`${t.status} in ('running','waiting')`),
  ],
);

export const nodeExecutions = pgTable(
  "node_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    executionId: uuid("execution_id").notNull().references(() => journeyExecutions.id),
    nodeId: text("node_id").notNull(),
    stepSeq: integer("step_seq").notNull(),
    status: text("status").notNull(), // succeeded|failed
    result: jsonb("result"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("node_exec_step").on(t.executionId, t.stepSeq)],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id),
    type: text("type").notNull(),
    source: text("source").notNull(), // app|form|ses|twilio
    externalId: text("external_id"), // provider event id, for dedupe
    data: jsonb("data").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("events_dedupe").on(t.source, t.externalId).where(sql`${t.externalId} is not null`),
    index("events_contact_type").on(t.contactId, t.type, t.occurredAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id),
    executionId: uuid("execution_id").references(() => journeyExecutions.id),
    nodeId: text("node_id"),
    channel: text("channel").notNull(), // email|sms
    idempotencyKey: text("idempotency_key").notNull(), // `${executionId}:${stepSeq}`
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    status: text("status").notNull().default("pending"), // pending|sending|sent|failed|unknown|suppressed
    toAddress: text("to_address").notNull(),
    payload: jsonb("payload").notNull(), // rendered snapshot, for audit
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("messages_idem").on(t.idempotencyKey),
    index("messages_provider_id").on(t.provider, t.providerMessageId),
  ],
);

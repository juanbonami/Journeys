import { and, eq } from "drizzle-orm";
import { contacts, events, type Db } from "@journeys/db";
import type { EventType } from "@journeys/shared";

export type IngestInput = {
  workspaceId: string;
  contactId: string;
  type: EventType;
  source: string; // app|form|ses|twilio|dev
  /** Provider's own event id. (source, externalId) is unique, so redelivered webhooks are ignored. */
  externalId?: string | null;
  data?: Record<string, unknown>;
  occurredAt?: Date;
};

/** Which email_status (if any) an event causes. Only permanent bounces suppress. */
function suppressionFor(type: EventType, data: Record<string, unknown>): "bounced" | "complained" | "unsubscribed" | null {
  if (type === "email.bounced") return data.permanent === false ? null : "bounced";
  if (type === "email.complained") return "complained";
  if (type === "email.unsubscribed") return "unsubscribed";
  return null;
}

/**
 * The single door into the events table. Provider adapters (SES, Twilio, dev simulator, your own app)
 * all call this, so the workflow engine never sees a provider payload.
 * Event insert and suppression update commit together; a duplicate event changes nothing.
 */
export async function ingestEvent(db: Db, i: IngestInput, now = new Date()): Promise<{ inserted: boolean; eventId?: string }> {
  return db.transaction(async (tx) => {
    const data = i.data ?? {};
    const [row] = await tx
      .insert(events)
      .values({
        workspaceId: i.workspaceId, contactId: i.contactId, type: i.type, source: i.source,
        externalId: i.externalId ?? null, data, occurredAt: i.occurredAt ?? now,
      })
      .onConflictDoNothing()
      .returning({ id: events.id });
    if (!row) return { inserted: false };

    const next = suppressionFor(i.type, data);
    if (next) {
      // A complaint always wins; otherwise only move a still-subscribed contact (never downgrade a complaint).
      const where = next === "complained" ? eq(contacts.id, i.contactId) : and(eq(contacts.id, i.contactId), eq(contacts.emailStatus, "subscribed"));
      await tx.update(contacts).set({ emailStatus: next, emailStatusAt: now }).where(where);
    }
    return { inserted: true, eventId: row.id };
  });
}

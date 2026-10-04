import { and, desc, eq, gte, sql } from "drizzle-orm";
import { contacts, events, messages, type journeyExecutions } from "@journeys/db";
import { ProviderError } from "@journeys/providers";
import { durationMs, type JourneyNode } from "@journeys/shared";
import type { Ctx } from "./context";
import { renderTemplate } from "./render";
import { unsubscribeUrl } from "./unsubscribe";

export type Execution = typeof journeyExecutions.$inferSelect;

/** What a node decided. Handlers never mutate the execution; advance() applies the outcome atomically. */
export type Outcome =
  | { kind: "next"; nodeId: string; detail?: Record<string, unknown> }
  | { kind: "wait"; until: Date; nextNodeId: string }
  | { kind: "exit"; reason: string };

type Handler<T extends JourneyNode["type"]> = (
  ctx: Ctx,
  exec: Execution,
  node: Extract<JourneyNode, { type: T }>,
) => Promise<Outcome>;

const trigger: Handler<"trigger"> = async (_ctx, _exec, node) => ({ kind: "next", nodeId: node.next });

const wait: Handler<"wait"> = async (ctx, _exec, node) => ({
  kind: "wait",
  until: new Date(ctx.now().getTime() + durationMs(node.duration)),
  nextNodeId: node.next,
});

const exit: Handler<"exit"> = async () => ({ kind: "exit", reason: "reached_exit_node" });

const sendEmail: Handler<"send_email"> = async (ctx, exec, node) => {
  const idem = `${exec.id}:${exec.stepSeq}`;
  const next = (detail: Record<string, unknown>): Outcome => ({ kind: "next", nodeId: node.next, detail });

  const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, exec.contactId));
  if (!contact) throw new Error(`contact ${exec.contactId} not found`);

  // Suppression is enforced by the engine, not by whoever wrote the journey.
  const suppressedReason = !contact.email ? "no_email" : contact.emailStatus !== "subscribed" ? `email_${contact.emailStatus}` : null;

  const vars = { firstName: contact.firstName, lastName: contact.lastName, email: contact.email };
  // Every email carries an unsubscribe link; journey authors can't forget it.
  const unsubUrl = unsubscribeUrl(ctx.appUrl, contact.id, ctx.secret);
  const payload = {
    subject: renderTemplate(node.template.subject, vars),
    html:
      renderTemplate(node.template.html, vars, true) +
      `<p style="font-size:12px;color:#888;margin-top:24px"><a href="${unsubUrl}">Unsubscribe</a></p>`,
    text: (node.template.text ? renderTemplate(node.template.text, vars) : "") + `\n\nUnsubscribe: ${unsubUrl}`,
  };

  // Claim the send slot. The unique idempotency key means a retried step can never create a second message.
  const inserted = await ctx.db
    .insert(messages)
    .values({
      workspaceId: exec.workspaceId,
      contactId: exec.contactId,
      executionId: exec.id,
      nodeId: exec.currentNodeId,
      channel: "email",
      idempotencyKey: idem,
      toAddress: contact.email ?? "",
      payload,
      status: suppressedReason ? "suppressed" : "pending",
      error: suppressedReason,
    })
    .onConflictDoNothing()
    .returning();

  if (suppressedReason) return next({ sent: false, suppressed: suppressedReason });

  let msg = inserted[0];
  if (!msg) {
    const [existing] = await ctx.db.select().from(messages).where(eq(messages.idempotencyKey, idem));
    if (!existing) throw new Error("idempotency conflict but message not found");
    if (existing.status === "sending") {
      // Crashed mid-send: we cannot know if it went out. At-most-once policy: do not resend.
      await ctx.db.update(messages).set({ status: "unknown", error: "worker died while sending" }).where(eq(messages.id, existing.id));
      return next({ sent: false, messageId: existing.id, status: "unknown" });
    }
    if (existing.status !== "pending") return next({ sent: existing.status === "sent", messageId: existing.id, status: existing.status });
    msg = existing; // still pending: the earlier attempt never reached the provider, safe to send
  }

  await ctx.db.update(messages).set({ status: "sending", provider: ctx.email.name }).where(eq(messages.id, msg.id));
  try {
    const res = await ctx.email.send({
      from: ctx.emailFrom,
      to: contact.email!,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      tags: { messageId: msg.id, executionId: exec.id, nodeId: exec.currentNodeId, workspaceId: exec.workspaceId },
    });
    const sentAt = ctx.now();
    await ctx.db
      .update(messages)
      .set({ status: "sent", providerMessageId: res.providerMessageId, sentAt })
      .where(eq(messages.id, msg.id));
    await ctx.db
      .insert(events)
      .values({
        workspaceId: exec.workspaceId,
        contactId: exec.contactId,
        type: "email.sent",
        source: "app",
        externalId: `msg_${msg.id}_sent`,
        data: { messageId: msg.id, executionId: exec.id, nodeId: exec.currentNodeId },
        occurredAt: sentAt,
      })
      .onConflictDoNothing();
    return next({ sent: true, messageId: msg.id });
  } catch (e) {
    if (e instanceof ProviderError && e.definitelyNotSent) {
      // Provider rejected before sending: back to pending, let BullMQ retry with backoff.
      await ctx.db.update(messages).set({ status: "pending", error: e.message }).where(eq(messages.id, msg.id));
      throw e;
    }
    // Ambiguous failure: may or may not have been sent. Never auto-retry.
    await ctx.db.update(messages).set({ status: "unknown", error: (e as Error).message }).where(eq(messages.id, msg.id));
    return next({ sent: false, messageId: msg.id, status: "unknown", error: (e as Error).message });
  }
};

const condition: Handler<"condition"> = async (ctx, exec, node) => {
  const c = node.check;
  let matched = false;
  let evidence: unknown = null;

  if (c.kind === "event_since_entry") {
    const [row] = await ctx.db
      .select({ id: events.id, occurredAt: events.occurredAt })
      .from(events)
      .where(and(eq(events.contactId, exec.contactId), eq(events.type, c.eventType), gte(events.occurredAt, exec.startedAt)))
      .orderBy(desc(events.occurredAt))
      .limit(1);
    matched = !!row;
    evidence = row ?? null;
  } else {
    // events for the message sent by the referenced node in THIS execution
    const [msg] = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.executionId, exec.id), eq(messages.nodeId, c.nodeId)))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (msg) {
      const [row] = await ctx.db
        .select({ id: events.id, occurredAt: events.occurredAt })
        .from(events)
        .where(and(eq(events.contactId, exec.contactId), eq(events.type, c.eventType), sql`${events.data}->>'messageId' = ${msg.id}`))
        .limit(1);
      matched = !!row;
      evidence = row ?? null;
    }
  }
  return { kind: "next", nodeId: matched ? node.yes : node.no, detail: { check: c, matched, evidence } };
};

export const handlers = { trigger, wait, exit, send_email: sendEmail, condition } as const;

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { contacts, createDb, events, journeys, journeyVersions, messages, nodeExecutions, workspaces } from "@journeys/db";
import { advance, ingestEvent, signUnsubscribeToken, startExecutionsForEvent, verifyUnsubscribeToken, type Ctx } from "@journeys/engine";
import { JourneyDefinition } from "@journeys/shared";
import type { SendEmailInput } from "@journeys/providers";

// Runs against your dev Postgres (each test uses its own fresh workspace, so nothing collides).
const { db, pool } = createDb(process.env.DATABASE_URL ?? "postgres://postgres:dev@localhost:5432/journeys");
afterAll(() => pool.end());

let clock = new Date();
let sent: SendEmailInput[] = [];
const ctx: Ctx = {
  db,
  queue: { add: async () => ({}) } as never, // no Redis: the test drives advance() itself
  email: { name: "fake", send: async (i) => (sent.push(i), { providerMessageId: `fake-${sent.length}` }) },
  emailFrom: "t@example.com",
  appUrl: "http://test",
  secret: "test-secret",
  now: () => clock,
};
const tpl = (subject: string) => ({ subject, html: `<p>${subject}</p>` });

const branchDef = JourneyDefinition.parse({
  start: "t",
  nodes: {
    t: { type: "trigger", next: "e1" },
    e1: { type: "send_email", template: tpl("first"), next: "w" },
    w: { type: "wait", duration: { days: 2 }, next: "c" },
    c: { type: "condition", check: { kind: "event_since_node", eventType: "email.clicked", nodeId: "e1" }, yes: "a", no: "b" },
    a: { type: "send_email", template: tpl("A"), next: "x" },
    b: { type: "send_email", template: tpl("B"), next: "x" },
    x: { type: "exit" },
  },
});
const dripDef = JourneyDefinition.parse({
  start: "t",
  nodes: {
    t: { type: "trigger", next: "e1" },
    e1: { type: "send_email", template: tpl("first"), next: "w" },
    w: { type: "wait", duration: { days: 1 }, next: "e2" },
    e2: { type: "send_email", template: tpl("second"), next: "x" },
    x: { type: "exit" },
  },
});

async function setup(def: unknown) {
  const [ws] = await db.insert(workspaces).values({ name: "test" }).returning();
  const [c] = await db.insert(contacts).values({ workspaceId: ws!.id, email: `t${Date.now()}${Math.random()}@example.com`, firstName: "T" }).returning();
  const [j] = await db.insert(journeys).values({ workspaceId: ws!.id, name: "t", status: "active" }).returning();
  await db.insert(journeyVersions).values({ journeyId: j!.id, version: 1, definition: def as object, publishedAt: new Date() });
  const [ev] = await db.insert(events).values({ workspaceId: ws!.id, contactId: c!.id, type: "form.submitted", source: "form", occurredAt: clock }).returning();
  const [started] = await startExecutionsForEvent(db, { workspaceId: ws!.id, contactId: c!.id, eventId: ev!.id, eventType: "form.submitted", now: clock });
  return { wsId: ws!.id, contactId: c!.id, execId: started!.executionId };
}
/** Advance until the execution has nothing due right now (waiting) or finished. */
async function drive(execId: string) {
  for (let i = 0; i < 30; i++) {
    const r = await advance(ctx, execId);
    if (r === "skipped" || r === "completed") return r;
  }
  throw new Error("did not settle");
}
const msgFor = async (execId: string, nodeId: string) =>
  (await db.select().from(messages).where(and(eq(messages.executionId, execId), eq(messages.nodeId, nodeId))))[0]!;
const afterDays = (d: number) => (clock = new Date(clock.getTime() + d * 86_400_000 + 1000));

beforeEach(() => { clock = new Date(); sent = []; });

describe("conditions and branching", () => {
  it("click before the condition -> yes branch (A)", async () => {
    const { wsId, contactId, execId } = await setup(branchDef);
    await drive(execId);
    const m = await msgFor(execId, "e1");
    await ingestEvent(db, { workspaceId: wsId, contactId, type: "email.clicked", source: "dev", externalId: "c1", data: { messageId: m.id } }, clock);
    afterDays(2);
    expect(await drive(execId)).toBe("completed");
    expect(sent.map((s) => s.subject)).toEqual(["first", "A"]);
  });

  it("no click -> no branch (B)", async () => {
    const { execId } = await setup(branchDef);
    await drive(execId);
    afterDays(2);
    await drive(execId);
    expect(sent.map((s) => s.subject)).toEqual(["first", "B"]);
  });

  it("a click on a DIFFERENT message does not count", async () => {
    const { wsId, contactId, execId } = await setup(branchDef);
    await drive(execId);
    await ingestEvent(db, { workspaceId: wsId, contactId, type: "email.clicked", source: "dev", externalId: "c2", data: { messageId: crypto.randomUUID() } }, clock);
    afterDays(2);
    await drive(execId);
    expect(sent.map((s) => s.subject)).toEqual(["first", "B"]);
  });

  it("a click arriving AFTER the condition ran does not change the decision", async () => {
    const { wsId, contactId, execId } = await setup(branchDef);
    await drive(execId);
    afterDays(2);
    await drive(execId); // condition evaluated: no click -> B
    const m = await msgFor(execId, "e1");
    await ingestEvent(db, { workspaceId: wsId, contactId, type: "email.clicked", source: "dev", externalId: "late", data: { messageId: m.id } }, clock);
    const [step] = await db.select().from(nodeExecutions).where(and(eq(nodeExecutions.executionId, execId), eq(nodeExecutions.nodeId, "c")));
    expect((step!.result as { detail: { matched: boolean } }).detail.matched).toBe(false);
    expect(sent.map((s) => s.subject)).toEqual(["first", "B"]);
  });
});

describe("event ingestion and suppression", () => {
  it("ignores a redelivered event (same source + externalId)", async () => {
    const { wsId, contactId } = await setup(dripDef);
    const e = { workspaceId: wsId, contactId, type: "email.opened" as const, source: "ses", externalId: "dup-1" };
    expect((await ingestEvent(db, e)).inserted).toBe(true);
    expect((await ingestEvent(db, e)).inserted).toBe(false);
    const rows = await db.select().from(events).where(and(eq(events.contactId, contactId), eq(events.type, "email.opened")));
    expect(rows).toHaveLength(1);
  });

  it("a permanent bounce suppresses later sends; a transient one does not", async () => {
    const a = await setup(dripDef);
    await drive(a.execId);
    await ingestEvent(db, { workspaceId: a.wsId, contactId: a.contactId, type: "email.bounced", source: "ses", externalId: "b1", data: { permanent: true } });
    afterDays(1);
    await drive(a.execId);
    expect(sent.map((s) => s.subject)).toEqual(["first"]); // second suppressed
    expect((await msgFor(a.execId, "e2")).status).toBe("suppressed");

    sent = [];
    const b = await setup(dripDef);
    await drive(b.execId);
    await ingestEvent(db, { workspaceId: b.wsId, contactId: b.contactId, type: "email.bounced", source: "ses", externalId: "b2", data: { permanent: false } });
    afterDays(1);
    await drive(b.execId);
    expect(sent.map((s) => s.subject)).toEqual(["first", "second"]);
  });

  it("an unsubscribe suppresses later sends and the journey still completes", async () => {
    const { wsId, contactId, execId } = await setup(dripDef);
    await drive(execId);
    await ingestEvent(db, { workspaceId: wsId, contactId, type: "email.unsubscribed", source: "app", externalId: `unsub_${contactId}` });
    afterDays(1);
    expect(await drive(execId)).toBe("completed");
    expect(sent).toHaveLength(1);
    expect((await db.select().from(contacts).where(eq(contacts.id, contactId)))[0]!.emailStatus).toBe("unsubscribed");
  });

  it("a complaint is not downgraded by a later bounce", async () => {
    const { wsId, contactId } = await setup(dripDef);
    await ingestEvent(db, { workspaceId: wsId, contactId, type: "email.complained", source: "ses", externalId: "x1" });
    await ingestEvent(db, { workspaceId: wsId, contactId, type: "email.bounced", source: "ses", externalId: "x2", data: { permanent: true } });
    expect((await db.select().from(contacts).where(eq(contacts.id, contactId)))[0]!.emailStatus).toBe("complained");
  });
});

describe("unsubscribe links", () => {
  it("every email has a signed unsubscribe link and List-Unsubscribe headers", async () => {
    const { contactId, execId } = await setup(dripDef);
    await drive(execId);
    const mail = sent[0]!;
    expect(mail.html).toContain("/unsubscribe/");
    expect(mail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const token = /unsubscribe\/([^"<\s]+)/.exec(mail.text ?? "")![1]!;
    expect(verifyUnsubscribeToken(token, "test-secret")).toBe(contactId);
  });

  it("rejects tampered tokens and wrong secrets", () => {
    const t = signUnsubscribeToken("abc", "s1");
    expect(verifyUnsubscribeToken(t, "s1")).toBe("abc");
    expect(verifyUnsubscribeToken(t, "s2")).toBeNull();
    expect(verifyUnsubscribeToken(`${Buffer.from("other").toString("base64url")}.${t.split(".")[1]}`, "s1")).toBeNull();
    expect(verifyUnsubscribeToken("garbage", "s1")).toBeNull();
  });
});

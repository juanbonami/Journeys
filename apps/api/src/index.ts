import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { asc, desc, eq } from "drizzle-orm";
import {
  contacts, createDb, events, journeyExecutions, journeys, journeyVersions, messages, nodeExecutions, workspaces,
} from "@journeys/db";
import { createQueue, enqueueNew, startExecutionsForEvent } from "@journeys/engine";
import { JourneyDefinition } from "@journeys/shared";

const { db } = createDb();
const queue = createQueue();
const app = Fastify({ logger: true });

// TODO(auth): Milestone 1 resolves the workspace from a header. Replace with API keys / form keys.
async function workspaceId(req: { headers: Record<string, unknown> }): Promise<string> {
  const id = req.headers["x-workspace-id"];
  if (typeof id === "string") return id;
  const [ws] = await db.select().from(workspaces).limit(1);
  if (!ws) throw new Error("no workspace; run `pnpm seed`");
  return ws.id;
}

app.get("/health", async () => ({ ok: true }));

const Submission = z.object({
  email: z.string().email().transform((s) => s.trim().toLowerCase()),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(40).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

// Lead capture: form -> contact -> event -> executions, atomically. Enqueue after commit.
app.post("/v1/forms/:formKey/submissions", async (req, reply) => {
  const body = Submission.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { formKey } = req.params as { formKey: string };
  const wsId = await workspaceId(req);
  const now = new Date();

  const { contactId, created } = await db.transaction(async (tx) => {
    const [contact] = await tx
      .insert(contacts)
      .values({ workspaceId: wsId, email: body.data.email, firstName: body.data.firstName, lastName: body.data.lastName, phone: body.data.phone, attributes: body.data.attributes ?? {} })
      .onConflictDoUpdate({
        target: [contacts.workspaceId, contacts.email],
        // don't clobber existing data with blanks
        set: { firstName: body.data.firstName ?? undefined, lastName: body.data.lastName ?? undefined },
      })
      .returning();
    const [event] = await tx
      .insert(events)
      .values({ workspaceId: wsId, contactId: contact!.id, type: "form.submitted", source: "form", data: { formKey, ...body.data }, occurredAt: now })
      .returning();
    const started = await startExecutionsForEvent(tx, { workspaceId: wsId, contactId: contact!.id, eventId: event!.id, eventType: "form.submitted", now });
    return { contactId: contact!.id, created: started };
  });

  await enqueueNew(queue, created); // after commit; the sweeper covers a crash right here
  return reply.code(202).send({ contactId, executionsStarted: created.map((c) => c.executionId) });
});

const CreateJourney = z.object({ name: z.string().min(1), definition: JourneyDefinition });
app.post("/v1/journeys", async (req, reply) => {
  const body = CreateJourney.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const wsId = await workspaceId(req);
  const out = await db.transaction(async (tx) => {
    const [j] = await tx.insert(journeys).values({ workspaceId: wsId, name: body.data.name }).returning();
    const [v] = await tx.insert(journeyVersions).values({ journeyId: j!.id, version: 1, definition: body.data.definition }).returning();
    return { journeyId: j!.id, versionId: v!.id, version: 1 };
  });
  return reply.code(201).send(out);
});

// Publishing freezes the version and activates the journey. Editing later = a new version row.
app.post("/v1/journeys/:id/publish", async (req, reply) => {
  const { id } = req.params as { id: string };
  const [latest] = await db.select().from(journeyVersions).where(eq(journeyVersions.journeyId, id)).orderBy(desc(journeyVersions.version)).limit(1);
  if (!latest) return reply.code(404).send({ error: "journey not found" });
  JourneyDefinition.parse(latest.definition);
  await db.transaction(async (tx) => {
    await tx.update(journeyVersions).set({ publishedAt: new Date() }).where(eq(journeyVersions.id, latest.id));
    await tx.update(journeys).set({ status: "active" }).where(eq(journeys.id, id));
  });
  return { journeyId: id, version: latest.version, status: "active" };
});

// Debugging view: everything that happened to one contact, in order.
app.get("/v1/contacts/:id/timeline", async (req, reply) => {
  const { id } = req.params as { id: string };
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!contact) return reply.code(404).send({ error: "not found" });
  const execs = await db.select().from(journeyExecutions).where(eq(journeyExecutions.contactId, id));
  const steps = await Promise.all(execs.map((e) => db.select().from(nodeExecutions).where(eq(nodeExecutions.executionId, e.id)).orderBy(asc(nodeExecutions.stepSeq))));
  const msgs = await db.select().from(messages).where(eq(messages.contactId, id)).orderBy(asc(messages.createdAt));
  const evs = await db.select().from(events).where(eq(events.contactId, id)).orderBy(asc(events.occurredAt));
  return { contact, executions: execs.map((e, i) => ({ ...e, steps: steps[i] })), messages: msgs, events: evs };
});


// ---- Dashboard (read-only views + static UI) ----
const uiHtml = () => readFileSync(new URL("../public/index.html", import.meta.url), "utf8"); // re-read so edits show on refresh
app.get("/", async (_req, reply) => reply.type("text/html").send(uiHtml()));

app.get("/v1/executions", async () => {
  const rows = await db
    .select({
      id: journeyExecutions.id, status: journeyExecutions.status, currentNodeId: journeyExecutions.currentNodeId,
      wakeAt: journeyExecutions.wakeAt, startedAt: journeyExecutions.startedAt, completedAt: journeyExecutions.completedAt,
      contactId: contacts.id, email: contacts.email, firstName: contacts.firstName, journey: journeys.name, version: journeyVersions.version,
    })
    .from(journeyExecutions)
    .innerJoin(contacts, eq(contacts.id, journeyExecutions.contactId))
    .innerJoin(journeyVersions, eq(journeyVersions.id, journeyExecutions.journeyVersionId))
    .innerJoin(journeys, eq(journeys.id, journeyVersions.journeyId))
    .orderBy(desc(journeyExecutions.startedAt))
    .limit(100);
  return rows;
});

app.get("/v1/executions/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const [exec] = await db.select().from(journeyExecutions).where(eq(journeyExecutions.id, id));
  if (!exec) return reply.code(404).send({ error: "not found" });
  const [version] = await db.select().from(journeyVersions).where(eq(journeyVersions.id, exec.journeyVersionId));
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, exec.contactId));
  const steps = await db.select().from(nodeExecutions).where(eq(nodeExecutions.executionId, id)).orderBy(asc(nodeExecutions.stepSeq));
  const msgs = await db.select().from(messages).where(eq(messages.executionId, id)).orderBy(asc(messages.createdAt));
  const evs = await db.select().from(events).where(eq(events.contactId, exec.contactId)).orderBy(asc(events.occurredAt));
  return { execution: exec, definition: version?.definition, contact, steps, messages: msgs, events: evs };
});

const port = Number(process.env.API_PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });

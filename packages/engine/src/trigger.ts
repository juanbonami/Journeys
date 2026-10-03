import { and, eq, isNotNull } from "drizzle-orm";
import { journeyExecutions, journeys, journeyVersions, type Executor } from "@journeys/db";
import { JourneyDefinition } from "@journeys/shared";
import type { Queue } from "bullmq";
import { enqueueAdvance } from "./queue";

export type NewExecution = { executionId: string; stepSeq: number };

/**
 * Create executions for every active journey whose trigger matches this event.
 * Call inside the same transaction that inserted the event; enqueue the returned ids AFTER commit.
 * The partial unique index makes repeat submissions a no-op while a run is still active.
 */
export async function startExecutionsForEvent(
  tx: Executor,
  p: { workspaceId: string; contactId: string; eventId: string; eventType: string; now?: Date },
): Promise<NewExecution[]> {
  const now = p.now ?? new Date();
  const rows = await tx
    .select({ journeyId: journeys.id, versionId: journeyVersions.id, version: journeyVersions.version, definition: journeyVersions.definition })
    .from(journeys)
    .innerJoin(journeyVersions, eq(journeyVersions.journeyId, journeys.id))
    .where(and(eq(journeys.workspaceId, p.workspaceId), eq(journeys.status, "active"), isNotNull(journeyVersions.publishedAt)));

  // latest published version per journey
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = latest.get(r.journeyId);
    if (!cur || r.version > cur.version) latest.set(r.journeyId, r);
  }

  const created: NewExecution[] = [];
  for (const r of latest.values()) {
    const def = JourneyDefinition.parse(r.definition);
    const start = def.nodes[def.start];
    if (start?.type !== "trigger" || start.event !== p.eventType) continue;
    const [row] = await tx
      .insert(journeyExecutions)
      .values({
        workspaceId: p.workspaceId,
        journeyVersionId: r.versionId,
        contactId: p.contactId,
        currentNodeId: def.start,
        wakeAt: now,
        triggerEventId: p.eventId,
      })
      .onConflictDoNothing()
      .returning({ id: journeyExecutions.id });
    if (row) created.push({ executionId: row.id, stepSeq: 0 });
  }
  return created;
}

export async function enqueueNew(queue: Queue, created: NewExecution[]) {
  await Promise.all(created.map((c) => enqueueAdvance(queue, { executionId: c.executionId, stepSeq: c.stepSeq })));
}

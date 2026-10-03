import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { journeyExecutions, journeyVersions, nodeExecutions } from "@journeys/db";
import { JourneyDefinition } from "@journeys/shared";
import type { Ctx } from "./context";
import { handlers, type Execution, type Outcome } from "./handlers";
import { enqueueAdvance } from "./queue";

export const LEASE_MS = 60_000;

export type AdvanceResult = "skipped" | "advanced" | "waiting" | "completed";

/**
 * Atomically take the right to run one step. This (not the BullMQ job) is the real concurrency guard:
 * duplicate/stale/early jobs simply fail to claim and become no-ops.
 */
async function claim(ctx: Ctx, executionId: string, expectedStepSeq?: number): Promise<Execution | null> {
  const now = ctx.now();
  const [row] = await ctx.db
    .update(journeyExecutions)
    .set({ leaseUntil: new Date(now.getTime() + LEASE_MS) })
    .where(
      and(
        eq(journeyExecutions.id, executionId),
        sql`${journeyExecutions.status} in ('running','waiting')`,
        or(isNull(journeyExecutions.wakeAt), sql`${journeyExecutions.wakeAt} <= ${now}`),
        or(isNull(journeyExecutions.leaseUntil), lt(journeyExecutions.leaseUntil, now)),
        expectedStepSeq === undefined ? undefined : eq(journeyExecutions.stepSeq, expectedStepSeq),
      ),
    )
    .returning();
  return row ?? null;
}

async function releaseLease(ctx: Ctx, executionId: string) {
  await ctx.db.update(journeyExecutions).set({ leaseUntil: null }).where(eq(journeyExecutions.id, executionId));
}

export async function advance(ctx: Ctx, executionId: string, expectedStepSeq?: number): Promise<AdvanceResult> {
  const exec = await claim(ctx, executionId, expectedStepSeq);
  if (!exec) return "skipped";

  const startedAt = ctx.now();
  try {
    const [version] = await ctx.db.select().from(journeyVersions).where(eq(journeyVersions.id, exec.journeyVersionId));
    if (!version) throw new Error(`journey version ${exec.journeyVersionId} missing`);
    const def = JourneyDefinition.parse(version.definition);
    const node = def.nodes[exec.currentNodeId];
    if (!node) throw new Error(`node "${exec.currentNodeId}" not in definition`);

    const outcome: Outcome = await (handlers[node.type] as (c: Ctx, e: Execution, n: typeof node) => Promise<Outcome>)(ctx, exec, node);

    // One transaction: audit row + execution state. Either both land or neither.
    const now = ctx.now();
    await ctx.db.transaction(async (tx) => {
      await tx.insert(nodeExecutions).values({
        executionId: exec.id,
        nodeId: exec.currentNodeId,
        stepSeq: exec.stepSeq,
        status: "succeeded",
        result: outcome,
        startedAt,
        completedAt: now,
      });
      const base = { stepSeq: exec.stepSeq + 1, leaseUntil: null };
      if (outcome.kind === "next") {
        await tx.update(journeyExecutions).set({ ...base, status: "running", currentNodeId: outcome.nodeId, wakeAt: now }).where(eq(journeyExecutions.id, exec.id));
      } else if (outcome.kind === "wait") {
        await tx.update(journeyExecutions).set({ ...base, status: "waiting", currentNodeId: outcome.nextNodeId, wakeAt: outcome.until }).where(eq(journeyExecutions.id, exec.id));
      } else {
        await tx.update(journeyExecutions).set({ ...base, status: "completed", wakeAt: null, completedAt: now }).where(eq(journeyExecutions.id, exec.id));
      }
    });

    // Enqueue only after commit. If we crash right here, the sweeper re-enqueues from Postgres.
    if (outcome.kind === "next") {
      await enqueueAdvance(ctx.queue, { executionId: exec.id, stepSeq: exec.stepSeq + 1 }, now.getTime());
      return "advanced";
    }
    if (outcome.kind === "wait") {
      await enqueueAdvance(ctx.queue, { executionId: exec.id, stepSeq: exec.stepSeq + 1, runAt: outcome.until }, now.getTime());
      return "waiting";
    }
    return "completed";
  } catch (e) {
    await releaseLease(ctx, exec.id); // let BullMQ's retry (or the sweeper) claim it again
    throw e;
  }
}

/** Called by the worker when BullMQ has exhausted retries for a step. */
export async function markFailed(ctx: Ctx, executionId: string, error: string) {
  const [exec] = await ctx.db.select().from(journeyExecutions).where(eq(journeyExecutions.id, executionId));
  if (!exec || !["running", "waiting"].includes(exec.status)) return;
  await ctx.db.transaction(async (tx) => {
    await tx
      .insert(nodeExecutions)
      .values({ executionId, nodeId: exec.currentNodeId, stepSeq: exec.stepSeq, status: "failed", error, completedAt: ctx.now() })
      .onConflictDoNothing();
    await tx
      .update(journeyExecutions)
      .set({ status: "failed", leaseUntil: null, wakeAt: null, completedAt: ctx.now() })
      .where(eq(journeyExecutions.id, executionId));
  });
}

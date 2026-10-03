import { sql } from "drizzle-orm";
import { journeyExecutions } from "@journeys/db";
import type { Ctx } from "./context";
import { enqueueAdvance } from "./queue";

/**
 * Safety net: re-enqueue anything overdue that nobody holds a lease on.
 * Covers lost Redis, crashes between commit and enqueue, and workers that died mid-step.
 * Job ids include a minute bucket so a previously-completed job with the same step can't mask it;
 * duplicates are harmless because advance() claims atomically.
 */
export async function sweep(ctx: Ctx, opts: { graceMs?: number; limit?: number } = {}) {
  const now = ctx.now();
  const cutoff = new Date(now.getTime() - (opts.graceMs ?? 30_000));
  const due = await ctx.db
    .select({ id: journeyExecutions.id, stepSeq: journeyExecutions.stepSeq })
    .from(journeyExecutions)
    .where(
      sql`${journeyExecutions.status} in ('running','waiting')
          and ${journeyExecutions.wakeAt} <= ${cutoff}
          and (${journeyExecutions.leaseUntil} is null or ${journeyExecutions.leaseUntil} < ${now})`,
    )
    .limit(opts.limit ?? 500);
  const bucket = Math.floor(now.getTime() / 60_000);
  for (const d of due) await enqueueAdvance(ctx.queue, { executionId: d.id, stepSeq: d.stepSeq, idSuffix: `_s${bucket}` }, now.getTime());
  return due.length;
}

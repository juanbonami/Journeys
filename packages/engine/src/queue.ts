import { Queue } from "bullmq";
import IORedis from "ioredis";

export const QUEUE_NAME = "journey";
export const JOB_ATTEMPTS = 5;

export function createRedis(url = process.env.REDIS_URL ?? "redis://localhost:6379") {
  // BullMQ requires maxRetriesPerRequest: null for blocking connections
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function createQueue(connection = createRedis()) {
  return new Queue(QUEUE_NAME, { connection });
}

/**
 * Wake-up only: the job carries no state, Postgres is the source of truth.
 * A deterministic jobId is a best-effort dedupe; the real guard is the claim() lease in advance().
 * NOTE: BullMQ custom job ids must not contain ':'.
 */
export async function enqueueAdvance(
  queue: Queue,
  p: { executionId: string; stepSeq: number; runAt?: Date; idSuffix?: string },
  now = Date.now(),
) {
  const delay = Math.max((p.runAt?.getTime() ?? now) - now, 0);
  await queue.add(
    "advance",
    { executionId: p.executionId, stepSeq: p.stepSeq },
    {
      jobId: `${p.executionId}_${p.stepSeq}${p.idSuffix ?? ""}`,
      delay,
      attempts: JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 7 * 86400 },
    },
  );
}

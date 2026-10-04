import { Worker } from "bullmq";
import { createDb } from "@journeys/db";
import { advance, createQueue, createRedis, JOB_ATTEMPTS, markFailed, QUEUE_NAME, sweep, type Ctx } from "@journeys/engine";
import { createEmailProvider } from "@journeys/providers";

const { db } = createDb();
const connection = createRedis();
const queue = createQueue(createRedis());

const ctx: Ctx = {
  db,
  queue,
  email: createEmailProvider(),
  emailFrom: process.env.EMAIL_FROM ?? "Journeys <hello@example.com>",
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  secret: process.env.UNSUBSCRIBE_SECRET ?? "dev-only-secret",
  now: () => new Date(),
};

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { executionId, stepSeq } = job.data as { executionId: string; stepSeq?: number };
    const result = await advance(ctx, executionId, stepSeq);
    console.log(`[advance] ${executionId} step=${stepSeq ?? "-"} -> ${result}`);
    return result;
  },
  { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10) },
);

worker.on("failed", async (job, err) => {
  console.error(`[failed] job=${job?.id} attempt=${job?.attemptsMade}: ${err.message}`);
  // Out of retries: park the execution as failed so it is visible and never silently stuck.
  if (job && job.attemptsMade >= (job.opts.attempts ?? JOB_ATTEMPTS)) {
    await markFailed(ctx, (job.data as { executionId: string }).executionId, err.message);
  }
});

// Safety net: a plain timer (NOT a BullMQ scheduler), so it still runs if Redis was wiped.
// Recovers from lost Redis, crashes between commit and enqueue, and workers that died mid-step.
// Several workers sweeping at once is harmless: advance() claims atomically.
const sweepEveryMs = Number(process.env.SWEEP_EVERY_MS ?? 60_000);
const sweepTimer = setInterval(async () => {
  try {
    const n = await sweep(ctx);
    if (n > 0) console.log(`[sweep] re-enqueued ${n} overdue execution(s)`);
  } catch (e) {
    console.error("[sweep] failed:", (e as Error).message);
  }
}, sweepEveryMs);

console.log(`worker up (email provider: ${ctx.email.name})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    clearInterval(sweepTimer);
    await worker.close(); // lets in-flight jobs finish
    process.exit(0);
  });
}

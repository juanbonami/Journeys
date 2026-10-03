import { eq } from "drizzle-orm";
import { createDb, journeys, journeyVersions, workspaces } from "@journeys/db";
import { JourneyDefinition } from "@journeys/shared";

const { db, pool } = createDb();
const waitSeconds = Number(process.env.SEED_WAIT_SECONDS ?? 60);

// Milestone 1 journey: trigger -> email -> wait -> email -> exit
const definition = JourneyDefinition.parse({
  start: "trigger",
  nodes: {
    trigger: { type: "trigger", event: "form.submitted", next: "welcome" },
    welcome: {
      type: "send_email",
      template: { subject: "Welcome, {{firstName}}!", html: "<p>Hi {{firstName}}, thanks for signing up.</p>", text: "Hi {{firstName}}, thanks for signing up." },
      next: "pause",
    },
    pause: { type: "wait", duration: { seconds: waitSeconds }, next: "followup" },
    followup: {
      type: "send_email",
      template: { subject: "Quick follow-up, {{firstName}}", html: "<p>Hi {{firstName}}, just checking in.</p>", text: "Hi {{firstName}}, just checking in." },
      next: "done",
    },
    done: { type: "exit" },
  },
});

let [ws] = await db.select().from(workspaces).limit(1);
if (!ws) [ws] = await db.insert(workspaces).values({ name: "Dev Workspace" }).returning();

const existing = await db.select().from(journeys).where(eq(journeys.name, "Milestone 1"));
if (existing.length === 0) {
  const [j] = await db.insert(journeys).values({ workspaceId: ws!.id, name: "Milestone 1", status: "active" }).returning();
  await db.insert(journeyVersions).values({ journeyId: j!.id, version: 1, definition, publishedAt: new Date() });
  console.log(`seeded journey ${j!.id}`);
} else {
  console.log("journey already seeded");
}
console.log(`workspace ${ws!.id}`);
await pool.end();

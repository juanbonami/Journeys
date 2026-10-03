import { z } from "zod";
import { EventType } from "./events";

export const Duration = z
  .object({
    seconds: z.number().int().nonnegative().optional(),
    minutes: z.number().int().nonnegative().optional(),
    hours: z.number().int().nonnegative().optional(),
    days: z.number().int().nonnegative().optional(),
  })
  .refine((d) => durationMs(d) > 0, "duration must be > 0");
export type Duration = z.infer<typeof Duration>;

export function durationMs(d: { seconds?: number; minutes?: number; hours?: number; days?: number }): number {
  return (
    (d.seconds ?? 0) * 1000 +
    (d.minutes ?? 0) * 60_000 +
    (d.hours ?? 0) * 3_600_000 +
    (d.days ?? 0) * 86_400_000
  );
}

/** Conditions are deliberately narrow in v1; both are answered from the events table. */
export const Check = z.discriminatedUnion("kind", [
  // "Did this contact <eventType> for a message sent by <nodeId> in this execution?"
  z.object({ kind: z.literal("event_since_node"), eventType: EventType, nodeId: z.string() }),
  // "Has this contact had <eventType> at any point since entering this execution?"
  z.object({ kind: z.literal("event_since_entry"), eventType: EventType }),
]);
export type Check = z.infer<typeof Check>;

const Trigger = z.object({ type: z.literal("trigger"), event: EventType.default("form.submitted"), next: z.string() });
const SendEmail = z.object({
  type: z.literal("send_email"),
  template: z.object({ subject: z.string(), html: z.string(), text: z.string().optional() }),
  next: z.string(),
});
const Wait = z.object({ type: z.literal("wait"), duration: Duration, next: z.string() });
const Condition = z.object({ type: z.literal("condition"), check: Check, yes: z.string(), no: z.string() });
const Exit = z.object({ type: z.literal("exit") });

export const JourneyNode = z.discriminatedUnion("type", [Trigger, SendEmail, Wait, Condition, Exit]);
export type JourneyNode = z.infer<typeof JourneyNode>;

export const JourneyDefinition = z
  .object({
    start: z.string(),
    nodes: z.record(z.string(), JourneyNode),
  })
  .superRefine((def, ctx) => {
    const ids = new Set(Object.keys(def.nodes));
    if (!ids.has(def.start)) ctx.addIssue({ code: "custom", message: `start node "${def.start}" does not exist` });
    if (def.nodes[def.start]?.type !== "trigger")
      ctx.addIssue({ code: "custom", message: "start node must be a trigger" });
    let hasExit = false;
    for (const [id, n] of Object.entries(def.nodes)) {
      const targets =
        n.type === "condition" ? [n.yes, n.no] : n.type === "exit" ? [] : [n.next];
      if (n.type === "exit") hasExit = true;
      for (const t of targets)
        if (!ids.has(t)) ctx.addIssue({ code: "custom", message: `node "${id}" points to missing node "${t}"` });
      if (n.type === "condition" && n.check.kind === "event_since_node") {
        const ref = def.nodes[n.check.nodeId];
        if (!ref) ctx.addIssue({ code: "custom", message: `condition "${id}" references missing node "${n.check.nodeId}"` });
        else if (ref.type !== "send_email")
          ctx.addIssue({ code: "custom", message: `condition "${id}" must reference a send_email node` });
      }
    }
    if (!hasExit) ctx.addIssue({ code: "custom", message: "journey needs at least one exit node" });
  });
export type JourneyDefinition = z.infer<typeof JourneyDefinition>;

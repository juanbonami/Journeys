import { describe, expect, it } from "vitest";
import { JourneyDefinition } from "@journeys/shared";
import { renderTemplate } from "@journeys/engine";

const email = { subject: "s", html: "<p>h</p>" };
const valid = {
  start: "t",
  nodes: {
    t: { type: "trigger", next: "e1" },
    e1: { type: "send_email", template: email, next: "w" },
    w: { type: "wait", duration: { days: 2 }, next: "c" },
    c: { type: "condition", check: { kind: "event_since_node", eventType: "email.clicked", nodeId: "e1" }, yes: "x", no: "x" },
    x: { type: "exit" },
  },
};

describe("JourneyDefinition", () => {
  it("accepts a valid branching journey", () => {
    expect(JourneyDefinition.safeParse(valid).success).toBe(true);
  });
  it("rejects edges to missing nodes", () => {
    const bad = structuredClone(valid) as any;
    bad.nodes.w.next = "nope";
    expect(JourneyDefinition.safeParse(bad).success).toBe(false);
  });
  it("requires an exit node and a trigger start", () => {
    const noExit = structuredClone(valid) as any;
    delete noExit.nodes.x;
    noExit.nodes.c.yes = "e1"; noExit.nodes.c.no = "e1";
    expect(JourneyDefinition.safeParse(noExit).success).toBe(false);
    const badStart = { ...valid, start: "e1" };
    expect(JourneyDefinition.safeParse(badStart).success).toBe(false);
  });
  it("conditions must reference a send_email node", () => {
    const bad = structuredClone(valid) as any;
    bad.nodes.c.check.nodeId = "w";
    expect(JourneyDefinition.safeParse(bad).success).toBe(false);
  });
  it("rejects zero-length waits", () => {
    const bad = structuredClone(valid) as any;
    bad.nodes.w.duration = {};
    expect(JourneyDefinition.safeParse(bad).success).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("escapes HTML but not plain text", () => {
    expect(renderTemplate("Hi {{firstName}}", { firstName: "<b>J</b>" }, true)).toBe("Hi &lt;b&gt;J&lt;/b&gt;");
    expect(renderTemplate("Hi {{firstName}}", { firstName: "J&J" })).toBe("Hi J&J");
  });
});

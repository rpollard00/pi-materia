import { describe, expect, test } from "bun:test";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

describe("FakePiHarness", () => {
  test("captures Pi extension primitives without provider or real session access", async () => {
    const harness = new FakePiHarness(process.cwd());

    harness.pi.registerFlag("example", { description: "example flag", type: "string", default: "ok" });
    harness.pi.on("session_start", (_event, ctx) => {
      ctx.ui.setStatus("fake", "started");
      ctx.ui.setWidget("fake-widget", ["hello"], { placement: "belowEditor" });
      ctx.ui.notify("started", "info");
    });
    harness.pi.appendEntry("state", { active: true });
    harness.pi.sendMessage({ customType: "visible", content: "hello", display: true });
    harness.pi.sendUserMessage("run this");
    harness.pi.setActiveTools(["read", "grep"]);

    await harness.emit("session_start");

    expect(harness.pi.getFlag("example")).toBe("ok");
    expect(harness.sessionManager.getEntries().map((entry) => entry.type)).toEqual(["custom", "custom_message"]);
    expect(harness.userMessages).toHaveLength(1);
    expect(harness.activeTools).toEqual(["read", "grep"]);
    expect(harness.statuses.get("fake")).toBe("started");
    expect(harness.widgets.get("fake-widget")?.content).toEqual(["hello"]);
    expect(harness.notifications[0]).toEqual({ message: "started", type: "info" });
  });

  test("loads pi-materia and runs /materia grid locally", async () => {
    const harness = new FakePiHarness(process.cwd());
    piMateria(harness.pi);

    await harness.runCommand("materia", "grid");

    expect(harness.commands.has("materia")).toBe(true);
    expect(harness.registeredRenderers.has("pi-materia")).toBe(true);
    expect(harness.widgets.get("materia-grid")?.content?.[0]).toContain("Materia Grid");
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.userMessages).toHaveLength(0);
  });
});

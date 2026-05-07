import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

  test("lists and switches /materia loadout without triggering a turn", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-command-"));
    const configFile = path.join(dir, ".pi", "pi-materia.json");
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify({
      activeLoadout: "Full-Auto",
      loadouts: {
        "Full-Auto": {
          entry: "planner",
          nodes: { planner: { type: "agent", materia: "planner" } },
        },
        "Planning-Consult": {
          entry: "planner",
          nodes: { planner: { type: "agent", materia: "interactivePlan" } },
        },
      },
    }), "utf8");
    const harness = new FakePiHarness(dir);
    piMateria(harness.pi);

    await harness.runCommand("materia", "loadout");
    const listed = harness.sentMessages.at(-1)?.message as { content?: string };
    expect(listed.content).toContain("Loadout: Full-Auto");
    expect(listed.content).toContain("Full-Auto*");
    expect(listed.content).toContain("Planning-Consult");
    expect(harness.widgets.get("materia-loadouts")?.content).toBeUndefined();

    await harness.runCommand("materia", "loadout Planning-Consult");
    const switched = harness.sentMessages.at(-1)?.message as { content?: string };
    const raw = JSON.parse(await readFile(configFile, "utf8"));
    expect(raw.activeLoadout).toBe("Planning-Consult");
    expect(switched.content).toContain("Loadout: Planning-Consult");
    expect(switched.content).toContain("Planning-Consult*");
    expect(harness.operationLog).not.toContain("triggerTurn");
    expect(harness.userMessages).toHaveLength(0);
  });

  test("switches bundled default loadout by writing only a project override", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-command-default-"));
    const projectFile = path.join(dir, ".pi", "pi-materia.json");
    const defaultFile = path.resolve("config", "default.json");
    const beforeDefault = await readFile(defaultFile, "utf8");
    const harness = new FakePiHarness(dir);
    piMateria(harness.pi);

    await harness.runCommand("materia", "loadout Planning-Consult");

    const raw = JSON.parse(await readFile(projectFile, "utf8"));
    const switched = harness.sentMessages.at(-1)?.message as { content?: string };
    expect(raw).toEqual({ activeLoadout: "Planning-Consult" });
    expect(await readFile(defaultFile, "utf8")).toBe(beforeDefault);
    expect(switched.content).toContain("Loadout: Planning-Consult");
    expect(switched.content).toContain("Planning-Consult*");
    expect(switched.content).toContain("Full-Auto");
    expect(harness.operationLog).not.toContain("triggerTurn");
  });

  test("reports valid options for an unknown /materia loadout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-command-"));
    const configFile = path.join(dir, ".pi", "pi-materia.json");
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify({
      activeLoadout: "Full-Auto",
      loadouts: {
        "Full-Auto": {
          entry: "planner",
          nodes: { planner: { type: "agent", materia: "planner" } },
        },
        "Planning-Consult": {
          entry: "planner",
          nodes: { planner: { type: "agent", materia: "interactivePlan" } },
        },
      },
    }), "utf8");
    const before = await readFile(configFile, "utf8");
    const harness = new FakePiHarness(dir);
    piMateria(harness.pi);

    await harness.runCommand("materia", "loadout Missing");

    expect(harness.notifications.at(-1)?.type).toBe("error");
    expect(harness.notifications.at(-1)?.message).toContain('Unknown Materia loadout "Missing". Available loadouts: Full-Auto, Planning-Consult');
    expect(await readFile(configFile, "utf8")).toBe(before);
    expect(harness.operationLog).not.toContain("triggerTurn");
  });

  test("starts and reuses /materia ui session-scoped background server", async () => {
    const harness = new FakePiHarness(process.cwd());
    piMateria(harness.pi);

    harness.idle = false;
    await harness.runCommand("materia", "ui");
    const first = harness.sentMessages.at(-1)?.message as { content?: string; details?: { url?: string; sessionKey?: string } };
    const firstUrl = first.details?.url;
    expect(firstUrl).toStartWith("http://127.0.0.1:");
    expect(first.content).toContain("WebUI started: http://127.0.0.1:");
    expect(first.content).not.toContain("scope: this Pi session only");
    expect(harness.operationLog).not.toContain("triggerTurn");
    expect(harness.operationLog).not.toContain("waitForIdle");
    expect(harness.waitForIdleCalls).toBe(0);

    const response = await fetch(`${firstUrl?.replace(/\/$/, "")?.replace(/\?.*$/, "")}/api/session`);
    const session = await response.json() as { scope?: string; sessionKey?: string };
    expect(session.scope).toBe("session");
    expect(session.sessionKey).toBe(first.details?.sessionKey);

    await harness.runCommand("materia", "ui");
    const second = harness.sentMessages.at(-1)?.message as { content?: string; details?: { url?: string; sessionKey?: string } };
    expect(second.details?.url).toBe(firstUrl);
    expect(second.content).toContain("WebUI ready: http://127.0.0.1:");
    expect(harness.waitForIdleCalls).toBe(0);

    await harness.emit("session_shutdown");
  });

  test("loads pi-materia and runs /materia grid locally", async () => {
    const harness = new FakePiHarness(process.cwd());
    piMateria(harness.pi);

    await harness.runCommand("materia", "grid");

    expect(harness.commands.has("materia")).toBe(true);
    expect(harness.registeredRenderers.has("pi-materia")).toBe(true);
    expect(harness.widgets.get("materia-grid")?.content).toBeUndefined();
    const gridMessage = harness.sentMessages.at(-1)?.message as { content?: string };
    expect(gridMessage.content).toContain("Materia Grid");
    expect(harness.userMessages).toHaveLength(0);
  });

  test("/materia grid clears stale persistent grid widgets instead of adding below-editor noise", async () => {
    const harness = new FakePiHarness(process.cwd());
    piMateria(harness.pi);
    harness.widgets.set("materia-grid", { content: ["old", "noisy", "persistent", "grid", "widget"], options: { placement: "belowEditor" } });

    await harness.runCommand("materia", "grid");

    expect(harness.widgets.get("materia-grid")?.content).toBeUndefined();
    const gridMessage = harness.sentMessages.at(-1)?.message as { content?: string };
    expect(gridMessage.content).toContain("Materia Grid");
  });
});

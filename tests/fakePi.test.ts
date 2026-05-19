import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

function autocastConfig() {
  return {
    activeLoadout: "ReviewOnly",
    materia: {
      Build: { prompt: "Build the requested change.", tools: "coding" },
      Maintain: { prompt: "Maintain the requested change.", tools: "coding" },
      Review: { prompt: "Review the prior output.", tools: "coding" },
    },
    loadouts: {
      ReviewOnly: {
        entry: "Socket-1",
        sockets: { "Socket-1": { materia: "Review" } },
      },
      "Command-Auto": {
        entry: "Socket-2",
        sockets: { "Socket-2": { materia: "Build" } },
      },
    },
  };
}

async function makeAutocastHarness(config: unknown = autocastConfig()): Promise<{ harness: FakePiHarness; configFile: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-autocast-command-"));
  const configFile = path.join(dir, ".pi", "pi-materia.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify(config), "utf8");
  const harness = new FakePiHarness(dir);
  piMateria(harness.pi);
  return { harness, configFile };
}

async function waitForNotification(harness: FakePiHarness, predicate: (message: string) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (harness.notifications.some((notification) => predicate(notification.message))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
          entry: "Socket-1",
          sockets: { "Socket-1": { materia: "planner" } },
        },
        "Planning-Consult": {
          entry: "Socket-1",
          sockets: { "Socket-1": { materia: "interactivePlan" } },
        },
      },
    }), "utf8");
    const harness = new FakePiHarness(dir);
    piMateria(harness.pi);

    await harness.runCommand("materia", "loadout");
    const listed = harness.sentMessages.at(-1)?.message as { content?: string };
    expect(listed.content).toContain("⌘ Full-Auto");
    expect(listed.content).toContain("Full-Auto*");
    expect(listed.content).toContain("Planning-Consult");
    expect(listed.content).not.toContain("Loadout:");
    expect(listed.content).not.toContain("Available:");
    expect(harness.widgets.get("materia-loadouts")?.content).toBeUndefined();

    await harness.runCommand("materia", "loadout Planning-Consult");
    const switched = harness.sentMessages.at(-1)?.message as { content?: string };
    const raw = JSON.parse(await readFile(configFile, "utf8"));
    expect(raw.activeLoadout).toBe("Planning-Consult");
    expect(switched.content).toContain("⌘ Planning-Consult");
    expect(switched.content).toContain("Planning-Consult*");
    expect(switched.content).not.toContain("Loadout:");
    expect(switched.content).not.toContain("Available:");
    const switchedDetails = (harness.sentMessages.at(-1)?.message as { details?: Record<string, unknown> }).details;
    expect(switchedDetails).toMatchObject({
      eventType: "loadout",
      source: "command",
      name: "Planning-Consult",
      loadoutEvent: {
        eventType: "active-loadout-changed",
        source: "command",
        activeLoadout: "Planning-Consult",
      },
    });
    expect((switchedDetails?.loadoutEvent as { loadouts?: string[] } | undefined)?.loadouts).toEqual(expect.arrayContaining(["Full-Auto", "Planning-Consult"]));
    expect(harness.appendedEntries.at(-1)).toMatchObject({
      customType: "pi-materia-active-loadout-changed",
      data: {
        eventType: "active-loadout-changed",
        source: "command",
        activeLoadout: "Planning-Consult",
      },
    });
    expect((harness.appendedEntries.at(-1)?.data as { loadouts?: string[] } | undefined)?.loadouts).toEqual(expect.arrayContaining(["Full-Auto", "Planning-Consult"]));
    expect(harness.widgets.get("materia-loadouts")?.content?.join("\n")).toContain("Planning-Consult*");
    expect(harness.widgets.get("materia")?.content?.[0]).toContain("⌘ Planning-Co");
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
    expect(raw).toMatchObject({ activeLoadout: "Planning-Consult", activeLoadoutId: "default:planning-consult" });
    expect(raw.piMateria).toBeUndefined();
    expect(await readFile(defaultFile, "utf8")).toBe(beforeDefault);
    expect(switched.content).toContain("⌘ Planning-Consult");
    expect(switched.content).toContain("Planning-Consult*");
    expect(switched.content).toContain("Full-Auto");
    expect(switched.content).not.toContain("Loadout:");
    expect(switched.content).not.toContain("Available:");
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
          entry: "Socket-1",
          sockets: { "Socket-1": { materia: "planner" } },
        },
        "Planning-Consult": {
          entry: "Socket-1",
          sockets: { "Socket-1": { materia: "interactivePlan" } },
        },
      },
    }), "utf8");
    const harness = new FakePiHarness(dir);
    piMateria(harness.pi);

    await harness.runCommand("materia", "loadout Missing");

    expect(harness.notifications.at(-1)?.type).toBe("error");
    expect(harness.notifications.at(-1)?.message).toContain('Unknown Materia loadout "Missing". Available loadouts: Full-Auto, Planning-Consult');
    const after = JSON.parse(await readFile(configFile, "utf8"));
    expect(after.activeLoadout).toBe("Full-Auto");
    expect(after.piMateria).toBeUndefined();
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

  test("starts /materia link through the registered command using a virtual loadout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-link-command-"));
    const configFile = path.join(dir, ".pi", "pi-materia.json");
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify({
      activeLoadout: "ReviewOnly",
      materia: {
        Build: { prompt: "Build the requested change.", tools: "coding" },
        Review: { prompt: "Review the prior output.", tools: "coding" },
      },
      loadouts: {
        ReviewOnly: {
          entry: "Socket-1",
          sockets: { "Socket-1": { materia: "Review" } },
        },
      },
    }), "utf8");
    const harness = new FakePiHarness(dir);
    piMateria(harness.pi);

    expect(harness.commands.get("materia")?.description).toContain("link");
    await harness.runCommand("materia", "link materia:Build loadout:ReviewOnly -- implement chained build");

    expect(harness.operationLog).toContain("triggerTurn");
    expect(harness.sessionName).toContain("materia: implement chained build");
    expect(harness.notifications.some((entry) => entry.message.includes("pi-materia linked virtual loadout"))).toBe(true);
    const stateEntry = harness.appendedEntries.findLast((entry) => entry.customType === "pi-materia-cast-state")?.data as { data?: Record<string, unknown>; request?: string; pipeline?: { entry?: { id?: string } } } | undefined;
    expect(stateEntry?.request).toBe("implement chained build");
    expect(stateEntry?.data?.link).toMatchObject({ plan: { invocation: { command: "/materia link" }, targets: [{ kind: "materia", id: "Build" }, { kind: "loadout", id: "ReviewOnly" }] }, virtualLoadout: { name: "Linked virtual loadout: Build → ReviewOnly" } });
    expect(stateEntry?.pipeline?.entry?.id).toBe("Socket-1");
    expect(JSON.parse(await readFile(configFile, "utf8")).activeLoadout).toBe("ReviewOnly");
  });

  test("registers /materia autocast and starts a temporary named loadout cast", async () => {
    const { harness, configFile } = await makeAutocastHarness();

    expect(harness.commands.get("materia")?.description).toContain("autocast");
    expect(harness.getCommandCompletions("materia", "auto")?.map((completion) => completion.value)).toContain("autocast");
    await harness.runCommand("materia", "autocast Command-Auto implement temporary build");

    expect(harness.waitForIdleCalls).toBe(0);
    await waitForNotification(harness, (message) => message.includes("Materia WebUI"));
    expect(harness.notifications.some((entry) => entry.message.includes("Materia WebUI") && !entry.message.includes("failed"))).toBe(true);
    expect(harness.widgets.get("materia-webui")?.content?.join("\n")).toContain("WebUI");
    expect(harness.operationLog).toContain("triggerTurn");
    expect(harness.sessionName).toContain("materia: implement temporary build");
    expect(harness.notifications.some((entry) => entry.message.includes("pi-materia autocast temporary loadout: Command-Auto"))).toBe(true);
    expect(harness.notifications.some((entry) => entry.message.includes("active loadout set"))).toBe(false);
    const stateEntry = harness.appendedEntries.findLast((entry) => entry.customType === "pi-materia-cast-state")?.data as { data?: Record<string, unknown>; request?: string; pipeline?: { entry?: { id?: string } } } | undefined;
    expect(stateEntry?.request).toBe("implement temporary build");
    expect(stateEntry?.pipeline?.entry?.id).toBe("Socket-2");
    expect(stateEntry?.data?.autocast).toMatchObject({ mode: "loadout", requestedTarget: "Command-Auto", activeLoadoutChanged: false, effectiveLoadout: { name: "Command-Auto" } });
    expect(stateEntry?.data?.link).toBeUndefined();
    expect(JSON.parse(await readFile(configFile, "utf8")).activeLoadout).toBe("ReviewOnly");
    expect(harness.appendedEntries.some((entry) => entry.customType === "pi-materia-active-loadout-changed")).toBe(false);
  });

  test("starts /materia autocast with a single-materia virtual loadout", async () => {
    const { harness, configFile } = await makeAutocastHarness();

    await harness.runCommand("materia", "autocast materia:Maintain fix drift");

    expect(harness.waitForIdleCalls).toBe(0);
    expect(harness.operationLog).toContain("triggerTurn");
    expect(harness.notifications.some((entry) => entry.message.includes("pi-materia autocast virtual materia loadout: Maintain"))).toBe(true);
    const stateEntry = harness.appendedEntries.findLast((entry) => entry.customType === "pi-materia-cast-state")?.data as { data?: Record<string, unknown>; request?: string; pipeline?: { entry?: { id?: string } } } | undefined;
    expect(stateEntry?.request).toBe("fix drift");
    expect(stateEntry?.data?.autocast).toMatchObject({
      mode: "materia",
      requestedTarget: "materia:Maintain",
      activeLoadoutChanged: false,
      resolvedMateria: { id: "Maintain" },
      virtualLoadout: {
        name: "Autocast virtual loadout: Maintain",
        targets: [{ kind: "materia", id: "Maintain" }],
        remappings: [{ targetOrder: 0, fromSocketId: "Socket-1", toSocketId: "Socket-1" }],
        stitching: [],
      },
    });
    expect(stateEntry?.data?.link).toBeUndefined();
    expect(JSON.parse(await readFile(configFile, "utf8")).activeLoadout).toBe("ReviewOnly");
  });

  test("reports /materia autocast usage and validation errors without starting", async () => {
    const cases = [
      { command: "autocast", message: "Usage: /materia autocast <loadout|materia:name> <prompt>" },
      { command: "autocast Command-Auto", message: "Usage: /materia autocast <loadout|materia:name> <prompt>" },
      { command: "autocast Missing do it", message: "Unknown Materia loadout" },
      { command: "autocast materia:Missing do it", message: "Unknown Materia" },
    ];

    for (const { command, message } of cases) {
      const { harness, configFile } = await makeAutocastHarness();
      await harness.runCommand("materia", command);
      expect(harness.notifications.at(-1)?.type).toBe("error");
      expect(harness.notifications.at(-1)?.message).toContain(message);
      expect(harness.operationLog).not.toContain("triggerTurn");
      expect(harness.appendedEntries.find((entry) => entry.customType === "pi-materia-cast-state")).toBeUndefined();
      expect(JSON.parse(await readFile(configFile, "utf8")).activeLoadout).toBe("ReviewOnly");
    }
  });

  test("reports /materia autocast active-cast conflicts without switching loadouts", async () => {
    const { harness, configFile } = await makeAutocastHarness({
      ...autocastConfig(),
      activeLoadout: "Command-Auto",
    });

    await harness.runCommand("materia", "cast start an active build");
    const startsBefore = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").length;
    await harness.runCommand("materia", "autocast ReviewOnly try while active");

    expect(harness.notifications.at(-1)?.type).toBe("error");
    expect(harness.notifications.at(-1)?.message).toContain("already active");
    expect(harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state")).toHaveLength(startsBefore);
    expect(JSON.parse(await readFile(configFile, "utf8")).activeLoadout).toBe("Command-Auto");
    expect(harness.appendedEntries.some((entry) => entry.customType === "pi-materia-active-loadout-changed")).toBe(false);
  });

  test("reports /materia link validation errors without starting a partial cast", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-link-invalid-command-"));
    const configFile = path.join(dir, ".pi", "pi-materia.json");
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify({
      activeLoadout: "Default",
      materia: { Build: { prompt: "Build." } },
      loadouts: { Default: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } } },
    }), "utf8");
    const harness = new FakePiHarness(dir);
    piMateria(harness.pi);

    await harness.runCommand("materia", "link Build without delimiter");

    expect(harness.notifications.at(-1)?.type).toBe("error");
    expect(harness.notifications.at(-1)?.message).toContain("missing prompt delimiter");
    expect(harness.operationLog).not.toContain("triggerTurn");
    expect(harness.appendedEntries.find((entry) => entry.customType === "pi-materia-cast-state")).toBeUndefined();
    const rawConfig = JSON.parse(await readFile(configFile, "utf8"));
    expect(rawConfig).toMatchObject({ activeLoadout: "Default" });
    expect(rawConfig.piMateria).toBeUndefined();
  });

  test("loads pi-materia and runs /materia grid locally", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-grid-command-"));
    const harness = new FakePiHarness(dir);
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
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-grid-command-"));
    const harness = new FakePiHarness(dir);
    piMateria(harness.pi);
    harness.widgets.set("materia-grid", { content: ["old", "noisy", "persistent", "grid", "widget"], options: { placement: "belowEditor" } });

    await harness.runCommand("materia", "grid");

    expect(harness.widgets.get("materia-grid")?.content).toBeUndefined();
    const firstGridMessage = harness.sentMessages.at(-1)?.message as { content?: string };
    expect(firstGridMessage.content).toContain("Materia Grid");

    harness.widgets.set("materia-grid", { content: ["stale", "persistent", "grid"], options: { placement: "belowEditor" } });
    await harness.runCommand("materia", "grid");

    expect(harness.widgets.get("materia-grid")?.content).toBeUndefined();
    const secondGridMessage = harness.sentMessages.at(-1)?.message as { content?: string };
    expect(secondGridMessage.content).toContain("Materia Grid");
    expect(harness.sentMessages).toHaveLength(2);
  });
});

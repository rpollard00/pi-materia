import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { reactivateQueuedNativeCast, loadCastStateById } from "../src/castRuntime.js";
import { FakePiHarness } from "./fakePi.js";

function agentConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: { "Socket-1": { materia: "Build" } },
      },
    },
    materia: {
      Build: { type: "agent", tools: "readOnly", prompt: "Build it" },
    },
  };
}

function utilityConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: { "Socket-1": { materia: "Echo" } },
      },
    },
    materia: {
      Echo: { type: "utility", utility: "echo", params: { text: "done" } },
    },
  };
}

function baseCastState(harness: FakePiHarness, castId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const runDir = path.join(harness.cwd, ".pi", "pi-materia", castId);
  return {
    version: 2,
    active: false,
    castId,
    request: "test request",
    configSource: ".pi/pi-materia.json",
    configHash: "test",
    cwd: harness.cwd,
    runDir,
    artifactRoot: path.join(harness.cwd, ".pi/pi-materia"),
    phase: "failed",
    socketState: "failed",
    awaitingResponse: false,
    failedReason: "test failure",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    data: {},
    cursors: {},
    visits: {},
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: {
      runId: castId,
      startedAt: Date.now(),
      budgetWarned: false,
      runDir,
      eventsFile: path.join(runDir, "events.jsonl"),
      usageFile: path.join(runDir, "usage.json"),
      usage: {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        byMateria: {},
        bySocket: {},
        byTask: {},
        byAttempt: {},
      },
      currentSocketId: "Socket-1",
      currentMateria: "Build",
      lastMessage: "Initial cast state",
    },
    currentItemKey: "item-key-1",
    currentItemLabel: "Item Label 1",
    pipeline: {
      entry: { id: "Socket-1", socket: { materia: "Build" }, materia: { type: "agent", tools: "readOnly", prompt: "Build it" } },
      sockets: {
        "Socket-1": { id: "Socket-1", socket: { materia: "Build" }, materia: { type: "agent", tools: "readOnly", prompt: "Build it" } },
      },
    },
    ...extra,
  };
}

async function makeAgentHarness(): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-reactivate-"));
  await mkdir(path.join(cwd, ".pi", "pi-materia"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(agentConfig(), null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

async function makeUtilityHarness(): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-reactivate-util-"));
  await mkdir(path.join(cwd, ".pi", "pi-materia"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(utilityConfig(), null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

async function setupCastRunDir(harness: FakePiHarness, castId: string, config: unknown): Promise<void> {
  const runDir = path.join(harness.cwd, ".pi", "pi-materia", castId);
  await mkdir(path.join(runDir, "sockets"), { recursive: true });
  await mkdir(path.join(runDir, "contexts"), { recursive: true });
  await writeFile(path.join(runDir, "config.resolved.json"), JSON.stringify(config, null, 2));
  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ castId, entries: [] }, null, 2));
}

async function seedCastState(harness: FakePiHarness, castId: string, dataExtra: Record<string, unknown> = {}): Promise<void> {
  const state = baseCastState(harness, castId, {
    data: {
      quest: { questId: "quest-queued-1", title: "Queued quest" },
      questQueuedResurrection: { questId: "quest-queued-1", resumeCastId: castId },
      ...dataExtra,
    },
  });
  harness.pi.appendEntry("pi-materia-cast-state", state);
}

describe("reactivateQueuedNativeCast", () => {
  test("emits cast_queued_resume event, preserves current-work, clears resurrection marker, activates awaiting_agent_response, and dispatches no prompt", async () => {
    const harness = await makeAgentHarness();
    const castId = "cast-queued-1";
    await setupCastRunDir(harness, castId, agentConfig());
    await seedCastState(harness, castId);

    // Record current-work values before reactivation.
    const loadedBefore = loadCastStateById(harness.ctx, castId);
    expect(loadedBefore).toBeDefined();
    const beforeSocketId = loadedBefore!.runState.currentSocketId;
    const beforeMateria = loadedBefore!.runState.currentMateria;
    const beforeItemKey = loadedBefore!.currentItemKey;
    const beforeItemLabel = loadedBefore!.currentItemLabel;

    // Count triggerTurn sends before.
    const triggerTurnsBefore = harness.sentMessages.filter(
      (m) => (m.options as { triggerTurn?: boolean } | undefined)?.triggerTurn === true,
    ).length;

    // Call the native function.
    const result = await reactivateQueuedNativeCast(harness.pi, harness.ctx, castId);

    // --- Assertions ---

    // Load state after reactivation.
    const loadedAfter = loadCastStateById(harness.ctx, castId);
    expect(loadedAfter).toBeDefined();

    // (1) cast_queued_resume event appended to events file.
    const eventsContent = await readFile(path.join(harness.cwd, ".pi", "pi-materia", castId, "events.jsonl"), "utf8");
    const events = eventsContent.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const resumeEvent = events.find((e: any) => e.type === "cast_queued_resume");
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent!.data).toMatchObject({
      castId,
      socket: "Socket-1",
      materia: "Build",
      itemKey: beforeItemKey,
      itemLabel: beforeItemLabel,
    });

    // (2) Current-work preserved (socket, materia, item key/label unchanged).
    expect(loadedAfter!.runState.currentSocketId).toBe(beforeSocketId);
    expect(loadedAfter!.runState.currentMateria).toBe(beforeMateria);
    expect(loadedAfter!.currentItemKey).toBe(beforeItemKey);
    expect(loadedAfter!.currentItemLabel).toBe(beforeItemLabel);

    // (3) questQueuedResurrection cleared from state.data.
    expect((loadedAfter!.data as any)?.questQueuedResurrection).toBeUndefined();

    // (4) State is now active, awaiting_agent_response, with failedReason/endedAt cleared.
    expect(loadedAfter!.active).toBe(true);
    expect(loadedAfter!.awaitingResponse).toBe(true);
    expect(loadedAfter!.socketState).toBe("awaiting_agent_response");
    expect(loadedAfter!.failedReason).toBeUndefined();
    expect(loadedAfter!.runState.endedAt).toBeUndefined();

    // (5) No prompt dispatched (no new triggerTurn sends beyond what was there before).
    const triggerTurnsAfter = harness.sentMessages.filter(
      (m) => (m.options as { triggerTurn?: boolean } | undefined)?.triggerTurn === true,
    ).length;
    expect(triggerTurnsAfter).toBe(triggerTurnsBefore);
    // Also verify no sendMateriaTurn or startSocket was called for the reactivation.
    // (The operationLog will have entries for setActiveTools but not for triggerTurn.)
    expect(harness.operationLog.filter((op) => op === "triggerTurn").length).toBe(triggerTurnsBefore);

    // (6) Tool scope updated (setActiveTools called) for agent socket.
    expect(harness.operationLog.filter((op) => op === "setActiveTools").length).toBeGreaterThan(0);

    // (7) Return value reflects the updated state.
    expect(result.active).toBe(true);
    expect(result.castId).toBe(castId);

    // (8) User notification about reactivation.
    expect(harness.notifications.some((n) => n.message.includes("reactivated from queued resumption"))).toBe(true);

    // (9) UI status set.
    expect(harness.statuses.get("materia")).toBeDefined();

    // (10) Socket materia/item state is preserved as well
    // (the socket in the pipeline is not modified by reactivation).
    const socketEntry = loadedAfter!.pipeline?.sockets?.["Socket-1"];
    expect(socketEntry).toBeDefined();
    expect(socketEntry!.id).toBe("Socket-1");
    expect(socketEntry!.materia).toBeDefined();
  });

  test("reactivates a utility socket cast without tool scope update or prompt", async () => {
    const harness = await makeUtilityHarness();
    const castId = "cast-queued-util";
    await setupCastRunDir(harness, castId, utilityConfig());
    await seedCastState(harness, castId);

    // For utility socket, override the pipeline to have a utility socket.
    // Re-seed with utility pipeline.
    const utilState = baseCastState(harness, castId, {
      data: {
        quest: { questId: "quest-queued-util", title: "Queued utility" },
        questQueuedResurrection: { questId: "quest-queued-util", resumeCastId: castId },
      },
      runState: {
        runId: castId,
        startedAt: Date.now(),
        budgetWarned: false,
        runDir: path.join(harness.cwd, ".pi", "pi-materia", castId),
        eventsFile: path.join(harness.cwd, ".pi", "pi-materia", castId, "events.jsonl"),
        usageFile: path.join(harness.cwd, ".pi", "pi-materia", castId, "usage.json"),
        usage: {
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          byMateria: {},
          bySocket: {},
          byTask: {},
          byAttempt: {},
        },
        currentSocketId: "Socket-1",
        currentMateria: "Echo",
        lastMessage: "Initial utility cast state",
      },
      pipeline: {
        entry: { id: "Socket-1", socket: { materia: "Echo" }, materiaId: "Echo", materia: { type: "utility", utility: "echo", params: { text: "done" } } },
        sockets: {
          "Socket-1": { id: "Socket-1", socket: { materia: "Echo" }, materiaId: "Echo", materia: { type: "utility", utility: "echo", params: { text: "done" } } },
        },
      },
      currentMateria: "Echo",
    });
    // Overwrite the seeded state with the utility version.
    harness.pi.appendEntry("pi-materia-cast-state", utilState);

    const loadedBefore = loadCastStateById(harness.ctx, castId);
    expect(loadedBefore).toBeDefined();
    const beforeSocketId = loadedBefore!.runState.currentSocketId;
    const beforeMateria = loadedBefore!.runState.currentMateria;
    const beforeItemKey = loadedBefore!.currentItemKey;
    const beforeItemLabel = loadedBefore!.currentItemLabel;

    const setActiveToolsBefore = harness.operationLog.filter((op) => op === "setActiveTools").length;

    const result = await reactivateQueuedNativeCast(harness.pi, harness.ctx, castId);

    const loadedAfter = loadCastStateById(harness.ctx, castId);
    expect(loadedAfter).toBeDefined();

    // (1) cast_queued_resume event.
    const eventsContent = await readFile(path.join(harness.cwd, ".pi", "pi-materia", castId, "events.jsonl"), "utf8");
    const events = eventsContent.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    expect(events.some((e: any) => e.type === "cast_queued_resume")).toBe(true);

    // (2) Current-work preserved.
    expect(loadedAfter!.runState.currentSocketId).toBe(beforeSocketId);
    expect(loadedAfter!.runState.currentMateria).toBe(beforeMateria);
    expect(loadedAfter!.currentItemKey).toBe(beforeItemKey);
    expect(loadedAfter!.currentItemLabel).toBe(beforeItemLabel);

    // (3) questQueuedResurrection cleared.
    expect((loadedAfter!.data as any)?.questQueuedResurrection).toBeUndefined();

    // (4) active=true. For utility socket awaitingResponse is false
    // (utility sockets don't await agent input) and socketState is "running_utility".
    expect(loadedAfter!.active).toBe(true);
    expect(loadedAfter!.awaitingResponse).toBe(false);
    // Utility socket: isAgentResolvedSocket returns false, so setCurrentSocketState calls with "running_utility"
    expect(loadedAfter!.socketState).toBe("running_utility");
    expect(loadedAfter!.failedReason).toBeUndefined();
    expect(loadedAfter!.runState.endedAt).toBeUndefined();

    // (5) No new triggerTurn sends.
    const triggerTurnsAfter = harness.sentMessages.filter(
      (m) => (m.options as { triggerTurn?: boolean } | undefined)?.triggerTurn === true,
    ).length;
    expect(triggerTurnsAfter).toBe(0);

    // (6) Tool scope NOT updated for utility socket (isAgentResolvedSocket returns false).
    expect(harness.operationLog.filter((op) => op === "setActiveTools").length).toBe(setActiveToolsBefore);

    // (7) Notification.
    expect(harness.notifications.some((n) => n.message.includes("reactivated from queued resumption"))).toBe(true);
  });

  test("throws for unknown cast id", async () => {
    const harness = await makeAgentHarness();
    await expect(
      reactivateQueuedNativeCast(harness.pi, harness.ctx, "non-existent-cast"),
    ).rejects.toThrow("Unknown pi-materia cast id");
  });
});

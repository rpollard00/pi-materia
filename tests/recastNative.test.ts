import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import type { MateriaCastState } from "../src/types.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(options: { nodeId?: string; materia?: string } = {}): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-recast-"));
  const nodeId = options.nodeId ?? "Socket-1";
  const materia = options.materia ?? "Build";
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: nodeId,
        nodes: {
          [nodeId]: { type: "agent", materia },
        },
      },
    },
    materia: { [materia]: { tools: "coding", prompt: `${materia} materia` } },
  }, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function latestState(harness: FakePiHarness): MateriaCastState {
  const entry = harness.appendedEntries.filter((item) => item.customType === "pi-materia-cast-state").at(-1);
  if (!entry?.data) throw new Error("No materia cast state was appended");
  return entry.data as MateriaCastState;
}

function cloneState(state: MateriaCastState, overrides: Partial<MateriaCastState>): MateriaCastState {
  return { ...(structuredClone(state) as MateriaCastState), ...overrides, updatedAt: Date.now() };
}

function makeRevivableState(state: MateriaCastState, options: { key?: string; originalMaxAttempts?: number; effectiveMaxAttempts?: number; reviveCount?: number; extraAllowances?: MateriaCastState["recoveryAllowances"] } = {}): MateriaCastState {
  const key = options.key ?? JSON.stringify(["normal", state.currentNode ?? state.phase, "__singleton__", state.currentNode ? state.visits[state.currentNode] ?? 0 : 0, 0]);
  const originalMaxAttempts = options.originalMaxAttempts ?? 1;
  const effectiveMaxAttempts = options.effectiveMaxAttempts ?? originalMaxAttempts;
  const reviveCount = options.reviveCount ?? 0;
  return cloneState(state, {
    recoveryAllowances: { ...options.extraAllowances, [key]: { originalMaxAttempts, effectiveMaxAttempts, reviveCount } },
    recoveryExhaustion: {
      kind: "same_node_recovery_exhausted",
      reason: "context_window",
      key,
      attempts: effectiveMaxAttempts,
      originalMaxAttempts,
      effectiveMaxAttempts,
      reviveCount,
      failedReason: state.failedReason ?? "provider outage",
      node: state.currentNode,
      mode: "normal",
      exhaustedAt: Date.now(),
    },
  });
}

async function readEvents(state: MateriaCastState): Promise<Array<{ type?: string; data?: Record<string, unknown> }>> {
  return (await readFile(path.join(state.runDir, "events.jsonl"), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; data?: Record<string, unknown> });
}

async function readEventTypes(state: MateriaCastState): Promise<string[]> {
  return (await readEvents(state)).map((event) => event.type ?? "");
}

async function failCurrentCast(harness: FakePiHarness, message = "provider outage"): Promise<MateriaCastState> {
  harness.appendAssistantMessage("", { stopReason: "error", errorMessage: message });
  await harness.emit("agent_end", { messages: [] });
  return latestState(harness);
}

describe("/materia recast", () => {
  test("native TUI status prefers Materia names over Socket node ids on start, restore, and recast", async () => {
    const harness = await makeHarness({ nodeId: "Socket-4", materia: "Build" });

    await harness.runCommand("materia", "cast useful status labels");
    expect(harness.statuses.get("materia")).toBe("Build");

    await harness.emit("session_start");
    expect(harness.statuses.get("materia")).toBe("Build");

    await failCurrentCast(harness, "retry me");
    expect(harness.statuses.get("materia")).toBe("failed");

    await harness.runCommand("materia", "recast");
    expect(harness.statuses.get("materia")).toBe("Build");
  });

  test("without an explicit id resumes the newest failed or aborted cast", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast first task");
    const failed = await failCurrentCast(harness, "first failure");

    await harness.runCommand("materia", "cast second task");
    const secondRunning = latestState(harness);
    await harness.runCommand("materia", "abort");
    const aborted = latestState(harness);

    expect(aborted.castId).not.toBe(failed.castId);
    await harness.runCommand("materia", "recast");

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(aborted.castId);
    expect(resumed.active).toBe(true);
    expect(resumed.nodeState).toBe("awaiting_agent_response");
    expect(resumed.runState.lastMessage).toBe("Recasting from node Socket-1.");
    expect(secondRunning.castId).toBe(aborted.castId);
  });

  test("explicit id resumes the requested failed cast", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast explicit task");
    const failed = await failCurrentCast(harness);

    await harness.runCommand("materia", `recast ${failed.castId}`);

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(failed.castId);
    expect(resumed.active).toBe(true);
    expect(harness.notifications.at(-1)?.message).toContain(`pi-materia cast ${failed.castId} recast from node "Socket-1".`);
    const eventTypes = await readEventTypes(resumed);
    expect(eventTypes).toContain("cast_recast");
    expect(eventTypes).not.toContain("cast_revive");
  });

  test("explicit id resumes an aborted cast", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast aborted task");
    await harness.runCommand("materia", "abort");
    const aborted = latestState(harness);

    await harness.runCommand("materia", `recast ${aborted.castId}`);

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(aborted.castId);
    expect(resumed.active).toBe(true);
    expect(resumed.runState.lastMessage).toBe("Recasting from node Socket-1.");
  });

  test("recast backfills missing legacy loadout metadata from persisted cast config", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast legacy loadout task");
    const failed = await failCurrentCast(harness);
    const legacy = cloneState(failed, { runState: { ...failed.runState, endedAt: undefined } });
    delete legacy.runState.loadoutName;
    harness.pi.appendEntry("pi-materia-cast-state", legacy);

    await harness.runCommand("materia", `recast ${legacy.castId}`);

    const resumed = latestState(harness);
    expect(resumed.runState.loadoutName).toBe("Test");
    expect(harness.widgets.get("materia")?.content.join("\n")).toContain("⌘ Test");
  });

  test("reports clear errors for complete, running, missing, and non-resumable casts", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast complete task");
    harness.appendAssistantMessage("done");
    await harness.emit("agent_end", { messages: [] });
    const complete = latestState(harness);
    await harness.runCommand("materia", `recast ${complete.castId}`);
    expect(harness.notifications.at(-1)?.message).toContain("is complete and cannot be recast");

    await harness.runCommand("materia", "cast running task");
    const running = latestState(harness);
    await harness.runCommand("materia", `recast ${running.castId}`);
    expect(harness.notifications.at(-1)?.message).toContain("is already running");
    await harness.runCommand("materia", "abort");

    await harness.runCommand("materia", "recast missing-cast-id");
    expect(harness.notifications.at(-1)?.message).toContain('Unknown pi-materia cast id "missing-cast-id"');

    const aborted = latestState(harness);
    const idle = cloneState(aborted, { castId: "idle-cast", active: false, phase: "work", nodeState: "idle", failedReason: undefined });
    harness.pi.appendEntry("pi-materia-cast-state", idle);
    await harness.runCommand("materia", "recast idle-cast");
    expect(harness.notifications.at(-1)?.message).toContain("is not failed or aborted");
  });

  test("without an explicit id reports when no resumable casts exist", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast complete only");
    harness.appendAssistantMessage("done");
    await harness.emit("agent_end", { messages: [] });

    await harness.runCommand("materia", "recast");

    expect(harness.notifications.at(-1)).toEqual({
      message: "No failed or aborted pi-materia casts are available to recast.",
      type: "info",
    });
  });

  test("revive extends an exhausted same-node recovery allowance then follows recast", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast exhausted task");
    const failed = await failCurrentCast(harness, "Same-node recovery exhausted for normal turn");
    const revivable = makeRevivableState(failed);
    const recoveryKey = revivable.recoveryExhaustion!.key;
    harness.pi.appendEntry("pi-materia-cast-state", revivable);

    await harness.runCommand("materia", `revive ${revivable.castId}`);

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(revivable.castId);
    expect(resumed.active).toBe(true);
    expect(resumed.nodeState).toBe("awaiting_agent_response");
    const allowance = resumed.recoveryAllowances?.[recoveryKey];
    expect(allowance).toMatchObject({ originalMaxAttempts: 1, effectiveMaxAttempts: 2, reviveCount: 1 });
    expect(resumed.recoveryExhaustion).toBeUndefined();
    expect(harness.notifications.at(-1)?.message).toContain(`pi-materia cast ${revivable.castId} recast from node "Socket-1".`);

    const events = await readEvents(resumed);
    const eventTypes = events.map((event) => event.type ?? "");
    const reviveIndex = eventTypes.indexOf("cast_revive");
    expect(reviveIndex).toBeGreaterThan(-1);
    expect(eventTypes.indexOf("cast_recast")).toBeGreaterThan(reviveIndex);
    expect(events[reviveIndex]?.data).toMatchObject({
      castId: revivable.castId,
      exhaustedRecoveryKey: recoveryKey,
      priorEffectiveMaxAttempts: 1,
      increment: 1,
      newEffectiveMaxAttempts: 2,
      reviveCount: 1,
      recoveryContext: { key: recoveryKey, node: "Socket-1", mode: "normal" },
    });
    expect(events[reviveIndex]?.data).not.toHaveProperty("satisfied");
    expect(events[reviveIndex]?.data).not.toHaveProperty("feedback");
    expect(events[reviveIndex]?.data).not.toHaveProperty("missing");
  });

  test("repeated revives grow allowance linearly and only for the exhausted recovery context", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast repeated revive task");
    const failed = await failCurrentCast(harness, "Same-node recovery exhausted first time");
    const recoveryKey = JSON.stringify(["normal", failed.currentNode ?? failed.phase, "__singleton__", failed.currentNode ? failed.visits[failed.currentNode] ?? 0 : 0, 0]);
    const otherKey = JSON.stringify(["normal", "Other-Socket", "__singleton__", 1, 0]);
    const revivable = makeRevivableState(failed, {
      key: recoveryKey,
      originalMaxAttempts: 2,
      effectiveMaxAttempts: 2,
      extraAllowances: { [otherKey]: { originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 } },
    });
    harness.pi.appendEntry("pi-materia-cast-state", revivable);

    await harness.runCommand("materia", `revive ${revivable.castId}`);
    const firstResume = latestState(harness);
    expect(firstResume.recoveryAllowances?.[recoveryKey]).toMatchObject({ originalMaxAttempts: 2, effectiveMaxAttempts: 4, reviveCount: 1 });
    expect(firstResume.recoveryAllowances?.[otherKey]).toMatchObject({ originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 });

    const secondFailureReason = "Same-node recovery exhausted second time";
    const exhaustedAgain = makeRevivableState(cloneState(firstResume, {
      active: false,
      awaitingResponse: false,
      phase: "failed",
      nodeState: "failed",
      failedReason: secondFailureReason,
      runState: { ...firstResume.runState, lastMessage: secondFailureReason, endedAt: Date.now() },
    }), {
      key: recoveryKey,
      originalMaxAttempts: 2,
      effectiveMaxAttempts: 4,
      reviveCount: 1,
      extraAllowances: { [otherKey]: { originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 } },
    });
    harness.pi.appendEntry("pi-materia-cast-state", exhaustedAgain);

    await harness.runCommand("materia", `revive ${exhaustedAgain.castId}`);

    const secondResume = latestState(harness);
    expect(secondResume.recoveryAllowances?.[recoveryKey]).toMatchObject({ originalMaxAttempts: 2, effectiveMaxAttempts: 6, reviveCount: 2 });
    expect(secondResume.recoveryAllowances?.[recoveryKey]?.effectiveMaxAttempts).not.toBe(8);
    expect(secondResume.recoveryAllowances?.[otherKey]).toMatchObject({ originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 });
  });

  test("revive rejects active, missing, and legacy non-revivable cast references", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast active task");
    const running = latestState(harness);
    await harness.runCommand("materia", `revive ${running.castId}`);
    expect(harness.notifications.at(-1)?.message).toContain("is already running");
    await harness.runCommand("materia", "abort");

    await harness.runCommand("materia", "revive missing-cast-id");
    expect(harness.notifications.at(-1)?.message).toContain('Unknown pi-materia cast id "missing-cast-id"');

    const aborted = latestState(harness);
    const legacy = cloneState(aborted, {
      castId: "legacy-exhausted-without-allowance",
      active: false,
      phase: "failed",
      nodeState: "failed",
      failedReason: "Same-node recovery exhausted before structured allowances existed",
      recoveryAllowances: undefined,
      recoveryExhaustion: {
        kind: "same_node_recovery_exhausted",
        reason: "context_window",
        key: "legacy-key",
        attempts: 1,
        originalMaxAttempts: 1,
        effectiveMaxAttempts: 1,
        reviveCount: 0,
        failedReason: "Same-node recovery exhausted before structured allowances existed",
        node: aborted.currentNode,
        mode: "normal",
        exhaustedAt: Date.now(),
      },
    });
    harness.pi.appendEntry("pi-materia-cast-state", legacy);
    await harness.runCommand("materia", `revive ${legacy.castId}`);
    expect(harness.notifications.at(-1)?.message).toContain("recovery allowance metadata is missing or invalid");
    expect(harness.notifications.at(-1)?.message).toContain("Use /materia recast");
  });

  test("revive rejects non-exhaustion failures with recast guidance", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast ordinary failure");
    const failed = await failCurrentCast(harness, "ordinary failure");

    await harness.runCommand("materia", `revive ${failed.castId}`);

    const notification = harness.notifications.at(-1);
    expect(notification?.type).toBe("error");
    expect(notification?.message).toContain("not revivable");
    expect(notification?.message).toContain("Use /materia recast");
  });

  test("revive reports when no eligible casts exist and completes only revivable casts", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast ordinary failure");
    await failCurrentCast(harness, "ordinary failure");

    await harness.runCommand("materia", "revive");
    expect(harness.notifications.at(-1)).toEqual({
      message: "No failed pi-materia casts exhausted by same-node recovery are available to revive. Use /materia recast [cast-id] for general failed or aborted casts.",
      type: "info",
    });

    const completions = harness.getCommandCompletions("materia", "revive ") ?? [];
    expect(completions).toEqual([]);
  });

  test("completions include only matching resumable casts newest first", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast older failed request");
    const older = await failCurrentCast(harness, "older failure");

    await harness.runCommand("materia", "cast complete request");
    harness.appendAssistantMessage("done");
    await harness.emit("agent_end", { messages: [] });
    const complete = latestState(harness);

    await harness.runCommand("materia", "cast newer aborted request");
    await harness.runCommand("materia", "abort");
    const newer = latestState(harness);

    const completions = harness.getCommandCompletions("materia", "recast ") ?? [];
    expect(completions.map((item) => item.value)).toEqual([`recast ${newer.castId}`, `recast ${older.castId}`]);
    expect(completions.map((item) => item.value)).not.toContain(`recast ${complete.castId}`);
    expect(completions[0].label).toContain("aborted");
    expect(completions[1].label).toContain("failed");
    expect(completions[0].description).toContain("newer aborted request");

    const prefixCompletions = harness.getCommandCompletions("materia", `recast ${older.castId.slice(0, -1)}`) ?? [];
    expect(prefixCompletions.map((item) => item.value)).toEqual([`recast ${older.castId}`]);
  });
});

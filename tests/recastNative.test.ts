import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import type { MateriaCastState } from "../src/types.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(options: { socketId?: string; materia?: string } = {}): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-recast-"));
  const socketId = options.socketId ?? "Socket-1";
  const materia = options.materia ?? "Build";
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: socketId,
        sockets: {
          [socketId]: { materia },
        },
      },
    },
    materia: { [materia]: { tools: "coding", prompt: `${materia} materia` } },
  }, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

async function makeMultiSocketHarness(): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-recast-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
          "Socket-2": { materia: "Build" },
        },
      },
    },
    materia: { Build: { tools: "coding", prompt: "Build materia" } },
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
  const key = options.key ?? JSON.stringify(["normal", state.currentSocketId ?? state.phase, "__singleton__", state.currentSocketId ? state.visits[state.currentSocketId] ?? 0 : 0, 0]);
  const originalMaxAttempts = options.originalMaxAttempts ?? 1;
  const effectiveMaxAttempts = options.effectiveMaxAttempts ?? originalMaxAttempts;
  const reviveCount = options.reviveCount ?? 0;
  return cloneState(state, {
    recoveryAllowances: { ...options.extraAllowances, [key]: { originalMaxAttempts, effectiveMaxAttempts, reviveCount } },
    recoveryExhaustion: {
      kind: "same_socket_recovery_exhausted",
      reason: "context_window",
      key,
      attempts: effectiveMaxAttempts,
      originalMaxAttempts,
      effectiveMaxAttempts,
      reviveCount,
      failedReason: state.failedReason ?? "provider outage",
      socket: state.currentSocketId,
      mode: "normal",
      exhaustedAt: Date.now(),
    },
  });
}

function makeEdgeTraversalExhaustedState(state: MateriaCastState, options: { from?: string; to?: string; scopedKey?: string; originalLimit?: number; effectiveLimit?: number; reviveCount?: number; count?: number; extraEdgeAllowances?: MateriaCastState["edgeAllowances"] } = {}): MateriaCastState {
  const from = options.from ?? "Socket-1";
  const to = options.to ?? "Socket-2";
  const key = `${from}->${to}`;
  const scopedKey = options.scopedKey ?? key;
  const originalLimit = options.originalLimit ?? 1;
  const effectiveLimit = options.effectiveLimit ?? originalLimit;
  const reviveCount = options.reviveCount ?? 0;
  const count = options.count ?? effectiveLimit + 1;
  const failedReason = `Materia edge traversal limit exceeded for ${from}->${to} (${count}/${effectiveLimit})`;
  return cloneState(state, {
    edgeAllowances: { ...options.extraEdgeAllowances, [scopedKey]: { originalLimit, effectiveLimit, reviveCount } },
    edgeTraversals: { ...state.edgeTraversals, [key]: count },
    recoveryExhaustion: {
      kind: "edge_traversal_exhausted",
      from,
      to,
      key,
      scopedKey,
      count,
      originalLimit,
      effectiveLimit,
      reviveCount,
      failedReason,
      exhaustedAt: Date.now(),
    },
    failedReason,
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
  // Directly create a terminal state that is resumable (recastable).
  // stopReason errors are now provisional inference interruptions, so we
  // construct the failure state manually instead of going through the
  // agent_end flow.
  const running = latestState(harness);
  const failed = cloneState(running, {
    active: false,
    phase: "failed",
    socketState: "failed",
    failedReason: message,
    awaitingResponse: false,
    multiTurnFinalizing: false,
    recoveryExhaustion: undefined,
    runState: { ...running.runState, lastMessage: message, endedAt: Date.now() },
  });
  harness.pi.appendEntry("pi-materia-cast-state", failed);
  harness.ctx.ui.setStatus("materia", "failed");
  return failed;
}

describe("/materia recast", () => {
  test("starts every cast in a persisted base execution scope at the session project cwd", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast scoped task");
    const state = latestState(harness);

    expect(state.baseScope).toEqual({
      id: `cast:${encodeURIComponent(state.castId)}:base`,
      cwd: harness.cwd,
      state: {},
      exports: {},
    });
    expect(state.activeScope).toEqual(state.baseScope);
    expect(state.activeScope).not.toBe(state.baseScope);
  });

  test("native TUI status prefers Materia names over socket ids on start, restore, and recast", async () => {
    const harness = await makeHarness({ socketId: "Socket-4", materia: "Build" });

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
    expect(resumed.socketState).toBe("awaiting_agent_response");
    expect(resumed.runState.lastMessage).toBe("Recasting from socket Socket-1.");
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
    expect(harness.notifications.at(-1)?.message).toContain(`pi-materia cast ${failed.castId} recast from socket "Socket-1".`);
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
    expect(resumed.runState.lastMessage).toBe("Recasting from socket Socket-1.");
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
    const idle = cloneState(aborted, { castId: "idle-cast", active: false, phase: "work", socketState: "idle", failedReason: undefined });
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

    expect(harness.notifications).toContainEqual({
      message: "No failed or aborted pi-materia casts are available to recast.",
      type: "info",
    });
  });

  test("revive extends an exhausted same-socket recovery allowance then follows recast", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast exhausted task");
    const failed = await failCurrentCast(harness, "Same-socket recovery exhausted for normal turn");
    const revivable = makeRevivableState(failed);
    const recoveryKey = revivable.recoveryExhaustion!.key;
    harness.pi.appendEntry("pi-materia-cast-state", revivable);

    await harness.runCommand("materia", `revive ${revivable.castId}`);

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(revivable.castId);
    expect(resumed.active).toBe(true);
    expect(resumed.socketState).toBe("awaiting_agent_response");
    const allowance = resumed.recoveryAllowances?.[recoveryKey];
    expect(allowance).toMatchObject({ originalMaxAttempts: 1, effectiveMaxAttempts: 2, reviveCount: 1 });
    expect(resumed.recoveryExhaustion).toBeUndefined();
    expect(harness.notifications.at(-1)?.message).toContain(`pi-materia cast ${revivable.castId} recast from socket "Socket-1".`);

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
      recoveryContext: { key: recoveryKey, socket: "Socket-1", mode: "normal" },
    });
    expect(events[reviveIndex]?.data).not.toHaveProperty("satisfied");
    expect(events[reviveIndex]?.data).not.toHaveProperty("feedback");
    expect(events[reviveIndex]?.data).not.toHaveProperty("missing");
  });

  test("repeated revives grow allowance linearly and only for the exhausted recovery context", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast repeated revive task");
    const failed = await failCurrentCast(harness, "Same-socket recovery exhausted first time");
    const recoveryKey = JSON.stringify(["normal", failed.currentSocketId ?? failed.phase, "__singleton__", failed.currentSocketId ? failed.visits[failed.currentSocketId] ?? 0 : 0, 0]);
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

    const secondFailureReason = "Same-socket recovery exhausted second time";
    const exhaustedAgain = makeRevivableState(cloneState(firstResume, {
      active: false,
      awaitingResponse: false,
      phase: "failed",
      socketState: "failed",
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
      socketState: "failed",
      failedReason: "Same-socket recovery exhausted before structured allowances existed",
      recoveryAllowances: undefined,
      recoveryExhaustion: {
        kind: "same_socket_recovery_exhausted",
        reason: "context_window",
        key: "legacy-key",
        attempts: 1,
        originalMaxAttempts: 1,
        effectiveMaxAttempts: 1,
        reviveCount: 0,
        failedReason: "Same-socket recovery exhausted before structured allowances existed",
        socket: aborted.currentSocketId,
        mode: "normal",
        exhaustedAt: Date.now(),
      },
    });
    harness.pi.appendEntry("pi-materia-cast-state", legacy);
    await harness.runCommand("materia", `revive ${legacy.castId}`);
    expect(harness.notifications.at(-1)?.message).toContain("recovery allowance metadata is missing or invalid");
    expect(harness.notifications.at(-1)?.message).toContain("Use /materia recast");
  });

  test("revive passively restores ordinary failed casts without dispatching inference", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast ordinary failure");
    const failed = await failCurrentCast(harness, "ordinary failure");

    await harness.runCommand("materia", `revive ${failed.castId}`);

    // Passive revive normalizes state without dispatching inference.
    const revived = latestState(harness);
    expect(revived.castId).toBe(failed.castId);
    expect(revived.active).toBe(true);
    expect(revived.socketState).toBe("awaiting_agent_response");
    expect(revived.failedReason).toBeUndefined();
    expect(revived.runState.endedAt).toBeUndefined();
    // No dispatch — cast is active/awaiting, user nudges or recasts.
    expect(harness.notifications.at(-1)?.message).toContain("revived at socket");
    expect(harness.notifications.at(-1)?.message).toContain("Use /materia recast to resend");
  });

  test("revive activates the latest revivable cast preferring structured exhaustion", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast ordinary failure");
    const ordinary = await failCurrentCast(harness, "ordinary failure");

    // Ordinary failure is now revivable (passive revive).
    // No-id revive picks the latest revivable cast.
    await harness.runCommand("materia", "revive");
    const revivedOrdinary = latestState(harness);
    expect(revivedOrdinary.castId).toBe(ordinary.castId);
    expect(revivedOrdinary.active).toBe(true);

    // The revived cast should appear in completions after being consumed.
    // (It is now active, so listRevivable excludes it.)
    // Create a fresh ordinary failure and an exhausted failure to test ordering.
    await harness.runCommand("materia", "cast fresh ordinary");
    const freshOrdinary = await failCurrentCast(harness, "fresh ordinary");

    await harness.runCommand("materia", "cast exhausted failure");
    const failed = await failCurrentCast(harness, "Same-socket recovery exhausted for normal turn");
    const revivable = makeRevivableState(failed);
    harness.pi.appendEntry("pi-materia-cast-state", revivable);

    const mixedCompletions = harness.getCommandCompletions("materia", "revive ") ?? [];
    // Both exhausted and ordinary failures appear (exhausted is newer)
    expect(mixedCompletions.map((item) => item.value)).toEqual([`revive ${revivable.castId}`, `revive ${freshOrdinary.castId}`]);

    await harness.runCommand("materia", "revive");
    const resumed = latestState(harness);
    // No-id revive picks the latest revivable (exhausted cast is newer)
    expect(resumed.castId).toBe(revivable.castId);
    expect(resumed.active).toBe(true);
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

  // ── Edge-traversal exhaustion revive regression tests ──

  test("revive extends an exhausted edge-traversal allowance and advances to the blocked target", async () => {
    const harness = await makeMultiSocketHarness();

    await harness.runCommand("materia", "cast edge traversal task");
    const failed = await failCurrentCast(harness, "Materia edge traversal limit exceeded for Socket-1->Socket-2");
    const exhausted = makeEdgeTraversalExhaustedState(failed, { from: "Socket-1", to: "Socket-2", originalLimit: 1, effectiveLimit: 1 });
    const edgeKey = exhausted.recoveryExhaustion!.key;
    harness.pi.appendEntry("pi-materia-cast-state", exhausted);

    await harness.runCommand("materia", `revive ${exhausted.castId}`);

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(exhausted.castId);
    expect(resumed.active).toBe(true);
    expect(resumed.recoveryExhaustion).toBeUndefined();
    expect(resumed.failedReason).toBeUndefined();

    const allowance = resumed.edgeAllowances?.[edgeKey];
    expect(allowance).toMatchObject({ originalLimit: 1, effectiveLimit: 2, reviveCount: 1 });

    // Notification verifies revive reached the target socket (startSocket overwrites runState.lastMessage)
    const reviveNotify = harness.notifications.find((n) => n.message.includes("revived to blocked target socket"));
    expect(reviveNotify?.message).toContain(`revived to blocked target socket "Socket-2"`);

    const events = await readEvents(resumed);
    const eventTypes = events.map((event) => event.type ?? "");
    const reviveIndex = eventTypes.indexOf("cast_revive");
    expect(reviveIndex).toBeGreaterThan(-1);
    // Edge-traversal revive does NOT emit a cast_recast event (different path)
    expect(eventTypes).not.toContain("cast_recast");
    expect(events[reviveIndex]?.data).toMatchObject({
      castId: exhausted.castId,
      exhaustedRecoveryKey: edgeKey,
      traversalContext: {
        from: "Socket-1",
        to: "Socket-2",
        key: edgeKey,
      },
      priorEffectiveLimit: 1,
      increment: 1,
      newEffectiveLimit: 2,
      reviveCount: 1,
    });
    expect(events[reviveIndex]?.data).not.toHaveProperty("recoveryContext");
  });

  test("repeated edge-traversal revives grow allowance linearly and leave unrelated edges untouched", async () => {
    const harness = await makeMultiSocketHarness();

    await harness.runCommand("materia", "cast repeated edge traversal task");
    const failed = await failCurrentCast(harness, "Materia edge traversal limit exceeded for Socket-1->Socket-2");
    const edgeKey = "Socket-1->Socket-2";
    const otherKey = "Socket-1->Socket-3";
    const exhausted = makeEdgeTraversalExhaustedState(failed, {
      from: "Socket-1",
      to: "Socket-2",
      originalLimit: 3,
      effectiveLimit: 3,
      extraEdgeAllowances: { [otherKey]: { originalLimit: 2, effectiveLimit: 2, reviveCount: 0 } },
    });
    harness.pi.appendEntry("pi-materia-cast-state", exhausted);

    // First revive
    await harness.runCommand("materia", `revive ${exhausted.castId}`);
    const firstResume = latestState(harness);
    expect(firstResume.edgeAllowances?.[edgeKey]).toMatchObject({ originalLimit: 3, effectiveLimit: 6, reviveCount: 1 });
    expect(firstResume.edgeAllowances?.[otherKey]).toMatchObject({ originalLimit: 2, effectiveLimit: 2, reviveCount: 0 });

    // Set up second exhaustion (with increased effectiveLimit and reviveCount from first revive)
    const secondFailureReason = "Materia edge traversal limit exceeded for Socket-1->Socket-2 (7/6)";
    const exhaustedAgain = makeEdgeTraversalExhaustedState(cloneState(firstResume, {
      active: false,
      awaitingResponse: false,
      phase: "failed",
      socketState: "failed",
      failedReason: secondFailureReason,
      runState: { ...firstResume.runState, lastMessage: secondFailureReason, endedAt: Date.now() },
    }), {
      from: "Socket-1",
      to: "Socket-2",
      originalLimit: 3,
      effectiveLimit: 6,
      reviveCount: 1,
      count: 7,
      extraEdgeAllowances: { [otherKey]: { originalLimit: 2, effectiveLimit: 2, reviveCount: 0 } },
    });
    harness.pi.appendEntry("pi-materia-cast-state", exhaustedAgain);

    // Second revive
    await harness.runCommand("materia", `revive ${exhaustedAgain.castId}`);
    const secondResume = latestState(harness);
    expect(secondResume.edgeAllowances?.[edgeKey]).toMatchObject({ originalLimit: 3, effectiveLimit: 9, reviveCount: 2 });
    expect(secondResume.edgeAllowances?.[edgeKey]?.effectiveLimit).not.toBe(12); // incremental, not multiplicative
    expect(secondResume.edgeAllowances?.[otherKey]).toMatchObject({ originalLimit: 2, effectiveLimit: 2, reviveCount: 0 });
  });

  test("edge-traversal revive extends only the exhausted work item's scoped allowance", async () => {
    const harness = await makeMultiSocketHarness();

    await harness.runCommand("materia", "cast scoped edge traversal revive");
    const failed = await failCurrentCast(harness, "Materia edge traversal limit exceeded for Socket-1->Socket-2 (3/2)");
    const scopedKey = "Socket-1->Socket-2@WI-1";
    const otherItemKey = "Socket-1->Socket-2@WI-2";
    const exhausted = makeEdgeTraversalExhaustedState(failed, {
      from: "Socket-1",
      to: "Socket-2",
      scopedKey,
      originalLimit: 2,
      effectiveLimit: 2,
      count: 3,
      extraEdgeAllowances: { [otherItemKey]: { originalLimit: 2, effectiveLimit: 2, reviveCount: 0 } },
    });
    harness.pi.appendEntry("pi-materia-cast-state", exhausted);

    await harness.runCommand("materia", `revive ${exhausted.castId}`);

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(exhausted.castId);
    expect(resumed.active).toBe(true);
    // Only WI-1's scoped allowance is extended; WI-2 and the aggregate key are untouched.
    expect(resumed.edgeAllowances?.[scopedKey]).toMatchObject({ originalLimit: 2, effectiveLimit: 4, reviveCount: 1 });
    expect(resumed.edgeAllowances?.[otherItemKey]).toMatchObject({ originalLimit: 2, effectiveLimit: 2, reviveCount: 0 });
    expect(resumed.edgeAllowances?.["Socket-1->Socket-2"]).toBeUndefined();

    // The revive event reports the scoped identity that was extended.
    const events = await readEvents(resumed);
    const reviveEvent = events.find((event) => event.type === "cast_revive");
    expect(reviveEvent?.data).toMatchObject({
      exhaustedRecoveryKey: scopedKey,
      traversalContext: { from: "Socket-1", to: "Socket-2", key: scopedKey },
      newEffectiveLimit: 4,
      reviveCount: 1,
    });
  });

  test("legacy persisted edge exhaustion metadata without a scoped key remains revivable", async () => {
    const harness = await makeMultiSocketHarness();

    await harness.runCommand("materia", "cast legacy edge exhaustion revive");
    const failed = await failCurrentCast(harness, "Materia edge traversal limit exceeded for Socket-1->Socket-2 (2/1)");
    const legacy = makeEdgeTraversalExhaustedState(failed, { from: "Socket-1", to: "Socket-2", originalLimit: 1, effectiveLimit: 1, count: 2 });
    // Simulate pre-scoped persisted metadata: no scopedKey and an aggregate-keyed allowance.
    delete (legacy.recoveryExhaustion as { scopedKey?: string }).scopedKey;
    expect(legacy.recoveryExhaustion?.scopedKey).toBeUndefined();
    expect(legacy.edgeAllowances).toHaveProperty("Socket-1->Socket-2");
    harness.pi.appendEntry("pi-materia-cast-state", legacy);

    // The cast remains revivable and the revive extends the legacy aggregate-keyed allowance.
    const completions = harness.getCommandCompletions("materia", "revive ") ?? [];
    expect(completions.some((item) => item.value === `revive ${legacy.castId}`)).toBe(true);

    await harness.runCommand("materia", `revive ${legacy.castId}`);

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(legacy.castId);
    expect(resumed.active).toBe(true);
    expect(resumed.recoveryExhaustion).toBeUndefined();
    expect(resumed.edgeAllowances?.["Socket-1->Socket-2"]).toMatchObject({ originalLimit: 1, effectiveLimit: 2, reviveCount: 1 });
  });

  test("prior scoped-retry exhaustion with aggregate-keyed allowances falls back to the aggregate key", async () => {
    const harness = await makeMultiSocketHarness();

    await harness.runCommand("materia", "cast mixed-version scoped exhaustion revive");
    const failed = await failCurrentCast(harness, "Materia edge traversal limit exceeded for Socket-1->Socket-2 (2/1)");
    const scopedKey = "Socket-1->Socket-2@WI-1";
    const mixed = makeEdgeTraversalExhaustedState(failed, { from: "Socket-1", to: "Socket-2", scopedKey, originalLimit: 1, effectiveLimit: 1, count: 2 });
    // Simulate a prior scoped-retry state persisted before edgeAllowances was
    // scoped: exhaustion carries scopedKey but edgeAllowances has only the
    // aggregate from->to entry.
    mixed.edgeAllowances = { "Socket-1->Socket-2": { originalLimit: 1, effectiveLimit: 1, reviveCount: 0 } };
    expect(mixed.recoveryExhaustion?.scopedKey).toBe(scopedKey);
    expect(mixed.edgeAllowances?.[scopedKey]).toBeUndefined();
    expect(mixed.edgeAllowances?.["Socket-1->Socket-2"]).toBeDefined();
    harness.pi.appendEntry("pi-materia-cast-state", mixed);

    // The cast remains revivable even though the scoped allowance is absent.
    const completions = harness.getCommandCompletions("materia", "revive ") ?? [];
    expect(completions.some((item) => item.value === `revive ${mixed.castId}`)).toBe(true);

    await harness.runCommand("materia", `revive ${mixed.castId}`);

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(mixed.castId);
    expect(resumed.active).toBe(true);
    expect(resumed.recoveryExhaustion).toBeUndefined();
    // The fallback extended the aggregate-keyed allowance that actually exists.
    expect(resumed.edgeAllowances?.["Socket-1->Socket-2"]).toMatchObject({ originalLimit: 1, effectiveLimit: 2, reviveCount: 1 });
  });

  test("no-id revive selects latest eligible edge-traversal exhausted cast", async () => {
    const harness = await makeMultiSocketHarness();

    // Create an ordinary failed cast first
    await harness.runCommand("materia", "cast ordinary failure first");
    const ordinary = await failCurrentCast(harness, "ordinary failure");

    // Create an edge-traversal exhausted cast (newer)
    await harness.runCommand("materia", "cast edge traversal exhausted cast");
    const failed = await failCurrentCast(harness, "Materia edge traversal limit exceeded for Socket-1->Socket-2");
    const exhausted = makeEdgeTraversalExhaustedState(failed, { from: "Socket-1", to: "Socket-2", originalLimit: 1, effectiveLimit: 1 });
    harness.pi.appendEntry("pi-materia-cast-state", exhausted);

    // No-id revive should pick the edge-exhausted cast, not the ordinary one
    await harness.runCommand("materia", "revive");

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(exhausted.castId);
    expect(resumed.active).toBe(true);

    // Ordinary cast should remain untouched
    const ordinaryLatest = harness.appendedEntries
      .filter((entry) => entry.customType === "pi-materia-cast-state" && (entry.data as MateriaCastState | undefined)?.castId === ordinary.castId)
      .at(-1)?.data as MateriaCastState | undefined;
    expect(ordinaryLatest).toMatchObject({ castId: ordinary.castId, active: false, phase: "failed" });
  });

  test("revive completions show all failed casts with appropriate labels", async () => {
    const harness = await makeMultiSocketHarness();

    // Edge-traversal exhausted cast
    await harness.runCommand("materia", "cast edge traversal exhausted filter");
    const failed = await failCurrentCast(harness, "Materia edge traversal limit exceeded for Socket-1->Socket-2");
    const edgeExhausted = makeEdgeTraversalExhaustedState(failed, { from: "Socket-1", to: "Socket-2" });
    harness.pi.appendEntry("pi-materia-cast-state", edgeExhausted);

    // Same-socket recovery exhausted cast
    await harness.runCommand("materia", "cast same socket exhausted filter");
    const sameSocketFailed = await failCurrentCast(harness, "Same-socket recovery exhausted for normal turn");
    const sameSocketExhausted = makeRevivableState(sameSocketFailed);
    harness.pi.appendEntry("pi-materia-cast-state", sameSocketExhausted);

    // Ordinary failed cast (now also revivable)
    await harness.runCommand("materia", "cast ordinary failure for filter");
    const ordinary = await failCurrentCast(harness, "ordinary failure");

    const completions = harness.getCommandCompletions("materia", "revive ") ?? [];
    const completionValues = completions.map((item) => item.value);

    // All three failed casts appear, newest first (ordinary created last is newest)
    expect(completionValues).toEqual([
      `revive ${ordinary.castId}`,
      `revive ${sameSocketExhausted.castId}`,
      `revive ${edgeExhausted.castId}`,
    ]);

    // Edge-traversal cast shows edge-exhausted label with target socket
    const edgeCompletion = completions.find((item) => item.value === `revive ${edgeExhausted.castId}`);
    expect(edgeCompletion?.label).toContain("edge-exhausted");
    expect(edgeCompletion?.label).toContain("Socket-2");

    // Same-socket cast shows recovery-exhausted label with source socket
    const sameSocketCompletion = completions.find((item) => item.value === `revive ${sameSocketExhausted.castId}`);
    expect(sameSocketCompletion?.label).toContain("recovery-exhausted");

    // Ordinary cast shows revivable label
    const ordinaryCompletion = completions.find((item) => item.value === `revive ${ordinary.castId}`);
    expect(ordinaryCompletion?.label).toContain("revivable");
  });

  test("revive completions include both same-socket and edge-traversal exhausted casts when both types exist", async () => {
    const harness = await makeMultiSocketHarness();

    // Same-socket exhausted (older)
    await harness.runCommand("materia", "cast older same-socket exhausted");
    const older = await failCurrentCast(harness, "Same-socket recovery exhausted for normal turn");
    const olderRevivable = makeRevivableState(older);
    harness.pi.appendEntry("pi-materia-cast-state", olderRevivable);

    // Edge-traversal exhausted (newer)
    await harness.runCommand("materia", "cast newer edge exhausted");
    const newer = await failCurrentCast(harness, "Materia edge traversal limit exceeded for Socket-1->Socket-2");
    const newerEdgeExhausted = makeEdgeTraversalExhaustedState(newer, { from: "Socket-1", to: "Socket-2" });
    harness.pi.appendEntry("pi-materia-cast-state", newerEdgeExhausted);

    // No-id revive picks newest revivable (edge-traversal in this case)
    await harness.runCommand("materia", "revive");

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(newerEdgeExhausted.castId);

    const completions = harness.getCommandCompletions("materia", "revive ") ?? [];
    // The now-active cast should not appear in completions
    expect(completions.map((item) => item.value)).toEqual([`revive ${olderRevivable.castId}`]);
  });

  test("passive revive activates ordinary failures without dispatching inference", async () => {
    const harness = await makeMultiSocketHarness();

    // Ordinary failure — now revivable
    await harness.runCommand("materia", "cast ordinary failure for revive");
    await failCurrentCast(harness, "ordinary failure");

    // Completions include the ordinary failure with revivable label
    const completions = harness.getCommandCompletions("materia", "revive ") ?? [];
    expect(completions.length).toBe(1);
    expect(completions[0].label).toContain("revivable");

    // No-id revive activates the ordinary failure
    await harness.runCommand("materia", "revive");
    const revived = latestState(harness);
    expect(revived.active).toBe(true);
    expect(revived.failedReason).toBeUndefined();
    expect(revived.runState.endedAt).toBeUndefined();
    expect(harness.notifications.at(-1)?.message).toContain("revived at socket");
    expect(harness.notifications.at(-1)?.message).toContain("nudge to continue");
  });

  test("preserves existing same-socket revive behavior after edge-traversal revive changes", async () => {
    // Verify that the same-socket revive tests still pass unchanged
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast same socket sanity check");
    const failed = await failCurrentCast(harness, "Same-socket recovery exhausted for normal turn");
    const revivable = makeRevivableState(failed);
    const recoveryKey = revivable.recoveryExhaustion!.key;
    harness.pi.appendEntry("pi-materia-cast-state", revivable);

    await harness.runCommand("materia", `revive ${revivable.castId}`);

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(revivable.castId);
    expect(resumed.active).toBe(true);
    expect(resumed.socketState).toBe("awaiting_agent_response");
    const allowance = resumed.recoveryAllowances?.[recoveryKey];
    expect(allowance).toMatchObject({ originalMaxAttempts: 1, effectiveMaxAttempts: 2, reviveCount: 1 });
    expect(resumed.recoveryExhaustion).toBeUndefined();
    expect(harness.notifications.at(-1)?.message).toContain(`pi-materia cast ${revivable.castId} recast from socket "Socket-1".`);

    const events = await readEvents(resumed);
    const eventTypes = events.map((event) => event.type ?? "");
    expect(eventTypes).toContain("cast_revive");
    expect(eventTypes).toContain("cast_recast");
  });
});

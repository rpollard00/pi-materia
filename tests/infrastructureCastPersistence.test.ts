import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, appendManifest, initializeRun, recordCommandArtifacts, recordSocketOutput, recordSocketParsedJson, recordUtilityInput, writeContextArtifact } from "../src/infrastructure/castArtifacts.js";
import { assertBudget, writeUsage } from "../src/infrastructure/castUsage.js";
import { clearCastState, listLatestCastStates, loadActiveCastState, saveCastState } from "../src/infrastructure/castStateRepository.js";
import type { MateriaCastState } from "../src/types.js";

function castState(runDir: string, overrides: Partial<MateriaCastState> = {}): MateriaCastState {
  const state: MateriaCastState = {
    version: 1,
    active: true,
    castId: "cast-1",
    request: "request",
    configSource: "test",
    configHash: "hash",
    cwd: runDir,
    runDir,
    artifactRoot: path.dirname(runDir),
    phase: "Build",
    currentSocketId: "Build",
    currentMateria: "Build",
    currentItemKey: "item/1",
    currentItemLabel: "A very descriptive item label for manifest metadata",
    awaitingResponse: true,
    socketState: "awaiting_agent_response",
    startedAt: 1,
    updatedAt: 1,
    data: {},
    cursors: {},
    visits: { Build: 2 },
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: {
      runId: "cast-1",
      startedAt: 1,
      runDir,
      eventsFile: path.join(runDir, "events.jsonl"),
      usageFile: path.join(runDir, "usage.json"),
      currentSocketId: "Build",
      currentMateria: "Build",
      usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byMateria: {}, bySocket: {}, byTask: {}, byAttempt: {} },
      budgetWarned: false,
    },
    pipeline: { entry: { id: "Build", socket: { materia: "Build" }, materia: { prompt: "", tools: "coding" } }, sockets: {} } as MateriaCastState["pipeline"],
    ...overrides,
  };
  state.runState.runDir = runDir;
  state.runState.eventsFile = path.join(runDir, "events.jsonl");
  state.runState.usageFile = path.join(runDir, "usage.json");
  return state;
}

describe("cast persistence infrastructure", () => {
  test("session-backed repository lists latest states, loads active, and clears through session entries", () => {
    const entries: unknown[] = [];
    const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) } as any;
    const ctx = { sessionManager: { getBranch: () => entries } } as any;
    const older = castState("/tmp/cast-old", { castId: "same", updatedAt: 1, active: false, socketState: "failed", phase: "failed" });
    const latest = castState("/tmp/cast-new", { castId: "same", updatedAt: 2, active: true });

    saveCastState(pi, older);
    saveCastState(pi, latest);

    expect(listLatestCastStates(ctx).map((state) => state.castId)).toEqual(["same"]);
    expect(loadActiveCastState(ctx)?.runDir).toBe("/tmp/cast-new");

    clearCastState(pi, latest, "aborted");
    expect(latest.active).toBe(false);
    expect(latest.socketState).toBe("failed");
    expect(latest.runState.endedAt).toBeNumber();
    expect(entries).toHaveLength(3);
  });

  test("artifact store preserves canonical socket paths and manifest write ordering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-artifacts-"));
    const runDir = path.join(root, "cast-1");
    await mkdir(runDir, { recursive: true });
    const state = castState(runDir);
    await initializeRun(runDir, { materias: {}, loadouts: { default: { sockets: [] } } } as any, { castId: state.castId, request: state.request, configSource: state.configSource, entries: [] });

    const output = await recordSocketOutput({ state, socketId: "Build", materia: "Build", visit: 2, text: "done", entryId: "entry-1", kind: "socket_output" });
    await appendManifest(state, { phase: "Build", socket: "Build", itemKey: "item/1", entryId: "manual" });
    const parsed = await recordSocketParsedJson({ state, socketId: "Build", visit: 2, parsed: { ok: true } });
    const input = await recordUtilityInput({ state, socketId: "Build", materia: "Build", visit: 2, input: { ok: true } });
    const command = await recordCommandArtifacts({ state, socketId: "Build", materia: "Build", visit: 2, stdout: "out", stderr: "err", stdoutTruncated: false, stderrTruncated: true, maxBytes: 123 });

    expect(output).toBe(path.join("sockets", "Build", "2-item-1.md"));
    expect(parsed).toBe(path.join("sockets", "Build", "2.json"));
    expect(input).toBe(path.join("sockets", "Build", "2-item-1.input.json"));
    expect(command.stderrArtifact).toBe(path.join("sockets", "Build", "2-item-1.command.stderr.txt"));
    expect(await readFile(path.join(runDir, output), "utf8")).toBe("done");
    expect(JSON.parse(await readFile(path.join(runDir, parsed), "utf8"))).toEqual({ ok: true });

    const manifest = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
    expect(manifest.entries.map((entry: any) => entry.entryId)).toEqual(["entry-1", "manual", "utility:Build:2:input", "utility:Build:2:command:stdout", "utility:Build:2:command:stderr", "utility:Build:2:command:meta"]);
    expect(manifest.entries[0].socket).toBe("Build");
    expect(manifest.entries[0].itemLabelShort).toContain("A very descriptive item label");
  });

  test("events and usage IO are owned by infrastructure adapters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-usage-"));
    const state = castState(root);

    state.runState.usage.tokens.total = 75;
    await writeUsage(state.runState);
    await appendEvent(state.runState, "custom_event", { ok: true });
    await assertBudget({ materias: {}, loadouts: { default: { sockets: [] } }, budget: { maxTokens: 100, warnAtPercent: 50 } } as any, state.runState, { ui: { notify: () => undefined }, hasUI: true } as any);

    const usage = JSON.parse(await readFile(path.join(root, "usage.json"), "utf8"));
    expect(usage.tokens.total).toBe(75);
    const eventLines = (await readFile(path.join(root, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(eventLines.map((event) => event.type)).toEqual(["custom_event", "budget_warning"]);
    expect(eventLines[1].data).toMatchObject({ maxTokens: 100, consumedTokens: 75, percent: 75 });
    expect(state.runState.budgetWarned).toBe(true);
  });

  test("warns at the configured token percentage and not before it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-budget-warning-"));
    const state = castState(root);
    const config = { materias: {}, loadouts: { default: { sockets: [] } }, budget: { maxTokens: 100, warnAtPercent: 50 } } as any;
    const ctx = { ui: { notify: () => undefined }, hasUI: true } as any;

    state.runState.usage.tokens.total = 49;
    await assertBudget(config, state.runState, ctx);
    expect(state.runState.budgetWarned).toBe(false);

    state.runState.usage.tokens.total = 50;
    await assertBudget(config, state.runState, ctx);
    expect(state.runState.budgetWarned).toBe(true);
    const events = (await readFile(path.join(root, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "budget_warning", data: { maxTokens: 100, consumedTokens: 50, percent: 50 } });
  });

  test("hard-stops at the exact token limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-budget-exact-"));
    const state = castState(root);
    state.runState.usage.tokens.total = 100;

    await expect(assertBudget(
      { materias: {}, loadouts: { default: { sockets: [] } }, budget: { maxTokens: 100 } } as any,
      state.runState,
      { ui: { notify: () => undefined }, hasUI: true } as any,
    )).rejects.toThrow("pi-materia budget limit reached");

    const events = (await readFile(path.join(root, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(["budget_warning", "budget_limit"]);
    expect(events[1].data).toMatchObject({ maxTokens: 100, consumedTokens: 100, percent: 100 });
  });

  test("hard-stops when token usage exceeds the limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-budget-over-"));
    const state = castState(root);
    state.runState.usage.tokens.total = 101;

    await expect(assertBudget(
      { materias: {}, loadouts: { default: { sockets: [] } }, budget: { maxTokens: 100, warnAtPercent: 200 } } as any,
      state.runState,
      { ui: { notify: () => undefined }, hasUI: true } as any,
    )).rejects.toThrow("pi-materia budget limit reached");

    const events = (await readFile(path.join(root, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "budget_limit", data: { maxTokens: 100, consumedTokens: 101, percent: 101 } });
  });

  test("ignores legacy monetary-only budget settings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-budget-legacy-"));
    const state = castState(root);
    state.runState.usage.tokens.total = 1;
    state.runState.usage.cost.total = 10;

    await assertBudget(
      { materias: {}, loadouts: { default: { sockets: [] } }, budget: { maxCostUsd: 0.01, warnAtPercent: 0 } } as any,
      state.runState,
      { ui: { notify: () => undefined }, hasUI: true } as any,
    );

    expect(state.runState.budgetWarned).toBe(false);
    expect(await readFile(path.join(root, "events.jsonl"), "utf8").catch(() => "")).toBe("");
  });

  test("ignores the legacy soft-stop flag when the token limit is reached", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-budget-hard-stop-"));
    const state = castState(root);
    state.runState.usage.tokens.total = 100;

    await expect(assertBudget(
      { materias: {}, loadouts: { default: { sockets: [] } }, budget: { maxTokens: 100, stopAtLimit: false, warnAtPercent: 200 } } as any,
      state.runState,
      { ui: { notify: () => undefined }, hasUI: true } as any,
    )).rejects.toThrow("pi-materia budget limit reached");
  });

  test("context artifact writer keeps isolated context layout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-context-"));
    const state = castState(root);
    const artifact = await writeContextArtifact({ state, prompt: "hidden prompt", syntheticContext: "synthetic", activeTools: ["read"], socketId: "Build", visit: 2, model: "provider/model", modelSource: "configured", thinking: "medium", thinkingSource: "configured" });

    expect(artifact).toBe(path.join("contexts", "Build-item-1-2.md"));
    const text = await readFile(path.join(root, artifact), "utf8");
    expect(text).toContain("# Materia Isolated Context");
    expect(text).toContain("socket: Build");
    expect(text).toContain("## Synthetic cast context\n\nsynthetic");
    expect(text).toContain("## Hidden materia prompt\n\nhidden prompt");
  });
});

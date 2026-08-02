import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { baseExecutionScopeId, createExecutionScope } from "../src/domain/executionScope.js";
import { appendEvent, appendManifest, initializeRun, recordCommandArtifacts, recordSocketOutput, recordSocketParsedJson, recordUtilityInput, writeContextArtifact } from "../src/infrastructure/castArtifacts.js";
import { assertBudget, writeUsage } from "../src/infrastructure/castUsage.js";
import { clearCastState, listLatestCastStates, loadActiveCastState, restoreCastState, saveCastState } from "../src/infrastructure/castStateRepository.js";
import { hashConfig, loadConfigFromState, persistCastBudget } from "../src/runtime/configPersistence.js";
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

  test("migrates cwd-only casts and persists exact active and branch scope transitions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-scopes-"));
    const entries: any[] = [];
    const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) } as any;
    const ctx = { sessionManager: { getBranch: () => entries } } as any;
    const state = castState(root);

    saveCastState(pi, state);
    expect(state.version).toBe(2);
    expect(state.baseScope.cwd).toBe(root);
    expect(state.activeScope).toEqual(state.baseScope);
    expect(state.branchScopes).toEqual({});

    const branch = createExecutionScope({
      id: "scope:branch-1",
      cwd: path.join(root, "branch-1"),
      state: { attempt: 2, cursor: 4 },
      exports: { result: { producer: "utility:spawn", value: { opaqueId: "owned-1" } } },
    });
    state.activeScope = branch;
    state.branchScopes = { [branch.id]: branch };
    saveCastState(pi, state);

    const restored = loadActiveCastState(ctx)!;
    expect(restored.activeScope).toEqual(branch);
    expect(restored.branchScopes).toEqual({ [branch.id]: branch });
    expect(restored.activeScope).not.toBe(state.activeScope);
    expect(JSON.parse(await readFile(path.join(root, "execution-scopes.json"), "utf8"))).toEqual({
      version: 1,
      castId: "cast-1",
      baseScope: state.baseScope,
      activeScope: branch,
      branchScopes: { [branch.id]: branch },
    });
  });

  test("round-trips valid inherited-property names in scope maps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-scope-keys-"));
    const entries: any[] = [];
    const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) } as any;
    const ctx = { sessionManager: { getBranch: () => entries } } as any;
    const state = castState(root);
    saveCastState(pi, state);

    const branch = createExecutionScope({
      id: "__proto__",
      cwd: path.join(root, "branch"),
      exports: Object.fromEntries([["__proto__", { producer: "utility:spawn", value: { owned: true } }]]),
    });
    state.activeScope = branch;
    state.branchScopes = Object.fromEntries([[branch.id, branch]]);
    saveCastState(pi, state);

    const restored = loadActiveCastState(ctx)!;
    expect(Object.hasOwn(restored.branchScopes, "__proto__")).toBe(true);
    expect(restored.branchScopes.__proto__).toEqual(branch);
    expect(Object.hasOwn(restored.branchScopes.__proto__.exports, "__proto__")).toBe(true);
    expect(restored.branchScopes.__proto__.exports.__proto__).toEqual({ producer: "utility:spawn", value: { owned: true } });

    const snapshot = JSON.parse(await readFile(path.join(root, "execution-scopes.json"), "utf8"));
    expect(Object.hasOwn(snapshot.branchScopes, "__proto__")).toBe(true);
    expect(Object.hasOwn(snapshot.branchScopes.__proto__.exports, "__proto__")).toBe(true);
  });

  test("rejects missing and malformed scope records in canonical casts", () => {
    const entries: any[] = [];
    const ctx = { sessionManager: { getBranch: () => entries } } as any;
    const missingAll = castState("/tmp/missing-all", { version: 2 } as any) as any;
    entries.push({ type: "custom", customType: "pi-materia-cast-state", data: missingAll });
    expect(() => listLatestCastStates(ctx)).toThrow("canonical cast must contain baseScope, activeScope, and branchScopes");

    const branch = createExecutionScope({ id: "scope:orphan", cwd: "/tmp/orphan" });
    const branchOnly = castState("/tmp/branch-only", { version: 2 } as any) as any;
    branchOnly.branchScopes = { [branch.id]: branch };
    expect(() => restoreCastState(branchOnly)).toThrow("canonical cast must contain baseScope, activeScope, and branchScopes");

    const missingActive = castState("/tmp/missing-active", { version: 2 } as any) as any;
    missingActive.baseScope = createExecutionScope({ id: baseExecutionScopeId(missingActive.castId), cwd: missingActive.cwd });
    missingActive.branchScopes = {};
    expect(() => restoreCastState(missingActive)).toThrow("both baseScope and activeScope");
  });

  test("restricts cwd-only scope migration to version-one casts", () => {
    expect(restoreCastState(castState("/tmp/legacy"))).toMatchObject({
      version: 2,
      baseScope: { id: baseExecutionScopeId("cast-1"), cwd: "/tmp/legacy" },
      activeScope: { id: baseExecutionScopeId("cast-1"), cwd: "/tmp/legacy" },
      branchScopes: {},
    });

    const missingVersion = castState("/tmp/unversioned") as any;
    delete missingVersion.version;
    expect(() => restoreCastState(missingVersion)).toThrow("canonical cast must contain baseScope, activeScope, and branchScopes");

    const ambiguousLegacy = castState("/tmp/ambiguous") as any;
    ambiguousLegacy.branchScopes = {};
    expect(() => restoreCastState(ambiguousLegacy)).toThrow("canonical cast must contain baseScope, activeScope, and branchScopes");
  });

  test("rejects persisted scopes with missing or null state and exports records", () => {
    const canonicalState = () => {
      const state = castState("/tmp/canonical-records", { version: 2 } as any) as any;
      state.baseScope = createExecutionScope({ id: baseExecutionScopeId(state.castId), cwd: state.cwd });
      state.activeScope = createExecutionScope({ id: "scope:active", cwd: "/tmp/active" });
      const branch = createExecutionScope({ id: "scope:branch", cwd: "/tmp/branch" });
      state.branchScopes = { [branch.id]: branch };
      return state;
    };
    const cases: Array<["baseScope" | "activeScope" | "branchScope", "state" | "exports", "missing" | "null"]> = [
      ["baseScope", "state", "missing"],
      ["baseScope", "exports", "null"],
      ["activeScope", "state", "null"],
      ["activeScope", "exports", "missing"],
      ["branchScope", "state", "missing"],
      ["branchScope", "exports", "null"],
    ];

    for (const [scopeName, field, corruption] of cases) {
      const state = canonicalState();
      const scope = scopeName === "branchScope" ? state.branchScopes["scope:branch"] : state[scopeName];
      if (corruption === "missing") delete scope[field];
      else scope[field] = null;

      expect(() => restoreCastState(state)).toThrow(new RegExp(`${scopeName === "branchScope" ? "branchScopes.scope:branch" : scopeName}.*${field}.*present, non-null plain object`));
    }
  });

  test("rejects persisted base scopes that violate the cast identity or cwd invariant", () => {
    const canonical = castState("/tmp/canonical", { version: 2 } as any) as any;
    canonical.baseScope = createExecutionScope({ id: "arbitrary", cwd: canonical.cwd });
    canonical.activeScope = canonical.baseScope;
    canonical.branchScopes = {};
    expect(() => restoreCastState(canonical)).toThrow("baseScope id must be");

    canonical.baseScope = createExecutionScope({ id: baseExecutionScopeId(canonical.castId), cwd: "/tmp/other" });
    canonical.activeScope = canonical.baseScope;
    expect(() => restoreCastState(canonical)).toThrow("baseScope cwd must match the cast cwd");
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

  test("persists cast-local token budgets atomically without changing source-shaped config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-cast-budget-update-"));
    const state = castState(root);
    state.runState.usage.tokens.total = 40;
    state.runState.budgetWarned = true;
    await writeFile(path.join(root, "config.resolved.json"), JSON.stringify({
      artifactDir: ".pi/pi-materia",
      budget: { maxTokens: 100, warnAtPercent: 75 },
      limits: { maxSocketVisits: 3 },
      materia: { Build: { prompt: "unchanged" } },
    }, null, 2));
    await writeFile(state.runState.eventsFile, "");
    const entries: unknown[] = [];
    const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }) } as any;

    const update = await persistCastBudget(pi, state, 200);
    const persisted = JSON.parse(await readFile(path.join(root, "config.resolved.json"), "utf8"));

    expect(update).toEqual({ castId: "cast-1", previousMaxTokens: 100, maxTokens: 200, consumedTokens: 40 });
    expect(persisted).toEqual({
      artifactDir: ".pi/pi-materia",
      budget: { maxTokens: 200, warnAtPercent: 75 },
      limits: { maxSocketVisits: 3 },
      materia: { Build: { prompt: "unchanged" } },
    });
    expect(state.configHash).toBe(hashConfig(persisted));
    expect(state.runState.budgetWarned).toBe(false);
    expect(await loadConfigFromState(state)).toMatchObject({ budget: { maxTokens: 200, warnAtPercent: 75 } });
    expect(entries).toHaveLength(1);
    const events = (await readFile(state.runState.eventsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toEqual([{ ts: expect.any(Number), type: "budget_updated", data: update }]);
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

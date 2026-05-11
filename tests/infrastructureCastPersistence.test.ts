import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendManifest, initializeRun, recordCommandArtifacts, recordNodeOutput, recordUtilityInput, writeContextArtifact } from "../src/infrastructure/castArtifacts.js";
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
    currentNode: "Build",
    currentMateria: "Build",
    currentItemKey: "item/1",
    currentItemLabel: "A very descriptive item label for manifest metadata",
    awaitingResponse: true,
    nodeState: "awaiting_agent_response",
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
      currentNode: "Build",
      currentMateria: "Build",
      usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byMateria: {}, byNode: {}, byTask: {}, byAttempt: {} },
      budgetWarned: false,
    },
    pipeline: { entry: { id: "Build", socket: { type: "agent", materia: "Build" }, materia: { prompt: "", tools: "coding" } }, sockets: {} } as MateriaCastState["pipeline"],
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
    const older = castState("/tmp/cast-old", { castId: "same", updatedAt: 1, active: false, nodeState: "failed", phase: "failed" });
    const latest = castState("/tmp/cast-new", { castId: "same", updatedAt: 2, active: true });

    saveCastState(pi, older);
    saveCastState(pi, latest);

    expect(listLatestCastStates(ctx).map((state) => state.castId)).toEqual(["same"]);
    expect(loadActiveCastState(ctx)?.runDir).toBe("/tmp/cast-new");

    clearCastState(pi, latest, "aborted");
    expect(latest.active).toBe(false);
    expect(latest.nodeState).toBe("failed");
    expect(latest.runState.endedAt).toBeNumber();
    expect(entries).toHaveLength(3);
  });

  test("artifact store preserves legacy node paths and manifest write ordering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-artifacts-"));
    const runDir = path.join(root, "cast-1");
    await mkdir(runDir, { recursive: true });
    const state = castState(runDir);
    await initializeRun(runDir, { materias: {}, loadouts: { default: { sockets: [] } } } as any, { castId: state.castId, request: state.request, configSource: state.configSource, entries: [] });

    const output = await recordNodeOutput({ state, socketId: "Build", materia: "Build", visit: 2, text: "done", entryId: "entry-1", kind: "node_output" });
    await appendManifest(state, { phase: "Build", node: "Build", itemKey: "item/1", entryId: "manual" });
    const input = await recordUtilityInput({ state, socketId: "Build", materia: "Build", visit: 2, input: { ok: true } });
    const command = await recordCommandArtifacts({ state, socketId: "Build", materia: "Build", visit: 2, stdout: "out", stderr: "err", stdoutTruncated: false, stderrTruncated: true, maxBytes: 123 });

    expect(output).toBe(path.join("nodes", "Build", "2-item-1.md"));
    expect(input).toBe(path.join("nodes", "Build", "2-item-1.input.json"));
    expect(command.stderrArtifact).toBe(path.join("nodes", "Build", "2-item-1.command.stderr.txt"));
    expect(await readFile(path.join(runDir, output), "utf8")).toBe("done");

    const manifest = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
    expect(manifest.entries.map((entry: any) => entry.entryId)).toEqual(["entry-1", "manual", "utility:Build:2:input", "utility:Build:2:command:stdout", "utility:Build:2:command:stderr", "utility:Build:2:command:meta"]);
    expect(manifest.entries[0].node).toBe("Build");
    expect(manifest.entries[0].itemLabelShort).toContain("A very descriptive item label");
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

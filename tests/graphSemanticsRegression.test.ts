import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { validatePipelineGraph } from "../src/graphValidation.js";
import type { PiMateriaConfig } from "../src/types.js";
import { buildMateriaPalette } from "../src/webui/client/src/loadoutModel.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: PiMateriaConfig): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-graph-semantics-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function regressionConfig(): PiMateriaConfig {
  const evalScript = `
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const ctx = JSON.parse(input);
      const key = ctx.itemKey ?? "singleton";
      const previous = ctx.state.evalAttempts ?? {};
      const attempt = Number(previous[key] ?? 0) + 1;
      const evalAttempts = { ...previous, [key]: attempt };
      const satisfied = key === "alpha" ? attempt >= 2 : true;
      process.stdout.write(JSON.stringify({ satisfied, feedback: satisfied ? "ok" : "retry", evalAttempts }));
    });
  `;

  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Regression",
    loadouts: {
      Regression: {
        entry: "ensureArtifactsIgnored",
        nodes: {
          ensureArtifactsIgnored: {
            type: "utility",
            utility: "project.ensureIgnored",
            parse: "json",
            params: { patterns: [".pi/pi-materia/"] },
            assign: { artifactIgnore: "$" },
            edges: [{ when: "always", to: "detectVcs" }],
          },
          detectVcs: {
            type: "utility",
            utility: "vcs.detect",
            parse: "json",
            assign: { vcs: "$" },
            edges: [{ when: "always", to: "seedTasks" }],
          },
          seedTasks: {
            type: "utility",
            utility: "echo",
            parse: "json",
            params: { output: { tasks: [{ id: "alpha", title: "Alpha" }, { id: "beta", title: "Beta" }] } },
            assign: { tasks: "$.tasks" },
            edges: [{ when: "always", to: "Build" }],
          },
          Build: {
            type: "utility",
            utility: "echo",
            params: { text: "build" },
            edges: [{ when: "always", to: "Auto-Eval" }],
            limits: { maxVisits: 5 },
          },
          "Auto-Eval": {
            type: "utility",
            command: ["node", "-e", evalScript],
            parse: "json",
            assign: { lastFeedback: "$.feedback", evalAttempts: "$.evalAttempts" },
            edges: [
              { when: "satisfied", to: "Maintain" },
              { when: "not_satisfied", to: "Build", maxTraversals: 3 },
            ],
            limits: { maxVisits: 5 },
          },
          Maintain: {
            type: "utility",
            utility: "echo",
            parse: "json",
            params: { output: { satisfied: true, commitMessage: "maintain" } },
            assign: { lastMaintain: "$" },
            advance: { cursor: "taskIndex", items: "state.tasks", done: "end", when: "satisfied" },
            edges: [
              { when: "not_satisfied", to: "Maintain", maxTraversals: 3 },
              { when: "always", to: "Build" },
            ],
            limits: { maxVisits: 5 },
          },
        },
        loops: {
          taskIteration: {
            label: "Build → Eval → Maintain until all tasks complete",
            nodes: ["Build", "Auto-Eval", "Maintain"],
            iterator: { items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" },
            exit: { from: "Maintain", when: "satisfied", to: "end" },
          },
        },
      },
    },
    materia: {
      ensureArtifactsIgnored: {
        type: "utility",
        label: "Ensure artifacts ignored",
        description: "Ensures artifact output is ignored.",
        group: "Utility",
        utility: "project.ensureIgnored",
        parse: "json",
        params: { patterns: [".pi/pi-materia/"] },
        assign: { artifactIgnore: "$" },
      },
      detectVcs: {
        type: "utility",
        label: "Detect VCS",
        description: "Detects jj/git repository state.",
        group: "Utility",
        utility: "vcs.detect",
        parse: "json",
        assign: { vcs: "$" },
      },
      Build: { tools: "coding", foreach: { items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" }, prompt: "build" } as never,
      "Auto-Eval": { tools: "readOnly", prompt: "eval" },
      Maintain: { tools: "coding", prompt: "maintain" },
    },
  };
}

describe("graph semantics regression", () => {
  test("runs a graph combining utility palette materia, canonical edges, and an iterator loop", async () => {
    const config = regressionConfig();
    const loadout = config.loadouts!.Regression;

    expect(validatePipelineGraph(loadout)).toEqual({ ok: true, errors: [] });
    const palette = new Map(buildMateriaPalette(config.materia));
    expect(palette.get("ensureArtifactsIgnored")).toMatchObject({ type: "utility", utility: "project.ensureIgnored", parse: "json" });
    expect(palette.get("detectVcs")).toMatchObject({ type: "utility", utility: "vcs.detect", parse: "json" });
    expect(palette.get("Build")?.foreach).toEqual({ items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" });

    const harness = await makeHarness(config);
    await harness.runCommand("materia", "cast graph semantics");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; visits?: Record<string, number>; edgeTraversals?: Record<string, number>; cursors?: Record<string, number>; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.data?.artifactIgnore).toMatchObject({ ok: true, patterns: [".pi/pi-materia/"] });
    expect(state.data?.vcs).toMatchObject({ kind: "none" });
    expect(state.data?.evalAttempts).toEqual({ alpha: 2, beta: 1 });
    expect(state.visits).toMatchObject({ ensureArtifactsIgnored: 1, detectVcs: 1, seedTasks: 1, Build: 3, "Auto-Eval": 3, Maintain: 2 });
    expect(state.edgeTraversals).toMatchObject({
      "ensureArtifactsIgnored->detectVcs": 1,
      "detectVcs->seedTasks": 1,
      "seedTasks->Build": 1,
      "Build->Auto-Eval": 3,
      "Auto-Eval->Build": 1,
      "Auto-Eval->Maintain": 2,
      "Maintain->Build": 1,
    });
    expect(state.cursors?.taskIndex).toBe(2);
    await expect(readFile(path.join(harness.cwd, ".gitignore"), "utf8")).resolves.toContain(".pi/pi-materia/");
    const alphaRetryInput = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "Build", "2-alpha.input.json"), "utf8"));
    expect(alphaRetryInput.itemKey).toBe("alpha");
    const betaInput = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "Build", "3-beta.input.json"), "utf8"));
    expect(betaInput.itemKey).toBe("beta");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { validatePipelineGraph } from "../src/graph/graphValidation.js";
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
      const satisfied = key === "0" ? attempt >= 2 : true;
      process.stdout.write(JSON.stringify({ satisfied, feedback: satisfied ? "ok" : "retry", evalAttempts }));
    });
  `;

  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Regression",
    loadouts: {
      Regression: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": {
            materia: "ensureArtifactsIgnored",
            edges: [{ when: "always", to: "Socket-2" }],
          },
          "Socket-2": {
            materia: "detectVcs",
            edges: [{ when: "always", to: "Socket-3" }],
          },
          "Socket-3": { materia: "SeedTasks", edges: [{ when: "always", to: "Socket-4" }] },
          "Socket-4": { materia: "BuildUtility", edges: [{ when: "always", to: "Socket-5" }], limits: { maxVisits: 5 } },
          "Socket-5": {
            materia: "EvalUtility",
            edges: [
              { when: "satisfied", to: "Socket-6" },
              { when: "not_satisfied", to: "Socket-4", maxTraversals: 3 },
            ],
            limits: { maxVisits: 5 },
          },
          "Socket-6": {
            materia: "MaintainUtility",
            advance: { cursor: "taskIndex", items: "state.tasks", done: "end", when: "satisfied" },
            edges: [
              { when: "not_satisfied", to: "Socket-6", maxTraversals: 3 },
              { when: "always", to: "Socket-4" },
            ],
            limits: { maxVisits: 5 },
          },
        },
        loops: {
          taskIteration: {
            sockets: ["Socket-4", "Socket-5", "Socket-6"],
            iterator: { items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" },
            exit: { from: "Socket-6", when: "satisfied", to: "end" },
          },
        },
      },
    },
    materia: {
      ensureArtifactsIgnored: {
        label: "Ensure artifacts ignored",
        description: "Ensures artifact output is ignored.",
        group: "Utility",
        utility: "project.ensureIgnored",
        parse: "json",
        params: { patterns: [".pi/pi-materia/"] },
        assign: { artifactIgnore: "$" },
      },
      detectVcs: {
        label: "Detect VCS",
        description: "Detects jj/git repository state.",
        group: "Utility",
        utility: "vcs.detect",
        parse: "json",
        assign: { vcs: "$" },
      },
      SeedTasks: { type: "utility", utility: "echo", parse: "json", params: { output: { tasks: [{ id: "alpha", title: "Alpha" }, { id: "beta", title: "Beta" }] } }, assign: { tasks: "$.tasks" } },
      BuildUtility: { type: "utility", utility: "echo", params: { text: "build" } },
      EvalUtility: { type: "utility", command: ["node", "-e", evalScript], parse: "json", assign: { lastFeedback: "$.feedback", evalAttempts: "$.evalAttempts" } },
      MaintainUtility: { type: "utility", utility: "echo", parse: "json", params: { output: { satisfied: true, commitMessage: "maintain" } }, assign: { lastMaintain: "$" } },
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
    expect(palette.get("ensureArtifactsIgnored")).toMatchObject({ materia: "ensureArtifactsIgnored" });
    expect(palette.get("detectVcs")).toMatchObject({ materia: "detectVcs" });
    expect(palette.get("Build")?.foreach).toEqual({ items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" });

    const harness = await makeHarness(config);
    await harness.runCommand("materia", "cast graph semantics");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; visits?: Record<string, number>; edgeTraversals?: Record<string, number>; cursors?: Record<string, number>; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.data?.artifactIgnore).toMatchObject({ ok: true, patterns: [".pi/pi-materia/"] });
    expect(state.data?.vcs).toMatchObject({ kind: "none" });
    expect(state.data?.evalAttempts).toEqual({ "0": 2, "1": 1 });
    expect(state.visits).toMatchObject({ "Socket-1": 1, "Socket-2": 1, "Socket-3": 1, "Socket-4": 3, "Socket-5": 3, "Socket-6": 2 });
    expect(state.edgeTraversals).toMatchObject({
      "Socket-1->Socket-2": 1,
      "Socket-2->Socket-3": 1,
      "Socket-3->Socket-4": 1,
      "Socket-4->Socket-5": 3,
      "Socket-5->Socket-4": 1,
      "Socket-5->Socket-6": 2,
      "Socket-6->Socket-4": 1,
    });
    expect(state.cursors?.taskIndex).toBe(2);
    await expect(readFile(path.join(harness.cwd, ".gitignore"), "utf8")).resolves.toContain(".pi/pi-materia/");
    const alphaRetryInput = JSON.parse(await readFile(path.join(state.runDir!, "sockets", "Socket-4", "2-0.input.json"), "utf8"));
    expect(alphaRetryInput.itemKey).toBe("0");
    const betaInput = JSON.parse(await readFile(path.join(state.runDir!, "sockets", "Socket-4", "3-1.input.json"), "utf8"));
    expect(betaInput.itemKey).toBe("1");
  });
});

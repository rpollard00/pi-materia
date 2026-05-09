import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { resolvePipeline } from "../src/pipeline.js";
import type { PiMateriaConfig } from "../src/types.js";
import { normalizeMateriaConfigEdges } from "../src/webui/client/src/loadoutModel.js";
import { FakePiHarness } from "./fakePi.js";

interface YoloTestConfig extends PiMateriaConfig {
  __workItems: Array<{ id: string; title: string }>;
}

async function makeHarness(config: PiMateriaConfig): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-yolo-loop-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

const maintainScript = `
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    const ctx = JSON.parse(input);
    const key = ctx.itemKey ?? "singleton";
    const previous = ctx.state.maintainAttempts ?? {};
    const attempt = Number(previous[key] ?? 0) + 1;
    const maintainAttempts = { ...previous, [key]: attempt };
    const retryOnce = ctx.params.retryOnce ?? [];
    const satisfied = !(retryOnce.includes(key) && attempt === 1);
    process.stdout.write(JSON.stringify({ satisfied, feedback: satisfied ? "ok" : "retry", maintainAttempts }));
  });
`;

function yoloConfig(workItems: Array<{ id: string; title: string }>, options: { retryOnce?: string[]; exitTo?: string } = {}): YoloTestConfig {
  const exitTo = options.exitTo ?? "end";
  const nodes: Record<string, unknown> = {
    "Socket-3": {
      type: "utility",
      utility: "echo",
      params: { text: "build" },
      edges: [{ when: "always", to: "Socket-4" }],
      limits: { maxVisits: 10 },
    },
    "Socket-4": {
      type: "utility",
      command: ["node", "-e", maintainScript],
      params: { retryOnce: options.retryOnce ?? [] },
      assign: { maintainAttempts: "$.maintainAttempts", lastSatisfied: "$.satisfied" },
      edges: [{ when: "always", to: "Socket-3" }],
      limits: { maxVisits: 10 },
    },
    "Socket-5": {
      type: "agent",
      materia: "planner",
      parse: "json",
      assign: { workItems: "$.workItems" },
      edges: [{ when: "always", to: "Socket-3" }],
    },
  } as never;
  if (exitTo !== "end") {
    (nodes as Record<string, unknown>)[exitTo] = { type: "utility", utility: "echo", params: { output: { done: true } }, parse: "json", assign: { done: "$.done" } };
  }

  return {
    __workItems: workItems,
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Yolo",
    loadouts: {
      Yolo: {
        entry: "Socket-5",
        nodes: nodes as never,
        loops: {
          loopSelection: {
            nodes: ["Socket-3", "Socket-4"],
            consumes: { from: "Socket-5", output: "workItems" },
            exit: { from: "Socket-4", when: "satisfied", to: exitTo },
          },
        },
      },
    },
    materia: {
      planner: { tools: "readOnly", prompt: "Plan.", generator: true },
    },
  };
}

async function runYolo(config: YoloTestConfig) {
  const harness = await makeHarness(config);
  await harness.runCommand("materia", "cast yolo loop regression");
  const output = (config.loadouts!.Yolo.loops!.loopSelection as { consumes?: { output?: string } }).consumes?.output ?? "workItems";
  harness.appendAssistantMessage(JSON.stringify({ [output]: config.__workItems }));
  await harness.emit("agent_end", { messages: [] });
  const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as { phase?: string; data?: Record<string, unknown>; visits?: Record<string, number>; edgeTraversals?: Record<string, number>; cursors?: Record<string, number>; runDir?: string };
  return { harness, state };
}

describe("Yolo loop semantics regression", () => {
  test("single-item UI-created Yolo exits after satisfied instead of following the unconditional back-edge forever", async () => {
    const config = yoloConfig([{ id: "one", title: "One" }]);
    expect(resolvePipeline(config).nodes["Socket-4"].node.advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" });

    const { state } = await runYolo(config);

    expect(state.phase).toBe("complete");
    expect(state.visits).toMatchObject({ "Socket-3": 1, "Socket-4": 1 });
    expect(state.edgeTraversals?.["Socket-4->Socket-3"]).toBeUndefined();
    expect(state.cursors?.workItemIndex).toBe(1);
    expect(state.data?.maintainAttempts).toEqual({ one: 1 });
  });

  test("multi-item UI-created Yolo advances through consumed items then exits to loop.exit.to", async () => {
    const config = yoloConfig([{ id: "alpha", title: "Alpha" }, { id: "beta", title: "Beta" }], { exitTo: "Socket-2" });

    const { state } = await runYolo(config);

    expect(state.phase).toBe("complete");
    expect(state.data?.done).toBe(true);
    expect(state.visits).toMatchObject({ "Socket-3": 2, "Socket-4": 2, "Socket-2": 1 });
    expect(state.edgeTraversals).toMatchObject({ "Socket-4->Socket-3": 1 });
    expect(state.cursors?.workItemIndex).toBe(2);
    expect(state.data?.maintainAttempts).toEqual({ alpha: 1, beta: 1 });

    const betaInput = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "Socket-4", "2-beta.input.json"), "utf8"));
    expect(betaInput.itemKey).toBe("beta");
  });

  test("not_satisfied Maintain result retries through the loop route without advancing the consumed cursor", async () => {
    const config = yoloConfig([{ id: "alpha", title: "Alpha" }, { id: "beta", title: "Beta" }], { retryOnce: ["alpha"] });

    const { state } = await runYolo(config);

    expect(state.phase).toBe("complete");
    expect(state.visits).toMatchObject({ "Socket-3": 3, "Socket-4": 3 });
    expect(state.edgeTraversals).toMatchObject({ "Socket-4->Socket-3": 2 });
    expect(state.cursors?.workItemIndex).toBe(2);
    expect(state.data?.maintainAttempts).toEqual({ alpha: 2, beta: 1 });

    const retryInput = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "Socket-4", "2-alpha.input.json"), "utf8"));
    expect(retryInput.itemKey).toBe("alpha");
    expect(retryInput.cursor).toEqual({ name: "workItemIndex", index: 0 });
  });

  test("UI-authored and default-style Yolo loadouts normalize to equivalent executable semantics", () => {
    const uiAuthored = yoloConfig([{ id: "one", title: "One" }]);
    const defaultStyle = structuredClone(uiAuthored) as PiMateriaConfig;
    defaultStyle.loadouts!.Yolo.nodes["Socket-4"].parse = "json";
    defaultStyle.loadouts!.Yolo.nodes["Socket-4"].advance = { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" };

    const normalizedUiConfig = normalizeMateriaConfigEdges(uiAuthored as never) as PiMateriaConfig;
    expect(normalizedUiConfig.loadouts!.Yolo.nodes["Socket-4"]).toMatchObject({
      parse: "json",
      advance: { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" },
      edges: [{ when: "always", to: "Socket-3" }],
    });

    const uiPipeline = resolvePipeline(uiAuthored);
    const defaultPipeline = resolvePipeline(defaultStyle);
    expect(uiPipeline.nodes["Socket-4"].node).toEqual(defaultPipeline.nodes["Socket-4"].node);
    expect(uiPipeline.loops?.loopSelection).toEqual(defaultPipeline.loops?.loopSelection);
  });

  test("normalization preserves compatible explicit advance definitions and rejects conflicting ones", () => {
    const compatible = yoloConfig([{ id: "one", title: "One" }]);
    compatible.loadouts!.Yolo.nodes["Socket-4"].parse = "json";
    compatible.loadouts!.Yolo.nodes["Socket-4"].advance = { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" };
    expect(resolvePipeline(compatible).nodes["Socket-4"].node.advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" });

    const conflicting = structuredClone(compatible) as PiMateriaConfig;
    conflicting.loadouts!.Yolo.nodes["Socket-4"].advance = { cursor: "otherIndex", items: "state.workItems", done: "end", when: "satisfied" };
    expect(() => resolvePipeline(conflicting)).toThrow(/existing advance block.*cursor: current "otherIndex", expected "workItemIndex"/);
  });
});

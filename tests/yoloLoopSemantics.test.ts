import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { resolvePipeline } from "../src/runtime/pipeline.js";
import type { PiMateriaConfig } from "../src/types.js";
import { normalizeMateriaConfigEdges } from "../src/webui/client/src/loadoutModel.js";
import { FakePiHarness } from "./fakePi.js";

interface YoloTestConfig extends PiMateriaConfig {
  __workItems: ReturnType<typeof canonicalWorkItems>;
}

function testSockets(loadout: NonNullable<PiMateriaConfig["loadouts"]>[string]) {
  return loadout.sockets!;
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

function canonicalWorkItems(workItems: Array<{ id: string; title: string }>) {
  return workItems.map((item) => ({
    title: item.title,
    context: `Complete ${item.title}. Acceptance: Done.`,
  }));
}

function yoloConfig(workItems: Array<{ id: string; title: string }>, options: { retryOnce?: string[]; exitTo?: string } = {}): YoloTestConfig {
  const exitTo = options.exitTo ?? "end";
  const sockets: Record<string, unknown> = {
    "Socket-3": {
      materia: "Yolo-Build",
      edges: [{ when: "always", to: "Socket-4" }],
      limits: { maxVisits: 10 },
    },
    "Socket-4": {
      materia: "Yolo-Maintain",
      edges: [{ when: "always", to: "Socket-3" }],
      limits: { maxVisits: 10 },
    },
    "Socket-5": {
      materia: "planner",
      parse: "json",
      assign: { workItems: "$.workItems" },
      edges: [{ when: "always", to: "Socket-3" }],
    },
  } as never;
  if (exitTo !== "end") {
    (sockets as Record<string, unknown>)[exitTo] = { materia: "Yolo-Done" };
  }

  return {
    __workItems: canonicalWorkItems(workItems),
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Yolo",
    loadouts: {
      Yolo: {
        entry: "Socket-5",
        sockets: sockets as never,
        loops: {
          loopSelection: {
            sockets: ["Socket-3", "Socket-4"],
            consumes: { from: "Socket-5", output: "workItems" },
            exit: { from: "Socket-4", when: "satisfied", to: exitTo },
          },
        },
      },
    },
    materia: {
      planner: { type: "agent", tools: "readOnly", prompt: "Plan.", generator: true },
      "Yolo-Build": { type: "utility", utility: "echo", params: { text: "build" } },
      "Yolo-Maintain": { type: "utility", command: ["node", "-e", maintainScript], params: { retryOnce: options.retryOnce ?? [] }, parse: "json", assign: { maintainAttempts: "$.maintainAttempts", lastSatisfied: "$.satisfied" } },
      "Yolo-Done": { type: "utility", utility: "echo", params: { output: { done: true } }, parse: "json", assign: { done: "$.done" } },
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
    expect(resolvePipeline(config).sockets["Socket-4"].socket.advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", when: "satisfied" });

    const { state } = await runYolo(config);

    expect(state.phase).toBe("complete");
    expect(state.visits).toMatchObject({ "Socket-3": 1, "Socket-4": 1 });
    expect(state.edgeTraversals?.["Socket-4->Socket-3"]).toBeUndefined();
    expect(state.cursors?.workItemIndex).toBe(1);
    expect(state.data?.maintainAttempts).toEqual({ "WI-1": 1 });
  });

  test("multi-item UI-created Yolo advances through consumed items then routes through canonical loop exits", async () => {
    const config = yoloConfig([{ id: "alpha", title: "Alpha" }, { id: "beta", title: "Beta" }], { exitTo: "Socket-2" });

    const { state } = await runYolo(config);

    expect(state.phase).toBe("complete");
    expect(state.data?.done).toBe(true);
    expect(state.visits).toMatchObject({ "Socket-3": 2, "Socket-4": 2, "Socket-2": 1 });
    expect(state.edgeTraversals).toMatchObject({ "Socket-4->Socket-3": 1 });
    expect(state.cursors?.workItemIndex).toBe(2);
    expect(state.data?.maintainAttempts).toEqual({ "WI-1": 1, "WI-2": 1 });

    const betaInput = JSON.parse(await readFile(path.join(state.runDir!, "sockets", "Socket-4", "2-WI-2.input.json"), "utf8"));
    expect(betaInput.itemKey).toBe("WI-2");
  });

  test("not_satisfied Maintain result retries through the loop route without advancing the consumed cursor", async () => {
    const config = yoloConfig([{ id: "alpha", title: "Alpha" }, { id: "beta", title: "Beta" }], { retryOnce: ["WI-1"] });

    const { state } = await runYolo(config);

    expect(state.phase).toBe("complete");
    expect(state.visits).toMatchObject({ "Socket-3": 3, "Socket-4": 3 });
    expect(state.edgeTraversals).toMatchObject({ "Socket-4->Socket-3": 2 });
    expect(state.cursors?.workItemIndex).toBe(2);
    expect(state.data?.maintainAttempts).toEqual({ "WI-1": 2, "WI-2": 1 });

    const retryInput = JSON.parse(await readFile(path.join(state.runDir!, "sockets", "Socket-4", "2-WI-1.input.json"), "utf8"));
    expect(retryInput.itemKey).toBe("WI-1");
    expect(retryInput.cursor).toEqual({ name: "workItemIndex", index: 0 });
  });

  test("satisfied loop-exit route overrides legacy loop exit target with always fallback", async () => {
    const config = yoloConfig([{ id: "one", title: "One" }]);
    config.materia.Routed = { type: "utility", utility: "echo", params: { output: { routed: true } }, parse: "json", assign: { routed: "$.routed" } };
    testSockets(config.loadouts!.Yolo)["Socket-2"] = { materia: "Routed" };
    config.loadouts!.Yolo.loops!.loopSelection.exits = [{ id: "after-satisfied", from: "Socket-4", condition: "satisfied", targetSocketId: "Socket-2" }];

    const { state } = await runYolo(config);

    expect(state.phase).toBe("complete");
    expect(state.data?.routed).toBe(true);
    expect(state.visits).toMatchObject({ "Socket-4": 1, "Socket-2": 1 });
    expect(state.edgeTraversals?.["Socket-4->Socket-3"]).toBeUndefined();
  });

  test("not_satisfied loop-exit route is selected when the loop exits on a false outcome", async () => {
    const config = yoloConfig([{ id: "alpha", title: "Alpha" }], { retryOnce: ["WI-1"], exitTo: "Socket-2" });
    config.loadouts!.Yolo.loops!.loopSelection.exit = { from: "Socket-4", when: "not_satisfied", to: "end" };
    config.loadouts!.Yolo.loops!.loopSelection.exits = [{ id: "after-failed", from: "Socket-4", condition: "not_satisfied", targetSocketId: "Socket-2" }];

    const { state } = await runYolo(config);

    expect(state.phase).toBe("complete");
    expect(state.data?.done).toBe(true);
    expect(state.visits).toMatchObject({ "Socket-4": 1, "Socket-2": 1 });
    expect(state.cursors?.workItemIndex).toBe(1);
  });

  test("loop-exit route can enter another loop and no-match exhaustion falls through to end", async () => {
    const config = yoloConfig([{ id: "one", title: "One" }]);
    config.materia.FallbackDone = { type: "utility", utility: "echo", params: { output: { fallbackDone: true } }, parse: "json", assign: { fallbackDone: "$.fallbackDone" } };
    config.materia.SecondBuild = { type: "utility", utility: "echo", params: { text: "second build" } };
    config.materia.SecondDone = { type: "utility", utility: "echo", params: { output: { satisfied: true, secondLoopDone: true } }, parse: "json", assign: { secondLoopDone: "$.secondLoopDone" } };
    testSockets(config.loadouts!.Yolo)["Socket-2"] = { materia: "FallbackDone" };
    testSockets(config.loadouts!.Yolo)["Socket-6"] = { materia: "SecondBuild", foreach: { items: "state.workItems", cursor: "secondIndex" }, edges: [{ when: "always", to: "Socket-7" }] };
    testSockets(config.loadouts!.Yolo)["Socket-7"] = { materia: "SecondDone", advance: { cursor: "secondIndex", items: "state.workItems", done: "end", when: "satisfied" }, edges: [{ when: "always", to: "Socket-6" }] };
    config.loadouts!.Yolo.loops!.loopSelection.exits = [{ id: "after-first-loop", from: "Socket-4", condition: "satisfied", targetSocketId: "Socket-6" }];
    config.loadouts!.Yolo.loops!.secondLoop = { sockets: ["Socket-6", "Socket-7"] };

    const { state } = await runYolo(config);

    expect(state.phase).toBe("complete");
    expect(state.data?.secondLoopDone).toBe(true);
    expect(state.data?.fallbackDone).toBeUndefined();
    expect(state.visits).toMatchObject({ "Socket-4": 1, "Socket-6": 1, "Socket-7": 1 });
    expect(state.cursors).toMatchObject({ workItemIndex: 1, secondIndex: 1 });

    const noMatch = yoloConfig([{ id: "one", title: "One" }]);
    noMatch.loadouts!.Yolo.loops!.loopSelection.exits = [{ id: "not-selected", from: "Socket-4", condition: "not_satisfied", targetSocketId: "Socket-3" }];
    const { state: noMatchState } = await runYolo(noMatch);
    expect(noMatchState.data?.done).toBeUndefined();
    expect(noMatchState.visits?.["Socket-2"]).toBeUndefined();
  });

  test("UI-authored and default-style Yolo loadouts normalize to equivalent executable semantics", () => {
    const uiAuthored = yoloConfig([{ id: "one", title: "One" }]);
    const defaultStyle = structuredClone(uiAuthored) as PiMateriaConfig;
    testSockets(defaultStyle.loadouts!.Yolo)["Socket-4"].advance = { cursor: "workItemIndex", items: "state.workItems", when: "satisfied" };

    const normalizedUiConfig = normalizeMateriaConfigEdges(uiAuthored as never) as PiMateriaConfig;
    expect(testSockets(normalizedUiConfig.loadouts!.Yolo)["Socket-4"]).toMatchObject({
      edges: [{ when: "always", to: "Socket-3" }],
    });

    const uiPipeline = resolvePipeline(uiAuthored);
    const defaultPipeline = resolvePipeline(defaultStyle);
    expect(uiPipeline.sockets["Socket-4"].socket).toEqual(defaultPipeline.sockets["Socket-4"].socket);
    expect(uiPipeline.loops?.loopSelection).toEqual(defaultPipeline.loops?.loopSelection);
  });

  test("normalization preserves compatible explicit advance definitions and rejects conflicting ones", () => {
    const compatible = yoloConfig([{ id: "one", title: "One" }]);
    testSockets(compatible.loadouts!.Yolo)["Socket-4"].advance = { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" };
    expect(resolvePipeline(compatible).sockets["Socket-4"].socket.advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" });

    const conflicting = structuredClone(compatible) as PiMateriaConfig;
    testSockets(conflicting.loadouts!.Yolo)["Socket-4"].advance = { cursor: "otherIndex", items: "state.workItems", done: "end", when: "satisfied" };
    expect(() => resolvePipeline(conflicting)).toThrow(/existing advance block.*cursor: current "otherIndex", expected "workItemIndex"/);
  });
});

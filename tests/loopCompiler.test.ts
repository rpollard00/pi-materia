import { describe, expect, test } from "bun:test";
import { compileLoopRegionToChildLoadout } from "../src/graph/loopCompiler.js";
import type { MateriaPipelineConfig, ResolvedMateriaPipeline } from "../src/types.js";

function parallelLoadout(): MateriaPipelineConfig {
  return {
    entry: "Socket-1",
    sockets: {
      "Socket-1": { materia: "Planner", edges: [{ when: "always", to: "Socket-2" }] },
      "Socket-2": {
        materia: "Build",
        parse: "json",
        assign: { result: "$.result" },
        edges: [{ when: "always", to: "Socket-3" }],
      },
      "Socket-3": {
        materia: "Eval",
        parse: "json",
        advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied", done: "Socket-9" },
        edges: [
          { when: "not_satisfied", to: "Socket-2", maxTraversals: 2 },
          { when: "always", to: "Socket-2" },
        ],
      },
      "Socket-9": { materia: "After" },
      "Socket-10": { materia: "Join" },
      "Socket-11": { materia: "Resolve" },
    },
    loops: {
      work: {
        sockets: ["Socket-2", "Socket-3"],
        consumes: { from: "Socket-1", output: "workItems" },
        iterator: { items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "Socket-9" },
        parallel: { planInput: "state.parallelPlan", maxConcurrency: 2, workspaceMode: "jj", failurePolicy: "all_terminal", fanIn: "ordered" },
        exits: [
          { id: "clean", from: "Socket-3", condition: "satisfied", targetSocketId: "Socket-10" },
          { id: "conflict", from: "Socket-3", condition: "not_satisfied", targetSocketId: "Socket-11" },
        ],
      },
    },
  };
}

describe("parallel loop child loadout compiler", () => {
  test("extracts the complete loop, seeds only the ordered lane, and rewrites parent exits", () => {
    const source = parallelLoadout();
    const before = structuredClone(source);
    const result = compileLoopRegionToChildLoadout({
      pipeline: source,
      loopId: "work",
      laneId: "api",
      workItems: [{ title: "A", context: "first" }, { title: "B", context: "second" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(source).toEqual(before);
    expect(result.value.loadout).toEqual({
      entry: "Socket-1",
      sockets: {
        "Socket-1": { materia: "Build", parse: "json", assign: { result: "$.result" }, edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": {
          materia: "Eval",
          parse: "json",
          advance: { cursor: "workItemIndex", items: "state.workItems", when: "satisfied", done: "end" },
          edges: [{ when: "not_satisfied", to: "Socket-1", maxTraversals: 2 }, { when: "always", to: "Socket-1" }],
        },
      },
      loops: {
        work: {
          sockets: ["Socket-1", "Socket-2"],
          iterator: { items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" },
          exits: [
            { id: "clean", from: "Socket-2", condition: "satisfied", targetSocketId: "end" },
            { id: "conflict", from: "Socket-2", condition: "not_satisfied", targetSocketId: "end" },
          ],
        },
      },
    });
    expect(result.value.initialData).toEqual({ workItems: [{ title: "A", context: "first" }, { title: "B", context: "second" }] });
    expect(result.value.socketIdRemapping).toEqual([
      { sourceSocketId: "Socket-2", childSocketId: "Socket-1" },
      { sourceSocketId: "Socket-3", childSocketId: "Socket-2" },
    ]);
    expect(result.value.childLoadoutId).toBe("parallel-child-pipeline-work-api");
  });

  test("retains resolved agent and utility behavior while remapping structural fields", () => {
    const authored = parallelLoadout();
    const resolved: ResolvedMateriaPipeline = {
      entry: { id: "Socket-1", socket: authored.sockets!["Socket-1"]!, materia: { type: "agent", tools: "readOnly", prompt: "plan" } },
      sockets: {
        "Socket-1": { id: "Socket-1", socket: authored.sockets!["Socket-1"]!, materia: { type: "agent", tools: "readOnly", prompt: "plan" } },
        "Socket-2": { id: "Socket-2", socket: authored.sockets!["Socket-2"]!, materia: { type: "agent", tools: "readWrite", prompt: "build", model: "model-a" } },
        "Socket-3": { id: "Socket-3", socket: authored.sockets!["Socket-3"]!, materia: { type: "utility", utility: "eval", params: { strict: true } } },
        "Socket-9": { id: "Socket-9", socket: authored.sockets!["Socket-9"]!, materia: { type: "utility", utility: "after" } },
        "Socket-10": { id: "Socket-10", socket: authored.sockets!["Socket-10"]!, materia: { type: "utility", utility: "join" } },
        "Socket-11": { id: "Socket-11", socket: authored.sockets!["Socket-11"]!, materia: { type: "utility", utility: "resolve" } },
      },
      loops: authored.loops,
    } as unknown as ResolvedMateriaPipeline;

    const result = compileLoopRegionToChildLoadout({ pipeline: resolved, loopId: "work", stream: [{ title: "A", context: "ctx" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const child = result.value.loadout as ResolvedMateriaPipeline;
    expect(child.sockets["Socket-1"]?.materia).toMatchObject({ prompt: "build", tools: "readWrite", model: "model-a" });
    expect(child.sockets["Socket-2"]?.materia).toMatchObject({ utility: "eval", params: { strict: true } });
    expect(child.loops?.work?.parallel).toBeUndefined();
  });

  test("expands normalized stream indexes in their authored order", () => {
    const result = compileLoopRegionToChildLoadout({
      pipeline: parallelLoadout(),
      loopId: "work",
      workItems: [{ title: "zero", context: "0" }, { title: "one", context: "1" }, { title: "two", context: "2" }],
      stream: { laneId: "lane-api", name: "api", workItemIndexes: [2, 0] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.initialData.workItems.map((item) => item.title)).toEqual(["two", "zero"]);
  });

  test("rejects empty or malformed lane streams before compiling a child", () => {
    const empty = compileLoopRegionToChildLoadout({ pipeline: parallelLoadout(), loopId: "work", workItems: [] });
    expect(empty.ok).toBe(false);
    const malformed = compileLoopRegionToChildLoadout({ pipeline: parallelLoadout(), loopId: "work", workItems: [{ title: "A", context: "ctx", extra: true } as never] });
    expect(malformed.ok).toBe(false);
  });
});

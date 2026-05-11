import { describe, expect, test } from "bun:test";
import { buildUtilityInput, executeUtilitySocketWithDeps, type UtilityResolvedSocket } from "../src/application/utilityExecution.js";
import type { MateriaCastState } from "../src/types.js";

function state(): MateriaCastState {
  return {
    version: 1,
    active: true,
    castId: "cast-1",
    request: "do utility work",
    cwd: "/tmp/project",
    runDir: "/tmp/project/.pi/pi-materia/cast-1",
    artifactRoot: "/tmp/project/.pi/pi-materia",
    phase: "Socket-1",
    currentNode: "Socket-1",
    awaitingResponse: false,
    nodeState: "running_utility",
    startedAt: 1,
    updatedAt: 1,
    data: { existing: true },
    cursors: { itemCursor: 2 },
    visits: { "Socket-1": 3 },
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: { castId: "cast-1", runDir: "/tmp/project/.pi/pi-materia/cast-1", startedAt: 1, usage: { total: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, byNode: {}, byModel: {}, byTask: {} } },
    pipeline: { entry: {} as never, sockets: {} },
    currentItemKey: "item-a",
    currentItemLabel: "Item A",
  } as MateriaCastState;
}

function utilitySocket(socket: UtilityResolvedSocket["socket"]): UtilityResolvedSocket {
  return { id: "Socket-1", socket } as UtilityResolvedSocket;
}

describe("application utility execution", () => {
  test("builds stable utility input including legacy nodeId alias", () => {
    const input = buildUtilityInput(state(), utilitySocket({ type: "utility", utility: "echo", params: { answer: 42 } }));
    expect(input).toMatchObject({ cwd: "/tmp/project", request: "do utility work", castId: "cast-1", socketId: "Socket-1", nodeId: "Socket-1", params: { answer: 42 }, itemKey: "item-a", itemLabel: "Item A", state: { existing: true } });
  });

  test("routes command utilities through the command executor boundary and records input", async () => {
    const calls: string[] = [];
    const result = await executeUtilitySocketWithDeps(state(), utilitySocket({ type: "utility", utility: "ignored", command: ["tool"], params: { a: 1 } }), {
      executeCommand: async ({ input }) => {
        calls.push(`command:${input.nodeId}`);
        return "command output";
      },
      executeBuiltInUtility: () => { throw new Error("built-in should not run"); },
      hasBuiltInUtility: () => false,
      recordUtilityInput: async () => "nodes/Socket-1/3.input.json",
      appendUtilityInputEvent: async (artifact, visit) => calls.push(`event:${artifact}:${visit}`),
    });

    expect(result).toEqual({ output: "command output", entryId: "utility:Socket-1:3" });
    expect(calls).toEqual(["event:nodes/Socket-1/3.input.json:3", "command:Socket-1"]);
  });

  test("serializes configured object output with deterministic handoff serializer", async () => {
    const result = await executeUtilitySocketWithDeps(state(), utilitySocket({ type: "utility", utility: "echo", params: { output: { satisfied: true, b: 2, a: 1 } } }), {
      executeCommand: async () => { throw new Error("command should not run"); },
      executeBuiltInUtility: () => { throw new Error("built-in should not run"); },
      hasBuiltInUtility: () => false,
      recordUtilityInput: async () => "input.json",
      appendUtilityInputEvent: async () => {},
    });

    expect(result.output).toBe('{"satisfied":true,"b":2,"a":1}');
  });
});

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
    currentSocketId: "Socket-1",
    awaitingResponse: false,
    socketState: "running_utility",
    startedAt: 1,
    updatedAt: 1,
    data: { existing: true },
    cursors: { itemCursor: 2 },
    visits: { "Socket-1": 3 },
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: { castId: "cast-1", runDir: "/tmp/project/.pi/pi-materia/cast-1", startedAt: 1, usage: { total: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, bySocket: {}, byModel: {}, byTask: {} } },
    pipeline: { entry: {} as never, sockets: {} },
    currentItemKey: "item-a",
    currentItemLabel: "Item A",
  } as MateriaCastState;
}

function utilitySocket(materia: UtilityResolvedSocket["materia"], socket: Partial<UtilityResolvedSocket["socket"]> = {}): UtilityResolvedSocket {
  return { id: "Socket-1", socket: { materia: "Utility", ...socket }, materiaId: "Utility", materia };
}

describe("application utility execution", () => {
  test("builds stable utility input with canonical socketId", () => {
    const input = buildUtilityInput(state(), utilitySocket({ type: "utility", label: "Utility Label", utility: "echo", params: { answer: 42 } }));
    expect(input).toMatchObject({ cwd: "/tmp/project", request: "do utility work", castId: "cast-1", socketId: "Socket-1", materiaId: "Utility", materiaLabel: "Utility Label", params: { answer: 42 }, itemKey: "item-a", itemLabel: "Item A", state: { existing: true } });
  });

  test("routes command utilities through the command executor boundary and records input", async () => {
    const calls: string[] = [];
    const result = await executeUtilitySocketWithDeps(state(), utilitySocket({ type: "utility", utility: "ignored", command: ["tool"], params: { a: 1 } }), {
      executeCommand: async ({ input }) => {
        calls.push(`command:${input.socketId}`);
        return "command output";
      },
      executeBuiltInUtility: () => { throw new Error("built-in should not run"); },
      hasBuiltInUtility: () => false,
      recordUtilityInput: async () => "sockets/Socket-1/3.input.json",
      appendUtilityInputEvent: async (artifact, visit) => calls.push(`event:${artifact}:${visit}`),
    });

    expect(result).toEqual({ output: "command output", entryId: "utility:Socket-1:3" });
    expect(calls).toEqual(["event:sockets/Socket-1/3.input.json:3", "command:Socket-1"]);
  });

  test("uses resolved utility materia instead of inline socket behavior", async () => {
    const result = await executeUtilitySocketWithDeps(state(), utilitySocket({ type: "utility", utility: "echo", params: { output: "from materia" } }, { utility: "wrong", params: { output: "from socket" } }), {
      executeCommand: async () => { throw new Error("command should not run"); },
      executeBuiltInUtility: () => { throw new Error("built-in should not run"); },
      hasBuiltInUtility: () => false,
      recordUtilityInput: async () => "input.json",
      appendUtilityInputEvent: async () => {},
    });

    expect(result.output).toBe("from materia");
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

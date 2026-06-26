import { describe, expect, test } from "bun:test";
import {
  buildPipelineSocketDetails,
  findMultiTurnAgentSockets,
  isAgentControllerPresetActive,
  validateAgentControllerMultiTurnSockets,
} from "../src/runtime/nativeLifecycle.js";
import type {
  PiMateriaConfig,
  ResolvedMateriaAgentSocket,
  ResolvedMateriaPipeline,
  ResolvedMateriaUtilitySocket,
} from "../src/types.js";

// ── Test Helpers ────────────────────────────────────────────────────────

function createAgentSocket(
  id: string,
  materiaId: string,
  multiTurn = false,
): ResolvedMateriaAgentSocket {
  return {
    id,
    socket: { materia: materiaId },
    materia: {
      type: "agent",
      prompt: `You are ${materiaId}.`,
      tools: {},
      multiTurn,
    },
  };
}

function createUtilitySocket(id: string, materiaId: string): ResolvedMateriaUtilitySocket {
  return {
    id,
    socket: { materia: materiaId },
    materiaId,
    materia: {
      type: "utility",
      utility: materiaId,
    },
  };
}

function createPipeline(sockets: Record<string, ResolvedMateriaAgentSocket | ResolvedMateriaUtilitySocket>): ResolvedMateriaPipeline {
  const entryId = Object.keys(sockets)[0] ?? "Socket-1";
  return {
    entry: sockets[entryId],
    sockets,
  };
}

function createConfig(presets?: string[]): PiMateriaConfig {
  return {
    materia: {},
    eventing: presets
      ? {
          enabled: true,
          presets,
        }
      : undefined,
  };
}

// ── isAgentControllerPresetActive ──────────────────────────────────────

describe("isAgentControllerPresetActive", () => {
  test("returns true when agent-controller preset is in presets array", () => {
    const config = createConfig(["agent-controller"]);
    expect(isAgentControllerPresetActive(config)).toBe(true);
  });

  test("returns true when agent-controller is among multiple presets", () => {
    const config = createConfig(["agent-controller", "future-preset"]);
    expect(isAgentControllerPresetActive(config)).toBe(true);
  });

  test("returns false when presets array does not contain agent-controller", () => {
    const config = createConfig(["other-preset"]);
    expect(isAgentControllerPresetActive(config)).toBe(false);
  });

  test("returns false when eventing is undefined", () => {
    const config = createConfig();
    expect(isAgentControllerPresetActive(config)).toBe(false);
  });

  test("returns false when eventing.presets is undefined", () => {
    const config: PiMateriaConfig = {
      materia: {},
      eventing: { enabled: true },
    };
    expect(isAgentControllerPresetActive(config)).toBe(false);
  });

  test("returns false when eventing.presets is empty array", () => {
    const config = createConfig([]);
    expect(isAgentControllerPresetActive(config)).toBe(false);
  });
});

// ── findMultiTurnAgentSockets ──────────────────────────────────────────

describe("findMultiTurnAgentSockets", () => {
  test("returns empty array when no multiTurn agent sockets exist", () => {
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "SingleTurnPlanner", false),
      "Socket-2": createAgentSocket("Socket-2", "Builder", false),
    });

    const result = findMultiTurnAgentSockets(pipeline);
    expect(result).toEqual([]);
  });

  test("returns multiTurn agent sockets", () => {
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "SingleTurnPlanner", false),
      "Socket-2": createAgentSocket("Socket-2", "MultiTurnBuilder", true),
      "Socket-3": createAgentSocket("Socket-3", "MultiTurnReviewer", true),
    });

    const result = findMultiTurnAgentSockets(pipeline);
    expect(result.length).toBe(2);
    expect(result[0].socketId).toBe("Socket-2");
    expect(result[0].materiaName).toBe("MultiTurnBuilder");
    expect(result[0].isAgent).toBe(true);
    expect(result[0].multiTurn).toBe(true);
    expect(result[1].socketId).toBe("Socket-3");
    expect(result[1].materiaName).toBe("MultiTurnReviewer");
  });

  test("excludes utility sockets even if they appear in the pipeline", () => {
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "Planner", false),
      "Socket-2": createUtilitySocket("Socket-2", "GitUtility"),
    });

    const result = findMultiTurnAgentSockets(pipeline);
    expect(result).toEqual([]);
  });

  test("excludes non-multiTurn agent sockets", () => {
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "Planner", false),
      "Socket-2": createAgentSocket("Socket-2", "Builder", false),
      "Socket-3": createUtilitySocket("Socket-3", "GitUtility"),
    });

    const result = findMultiTurnAgentSockets(pipeline);
    expect(result).toEqual([]);
  });

  test("returns all sockets when all are multiTurn agents", () => {
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "MultiTurnPlanner", true),
      "Socket-2": createAgentSocket("Socket-2", "MultiTurnBuilder", true),
    });

    const result = findMultiTurnAgentSockets(pipeline);
    expect(result.length).toBe(2);
  });
});

// ── buildPipelineSocketDetails ─────────────────────────────────────────

describe("buildPipelineSocketDetails", () => {
  test("returns details for all sockets in the pipeline", () => {
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "Planner", false),
      "Socket-2": createAgentSocket("Socket-2", "Builder", true),
      "Socket-3": createUtilitySocket("Socket-3", "GitUtility"),
    });

    const details = buildPipelineSocketDetails(pipeline);
    expect(details.length).toBe(3);

    const socket1 = details.find((d) => d.socketId === "Socket-1");
    expect(socket1).toMatchObject({
      socketId: "Socket-1",
      materiaName: "Planner",
      isAgent: true,
      multiTurn: false,
    });

    const socket2 = details.find((d) => d.socketId === "Socket-2");
    expect(socket2).toMatchObject({
      socketId: "Socket-2",
      materiaName: "Builder",
      isAgent: true,
      multiTurn: true,
    });

    const socket3 = details.find((d) => d.socketId === "Socket-3");
    expect(socket3).toMatchObject({
      socketId: "Socket-3",
      materiaName: "GitUtility",
      isAgent: false,
      multiTurn: false,
    });
  });

  test("uses socket id as fallback materia name when materia has no label or id", () => {
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "SomeMateria", false),
    });

    const details = buildPipelineSocketDetails(pipeline);
    expect(details[0].materiaName).toBe("SomeMateria");
  });
});

// ── validateAgentControllerMultiTurnSockets ────────────────────────────

describe("validateAgentControllerMultiTurnSockets", () => {
  // (a) single-turn agent socket under agent-controller is allowed through
  test("single-turn agent socket under agent-controller is allowed through", () => {
    const config = createConfig(["agent-controller"]);
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "AutoPlanner", false),
      "Socket-2": createAgentSocket("Socket-2", "Builder", false),
    });

    const result = validateAgentControllerMultiTurnSockets(config, pipeline);
    expect(result.ok).toBe(true);
    expect(result.offendingSockets).toEqual([]);
    expect(result.errorMessage).toBeUndefined();
  });

  // (b) multiTurn agent socket under agent-controller aborts before agent turn
  test("multiTurn agent socket under agent-controller aborts with clear error", () => {
    const config = createConfig(["agent-controller"]);
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "AutoPlanner", false),
      "Socket-2": createAgentSocket("Socket-2", "InteractiveBuilder", true),
    });

    const result = validateAgentControllerMultiTurnSockets(config, pipeline);
    expect(result.ok).toBe(false);
    expect(result.offendingSockets.length).toBe(1);
    expect(result.offendingSockets[0].socketId).toBe("Socket-2");
    expect(result.offendingSockets[0].materiaName).toBe("InteractiveBuilder");
    expect(result.errorMessage).toBeDefined();
    expect(result.errorMessage).toContain("agent-controller");
    expect(result.errorMessage).toContain("multiTurn");
    expect(result.errorMessage).toContain("Socket-2");
    expect(result.errorMessage).toContain("InteractiveBuilder");
    expect(result.errorMessage).toContain("/materia continue");
  });

  // (c) multiTurn socket under interactive/CLI eventing is allowed through
  test("multiTurn socket under interactive/CLI eventing is allowed through", () => {
    // No agent-controller preset — interactive mode
    const config = createConfig(["other-preset"]);
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "Planner", false),
      "Socket-2": createAgentSocket("Socket-2", "InteractiveBuilder", true),
    });

    const result = validateAgentControllerMultiTurnSockets(config, pipeline);
    expect(result.ok).toBe(true);
    expect(result.offendingSockets).toEqual([]);
  });

  test("multiTurn socket with no eventing preset is allowed through", () => {
    const config = createConfig(); // no eventing at all
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "Planner", false),
      "Socket-2": createAgentSocket("Socket-2", "InteractiveBuilder", true),
    });

    const result = validateAgentControllerMultiTurnSockets(config, pipeline);
    expect(result.ok).toBe(true);
    expect(result.offendingSockets).toEqual([]);
  });

  // (d) failure artifact contains the resolved socket names and multiTurn flags
  test("failure result contains resolved socket names and multiTurn flags", () => {
    const config = createConfig(["agent-controller"]);
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "AutoPlanner", false),
      "Socket-2": createAgentSocket("Socket-2", "InteractiveBuilder", true),
      "Socket-3": createAgentSocket("Socket-3", "InteractiveReviewer", true),
    });

    const result = validateAgentControllerMultiTurnSockets(config, pipeline);
    expect(result.ok).toBe(false);
    expect(result.offendingSockets.length).toBe(2);

    // Verify each offending socket has the correct details
    const socket2 = result.offendingSockets.find((s) => s.socketId === "Socket-2");
    expect(socket2).toMatchObject({
      socketId: "Socket-2",
      materiaName: "InteractiveBuilder",
      isAgent: true,
      multiTurn: true,
    });

    const socket3 = result.offendingSockets.find((s) => s.socketId === "Socket-3");
    expect(socket3).toMatchObject({
      socketId: "Socket-3",
      materiaName: "InteractiveReviewer",
      isAgent: true,
      multiTurn: true,
    });

    // Verify the error message names both offending sockets
    expect(result.errorMessage).toContain("Socket-2");
    expect(result.errorMessage).toContain("InteractiveBuilder");
    expect(result.errorMessage).toContain("Socket-3");
    expect(result.errorMessage).toContain("InteractiveReviewer");
  });

  test("allows utility sockets under agent-controller regardless of multiTurn", () => {
    const config = createConfig(["agent-controller"]);
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "AutoPlanner", false),
      "Socket-2": createUtilitySocket("Socket-2", "GitUtility"),
      "Socket-3": createAgentSocket("Socket-3", "Builder", false),
    });

    const result = validateAgentControllerMultiTurnSockets(config, pipeline);
    expect(result.ok).toBe(true);
    expect(result.offendingSockets).toEqual([]);
  });

  test("error message references /materia continue as the reason", () => {
    const config = createConfig(["agent-controller"]);
    const pipeline = createPipeline({
      "Socket-1": createAgentSocket("Socket-1", "InteractiveBuilder", true),
    });

    const result = validateAgentControllerMultiTurnSockets(config, pipeline);
    expect(result.errorMessage).toContain("/materia continue");
  });
});

import { describe, expect, test } from "bun:test";
import { resolvePipeline } from "../src/runtime/pipeline.js";
import { buildPipelineSocketDetails, findMultiTurnAgentSockets, isAgentControllerPresetActive, validateAgentControllerMultiTurnSockets } from "../src/runtime/nativeLifecycle.js";
import { resolvedMateriaDisplayName, resolvedMateriaId } from "../src/runtime/resolvedMateria.js";
import type { PiMateriaConfig } from "../src/types.js";

/**
 * Regression test for: Elena Socket-3 Auto-Plana → Interactive-Plani divergence.
 *
 * Pins the expected behavior: a loadout socket's `materia` field must resolve
 * to exactly the materia definition it references. The resolution pipeline
 * does NOT transform, remap, or substitute materia references.
 *
 * The actual root cause was a user loadout authoring error: the Elena loadout's
 * Socket-3 `materia` field was set to "Interactive-Plani" instead of "Auto-Plana"
 * (likely from copying a Planning-Consult-derived loadout). The resolution code
 * correctly resolved whatever the loadout socket referenced.
 *
 * See: docs/investigations/socket-3-materia-divergence.md
 */
describe("socket materia binding regression (Elena Socket-3 divergence)", () => {
  function buildConfig(activeLoadout: string, socket3Materia: string): PiMateriaConfig {
    return {
      artifactDir: ".pi/pi-materia",
      activeLoadout,
      loadouts: {
        [activeLoadout]: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Detect-VCS", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Detect-VCS", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-3": { materia: socket3Materia, edges: [{ when: "always", to: "Socket-4" }] },
            "Socket-4": { materia: "Build" },
          },
        },
      },
      materia: {
        "Detect-VCS": { type: "utility", utility: "project.detectVcs", parse: "json" },
        "Auto-Plana": {
          type: "agent",
          tools: "readOnly",
          prompt: "You are the auto-planning materia.",
          parse: "json",
          generator: true,
          // Single-turn: no multiTurn flag (defaults to false)
        },
        "Interactive-Plani": {
          type: "agent",
          tools: "readOnly",
          prompt: "You are the interactive planning materia.",
          parse: "json",
          multiTurn: true,
          generator: true,
        },
        Build: {
          type: "agent",
          tools: "coding",
          prompt: "You are the build materia.",
          parse: "text",
        },
      },
    };
  }

  test("socket materia reference resolves to the exact materia id it references", () => {
    // When Socket-3 references "Auto-Plana", the resolved pipeline must show "Auto-Plana"
    const config = buildConfig("Elena", "Auto-Plana");
    const pipeline = resolvePipeline(config);

    const socket3 = pipeline.sockets["Socket-3"];
    expect(socket3).toBeDefined();

    // The resolved materia id must match the loadout socket's materia string
    const materiaId = resolvedMateriaId(socket3);
    expect(materiaId).toBe("Auto-Plana");

    // Display name (label ?? id) should also be "Auto-Plana" (no label set)
    const displayName = resolvedMateriaDisplayName(socket3);
    expect(displayName).toBe("Auto-Plana");
  });

  test("socket materia reference resolves correctly when set to Interactive-Plani", () => {
    // When Socket-3 references "Interactive-Plani", the resolved pipeline must show "Interactive-Plani"
    // This reproduces the actual divergence: the Elena loadout had this wrong binding.
    const config = buildConfig("Elena", "Interactive-Plani");
    const pipeline = resolvePipeline(config);

    const socket3 = pipeline.sockets["Socket-3"];
    expect(socket3).toBeDefined();

    const materiaId = resolvedMateriaId(socket3);
    expect(materiaId).toBe("Interactive-Plani");

    const displayName = resolvedMateriaDisplayName(socket3);
    expect(displayName).toBe("Interactive-Plani");
  });

  test("pipeline socket details reflect the loadout socket materia reference", () => {
    // Verify buildPipelineSocketDetails correctly extracts the materia name
    const config = buildConfig("Elena", "Auto-Plana");
    const pipeline = resolvePipeline(config);
    const details = buildPipelineSocketDetails(pipeline);

    const socket3Detail = details.find((d) => d.socketId === "Socket-3");
    expect(socket3Detail).toBeDefined();
    expect(socket3Detail!.materiaName).toBe("Auto-Plana");
    expect(socket3Detail!.isAgent).toBe(true);
    expect(socket3Detail!.multiTurn).toBe(false);
  });

  test("multiTurn agent socket is detected in pipeline socket details", () => {
    // When Socket-3 references a multiTurn materia, it must be flagged
    const config = buildConfig("Elena", "Interactive-Plani");
    const pipeline = resolvePipeline(config);
    const details = buildPipelineSocketDetails(pipeline);

    const socket3Detail = details.find((d) => d.socketId === "Socket-3");
    expect(socket3Detail).toBeDefined();
    expect(socket3Detail!.materiaName).toBe("Interactive-Plani");
    expect(socket3Detail!.isAgent).toBe(true);
    expect(socket3Detail!.multiTurn).toBe(true);
  });

  test("findMultiTurnAgentSockets identifies Interactive-Plani on Socket-3", () => {
    const config = buildConfig("Elena", "Interactive-Plani");
    const pipeline = resolvePipeline(config);
    const multiTurnSockets = findMultiTurnAgentSockets(pipeline);

    expect(multiTurnSockets.length).toBe(1);
    expect(multiTurnSockets[0].socketId).toBe("Socket-3");
    expect(multiTurnSockets[0].materiaName).toBe("Interactive-Plani");
    expect(multiTurnSockets[0].multiTurn).toBe(true);
  });

  test("findMultiTurnAgentSockets returns empty for Auto-Plana on Socket-3", () => {
    const config = buildConfig("Elena", "Auto-Plana");
    const pipeline = resolvePipeline(config);
    const multiTurnSockets = findMultiTurnAgentSockets(pipeline);

    expect(multiTurnSockets.length).toBe(0);
  });

  test("agent-controller preset rejects multiTurn agent sockets", () => {
    const configWithMultiTurn: PiMateriaConfig = {
      ...buildConfig("Elena", "Interactive-Plani"),
      eventing: { enabled: true, presets: ["agent-controller"], sinks: {}, heartbeatIntervalMs: 30000 },
    };
    const pipeline = resolvePipeline(configWithMultiTurn);

    expect(isAgentControllerPresetActive(configWithMultiTurn)).toBe(true);

    const validation = validateAgentControllerMultiTurnSockets(configWithMultiTurn, pipeline);
    expect(validation.ok).toBe(false);
    expect(validation.offendingSockets.length).toBe(1);
    expect(validation.offendingSockets[0].socketId).toBe("Socket-3");
    expect(validation.errorMessage).toContain("Socket-3");
    expect(validation.errorMessage).toContain("Interactive-Plani");
  });

  test("agent-controller preset allows single-turn agent sockets", () => {
    const configWithSingleTurn: PiMateriaConfig = {
      ...buildConfig("Elena", "Auto-Plana"),
      eventing: { enabled: true, presets: ["agent-controller"], sinks: {}, heartbeatIntervalMs: 30000 },
    };
    const pipeline = resolvePipeline(configWithSingleTurn);

    expect(isAgentControllerPresetActive(configWithSingleTurn)).toBe(true);

    const validation = validateAgentControllerMultiTurnSockets(configWithSingleTurn, pipeline);
    expect(validation.ok).toBe(true);
    expect(validation.offendingSockets.length).toBe(0);
  });

  test("non-agent-controller preset does not reject multiTurn agent sockets", () => {
    const configInteractive: PiMateriaConfig = {
      ...buildConfig("Elena", "Interactive-Plani"),
      eventing: { enabled: true, presets: ["interactive"], sinks: {}, heartbeatIntervalMs: 30000 },
    };
    const pipeline = resolvePipeline(configInteractive);

    expect(isAgentControllerPresetActive(configInteractive)).toBe(false);

    const validation = validateAgentControllerMultiTurnSockets(configInteractive, pipeline);
    expect(validation.ok).toBe(true);
    // multiTurn sockets are valid under interactive eventing (human can drive /materia continue)
  });
});

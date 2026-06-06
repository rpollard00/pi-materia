import { describe, expect, test } from "bun:test";
import {
  buildMateriaPalette,
  canonicalizeUtilitySocketReferences,
  materiaPaletteSocket,
  normalizeMateriaConfigEdges,
  placeMateriaInSocket,
  type MateriaConfig,
  type MateriaBehaviorConfig,
} from "../src/webui/client/src/loadoutModel.js";

const agentGeneratorMateria: Record<string, MateriaBehaviorConfig> = {
  "Auto-Plan": { type: "agent", tools: "readOnly", prompt: "Plan.", generator: true, parse: "json" },
  Build: { type: "agent", tools: "coding", prompt: "Build." },
};

const utilityGeneratorMateria: Record<string, MateriaBehaviorConfig> = {
  "Commit-Sigil": { type: "utility", command: ["node", "commit.mjs"], generator: true, parse: "json", assign: { lastFeedback: "$.context" } },
  "Ignore-Artifacts": { type: "utility", command: ["node", "ignore.mjs"], parse: "json" },
};

describe("WebUI materia palette for generator sockets", () => {
  test("materiaPaletteSocket omits parse and assign for agent generator materia", () => {
    const socket = materiaPaletteSocket("Auto-Plan", agentGeneratorMateria["Auto-Plan"]);
    // Generator materia owns parse/assign; palette socket should not carry them
    expect(socket.parse).toBeUndefined();
    expect(socket.assign).toBeUndefined();
    expect(socket.materia).toBe("Auto-Plan");
  });

  test("materiaPaletteSocket omits parse and assign for utility generator materia", () => {
    const socket = materiaPaletteSocket("Commit-Sigil", utilityGeneratorMateria["Commit-Sigil"]);
    expect(socket.parse).toBeUndefined();
    expect(socket.assign).toBeUndefined();
    expect(socket.materia).toBe("Commit-Sigil");
  });

  test("materiaPaletteSocket preserves parse and assign for non-generator agent materia", () => {
    const socket = materiaPaletteSocket("Build", agentGeneratorMateria["Build"]);
    // Non-generator agents preserve their defined parse (if any)
    expect(socket.parse).toBeUndefined(); // Build has no explicit parse in our test data
    expect(socket.materia).toBe("Build");
  });

  test("materiaPaletteSocket preserves parse for non-generator agent with explicit parse", () => {
    const defs: Record<string, MateriaBehaviorConfig> = {
      Eval: { type: "agent", tools: "none", prompt: "Eval.", parse: "json" },
    };
    const socket = materiaPaletteSocket("Eval", defs["Eval"]);
    expect(socket.parse).toBe("json");
    expect(socket.assign).toBeUndefined();
    expect(socket.materia).toBe("Eval");
  });

  test("buildMateriaPalette returns generator materia sockets without parse/assign", () => {
    const palette = buildMateriaPalette({
      ...agentGeneratorMateria,
      "Ignore-Artifacts": utilityGeneratorMateria["Ignore-Artifacts"],
    });
    const map = new Map(palette);

    // Agent generator: no parse/assign
    const autoPlan = map.get("Auto-Plan");
    expect(autoPlan?.parse).toBeUndefined();
    expect(autoPlan?.assign).toBeUndefined();
    expect(autoPlan?.materia).toBe("Auto-Plan");

    // Non-generator agent: keeps its parse (none in this case)
    const build = map.get("Build");
    expect(build?.materia).toBe("Build");

    // Utility: minimal socket
    const ignore = map.get("Ignore-Artifacts");
    expect(ignore?.materia).toBe("Ignore-Artifacts");
    expect(ignore?.parse).toBeUndefined();
    expect(ignore?.assign).toBeUndefined();
  });

  test("placeMateriaInSocket does not reintroduce parse/assign for generator materia", () => {
    const paletteSocket = materiaPaletteSocket("Auto-Plan", agentGeneratorMateria["Auto-Plan"]);
    const placed = placeMateriaInSocket({ socketKind: "normal" }, paletteSocket);
    expect(placed.parse).toBeUndefined();
    expect(placed.assign).toBeUndefined();
    expect(placed.materia).toBe("Auto-Plan");
    expect(placed.empty).toBe(false);
  });
});

describe("WebUI normalization prunes legacy generator socket fields", () => {
  test("normalizeMateriaConfigEdges prunes canonical parse:json from agent generator sockets", () => {
    const config: MateriaConfig = {
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Auto-Plan", parse: "json", assign: { workItems: "$.workItems" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Build", parse: "text" },
          },
          loops: {
            workLoop: { sockets: ["Socket-2"], consumes: { from: "Socket-1", output: "workItems" } },
          },
        },
      },
      materia: agentGeneratorMateria,
    };

    const normalized = normalizeMateriaConfigEdges(config);

    const s1 = normalized.loadouts?.Test?.sockets?.["Socket-1"];
    expect(s1?.materia).toBe("Auto-Plan");
    // Legacy canonical parse/assign should be pruned
    expect(s1?.parse).toBeUndefined();
    expect(s1?.assign).toBeUndefined();
    // Non-generator socket parse preserved
    const s2 = normalized.loadouts?.Test?.sockets?.["Socket-2"];
    expect(s2?.parse).toBe("text");
  });

  test("normalizeMateriaConfigEdges preserves non-canonical parse values on generator sockets for runtime rejection", () => {
    const config: MateriaConfig = {
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Auto-Plan", parse: "text", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Build" },
          },
        },
      },
      materia: agentGeneratorMateria,
    };

    const normalized = normalizeMateriaConfigEdges(config);

    const s1 = normalized.loadouts?.Test?.sockets?.["Socket-1"];
    // Non-json parse on a generator socket is preserved for runtime rejection
    expect(s1?.parse).toBe("text");
  });

  test("normalizeMateriaConfigEdges preserves non-workItems assign keys on generator sockets", () => {
    const config: MateriaConfig = {
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Auto-Plan", assign: { workItems: "$.workItems", lastPlan: "$" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Build" },
          },
        },
      },
      materia: agentGeneratorMateria,
    };

    const normalized = normalizeMateriaConfigEdges(config);

    const s1 = normalized.loadouts?.Test?.sockets?.["Socket-1"];
    // workItems is pruned (canonical), but lastPlan is preserved
    expect(s1?.assign?.workItems).toBeUndefined();
    expect(s1?.assign?.lastPlan).toBe("$");
  });

  test("normalizeMateriaConfigEdges does not modify non-generator agent socket parse/assign", () => {
    const config: MateriaConfig = {
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Build", parse: "text", assign: { lastBuild: "$" } },
          },
        },
      },
      materia: agentGeneratorMateria,
    };

    const normalized = normalizeMateriaConfigEdges(config);

    const s1 = normalized.loadouts?.Test?.sockets?.["Socket-1"];
    expect(s1?.parse).toBe("text");
    expect(s1?.assign).toEqual({ lastBuild: "$" });
  });

  test("normalizeMateriaConfigEdges handles clean generator sockets without modification", () => {
    const config: MateriaConfig = {
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Auto-Plan", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Build" },
          },
        },
      },
      materia: agentGeneratorMateria,
    };

    const normalized = normalizeMateriaConfigEdges(config);

    const s1 = normalized.loadouts?.Test?.sockets?.["Socket-1"];
    expect(s1?.parse).toBeUndefined();
    expect(s1?.assign).toBeUndefined();
    expect(s1?.materia).toBe("Auto-Plan");
  });
});

describe("WebUI canonicalizeUtilitySocketReferences", () => {
  test("removes executable fields from utility sockets", () => {
    const config: MateriaConfig = {
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": {
              materia: "Commit-Sigil",
              utility: "old-project.commit",
              command: ["node", "stale.mjs"],
              params: { flag: true },
              timeoutMs: 5000,
              parse: "json",
              assign: { workItems: "$.workItems" },
              edges: [{ when: "always", to: "Socket-2" }],
            },
            "Socket-2": { materia: "Build" },
          },
        },
      },
      materia: { ...utilityGeneratorMateria, Build: agentGeneratorMateria["Build"] },
    };

    const cleaned = canonicalizeUtilitySocketReferences(config);

    const s1 = cleaned.loadouts?.Test?.sockets?.["Socket-1"];
    // Executable fields removed
    expect(s1?.utility).toBeUndefined();
    expect(s1?.command).toBeUndefined();
    expect(s1?.params).toBeUndefined();
    expect(s1?.timeoutMs).toBeUndefined();
    expect(s1?.parse).toBeUndefined();
    expect(s1?.assign).toBeUndefined();
    // Materia reference preserved
    expect(s1?.materia).toBe("Commit-Sigil");
    // Structure preserved
    expect(s1?.edges).toEqual([{ when: "always", to: "Socket-2" }]);
  });

  test("does not modify non-utility agent sockets", () => {
    const config: MateriaConfig = {
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Build", parse: "text", assign: { lastBuild: "$" } },
          },
        },
      },
      materia: agentGeneratorMateria,
    };

    const cleaned = canonicalizeUtilitySocketReferences(config);

    const s1 = cleaned.loadouts?.Test?.sockets?.["Socket-1"];
    expect(s1?.materia).toBe("Build");
    expect(s1?.parse).toBe("text");
    expect(s1?.assign).toEqual({ lastBuild: "$" });
  });
});

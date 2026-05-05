import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { renderGrid, resolvePipeline } from "../src/pipeline.js";
import type { PiMateriaConfig } from "../src/types.js";

const baseLoadout = {
  entry: "hello",
  nodes: {
    hello: {
      type: "utility" as const,
      command: ["node", "hello.js"],
      parse: "json" as const,
      params: { name: "world" },
      next: "ignored",
      foreach: { items: "state.items", as: "item", done: "end" },
      limits: { maxVisits: 2, maxEdgeTraversals: 3, maxOutputBytes: 1024 },
      timeoutMs: 5000,
    },
    ignored: {
      type: "utility" as const,
      utility: "project.ensureIgnored",
      parse: "text" as const,
    },
  },
};

const baseConfig: PiMateriaConfig = {
  artifactDir: ".pi/pi-materia",
  activeLoadout: "Test",
  loadouts: { Test: baseLoadout },
  roles: {},
};

function activeLoadout(config: PiMateriaConfig) {
  return config.loadouts![config.activeLoadout!]!;
}

describe("loadout-aware pipeline resolution", () => {
  test("configs without named loadouts are rejected", () => {
    expect(() => resolvePipeline({ artifactDir: ".pi/pi-materia", roles: {} })).toThrow(/must define named "loadouts"/);
  });

  test("activeLoadout selects a named graph while sharing roles", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Planning-Consult",
      loadouts: {
        "Full-Auto": {
          entry: "planner",
          nodes: { planner: { type: "agent", role: "planner" } },
        },
        "Planning-Consult": {
          entry: "interactivePlan",
          nodes: { interactivePlan: { type: "agent", role: "interactivePlan" } },
        },
      },
      roles: {
        planner: { tools: "readOnly", systemPrompt: "Plan automatically." },
        interactivePlan: { tools: "readOnly", systemPrompt: "Plan interactively.", multiTurn: true },
      },
    };

    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(pipeline.entry.id).toBe("interactivePlan");
    expect(pipeline.entry.node.type).toBe("agent");
    expect(pipeline.entry.role.systemPrompt).toBe("Plan interactively.");
    expect(lines).toContain("loadout: Planning-Consult");
  });

  test("unknown activeLoadout names include valid options", () => {
    const config: PiMateriaConfig = {
      activeLoadout: "Missing",
      loadouts: {
        "Full-Auto": baseLoadout,
        "Planning-Consult": baseLoadout,
      },
      roles: {},
    };

    expect(() => resolvePipeline(config)).toThrow(/Unknown active Materia loadout "Missing"\. Available loadouts: Full-Auto, Planning-Consult/);
  });
});

describe("utility pipeline nodes", () => {
  test("resolvePipeline accepts command and named utility nodes", () => {
    const pipeline = resolvePipeline(baseConfig);

    expect(pipeline.entry.node.type).toBe("utility");
    expect(pipeline.nodes.ignored.node.type).toBe("utility");
  });

  test("renderGrid shows utility command, parse, routing, foreach, limits, and timeout", () => {
    const pipeline = resolvePipeline(baseConfig);
    const lines = renderGrid(baseConfig, pipeline, "test", "/tmp/project");

    expect(lines).toContain("- none configured");

    const hello = lines.find((line) => line.startsWith("- hello:"));
    expect(hello).toContain("type=utility");
    expect(hello).toContain('command="node" "hello.js"');
    expect(hello).toContain("parse=json");
    expect(hello).toContain("next=ignored");
    expect(hello).toContain("foreach=state.items as item done end");
    expect(hello).toContain("limits=visits 2/edges 3/output 1024B");
    expect(hello).toContain("timeoutMs=5000");

    const ignored = lines.find((line) => line.startsWith("- ignored:"));
    expect(ignored).toContain("utility=project.ensureIgnored");
  });

  test("renderGrid shows mixed explicit and active Pi model role settings", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      loadouts: {
        Test: {
          entry: "planner",
          nodes: {
            planner: { type: "agent", role: "planner", next: "Build" },
            Build: { type: "agent", role: "Build" },
          },
        },
      },
      roles: {
        planner: {
          tools: "readOnly",
          systemPrompt: "Plan.",
          model: "anthropic/claude-haiku",
          thinking: "low",
        },
        Build: {
          tools: "coding",
          systemPrompt: "Build.",
        },
      },
    };
    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(lines).toContain("- planner: tools=readOnly, model=anthropic/claude-haiku, thinking=low");
    expect(lines).toContain("- Build: tools=coding, model=active Pi model, thinking=active Pi thinking");

    const planner = lines.find((line) => line.startsWith("- planner: type=agent"));
    expect(planner).toContain("role=planner");
    expect(planner).toContain("tools=readOnly");
    expect(planner).toContain("model=anthropic/claude-haiku");
    expect(planner).toContain("thinking=low");

    const build = lines.find((line) => line.startsWith("- Build: type=agent"));
    expect(build).toContain("tools=coding");
    expect(build).toContain("model=active Pi model");
    expect(build).toContain("thinking=active Pi thinking");
  });

  test("rejects utility nodes without command or utility", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).nodes.hello = { type: "utility" };

    expect(() => resolvePipeline(config)).toThrow(/must configure either "utility" or "command"/);
  });

  test("rejects unsupported parse modes with a friendly error", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).nodes.hello = { type: "utility", utility: "example", parse: "yaml" as never };

    expect(() => resolvePipeline(config)).toThrow(/unsupported parse mode "yaml"/);
  });

  test("accepts multi-turn roles and renders roles plus agent slots with role-derived capability", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      loadouts: {
        Test: {
          entry: "interactivePlan",
          nodes: {
            interactivePlan: { type: "agent", role: "planner", parse: "json" },
          },
        },
      },
      roles: {
        planner: { tools: "readOnly", systemPrompt: "Plan interactively.", multiTurn: true },
      },
    };

    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(pipeline.entry.node.type).toBe("agent");
    expect(pipeline.entry.role.multiTurn).toBe(true);
    expect(lines).toContain("- planner: tools=readOnly, multiTurn=true, model=active Pi model, thinking=active Pi thinking");
    expect(lines.find((line) => line.startsWith("- interactivePlan:"))).toContain("role.multiTurn=true");
  });

  test("rejects obsolete node-level multiTurn", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).nodes.hello = { type: "utility", utility: "example", multiTurn: true } as never;

    expect(() => resolvePipeline(config)).toThrow(/obsolete multiTurn/);
  });

  test("rejects malformed multiTurn values on roles", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      loadouts: {
        Test: {
          entry: "planner",
          nodes: {
            planner: { type: "agent", role: "planner" },
          },
        },
      },
      roles: {
        planner: { tools: "readOnly", systemPrompt: "Plan.", multiTurn: "yes" as never },
      },
    };

    expect(() => resolvePipeline(config)).toThrow(/Materia role "planner" has invalid multiTurn/);
  });

  test("rejects malformed command arrays with a friendly error", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).nodes.hello = { type: "utility", command: ["node", ""] };

    expect(() => resolvePipeline(config)).toThrow(/malformed command element at index 1/);
  });

  test("default loadout shows explicit utility bootstrap before agent nodes", async () => {
    const config = JSON.parse(await readFile("config/default.json", "utf8")) as PiMateriaConfig;
    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "default", "/tmp/project");

    const loadout = activeLoadout(config);
    expect(loadout.entry).toBe("ensureArtifactsIgnored");
    expect(pipeline.entry.node.type).toBe("utility");
    expect(loadout.nodes.ensureArtifactsIgnored).toMatchObject({
      type: "utility",
      utility: "project.ensureIgnored",
      next: "detectVcs",
    });
    expect(loadout.nodes.detectVcs).toMatchObject({
      type: "utility",
      utility: "vcs.detect",
      assign: { vcs: "$" },
      next: "planner",
    });

    const slotsIndex = lines.indexOf("Slots:");
    const ensureLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- ensureArtifactsIgnored:"));
    const detectLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- detectVcs:"));
    const plannerLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- planner:"));
    expect(ensureLineIndex).toBeGreaterThanOrEqual(0);
    expect(detectLineIndex).toBeGreaterThan(ensureLineIndex);
    expect(plannerLineIndex).toBeGreaterThan(detectLineIndex);
    expect(lines[ensureLineIndex]).toContain("utility=project.ensureIgnored");
    expect(lines[detectLineIndex]).toContain("utility=vcs.detect");
    expect(loadout.nodes.Maintain).toMatchObject({
      type: "agent",
      role: "Maintain",
      parse: "json",
      assign: { lastMaintain: "$" },
      advance: { cursor: "taskIndex", items: "state.tasks", when: "$.satisfied == true" },
      edges: [{ when: "$.satisfied == false", to: "Maintain", maxTraversals: 3 }],
    });
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { renderGrid, resolvePipeline } from "../src/pipeline.js";
import type { PiMateriaConfig } from "../src/types.js";

const baseConfig: PiMateriaConfig = {
  artifactDir: ".pi/pi-materia",
  pipeline: {
    entry: "hello",
    nodes: {
      hello: {
        type: "utility",
        command: ["node", "hello.js"],
        parse: "json",
        params: { name: "world" },
        next: "ignored",
        foreach: { items: "state.items", as: "item", done: "end" },
        limits: { maxVisits: 2, maxEdgeTraversals: 3, maxOutputBytes: 1024 },
        timeoutMs: 5000,
      },
      ignored: {
        type: "utility",
        utility: "project.ensureIgnored",
        parse: "text",
      },
    },
  },
  roles: {},
};

describe("loadout-aware pipeline resolution", () => {
  test("legacy top-level pipeline configs still resolve", () => {
    const pipeline = resolvePipeline(baseConfig);

    expect(pipeline.entry.id).toBe("hello");
    expect(pipeline.entry.node.type).toBe("utility");
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
          nodes: { interactivePlan: { type: "agent", role: "interactivePlan", multiTurn: true } },
        },
      },
      roles: {
        planner: { tools: "readOnly", systemPrompt: "Plan automatically." },
        interactivePlan: { tools: "readOnly", systemPrompt: "Plan interactively." },
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
        "Full-Auto": baseConfig.pipeline!,
        "Planning-Consult": baseConfig.pipeline!,
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
      pipeline: {
        entry: "planner",
        nodes: {
          planner: { type: "agent", role: "planner", next: "Build" },
          Build: { type: "agent", role: "Build" },
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
    config.pipeline.nodes.hello = { type: "utility" };

    expect(() => resolvePipeline(config)).toThrow(/must configure either "utility" or "command"/);
  });

  test("rejects unsupported parse modes with a friendly error", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    config.pipeline.nodes.hello = { type: "utility", utility: "example", parse: "yaml" as never };

    expect(() => resolvePipeline(config)).toThrow(/unsupported parse mode "yaml"/);
  });

  test("accepts multi-turn agent nodes and renders them", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      pipeline: {
        entry: "interactivePlan",
        nodes: {
          interactivePlan: { type: "agent", role: "planner", multiTurn: true, parse: "json" },
        },
      },
      roles: {
        planner: { tools: "readOnly", systemPrompt: "Plan interactively." },
      },
    };

    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(pipeline.entry.node.type).toBe("agent");
    expect(pipeline.entry.node.multiTurn).toBe(true);
    expect(lines.find((line) => line.startsWith("- interactivePlan:"))).toContain("multiTurn=true");
  });

  test("rejects multi-turn utility nodes", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    config.pipeline.nodes.hello = { type: "utility", utility: "example", multiTurn: true } as never;

    expect(() => resolvePipeline(config)).toThrow(/multi-turn is only supported for agent nodes/);
  });

  test("rejects malformed multiTurn values on agent nodes", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      pipeline: {
        entry: "planner",
        nodes: {
          planner: { type: "agent", role: "planner", multiTurn: "yes" as never },
        },
      },
      roles: {
        planner: { tools: "readOnly", systemPrompt: "Plan." },
      },
    };

    expect(() => resolvePipeline(config)).toThrow(/invalid multiTurn/);
  });

  test("rejects malformed command arrays with a friendly error", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    config.pipeline.nodes.hello = { type: "utility", command: ["node", ""] };

    expect(() => resolvePipeline(config)).toThrow(/malformed command element at index 1/);
  });

  test("default loadout shows explicit utility bootstrap before agent nodes", async () => {
    const config = JSON.parse(await readFile("config/default.json", "utf8")) as PiMateriaConfig;
    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "default", "/tmp/project");

    expect(config.pipeline.entry).toBe("ensureArtifactsIgnored");
    expect(pipeline.entry.node.type).toBe("utility");
    expect(config.pipeline.nodes.ensureArtifactsIgnored).toMatchObject({
      type: "utility",
      utility: "project.ensureIgnored",
      next: "detectVcs",
    });
    expect(config.pipeline.nodes.detectVcs).toMatchObject({
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
    expect(config.pipeline.nodes.Maintain).toMatchObject({
      type: "agent",
      role: "Maintain",
      parse: "json",
      assign: { lastMaintain: "$" },
      advance: { cursor: "taskIndex", items: "state.tasks", when: "$.satisfied == true" },
      edges: [{ when: "$.satisfied == false", to: "Maintain", maxTraversals: 3 }],
    });
  });
});

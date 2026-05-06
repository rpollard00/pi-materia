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
  materia: {},
};

function activeLoadout(config: PiMateriaConfig) {
  return config.loadouts![config.activeLoadout!]!;
}

describe("loadout-aware pipeline resolution", () => {
  test("configs without named loadouts or a valid activeLoadout are rejected clearly", () => {
    expect(() => resolvePipeline({ artifactDir: ".pi/pi-materia", materia: {} })).toThrow(/must define named "loadouts"/);
    expect(() => resolvePipeline({
      artifactDir: ".pi/pi-materia",
      loadouts: { Test: { entry: "hello", nodes: { hello: { type: "utility", utility: "echo" } } } },
      materia: {},
    })).toThrow(/No active Materia loadout configured/);
  });

  test("activeLoadout selects a named graph while sharing materia", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Planning-Consult",
      loadouts: {
        "Full-Auto": {
          entry: "planner",
          nodes: { planner: { type: "agent", materia: "planner" } },
        },
        "Planning-Consult": {
          entry: "interactivePlan",
          nodes: { interactivePlan: { type: "agent", materia: "interactivePlan" } },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan automatically." },
        interactivePlan: { tools: "readOnly", prompt: "Plan interactively.", multiTurn: true },
      },
    };

    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(pipeline.entry.id).toBe("interactivePlan");
    expect(pipeline.entry.node.type).toBe("agent");
    expect(pipeline.entry.materia.prompt).toBe("Plan interactively.");
    expect(lines).toContain("loadout: Planning-Consult");
  });

  test("rejects direct pipeline configs with loadout-level prompt fields", () => {
    const withPrompt = structuredClone(baseConfig) as PiMateriaConfig;
    (activeLoadout(withPrompt) as unknown as Record<string, unknown>).prompt = "obsolete loadout behavior";
    expect(() => resolvePipeline(withPrompt)).toThrow(/loadout "Test" configures obsolete prompt/);

    const withSystemPrompt = structuredClone(baseConfig) as PiMateriaConfig;
    (activeLoadout(withSystemPrompt) as unknown as Record<string, unknown>).systemPrompt = "obsolete loadout system behavior";
    expect(() => resolvePipeline(withSystemPrompt)).toThrow(/loadout "Test" configures obsolete systemPrompt/);
  });

  test("rejects direct pipeline configs with obsolete or invalid materia prompt fields", () => {
    const withSystemPrompt: PiMateriaConfig = {
      ...baseConfig,
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", systemPrompt: "obsolete materia system behavior" } as never,
      },
    };
    expect(() => resolvePipeline(withSystemPrompt)).toThrow(/Materia "planner" configures obsolete systemPrompt/);

    const withoutPrompt: PiMateriaConfig = {
      ...baseConfig,
      materia: {
        planner: { tools: "readOnly" } as never,
      },
    };
    expect(() => resolvePipeline(withoutPrompt)).toThrow(/Materia "planner" has invalid prompt\. Expected a string/);

    const withNonStringPrompt: PiMateriaConfig = {
      ...baseConfig,
      materia: {
        planner: { tools: "readOnly", prompt: 42 } as never,
      },
    };
    expect(() => resolvePipeline(withNonStringPrompt)).toThrow(/Materia "planner" has invalid prompt\. Expected a string/);
  });

  test("unknown activeLoadout names include valid options", () => {
    const config: PiMateriaConfig = {
      activeLoadout: "Missing",
      loadouts: {
        "Full-Auto": baseLoadout,
        "Planning-Consult": baseLoadout,
      },
      materia: {},
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

  test("renderGrid shows mixed explicit and active Pi model materia settings", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      loadouts: {
        Test: {
          entry: "planner",
          nodes: {
            planner: { type: "agent", materia: "planner", next: "Build" },
            Build: { type: "agent", materia: "Build" },
          },
        },
      },
      materia: {
        planner: {
          tools: "readOnly",
          prompt: "Plan.",
          model: "anthropic/claude-haiku",
          thinking: "low",
        },
        Build: {
          tools: "coding",
          prompt: "Build.",
        },
      },
    };
    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(lines).toContain("- planner: tools=readOnly, model=anthropic/claude-haiku, thinking=low");
    expect(lines).toContain("- Build: tools=coding, model=active Pi model, thinking=active Pi thinking");

    const planner = lines.find((line) => line.startsWith("- planner: type=agent"));
    expect(planner).toContain("materia=planner");
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

  test("accepts multi-turn materia and renders materia plus agent slots with materia-derived capability", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      loadouts: {
        Test: {
          entry: "interactivePlan",
          nodes: {
            interactivePlan: { type: "agent", materia: "planner", parse: "json" },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan interactively.", multiTurn: true },
      },
    };

    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(pipeline.entry.node.type).toBe("agent");
    expect(pipeline.entry.materia.multiTurn).toBe(true);
    expect(lines).toContain("- planner: tools=readOnly, multiTurn=true, model=active Pi model, thinking=active Pi thinking");
    expect(lines.find((line) => line.startsWith("- interactivePlan:"))).toContain("materia.multiTurn=true");
  });

  test("rejects obsolete node-level multiTurn", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).nodes.hello = { type: "utility", utility: "example", multiTurn: true } as never;

    expect(() => resolvePipeline(config)).toThrow(/obsolete multiTurn/);
  });

  test("rejects malformed multiTurn values on materia", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      loadouts: {
        Test: {
          entry: "planner",
          nodes: {
            planner: { type: "agent", materia: "planner" },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", multiTurn: "yes" as never },
      },
    };

    expect(() => resolvePipeline(config)).toThrow(/Materia "planner" has invalid multiTurn/);
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
      materia: "Maintain",
      parse: "json",
      assign: { lastMaintain: "$" },
      advance: { cursor: "taskIndex", items: "state.tasks", done: "end", when: "$.satisfied == true" },
      edges: [{ when: "$.satisfied == false", to: "Maintain", maxTraversals: 3 }],
    });

    const maintainPrompt = config.materia.Maintain!.prompt;
    expect(maintainPrompt).toContain("Always inspect repository state before checkpointing");
    expect(maintainPrompt).toContain("Inspect the repository state first");
    expect(maintainPrompt).toContain("checkpointCreated=false");
    expect(maintainPrompt).toContain("No-op tasks must not create empty commits/checkpoints");
    expect(maintainPrompt).toContain("do not run jj describe, jj new, git add, git commit");

    const gitMaintainPrompt = config.materia.GitMaintain!.prompt;
    expect(gitMaintainPrompt).toContain("Inspect repository state before committing");
    expect(gitMaintainPrompt).toContain("checkpointCreated=false");
    expect(gitMaintainPrompt).toContain("No-op tasks must not create empty commits/checkpoints");
    expect(gitMaintainPrompt).toContain("do not run git add, git commit");
  });
});

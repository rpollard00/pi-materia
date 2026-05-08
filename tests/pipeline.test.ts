import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { loopIteratorForNode, renderGrid, resolvePipeline } from "../src/pipeline.js";
import type { PiMateriaConfig } from "../src/types.js";

const baseLoadout = {
  entry: "Socket-1",
  nodes: {
    "Socket-1": {
      type: "utility" as const,
      command: ["node", "hello.js"],
      parse: "json" as const,
      params: { name: "world" },
      next: "Socket-2",
      foreach: { items: "state.items", as: "item", done: "end" },
      limits: { maxVisits: 2, maxEdgeTraversals: 3, maxOutputBytes: 1024 },
      timeoutMs: 5000,
    },
    "Socket-2": {
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
      loadouts: { Test: { entry: "Socket-1", nodes: { "Socket-1": { type: "utility", utility: "echo" } } } },
      materia: {},
    })).toThrow(/No active Materia loadout configured/);
  });

  test("activeLoadout selects a named graph while sharing materia", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Planning-Consult",
      loadouts: {
        "Full-Auto": {
          entry: "Socket-1",
          nodes: { "Socket-1": { type: "agent", materia: "planner" } },
        },
        "Planning-Consult": {
          entry: "Socket-1",
          nodes: { "Socket-1": { type: "agent", materia: "interactivePlan" } },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan automatically." },
        interactivePlan: { tools: "readOnly", prompt: "Plan interactively.", multiTurn: true },
      },
    };

    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(pipeline.entry.id).toBe("Socket-1");
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

  test("resolvePipeline uses shared graph validation for ordered outgoing edges and missing endpoints", () => {
    const withUnreachableEdge = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(withUnreachableEdge).nodes["Socket-1"].edges = [
      { when: "always", to: "Socket-2" },
      { when: "satisfied", to: "Socket-2" },
    ];
    expect(() => resolvePipeline(withUnreachableEdge)).toThrow(/unreachable outgoing edge/);

    const withMissingEdgeEndpoint = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(withMissingEdgeEndpoint).nodes["Socket-1"].edges = [{ when: "satisfied", to: undefined as never }];
    expect(() => resolvePipeline(withMissingEdgeEndpoint)).toThrow(/Missing graph endpoint referenced by Socket-1\.edges\[0\]\.to/);
  });

  test("resolvePipeline derives loop iterator metadata from a declared generator consumer", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          loops: {
            taskIteration: {
              label: "Generated workItems loop",
              nodes: ["Socket-2"],
              consumes: { from: "Socket-1", output: "workItems" },
              exit: { from: "Socket-2", when: "satisfied", to: "end" },
            },
          },
          nodes: {
            "Socket-1": { type: "agent", materia: "planner", parse: "json", assign: { workItems: "$.workItems" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generator: true },
        Build: { tools: "coding", prompt: "Build." },
      },
    };

    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(pipeline.loops?.taskIteration.iterator).toEqual({ items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" });
    expect(loopIteratorForNode(pipeline, "Socket-2")?.items).toBe("state.workItems");
    expect(lines).toContain("- planner: tools=readOnly, model=active Pi model, thinking=active Pi thinking, generator=workItems:array<workItem>");
    expect(lines).toContain("loop taskIteration (Generated workItems loop): [Socket-2] consumes=Socket-1.workItems iterator=state.workItems as workItem done end exit=Socket-2.satisfied->end");
  });

  test("resolvePipeline migrates legacy iterator loops when one inbound generator edge identifies the consumer", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          loops: {
            taskIteration: {
              label: "Legacy generated task loop",
              nodes: ["Socket-2", "Socket-3"],
              iterator: { items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" },
              exit: { from: "Socket-3", when: "satisfied", to: "end" },
            },
          },
          nodes: {
            "Socket-1": { type: "agent", materia: "planner", parse: "json", assign: { tasks: "$.tasks" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-3": { type: "agent", materia: "Check", edges: [{ when: "always", to: "Socket-2" }] },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generates: { output: "tasks", as: "task", cursor: "taskIndex", done: "end", listType: "array", itemType: "task" } },
        Build: { tools: "coding", prompt: "Build." },
        Check: { tools: "none", prompt: "Check." },
      },
    };

    const pipeline = resolvePipeline(config);

    expect(pipeline.loops?.taskIteration.consumes).toEqual({ from: "Socket-1", output: "tasks" });
    expect(pipeline.loops?.taskIteration.iterator).toEqual({ items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" });
  });

  test("resolvePipeline gives clear guidance when a legacy iterator loop has multiple inbound generators", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          loops: { taskIteration: { nodes: ["Socket-2", "Socket-3"], iterator: { items: "state.tasks" } } },
          nodes: {
            "Socket-1": { type: "agent", materia: "planner", parse: "json", assign: { tasks: "$.tasks" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-4": { type: "agent", materia: "otherPlanner", parse: "json", assign: { work: "$.work" }, edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-2": { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-3": { type: "agent", materia: "Check", edges: [{ when: "always", to: "Socket-2" }] },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generates: { output: "tasks", listType: "array", itemType: "task" } },
        otherPlanner: { tools: "readOnly", prompt: "Plan more.", generates: { output: "work", listType: "array", itemType: "task" } },
        Build: { tools: "coding", prompt: "Build." },
        Check: { tools: "none", prompt: "Check." },
      },
    };

    expect(() => resolvePipeline(config)).toThrow(/Legacy loop "taskIteration" declares iterator metadata but no consumes generator.*Socket-1, Socket-4/);
  });

  test("resolvePipeline preserves explicit loop iterator metadata for runtime lookup and grid rendering", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          loops: {
            taskIteration: {
              label: "Build → Eval → Maintain until all tasks complete",
              nodes: ["Socket-1", "Socket-2", "Socket-3"],
              iterator: { items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" },
              exit: { from: "Socket-3", when: "satisfied", to: "end" },
            },
          },
          nodes: {
            "Socket-1": { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { type: "agent", materia: "Auto-Eval", edges: [{ when: "satisfied", to: "Socket-3" }, { when: "not_satisfied", to: "Socket-1" }] },
            "Socket-3": { type: "agent", materia: "Maintain", edges: [{ when: "always", to: "Socket-1" }] },
          },
        },
      },
      materia: {
        Build: { tools: "coding", prompt: "Build." },
        "Auto-Eval": { tools: "none", prompt: "Evaluate." },
        Maintain: { tools: "coding", prompt: "Maintain." },
      },
    };

    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(pipeline.loops?.taskIteration.nodes).toEqual(["Socket-1", "Socket-2", "Socket-3"]);
    expect(loopIteratorForNode(pipeline, "Socket-3")?.cursor).toBe("taskIndex");
    expect(lines).toContain("loop taskIteration (Build → Eval → Maintain until all tasks complete): [Socket-1, Socket-2, Socket-3] iterator=state.tasks as task done end exit=Socket-3.satisfied->end");
  });

  test("resolvePipeline accepts repeated guarded iterative workflow branches", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          nodes: {
            "Socket-1": { type: "agent", materia: "Build", next: "Socket-2" },
            "Socket-2": {
              type: "agent",
              materia: "Auto-Eval",
              edges: [
                { when: "satisfied", to: "Socket-3" },
                { when: "satisfied", to: "Socket-1", maxTraversals: 3 },
                { when: "not_satisfied", to: "Socket-1", maxTraversals: 3 },
              ],
            },
            "Socket-3": { type: "agent", materia: "Maintain", next: "Socket-1" },
          },
        },
      },
      materia: {
        Build: { tools: "coding", prompt: "Build." },
        "Auto-Eval": { tools: "none", prompt: "Evaluate." },
        Maintain: { tools: "coding", prompt: "Maintain." },
      },
    };

    expect(resolvePipeline(config).entry.id).toBe("Socket-1");
  });
});

describe("utility pipeline nodes", () => {
  test("resolvePipeline accepts command and named utility nodes", () => {
    const pipeline = resolvePipeline(baseConfig);

    expect(pipeline.entry.node.type).toBe("utility");
    expect(pipeline.nodes["Socket-2"].node.type).toBe("utility");
  });

  test("renderGrid shows utility command, parse, routing, foreach, limits, and timeout", () => {
    const pipeline = resolvePipeline(baseConfig);
    const lines = renderGrid(baseConfig, pipeline, "test", "/tmp/project");

    expect(lines).toContain("- none configured");

    const hello = lines.find((line) => line.startsWith("- Socket-1:"));
    expect(hello).toContain("type=utility");
    expect(hello).toContain('command="node" "hello.js"');
    expect(hello).toContain("parse=json");
    expect(hello).toContain("edges=always->Socket-2");
    expect(hello).toContain("foreach=state.items as item done end");
    expect(hello).toContain("limits=visits 2/edges 3/output 1024B");
    expect(hello).toContain("timeoutMs=5000");

    const ignored = lines.find((line) => line.startsWith("- Socket-2:"));
    expect(ignored).toContain("utility=project.ensureIgnored");
  });

  test("renderGrid shows mixed explicit and active Pi model materia settings", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      loadouts: {
        Test: {
          entry: "Socket-1",
          nodes: {
            "Socket-1": { type: "agent", materia: "planner", next: "Socket-2" },
            "Socket-2": { type: "agent", materia: "Build" },
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

    const planner = lines.find((line) => line.startsWith("- Socket-1: type=agent"));
    expect(planner).toContain("materia=planner");
    expect(planner).toContain("tools=readOnly");
    expect(planner).toContain("model=anthropic/claude-haiku");
    expect(planner).toContain("thinking=low");

    const build = lines.find((line) => line.startsWith("- Socket-2: type=agent"));
    expect(build).toContain("tools=coding");
    expect(build).toContain("model=active Pi model");
    expect(build).toContain("thinking=active Pi thinking");
  });

  test("rejects utility nodes without command or utility", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).nodes["Socket-1"] = { type: "utility" };

    expect(() => resolvePipeline(config)).toThrow(/must configure either "utility" or "command"/);
  });

  test("rejects unsupported parse modes with a friendly error", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).nodes["Socket-1"] = { type: "utility", utility: "example", parse: "yaml" as never };

    expect(() => resolvePipeline(config)).toThrow(/unsupported parse mode "yaml"/);
  });

  test("accepts multi-turn materia and renders materia plus agent slots with materia-derived capability", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      loadouts: {
        Test: {
          entry: "Socket-1",
          nodes: {
            "Socket-1": { type: "agent", materia: "planner", parse: "json" },
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
    expect(lines.find((line) => line.startsWith("- Socket-1:"))).toContain("materia.multiTurn=true");
  });

  test("rejects obsolete node-level multiTurn", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).nodes["Socket-1"] = { type: "utility", utility: "example", multiTurn: true } as never;

    expect(() => resolvePipeline(config)).toThrow(/obsolete multiTurn/);
  });

  test("loop generator consumers require a selected cycle and exactly one inbound generator edge", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          nodes: {
            "Socket-1": { type: "agent", materia: "customGenerator", parse: "json", assign: { work: "$.work" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-3": { type: "agent", materia: "Check", edges: [{ when: "always", to: "Socket-2" }] },
          },
          loops: { workLoop: { nodes: ["Socket-2", "Socket-3"], consumes: { from: "Socket-1", output: "work" } } },
        },
      },
      materia: {
        customGenerator: { tools: "readOnly", prompt: "Make work.", generates: { output: "work", listType: "array", itemType: "work-item", as: "workItem" } },
        Build: { tools: "coding", prompt: "Build." },
        Check: { tools: "none", prompt: "Check." },
      },
    };

    const resolved = resolvePipeline(config);
    expect(resolved.loops?.workLoop.iterator).toMatchObject({ items: "state.work", as: "workItem" });

    const noCycle = structuredClone(config) as PiMateriaConfig;
    noCycle.loadouts!.Loop.nodes["Socket-3"].edges = [{ when: "always", to: "end" }];
    expect(() => resolvePipeline(noCycle)).toThrow(/must contain a directed cycle/);

    const missingGeneratorInput = structuredClone(config) as PiMateriaConfig;
    missingGeneratorInput.loadouts!.Loop.nodes["Socket-1"].edges = [{ when: "always", to: "end" }];
    expect(() => resolvePipeline(missingGeneratorInput)).toThrow(/exactly one inbound edge from a generator socket.*found none/s);

    const multipleGeneratorInputs = structuredClone(config) as PiMateriaConfig;
    multipleGeneratorInputs.loadouts!.Loop.nodes["Socket-4"] = { type: "agent", materia: "otherGenerator", parse: "json", assign: { moreWork: "$.moreWork" }, edges: [{ when: "always", to: "Socket-3" }] };
    multipleGeneratorInputs.materia.otherGenerator = { tools: "readOnly", prompt: "Make more work.", generates: { output: "moreWork", listType: "array", itemType: "work-item" } };
    expect(() => resolvePipeline(multipleGeneratorInputs)).toThrow(/exactly one inbound edge from a generator socket.*found 2/s);
  });

  test("generator declarations must map to JSON-assigned list outputs", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          nodes: {
            "Socket-1": { type: "agent", materia: "planner", parse: "text", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
          },
          loops: { taskIteration: { nodes: ["Socket-2"], consumes: { from: "Socket-1", output: "tasks" } } },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generates: { output: "tasks", listType: "array", itemType: "task" } },
        Build: { tools: "coding", prompt: "Build." },
      },
    };

    expect(() => resolvePipeline(config)).toThrow(/Generator pipeline slot "Socket-1" must parse JSON/);

    config.loadouts!.Test.nodes["Socket-1"].parse = "json";
    expect(() => resolvePipeline(config)).toThrow(/must assign generated output "tasks"/);

    config.loadouts!.Test.nodes["Socket-1"].assign = { tasks: "$.tasks" };
    expect(resolvePipeline(config).entry.materia.generates?.output).toBe("tasks");

    config.materia.planner!.generates = { output: "tasks", itemType: "task" } as never;
    expect(() => resolvePipeline(config)).toThrow(/invalid generates\.listType/);

    config.materia.planner!.generates = { output: "tasks", listType: "array", itemType: "" } as never;
    expect(() => resolvePipeline(config)).toThrow(/invalid generates\.itemType/);
  });

  test("rejects malformed multiTurn values on materia", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      loadouts: {
        Test: {
          entry: "Socket-1",
          nodes: {
            "Socket-1": { type: "agent", materia: "planner" },
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
    activeLoadout(config).nodes["Socket-1"] = { type: "utility", command: ["node", ""] };

    expect(() => resolvePipeline(config)).toThrow(/malformed command element at index 1/);
  });

  test("default loadout shows explicit utility bootstrap before agent nodes", async () => {
    const config = JSON.parse(await readFile("config/default.json", "utf8")) as PiMateriaConfig;
    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "default", "/tmp/project");

    const loadout = activeLoadout(config);
    expect(loadout.entry).toBe("Socket-1");
    expect(Object.keys(loadout.nodes)).toEqual(["Socket-1", "Socket-2", "Socket-3", "Socket-4", "Socket-5", "Socket-6"]);
    expect(pipeline.entry.node.type).toBe("utility");
    expect(loadout.nodes["Socket-1"]).toMatchObject({
      type: "utility",
      utility: "project.ensureIgnored",
      edges: [{ when: "always", to: "Socket-2" }],
    });
    expect(loadout.nodes["Socket-2"]).toMatchObject({
      type: "utility",
      utility: "vcs.detect",
      assign: { vcs: "$" },
      edges: [{ when: "always", to: "Socket-3" }],
    });
    expect(JSON.stringify(loadout.nodes)).not.toContain('"next"');

    const slotsIndex = lines.indexOf("Slots:");
    const ensureLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- Socket-1:"));
    const detectLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- Socket-2:"));
    const plannerLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- Socket-3:"));
    expect(ensureLineIndex).toBeGreaterThanOrEqual(0);
    expect(detectLineIndex).toBeGreaterThan(ensureLineIndex);
    expect(plannerLineIndex).toBeGreaterThan(detectLineIndex);
    expect(lines[ensureLineIndex]).toContain("utility=project.ensureIgnored");
    expect(lines[detectLineIndex]).toContain("utility=vcs.detect");
    expect(config.materia.planner?.generator).toBe(true);
    expect(loadout.loops?.taskIteration.nodes).toEqual(["Socket-4", "Socket-5", "Socket-6"]);
    expect(loadout.loops?.taskIteration.exit).toEqual({ from: "Socket-6", when: "satisfied", to: "end" });
    expect(loadout.loops?.taskIteration.consumes).toEqual({ from: "Socket-3", output: "workItems" });
    expect(pipeline.loops?.taskIteration.iterator).toEqual({ items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" });
    expect(loadout.nodes["Socket-6"]).toMatchObject({
      type: "agent",
      materia: "Maintain",
      parse: "json",
      assign: { lastMaintain: "$" },
      advance: { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" },
      edges: [
        { when: "not_satisfied", to: "Socket-6", maxTraversals: 3 },
        { when: "always", to: "Socket-4" },
      ],
    });

    const maintainPrompt = config.materia.Maintain!.prompt;
    expect(maintainPrompt).toContain("Always inspect repository state before checkpointing");
    expect(maintainPrompt).toContain("Inspect the repository state first");
    expect(maintainPrompt).toContain("checkpointCreated=false");
    expect(maintainPrompt).toContain("No-op work items must not create empty commits/checkpoints");
    expect(maintainPrompt).toContain("do not run jj describe, jj new, git add, git commit");

    const gitMaintainPrompt = config.materia.GitMaintain!.prompt;
    expect(gitMaintainPrompt).toContain("Inspect repository state before committing");
    expect(gitMaintainPrompt).toContain("checkpointCreated=false");
    expect(gitMaintainPrompt).toContain("No-op work items must not create empty commits/checkpoints");
    expect(gitMaintainPrompt).toContain("do not run git add, git commit");
  });
});

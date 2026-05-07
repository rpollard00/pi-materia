import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { loopIteratorForNode, renderGrid, resolvePipeline } from "../src/pipeline.js";
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

  test("resolvePipeline uses shared graph validation for ordered outgoing edges and missing endpoints", () => {
    const withUnreachableEdge = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(withUnreachableEdge).nodes.hello.edges = [
      { when: "always", to: "ignored" },
      { when: "satisfied", to: "ignored" },
    ];
    expect(() => resolvePipeline(withUnreachableEdge)).toThrow(/unreachable outgoing edge/);

    const withMissingEdgeEndpoint = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(withMissingEdgeEndpoint).nodes.hello.edges = [{ when: "satisfied", to: undefined as never }];
    expect(() => resolvePipeline(withMissingEdgeEndpoint)).toThrow(/Missing graph endpoint referenced by hello\.edges\[0\]\.to/);
  });

  test("resolvePipeline derives loop iterator metadata from a declared generator consumer", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Plan",
          loops: {
            taskIteration: {
              label: "Generated task loop",
              nodes: ["Build"],
              consumes: { from: "Plan", output: "tasks" },
              exit: { when: "satisfied", to: "end" },
            },
          },
          nodes: {
            Plan: { type: "agent", materia: "planner", parse: "json", assign: { tasks: "$.tasks" }, edges: [{ when: "always", to: "Build" }] },
            Build: { type: "agent", materia: "Build", edges: [{ when: "always", to: "Build" }] },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generates: { output: "tasks", as: "task", cursor: "taskIndex", done: "end", listType: "array", itemType: "task" } },
        Build: { tools: "coding", prompt: "Build." },
      },
    };

    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(pipeline.loops?.taskIteration.iterator).toEqual({ items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" });
    expect(loopIteratorForNode(pipeline, "Build")?.items).toBe("state.tasks");
    expect(lines).toContain("- planner: tools=readOnly, model=active Pi model, thinking=active Pi thinking, generates=tasks:array<task>");
    expect(lines).toContain("loop taskIteration (Generated task loop): [Build] consumes=Plan.tasks iterator=state.tasks as task done end exit=satisfied->end");
  });

  test("resolvePipeline preserves explicit loop iterator metadata for runtime lookup and grid rendering", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Build",
          loops: {
            taskIteration: {
              label: "Build → Eval → Maintain until all tasks complete",
              nodes: ["Build", "Auto-Eval", "Maintain"],
              iterator: { items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" },
              exit: { when: "satisfied", to: "end" },
            },
          },
          nodes: {
            Build: { type: "agent", materia: "Build", edges: [{ when: "always", to: "Auto-Eval" }] },
            "Auto-Eval": { type: "agent", materia: "Auto-Eval", edges: [{ when: "satisfied", to: "Maintain" }, { when: "not_satisfied", to: "Build" }] },
            Maintain: { type: "agent", materia: "Maintain", edges: [{ when: "always", to: "Build" }] },
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

    expect(pipeline.loops?.taskIteration.nodes).toEqual(["Build", "Auto-Eval", "Maintain"]);
    expect(loopIteratorForNode(pipeline, "Maintain")?.cursor).toBe("taskIndex");
    expect(lines).toContain("loop taskIteration (Build → Eval → Maintain until all tasks complete): [Build, Auto-Eval, Maintain] iterator=state.tasks as task done end exit=satisfied->end");
  });

  test("resolvePipeline accepts repeated guarded iterative workflow branches", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Build",
          nodes: {
            Build: { type: "agent", materia: "Build", next: "Auto-Eval" },
            "Auto-Eval": {
              type: "agent",
              materia: "Auto-Eval",
              edges: [
                { when: "satisfied", to: "Maintain" },
                { when: "satisfied", to: "Build", maxTraversals: 3 },
                { when: "not_satisfied", to: "Build", maxTraversals: 3 },
              ],
            },
            Maintain: { type: "agent", materia: "Maintain", next: "Build" },
          },
        },
      },
      materia: {
        Build: { tools: "coding", prompt: "Build." },
        "Auto-Eval": { tools: "none", prompt: "Evaluate." },
        Maintain: { tools: "coding", prompt: "Maintain." },
      },
    };

    expect(resolvePipeline(config).entry.id).toBe("Build");
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
    expect(hello).toContain("edges=always->ignored");
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

  test("loop generator consumers require a selected cycle and exactly one inbound generator edge", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "ListMaker",
          nodes: {
            ListMaker: { type: "agent", materia: "customGenerator", parse: "json", assign: { work: "$.work" }, edges: [{ when: "always", to: "Build" }] },
            Build: { type: "agent", materia: "Build", edges: [{ when: "always", to: "Check" }] },
            Check: { type: "agent", materia: "Check", edges: [{ when: "always", to: "Build" }] },
          },
          loops: { workLoop: { nodes: ["Build", "Check"], consumes: { from: "ListMaker", output: "work" } } },
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
    noCycle.loadouts!.Loop.nodes.Check.edges = [{ when: "always", to: "end" }];
    expect(() => resolvePipeline(noCycle)).toThrow(/must contain a directed cycle/);

    const missingGeneratorInput = structuredClone(config) as PiMateriaConfig;
    missingGeneratorInput.loadouts!.Loop.nodes.ListMaker.edges = [{ when: "always", to: "end" }];
    expect(() => resolvePipeline(missingGeneratorInput)).toThrow(/exactly one inbound edge from a generator socket.*found none/s);

    const multipleGeneratorInputs = structuredClone(config) as PiMateriaConfig;
    multipleGeneratorInputs.loadouts!.Loop.nodes.OtherMaker = { type: "agent", materia: "otherGenerator", parse: "json", assign: { moreWork: "$.moreWork" }, edges: [{ when: "always", to: "Check" }] };
    multipleGeneratorInputs.materia.otherGenerator = { tools: "readOnly", prompt: "Make more work.", generates: { output: "moreWork", listType: "array", itemType: "work-item" } };
    expect(() => resolvePipeline(multipleGeneratorInputs)).toThrow(/exactly one inbound edge from a generator socket.*found 2/s);
  });

  test("generator declarations must map to JSON-assigned list outputs", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "planner",
          nodes: {
            planner: { type: "agent", materia: "planner", parse: "text", edges: [{ when: "always", to: "Build" }] },
            Build: { type: "agent", materia: "Build", edges: [{ when: "always", to: "Build" }] },
          },
          loops: { taskIteration: { nodes: ["Build"], consumes: { from: "planner", output: "tasks" } } },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generates: { output: "tasks", listType: "array", itemType: "task" } },
        Build: { tools: "coding", prompt: "Build." },
      },
    };

    expect(() => resolvePipeline(config)).toThrow(/Generator pipeline slot "planner" must parse JSON/);

    config.loadouts!.Test.nodes.planner.parse = "json";
    expect(() => resolvePipeline(config)).toThrow(/must assign generated output "tasks"/);

    config.loadouts!.Test.nodes.planner.assign = { tasks: "$.tasks" };
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
      edges: [{ when: "always", to: "detectVcs" }],
    });
    expect(loadout.nodes.detectVcs).toMatchObject({
      type: "utility",
      utility: "vcs.detect",
      assign: { vcs: "$" },
      edges: [{ when: "always", to: "planner" }],
    });
    expect(JSON.stringify(loadout.nodes)).not.toContain('"next"');

    const slotsIndex = lines.indexOf("Slots:");
    const ensureLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- ensureArtifactsIgnored:"));
    const detectLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- detectVcs:"));
    const plannerLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- planner:"));
    expect(ensureLineIndex).toBeGreaterThanOrEqual(0);
    expect(detectLineIndex).toBeGreaterThan(ensureLineIndex);
    expect(plannerLineIndex).toBeGreaterThan(detectLineIndex);
    expect(lines[ensureLineIndex]).toContain("utility=project.ensureIgnored");
    expect(lines[detectLineIndex]).toContain("utility=vcs.detect");
    expect(config.materia.planner?.generates).toMatchObject({ output: "tasks", listType: "array", itemType: "task" });
    expect(loadout.loops?.taskIteration.consumes).toEqual({ from: "planner", output: "tasks" });
    expect(pipeline.loops?.taskIteration.iterator).toEqual({ items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" });
    expect(loadout.nodes.Maintain).toMatchObject({
      type: "agent",
      materia: "Maintain",
      parse: "json",
      assign: { lastMaintain: "$" },
      advance: { cursor: "taskIndex", items: "state.tasks", done: "end", when: "satisfied" },
      edges: [
        { when: "not_satisfied", to: "Maintain", maxTraversals: 3 },
        { when: "always", to: "Build" },
      ],
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

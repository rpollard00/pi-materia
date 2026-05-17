import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { loopIteratorForSocket, renderGrid, resolvePipeline } from "../src/runtime/pipeline.js";
import { effectiveResolvedSocketConfig } from "../src/runtime/resolvedMateria.js";
import type { PiMateriaConfig } from "../src/types.js";

const baseLoadout = {
  entry: "Socket-1",
  sockets: {
    "Socket-1": {
      materia: "HelloUtility",
      edges: [{ when: 'always', to: 'Socket-2' }],
      foreach: { items: "state.items", as: "item", done: "end" },
      limits: { maxVisits: 2, maxEdgeTraversals: 3, maxOutputBytes: 1024 },
    },
    "Socket-2": {
      materia: "Ignore-Artifacts",
    },
  },
};

const baseConfig: PiMateriaConfig = {
  artifactDir: ".pi/pi-materia",
  activeLoadout: "Test",
  loadouts: { Test: baseLoadout },
  materia: {
    HelloUtility: { type: "utility", command: ["node", "hello.js"], parse: "json", params: { name: "world" }, timeoutMs: 5000 },
    "Ignore-Artifacts": { type: "utility", utility: "project.ensureIgnored", parse: "text" },
  },
};

function activeLoadout(config: PiMateriaConfig) {
  return config.loadouts![config.activeLoadout!]!;
}

function testSockets(loadout: NonNullable<PiMateriaConfig["loadouts"]>[string]) {
  return loadout.sockets!;
}

describe("loadout-aware pipeline resolution", () => {
  test("configs without named loadouts or a valid activeLoadout are rejected clearly", () => {
    expect(() => resolvePipeline({ artifactDir: ".pi/pi-materia", materia: {} })).toThrow(/must define named "loadouts"/);
    expect(() => resolvePipeline({
      artifactDir: ".pi/pi-materia",
      loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { utility: "echo" } } } },
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
          sockets: { "Socket-1": { materia: "planner" } },
        },
        "Planning-Consult": {
          entry: "Socket-1",
          sockets: { "Socket-1": { materia: "interactivePlan" } },
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
    expect(pipeline.entry.socket).toEqual(expect.objectContaining({ materia: "interactivePlan" }));
    expect(pipeline.sockets["Socket-1"]).toBe(pipeline.entry);
    expect(pipeline.sockets["Socket-1"]).toBe(pipeline.sockets["Socket-1"]);
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
    activeLoadout(withUnreachableEdge).sockets["Socket-1"].edges = [
      { when: "always", to: "Socket-2" },
      { when: "satisfied", to: "Socket-2" },
    ];
    expect(() => resolvePipeline(withUnreachableEdge)).toThrow(/unreachable outgoing edge/);

    const withMissingEdgeEndpoint = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(withMissingEdgeEndpoint).sockets["Socket-1"].edges = [{ when: "satisfied", to: undefined as never }];
    expect(() => resolvePipeline(withMissingEdgeEndpoint)).toThrow(/Missing graph endpoint referenced by Socket-1\.edges\[0\]\.to/);
  });

  test("resolvePipeline materializes executable loop exit semantics from generator consumer metadata", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Yolo",
      loadouts: {
        Yolo: {
          entry: "Socket-1",
          loops: {
            loopSelection: {
              sockets: ["Socket-3", "Socket-4"],
              consumes: { from: "Socket-1", output: "workItems" },
              exit: { from: "Socket-4", when: "satisfied", to: "Socket-2" },
            },
          },
          sockets: {
            "Socket-1": { materia: "planner", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-2": { materia: "Done" },
            "Socket-3": { materia: "Build", edges: [{ when: "always", to: "Socket-4" }] },
            "Socket-4": { materia: "Maintain", edges: [{ when: "always", to: "Socket-3" }] },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generator: true },
        Build: { tools: "coding", prompt: "Build." },
        Maintain: { tools: "coding", prompt: "Maintain." },
        Done: { tools: "none", prompt: "Done." },
      },
    };

    const pipeline = resolvePipeline(config);

    expect(pipeline.sockets["Socket-4"].socket.parse).toBe("json");
    expect(pipeline.sockets["Socket-4"].socket.advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", when: "satisfied" });
    expect(pipeline.sockets["Socket-4"].socket.edges).toEqual([{ when: "always", to: "Socket-3" }]);
    expect(pipeline.loops?.loopSelection.exits).toEqual([{ id: "exit:Socket-4:satisfied", from: "Socket-4", condition: "satisfied", targetSocketId: "Socket-2" }]);
    expect(pipeline.loops?.loopSelection.iterator).toEqual({ items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" });
  });

  test("resolvePipeline lets utility generator materia feed loop iterators", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          loops: {
            taskIteration: {
              sockets: ["Socket-2", "Socket-3", "Socket-4"],
              consumes: { from: "Socket-1" },
              exit: { from: "Socket-4", when: "satisfied", to: "end" },
            },
          },
          sockets: {
            "Socket-1": { materia: "scriptPlanner", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Build", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-3": { materia: "Eval", edges: [{ when: "always", to: "Socket-4" }] },
            "Socket-4": { materia: "Maintain", edges: [{ when: "always", to: "Socket-2" }] },
          },
        },
      },
      materia: {
        scriptPlanner: { command: ["node", "plan.mjs"], generator: true, parse: "text", assign: { other: "$.other" } },
        Build: { tools: "coding", prompt: "Build." },
        Eval: { tools: "readOnly", prompt: "Eval." },
        Maintain: { tools: "coding", prompt: "Maintain." },
      },
    };

    const pipeline = resolvePipeline(config);
    const effectiveGeneratorConfig = effectiveResolvedSocketConfig(pipeline.sockets["Socket-1"]);

    expect(pipeline.sockets["Socket-1"].socket.parse).toBe("json");
    expect(pipeline.sockets["Socket-1"].socket.assign?.workItems).toBe("$.workItems");
    expect(effectiveGeneratorConfig.parse).toBe("json");
    expect(effectiveGeneratorConfig.assign).toEqual({ other: "$.other", workItems: "$.workItems" });
    expect(pipeline.loops?.taskIteration.consumes).toEqual({ from: "Socket-1", output: "workItems" });
    expect(pipeline.loops?.taskIteration.iterator).toEqual({ items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" });
    expect(pipeline.sockets["Socket-4"].socket.advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", when: "satisfied" });
  });

  test("resolvePipeline preserves compatible materialized loop semantics and rejects conflicts", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          loops: {
            taskIteration: {
              sockets: ["Socket-2"],
              consumes: { from: "Socket-1", output: "workItems" },
              exit: { from: "Socket-2", when: "satisfied", to: "end" },
            },
          },
          sockets: {
            "Socket-1": { materia: "planner", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": {
              materia: "Build",
              parse: "json",
              advance: { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" },
              edges: [{ when: "always", to: "Socket-2" }],
            },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generator: true },
        Build: { tools: "coding", prompt: "Build." },
      },
    };

    const pipeline = resolvePipeline(config);
    expect(pipeline.sockets["Socket-2"].socket.advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" });

    const conflictingParse = structuredClone(config) as PiMateriaConfig;
    testSockets(conflictingParse.loadouts!.Loop)["Socket-2"].parse = "text";
    expect(() => resolvePipeline(conflictingParse)).toThrow(/requires parse: "json".*Current parse is "text"/);

    const conflictingAdvance = structuredClone(config) as PiMateriaConfig;
    testSockets(conflictingAdvance.loadouts!.Loop)["Socket-2"].advance = { cursor: "otherIndex", items: "state.workItems", done: "end", when: "satisfied" };
    expect(() => resolvePipeline(conflictingAdvance)).toThrow(/existing advance block.*cursor: current "otherIndex", expected "workItemIndex"/);
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
              sockets: ["Socket-2"],
              consumes: { from: "Socket-1", output: "workItems" },
              exit: { from: "Socket-2", when: "satisfied", to: "end" },
            },
          },
          sockets: {
            "Socket-1": { materia: "planner", parse: "json", assign: { workItems: "$.workItems" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
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
    expect(loopIteratorForSocket(pipeline, "Socket-2")?.items).toBe("state.workItems");
    expect(lines).toContain("- planner: tools=readOnly, model=active Pi model, thinking=active Pi thinking, generator=workItems:array<workItem>");
    expect(lines).toContain("loop taskIteration (Build): [Socket-2] consumes=Socket-1.workItems iterator=state.workItems as workItem done end exit=Socket-2.satisfied->end");
  });

  test("resolvePipeline validates chained generators as canonical workItems pipeline stages", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          loops: {
            taskIteration: {
              sockets: ["Socket-2", "Socket-3"],
              consumes: { from: "Socket-4", output: "workItems" },
              exit: { from: "Socket-3", when: "satisfied", to: "end" },
            },
          },
          sockets: {
            "Socket-1": { materia: "planner", parse: "json", assign: { workItems: "$.workItems" }, edges: [{ when: "always", to: "Socket-4" }] },
            "Socket-4": { materia: "architect", parse: "json", assign: { workItems: "$.workItems" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Build", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-3": { materia: "Check", edges: [{ when: "always", to: "Socket-2" }] },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generator: true },
        architect: { tools: "readOnly", prompt: "Refine plan.", generator: true },
        Build: { tools: "coding", prompt: "Build." },
        Check: { tools: "none", prompt: "Check." },
      },
    };

    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "architected-consult-like", "/tmp/project");
    expect(pipeline.loops?.taskIteration.iterator).toEqual({ items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" });
    expect(lines).toContain("loop taskIteration (Build → Check): [Socket-2, Socket-3] consumes=Socket-4.workItems iterator=state.workItems as workItem done end exit=Socket-3.satisfied->end");
    expect(lines).toContain("- planner: tools=readOnly, model=active Pi model, thinking=active Pi thinking, generator=workItems:array<workItem>");
    expect(lines).toContain("- architect: tools=readOnly, model=active Pi model, thinking=active Pi thinking, generator=workItems:array<workItem>");
    expect(lines.join("\n")).not.toContain("generator=tasks");
    expect(lines.join("\n")).not.toContain("generator=work:");

    const missingUpstreamParse = structuredClone(config) as PiMateriaConfig;
    delete testSockets(missingUpstreamParse.loadouts!.Loop)["Socket-1"].parse;
    const normalizedMissingUpstreamParse = resolvePipeline(missingUpstreamParse);
    expect(normalizedMissingUpstreamParse.sockets["Socket-1"].socket.parse).toBe("json");
    expect(normalizedMissingUpstreamParse.sockets["Socket-1"].socket.assign?.workItems).toBe("$.workItems");

    const missingDownstreamParse = structuredClone(config) as PiMateriaConfig;
    delete testSockets(missingDownstreamParse.loadouts!.Loop)["Socket-4"].parse;
    const normalizedMissingDownstreamParse = resolvePipeline(missingDownstreamParse);
    expect(normalizedMissingDownstreamParse.sockets["Socket-4"].socket.parse).toBe("json");
    expect(normalizedMissingDownstreamParse.sockets["Socket-4"].socket.assign?.workItems).toBe("$.workItems");

    const incompleteDownstreamAssignment = structuredClone(config) as PiMateriaConfig;
    testSockets(incompleteDownstreamAssignment.loadouts!.Loop)["Socket-4"].assign = { tasks: "$.tasks" };
    const normalizedIncompleteDownstreamAssignment = resolvePipeline(incompleteDownstreamAssignment);
    expect(normalizedIncompleteDownstreamAssignment.sockets["Socket-4"].socket.parse).toBe("json");
    expect(normalizedIncompleteDownstreamAssignment.sockets["Socket-4"].socket.assign?.workItems).toBe("$.workItems");
  });

  test("resolvePipeline reconciles stale loop consumer source from current graph edges", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          loops: {
            taskIteration: {
              sockets: ["Socket-3", "Socket-4"],
              consumes: { from: "Socket-1", output: "workItems" },
              exit: { from: "Socket-4", when: "satisfied", to: "end" },
            },
          },
          sockets: {
            "Socket-1": { materia: "planner", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "refiner", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-3": { materia: "Build", edges: [{ when: "always", to: "Socket-4" }] },
            "Socket-4": { materia: "Check", edges: [{ when: "always", to: "Socket-3" }] },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generator: true },
        refiner: { tools: "readOnly", prompt: "Refine.", generator: true },
        Build: { tools: "coding", prompt: "Build." },
        Check: { tools: "none", prompt: "Check." },
      },
    };

    const pipeline = resolvePipeline(config);

    expect(pipeline.loops?.taskIteration.consumes).toEqual({ from: "Socket-2", output: "workItems" });
    expect(pipeline.sockets["Socket-2"].socket.parse).toBe("json");
    expect(pipeline.sockets["Socket-2"].socket.assign?.workItems).toBe("$.workItems");
    expect(pipeline.sockets["Socket-4"].socket.advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", when: "satisfied" });
  });

  test("resolvePipeline normalizes generator-to-generator pipeline sockets without a loop consumer", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Yolo",
      loadouts: {
        Yolo: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "planner", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "refiner", edges: [{ when: "always", to: "end" }] },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generator: true },
        refiner: { tools: "readOnly", prompt: "Refine generated work.", generator: true },
      },
    };

    const pipeline = resolvePipeline(config);

    expect(pipeline.sockets["Socket-1"].socket.parse).toBe("json");
    expect(pipeline.sockets["Socket-1"].socket.assign?.workItems).toBe("$.workItems");
    expect(pipeline.sockets["Socket-2"].socket.parse).toBe("json");
    expect(pipeline.sockets["Socket-2"].socket.assign?.workItems).toBe("$.workItems");
  });

  test("resolvePipeline rejects authored legacy generates metadata with obsolete metadata guidance", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          loops: {
            taskIteration: {
              sockets: ["Socket-2", "Socket-3"],
              iterator: { items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" },
              exit: { from: "Socket-3", when: "satisfied", to: "end" },
            },
          },
          sockets: {
            "Socket-1": { materia: "planner", parse: "json", assign: { tasks: "$.tasks" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Build", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-3": { materia: "Check", edges: [{ when: "always", to: "Socket-2" }] },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generates: { output: "tasks", as: "task", cursor: "taskIndex", done: "end", listType: "array", itemType: "task" } },
        Build: { tools: "coding", prompt: "Build." },
        Check: { tools: "none", prompt: "Check." },
      },
    };

    expect(() => resolvePipeline(config)).toThrow(/obsolete generates metadata.*generator: true.*workItems.*custom generates\.output aliases/s);
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
              sockets: ["Socket-1", "Socket-2", "Socket-3"],
              iterator: { items: "state.tasks", as: "task", cursor: "taskIndex", done: "end" },
              exit: { from: "Socket-3", when: "satisfied", to: "end" },
            },
          },
          sockets: {
            "Socket-1": { materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Auto-Eval", edges: [{ when: "satisfied", to: "Socket-3" }, { when: "not_satisfied", to: "Socket-1" }] },
            "Socket-3": { materia: "Maintain", edges: [{ when: "always", to: "Socket-1" }] },
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

    expect(pipeline.loops?.taskIteration.sockets).toEqual(["Socket-1", "Socket-2", "Socket-3"]);
    expect(loopIteratorForSocket(pipeline, "Socket-3")?.cursor).toBe("taskIndex");
    expect(lines).toContain("loop taskIteration (Build → Auto-Eval → Maintain): [Socket-1, Socket-2, Socket-3] iterator=state.tasks as task done end exit=Socket-3.satisfied->end");
  });

  test("resolvePipeline accepts repeated guarded iterative workflow branches", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "Build", edges: [{ when: 'always', to: 'Socket-2' }] },
            "Socket-2": {
              materia: "Auto-Eval",
              edges: [
                { when: "satisfied", to: "Socket-3" },
                { when: "satisfied", to: "Socket-1", maxTraversals: 3 },
                { when: "not_satisfied", to: "Socket-1", maxTraversals: 3 },
              ],
            },
            "Socket-3": { materia: "Maintain", edges: [{ when: 'always', to: 'Socket-1' }] },
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

describe("utility pipeline sockets", () => {
  test("resolvePipeline accepts command and named utility sockets", () => {
    const pipeline = resolvePipeline(baseConfig);

    expect(pipeline.entry.socket).toEqual(expect.objectContaining({ materia: "HelloUtility" }));
    expect(pipeline.sockets["Socket-2"].socket).toEqual(expect.objectContaining({ materia: "Ignore-Artifacts" }));
  });

  test("renderGrid shows utility command, parse, routing, foreach, limits, and timeout", () => {
    const pipeline = resolvePipeline(baseConfig);
    const lines = renderGrid(baseConfig, pipeline, "test", "/tmp/project");

    expect(lines).toContain('- HelloUtility: type=utility, command="node" "hello.js", parse=json');

    const hello = lines.find((line) => line.startsWith("- Socket-1:"));
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
          sockets: {
            "Socket-1": { materia: "planner", edges: [{ when: 'always', to: 'Socket-2' }] },
            "Socket-2": { materia: "Build" },
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

    const planner = lines.find((line) => line.startsWith("- Socket-1:"));
    expect(planner).toContain("materia=planner");
    expect(planner).toContain("tools=readOnly");
    expect(planner).toContain("model=anthropic/claude-haiku");
    expect(planner).toContain("thinking=low");

    const build = lines.find((line) => line.startsWith("- Socket-2:"));
    expect(build).toContain("tools=coding");
    expect(build).toContain("model=active Pi model");
    expect(build).toContain("thinking=active Pi thinking");
  });

  test("rejects utility sockets without a materia reference", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).sockets["Socket-1"] = {} as never;

    expect(() => resolvePipeline(config)).toThrow(/must reference materia via "materia"/);
  });

  test("rejects utility socket-local parse fields as obsolete even when they mirror utility materia", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).sockets["Socket-1"] = { materia: "HelloUtility", parse: "json" };

    expect(() => resolvePipeline(config)).toThrow(/obsolete socket field "parse"/);
  });

  test("rejects utility socket-local script fields as obsolete", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).sockets["Socket-1"] = { materia: "HelloUtility", script: "./legacy-tool.py" } as never;

    expect(() => resolvePipeline(config)).toThrow(/obsolete socket field "script"/);
  });

  test("accepts multi-turn materia and renders materia plus agent slots with materia-derived capability", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "planner", parse: "json" },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan interactively.", multiTurn: true },
      },
    };

    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "test", "/tmp/project");

    expect(pipeline.entry.socket).toEqual(expect.objectContaining({ materia: "planner" }));
    expect(pipeline.entry.materia.multiTurn).toBe(true);
    expect(lines).toContain("- planner: tools=readOnly, multiTurn=true, model=active Pi model, thinking=active Pi thinking");
    expect(lines.find((line) => line.startsWith("- Socket-1:"))).toContain("materia.multiTurn=true");
  });

  test("rejects obsolete socket-level multiTurn", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    activeLoadout(config).sockets["Socket-1"] = { materia: "HelloUtility", multiTurn: true } as never;

    expect(() => resolvePipeline(config)).toThrow(/obsolete multiTurn/);
  });

  test("loop generator consumers require a selected cycle and exactly one inbound canonical generator edge", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "customGenerator", parse: "json", assign: { workItems: "$.workItems" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Build", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-3": { materia: "Check", edges: [{ when: "always", to: "Socket-2" }] },
          },
          loops: { workLoop: { sockets: ["Socket-2", "Socket-3"], consumes: { from: "Socket-1", output: "workItems" } } },
        },
      },
      materia: {
        customGenerator: { tools: "readOnly", prompt: "Make work.", generator: true },
        Build: { tools: "coding", prompt: "Build." },
        Check: { tools: "none", prompt: "Check." },
      },
    };

    const resolved = resolvePipeline(config);
    expect(resolved.loops?.workLoop.iterator).toMatchObject({ items: "state.workItems", as: "workItem" });

    const noCycle = structuredClone(config) as PiMateriaConfig;
    testSockets(noCycle.loadouts!.Loop)["Socket-3"].edges = [{ when: "always", to: "end" }];
    expect(() => resolvePipeline(noCycle)).toThrow(/must contain a directed cycle/);

    const missingGeneratorInput = structuredClone(config) as PiMateriaConfig;
    testSockets(missingGeneratorInput.loadouts!.Loop)["Socket-1"].edges = [{ when: "always", to: "end" }];
    expect(() => resolvePipeline(missingGeneratorInput)).toThrow(/exactly one inbound edge from a generator socket.*found none/s);

    const multipleGeneratorInputs = structuredClone(config) as PiMateriaConfig;
    testSockets(multipleGeneratorInputs.loadouts!.Loop)["Socket-4"] = { materia: "otherGenerator", parse: "json", assign: { workItems: "$.workItems" }, edges: [{ when: "always", to: "Socket-3" }] };
    multipleGeneratorInputs.materia.otherGenerator = { tools: "readOnly", prompt: "Make more work.", generator: true };
    expect(() => resolvePipeline(multipleGeneratorInputs)).toThrow(/exactly one inbound edge from a generator socket.*found 2/s);
  });

  test("canonical generator declarations must map to JSON-assigned workItems output", () => {
    const config: PiMateriaConfig = {
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "planner", parse: "text", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
          },
          loops: { taskIteration: { sockets: ["Socket-2"], consumes: { from: "Socket-1", output: "workItems" } } },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", generator: true },
        Build: { tools: "coding", prompt: "Build." },
      },
    };

    const normalizedTextParse = resolvePipeline(config);
    expect(normalizedTextParse.sockets["Socket-1"].socket.parse).toBe("json");
    expect(normalizedTextParse.sockets["Socket-1"].socket.assign?.workItems).toBe("$.workItems");

    testSockets(config.loadouts!.Test)["Socket-1"].parse = "json";
    const normalizedMissingAssignment = resolvePipeline(config);
    expect(normalizedMissingAssignment.sockets["Socket-1"].socket.assign?.workItems).toBe("$.workItems");

    testSockets(config.loadouts!.Test)["Socket-1"].assign = { tasks: "$.tasks" };
    const normalizedLegacyAssignment = resolvePipeline(config);
    expect(normalizedLegacyAssignment.sockets["Socket-1"].socket.parse).toBe("json");
    expect(normalizedLegacyAssignment.sockets["Socket-1"].socket.assign?.workItems).toBe("$.workItems");

    testSockets(config.loadouts!.Test)["Socket-1"].assign = { workItems: "$.workItems" };
    expect(resolvePipeline(config).entry.materia.generator).toBe(true);

    config.materia.planner!.generates = { output: "tasks", listType: "array", itemType: "task" } as never;
    expect(() => resolvePipeline(config)).toThrow(/obsolete generates metadata.*generator: true.*workItems/s);
  });

  test("rejects malformed multiTurn values on materia", () => {
    const config: PiMateriaConfig = {
      ...baseConfig,
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { materia: "planner" },
          },
        },
      },
      materia: {
        planner: { tools: "readOnly", prompt: "Plan.", multiTurn: "yes" as never },
      },
    };

    expect(() => resolvePipeline(config)).toThrow(/Materia "planner" has invalid multiTurn/);
  });

  test("rejects malformed command arrays on utility materia with a friendly error", () => {
    const config = structuredClone(baseConfig) as PiMateriaConfig;
    config.materia.BadCommand = { type: "utility", command: ["node", ""] };
    activeLoadout(config).sockets["Socket-1"] = { materia: "BadCommand" };

    expect(() => resolvePipeline(config)).toThrow(/malformed command element at index 1/);
  });

  test("default loadout shows explicit utility bootstrap before agent sockets", async () => {
    const config = JSON.parse(await readFile("config/default.json", "utf8")) as PiMateriaConfig;
    const pipeline = resolvePipeline(config);
    const lines = renderGrid(config, pipeline, "default", "/tmp/project");

    const loadout = activeLoadout(config);
    expect(loadout.entry).toBe("Socket-1");
    expect(Object.keys(loadout.sockets ?? {})).toEqual(["Socket-1", "Socket-2", "Socket-3", "Socket-4", "Socket-5", "Socket-6", "Socket-7", "Socket-8"]);
    expect(pipeline.entry.socket).toEqual(expect.objectContaining({ materia: "Ignore-Artifacts" }));
    expect(loadout.sockets?.["Socket-1"]).toMatchObject({
      materia: "Ignore-Artifacts",
      edges: [{ when: "always", to: "Socket-2" }],
    });
    expect(loadout.sockets?.["Socket-2"]).toMatchObject({
      materia: "Detect-VCS",
      edges: [{ when: "always", to: "Socket-3" }],
    });
    expect(JSON.stringify(loadout.sockets)).not.toContain('"next"');

    const slotsIndex = lines.indexOf("Slots:");
    const ensureLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- Socket-1:"));
    const detectLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- Socket-2:"));
    const plannerLineIndex = lines.findIndex((line, index) => index > slotsIndex && line.startsWith("- Socket-3:"));
    expect(ensureLineIndex).toBeGreaterThanOrEqual(0);
    expect(detectLineIndex).toBeGreaterThan(ensureLineIndex);
    expect(plannerLineIndex).toBeGreaterThan(detectLineIndex);
    expect(lines[ensureLineIndex]).toContain("script=shippedUtility:ensure-ignored.mjs");
    expect(lines[detectLineIndex]).toContain("script=shippedUtility:detect-vcs.mjs");
    expect(config.materia["Auto-Plan"]?.generator).toBe(true);
    expect(loadout.loops?.loopSelection.sockets).toEqual(["Socket-4", "Socket-5", "Socket-6"]);
    expect(loadout.loops?.loopSelection.exit).toEqual({ from: "Socket-6", when: "satisfied", to: "end" });
    expect(loadout.loops?.loopSelection.consumes).toEqual({ from: "Socket-8", output: "workItems" });
    expect(pipeline.loops?.loopSelection.iterator).toEqual({ items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" });
    expect(loadout.sockets?.["Socket-6"]).toMatchObject({
      materia: "Maintain",
      parse: "json",
      assign: { lastMaintain: "$" },
      advance: { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" },
      edges: [{ when: "always", to: "Socket-4" }],
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

  test("all bundled default loadouts validate with canonical workItems generator contracts", async () => {
    const bundled = JSON.parse(await readFile("config/default.json", "utf8")) as PiMateriaConfig;

    for (const loadoutName of Object.keys(bundled.loadouts ?? {})) {
      const config = structuredClone(bundled) as PiMateriaConfig;
      config.activeLoadout = loadoutName;

      const pipeline = resolvePipeline(config);
      const loadout = activeLoadout(config);
      const [loopId, loop] = Object.entries(loadout.loops ?? {})[0] ?? [];
      expect(loop?.consumes?.output).toBe("workItems");
      expect(typeof loop?.consumes?.from).toBe("string");
      expect(loadout.sockets?.[loop!.consumes!.from]).toMatchObject({ parse: "json", assign: { workItems: "$.workItems" } });
      expect(pipeline.loops?.[loopId]?.iterator).toEqual({ items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" });
      expect(renderGrid(config, pipeline, "default", "/tmp/project").join("\n")).toContain("generator=workItems:array<workItem>");
    }
  });
});

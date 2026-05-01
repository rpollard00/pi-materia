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

describe("utility pipeline nodes", () => {
  test("resolvePipeline accepts command and named utility nodes", () => {
    const pipeline = resolvePipeline(baseConfig);

    expect(pipeline.entry.node.type).toBe("utility");
    expect(pipeline.nodes.ignored.node.type).toBe("utility");
  });

  test("renderGrid shows utility command, parse, routing, foreach, limits, and timeout", () => {
    const pipeline = resolvePipeline(baseConfig);
    const lines = renderGrid(baseConfig, pipeline, "test", "/tmp/project");

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

    const ensureLineIndex = lines.findIndex((line) => line.startsWith("- ensureArtifactsIgnored:"));
    const detectLineIndex = lines.findIndex((line) => line.startsWith("- detectVcs:"));
    const plannerLineIndex = lines.findIndex((line) => line.startsWith("- planner:"));
    expect(ensureLineIndex).toBeGreaterThanOrEqual(0);
    expect(detectLineIndex).toBeGreaterThan(ensureLineIndex);
    expect(plannerLineIndex).toBeGreaterThan(detectLineIndex);
    expect(lines[ensureLineIndex]).toContain("utility=project.ensureIgnored");
    expect(lines[detectLineIndex]).toContain("utility=vcs.detect");
  });
});

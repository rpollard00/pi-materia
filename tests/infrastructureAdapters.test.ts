import { describe, expect, test } from "bun:test";
import { createArtifactCatalog, createConfigRepository, createConsoleLogger, createPipelinePresenter, createProcessEnvironmentLookup } from "../src/infrastructure/index.js";
import { createMateriaPluginAdapters } from "../src/runtime/pluginAdapters.js";

// These tests keep plugin composition honest without invoking the expensive native Pi runtime.
describe("infrastructure adapters", () => {
  test("compose the workflow ports consumed by application services", () => {
    const adapters = createMateriaPluginAdapters({ MATERIA_CONFIG: "custom.json" });
    expect(adapters.configs).toEqual(createConfigRepository());
    expect(Object.keys(adapters.pipeline).sort()).toEqual(["renderGrid", "renderLoadoutCatalog", "renderLoadoutList", "resolve"]);
    expect(Object.keys(adapters.states).sort()).toEqual(["listLatest", "listResumable", "listRevivable", "loadActive"]);
    expect(Object.keys(adapters.artifacts)).toEqual(["renderCastList"]);
    expect(Object.keys(adapters.context)).toEqual(["buildIsolatedContext"]);
    expect(Object.keys(adapters.agentTurns).sort()).toEqual(["handleAgentEnd", "handleToolExecutionEnd", "prepareAgentStartSystemPrompt"]);
    expect(Object.keys(adapters.lifecycle).sort()).toEqual(["clear", "continue", "resume", "revive", "start"]);
    expect(Object.keys(adapters.statusPresenter)).toEqual(["statusLabel"]);
    expect(adapters.environment.get("MATERIA_CONFIG")).toBe("custom.json");
    expect(adapters.logger.info).toBeFunction();
    expect(adapters.modelPolicies.resolveActivePolicy).toBeFunction();
  });

  test("exposes focused standalone adapters", () => {
    expect(createPipelinePresenter().resolve).toBeFunction();
    expect(createArtifactCatalog().renderCastList).toBeFunction();
    expect(createProcessEnvironmentLookup({ FOO: "bar" }).get("FOO")).toBe("bar");
    expect(createProcessEnvironmentLookup({}).get("FOO")).toBeUndefined();
  });

  test("adapts application logging to a concrete console-like sink", () => {
    const entries: Array<{ level: string; args: unknown[] }> = [];
    const logger = createConsoleLogger({
      info: (...args: unknown[]) => entries.push({ level: "info", args }),
      warn: (...args: unknown[]) => entries.push({ level: "warn", args }),
      error: (...args: unknown[]) => entries.push({ level: "error", args }),
    });

    logger.info?.("selected", { loadout: "default" });
    logger.warn?.("fallback");

    expect(entries).toEqual([
      { level: "info", args: ["[pi-materia] selected", { loadout: "default" }] },
      { level: "warn", args: ["[pi-materia] fallback"] },
    ]);
  });
});

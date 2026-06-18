import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRoleGenerationPrompt, generateMateriaRolePrompt, resolveRoleGenerationSettings } from "../src/handoff/roleGeneration.js";

const activeModel = { provider: "active-provider", id: "active-model", name: "Active", api: "active-api", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" } };
const overrideModel = { provider: "override-provider", id: "role-model", name: "Role", api: "override-api", reasoning: true, thinkingLevelMap: { off: null, minimal: "minimal", low: null, medium: null, high: "high", xhigh: null } };

function fakePi(thinking = "medium"): ExtensionAPI {
  return { getThinkingLevel: () => thinking } as unknown as ExtensionAPI;
}

function fakeCtx(branch: unknown[] = []): ExtensionContext {
  return {
    cwd: "/tmp/project",
    model: activeModel,
    modelRegistry: {
      find: (provider: string, id: string) => provider === overrideModel.provider && id === overrideModel.id ? overrideModel : undefined,
      getAll: () => [activeModel, overrideModel],
      getAvailable: () => [activeModel, overrideModel],
    },
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => "/tmp/project/.pi/session.jsonl",
      getSessionId: () => "active-session",
    },
  } as unknown as ExtensionContext;
}

describe("Materia role prompt generation service", () => {
  test("validates role briefs", async () => {
    const result = await generateMateriaRolePrompt(fakePi(), fakeCtx(), { brief: "   " }, {
      generator: async () => "unused",
      profile: { enabled: true },
    });

    expect(result).toEqual({ ok: false, code: "invalid_brief", error: "Role brief cannot be empty." });
  });

  test("generates prompt text with fallback active model settings", async () => {
    const generates = { output: "workItems", listType: "array" as const, itemType: "workItem", as: "workItem", cursor: "workItemIndex", done: "end" };
    const result = await generateMateriaRolePrompt(fakePi("high"), fakeCtx(), { brief: "review docs changes", generates }, {
      profile: { enabled: true },
      generator: async ({ brief, generates: generatorConfig, settings }) => {
        expect(brief).toBe("review docs changes");
        expect(generatorConfig).toEqual(generates);
        expect(settings.model).toBe(activeModel);
        expect(settings.provider).toBe("active-provider");
        expect(settings.api).toBe("active-api");
        expect(settings.thinking).toBe("high");
        return "You are a docs reviewer.";
      },
    });

    expect(result).toEqual({
      ok: true,
      prompt: "You are a docs reviewer.",
      isolated: true,
      model: "active-provider/active-model",
      provider: "active-provider",
      api: "active-api",
      thinking: "high",
      warnings: [],
      modelResolution: { requestedModel: null, effectiveModel: "active-provider/active-model", fallback: false, warnings: [] },
      thinkingResolution: { requestedThinking: null, effectiveThinking: "high", fallback: false, warnings: [] },
    });
  });

  test("builds generator prompts with concise central handoff contract guidance", () => {
    const prompt = buildRoleGenerationPrompt("create an evaluator role", { extraInstructions: "Keep it terse." });

    expect(prompt).toContain("describe only socket-relevant fields from the small contract: workItems, satisfied, context, and text");
    expect(prompt).not.toContain("entire canonical envelope");
    expect(prompt).not.toContain("pi-materia canonical handoff JSON contract:");
    expect(prompt).not.toContain("Legacy names such as \"passed\"");
    expect(prompt).toContain("Generator role: none configured.");
    expect(prompt).toContain("Additional operator instructions:\nKeep it terse.");
    expect(prompt).toContain("User brief:\ncreate an evaluator role");
  });

  test("includes Generator workItems metadata in prompt context", () => {
    const prompt = buildRoleGenerationPrompt("create a planner role", {}, {
      output: "workItems",
      items: "state.workItems",
      listType: "array",
      itemType: "workItem",
      as: "workItem",
      cursor: "workItemIndex",
      done: "end",
    });

    expect(prompt).toContain("Generator role: produce a workItems list");
    expect(prompt).toContain("- output key: workItems");
    expect(prompt).toContain("- list type: array");
    expect(prompt).toContain("- item type: workItem");
    expect(prompt).toContain("- items path: state.workItems");
    expect(prompt).not.toContain("- work item alias");
    expect(prompt).toContain("- cursor: workItemIndex");
    expect(prompt).toContain("- done behavior: end");
    expect(prompt).toContain("adapter metadata for assignment and iteration");
    expect(prompt).toContain("place generated units of work in workItems");
    expect(prompt).toContain("use only title:string and context:string for each generated item");
    expect(prompt).toContain("avoid ids/descriptions/acceptance arrays/nested context objects");
    expect(prompt).not.toMatch(/produce[^\n]+id/i);
    expect(prompt).toContain("socket-relevant handoff fields");
    expect(prompt).not.toContain("legacy placement-specific outputs such as tasks");
  });

  test("applies available roleGeneration model and thinking overrides", async () => {
    const settings = await resolveRoleGenerationSettings(fakePi("low"), fakeCtx(), {
      enabled: true,
      model: "override-provider/role-model",
      thinking: "minimal",
      api: "profile-api",
    });

    expect(settings.model).toBe(overrideModel);
    expect(settings.modelLabel).toBe("override-provider/role-model");
    expect(settings.provider).toBe("override-provider");
    expect(settings.api).toBe("profile-api");
    expect(settings.thinking).toBe("minimal");
    expect(settings.warnings).toEqual([]);
    expect(settings.modelResolution).toEqual({ requestedModel: "override-provider/role-model", effectiveModel: "override-provider/role-model", fallback: false, warnings: [] });
    expect(settings.thinkingResolution).toEqual({ requestedThinking: "minimal", effectiveThinking: "minimal", fallback: false, warnings: [] });
  });

  test("inherits active thinking only when supported by the effective generation model", async () => {
    const settings = await resolveRoleGenerationSettings(fakePi("medium"), fakeCtx(), {
      enabled: true,
      model: "override-provider/role-model",
      thinking: null,
    });

    expect(settings.model).toBe(overrideModel);
    expect(settings.thinking).toBeUndefined();
    expect(settings.warnings).toEqual([]);
    expect(settings.thinkingResolution).toEqual({ requestedThinking: null, effectiveThinking: null, fallback: false, warnings: [] });
  });

  test("falls back to active/default thinking with warning for stale unsupported saved thinking", async () => {
    const settings = await resolveRoleGenerationSettings(fakePi("high"), fakeCtx(), {
      enabled: true,
      model: "override-provider/role-model",
      thinking: "low" as never,
    });

    expect(settings.model).toBe(overrideModel);
    expect(settings.thinking).toBe("high");
    expect(settings.warnings).toEqual(['Saved generation thinking "low" is unsupported for override-provider/role-model; using Active Pi Thinking.']);
    expect(settings.thinkingResolution).toEqual({
      requestedThinking: "low",
      effectiveThinking: "high",
      fallback: true,
      warnings: ['Saved generation thinking "low" is unsupported for override-provider/role-model; using Active Pi Thinking.'],
    });
  });

  test("falls back to Active Pi model when saved roleGeneration model is unavailable", async () => {
    const result = await generateMateriaRolePrompt(fakePi("medium"), fakeCtx(), { brief: "writer" }, {
      profile: { enabled: true, model: "missing-provider/missing-model" },
      generator: async ({ settings }) => {
        expect(settings.model).toBe(activeModel);
        return "You are a writer.";
      },
    });

    expect(result).toMatchObject({
      ok: true,
      prompt: "You are a writer.",
      model: "active-provider/active-model",
      warnings: ["Saved generation model is unavailable; using Active Pi Model."],
      modelResolution: { requestedModel: "missing-provider/missing-model", effectiveModel: "active-provider/active-model", fallback: true },
    });
  });

  test("falls back to Active Pi model when model registry validation fails", async () => {
    const ctx = fakeCtx() as ExtensionContext & { modelRegistry: { getAvailable: () => never } };
    ctx.modelRegistry.getAvailable = () => { throw new Error("registry unavailable"); };

    const result = await generateMateriaRolePrompt(fakePi(), ctx, { brief: "writer" }, {
      profile: { enabled: true, model: "override-provider/role-model" },
      generator: async ({ settings }) => {
        expect(settings.model).toBe(activeModel);
        return "You are a writer.";
      },
    });

    expect(result).toMatchObject({
      ok: true,
      warnings: ["Saved generation model is unavailable; using Active Pi Model."],
      modelResolution: { requestedModel: "override-provider/role-model", effectiveModel: "active-provider/active-model", fallback: true },
    });
  });

  test("falls back to Active Pi model for unqualified saved roleGeneration model without throwing", async () => {
    const result = await generateMateriaRolePrompt(fakePi(), fakeCtx(), { brief: "writer" }, {
      profile: { enabled: true, model: "role-model" },
      generator: async ({ settings }) => {
        expect(settings.model).toBe(activeModel);
        return "You are a writer.";
      },
    });

    expect(result).toMatchObject({
      ok: true,
      warnings: ["Saved generation model is unavailable; using Active Pi Model."],
      modelResolution: { requestedModel: "role-model", effectiveModel: "active-provider/active-model", fallback: true },
    });
  });

  test("does not mutate the active WebUI session branch", async () => {
    const branch = [{ id: "entry-1", type: "message" }];
    const before = JSON.stringify(branch);

    const result = await generateMateriaRolePrompt(fakePi(), fakeCtx(branch), { brief: "build specialist" }, {
      profile: { enabled: true },
      generator: async ({ brief, profile }) => {
        expect(brief).toBe("build specialist");
        expect(buildRoleGenerationPrompt(brief, profile)).toContain("User brief:\nbuild specialist");
        return "You are a build specialist.";
      },
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(branch)).toBe(before);
  });

  test("returns clear disabled and generator failure results", async () => {
    const disabled = await generateMateriaRolePrompt(fakePi(), fakeCtx(), { brief: "anything" }, {
      profile: { enabled: false },
      generator: async () => "unused",
    });
    expect(disabled).toEqual({ ok: false, code: "disabled", error: "Materia role prompt generation is disabled in the profile config." });

    const failed = await generateMateriaRolePrompt(fakePi(), fakeCtx(), { brief: "anything" }, {
      profile: { enabled: true },
      generator: async () => { throw new Error("provider unavailable"); },
    });
    expect(failed).toEqual({ ok: false, code: "generation_failed", error: "provider unavailable" });
  });
});

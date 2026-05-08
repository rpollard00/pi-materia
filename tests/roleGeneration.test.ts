import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { HANDOFF_CONTRACT_PROMPT_TEXT } from "../src/handoffContract.js";
import { buildRoleGenerationPrompt, generateMateriaRolePrompt, resolveRoleGenerationSettings } from "../src/roleGeneration.js";

const activeModel = { provider: "active-provider", id: "active-model", name: "Active", api: "active-api" };
const overrideModel = { provider: "override-provider", id: "role-model", name: "Role", api: "override-api" };

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
    const generates = { output: "tasks", listType: "array" as const, itemType: "task", as: "task", cursor: "taskIndex", done: "end" };
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
    });
  });

  test("builds generator prompts with the central handoff contract guidance", () => {
    const prompt = buildRoleGenerationPrompt("create an evaluator role", { extraInstructions: "Keep it terse." });

    expect(prompt).toContain(HANDOFF_CONTRACT_PROMPT_TEXT);
    expect(prompt).toContain('"satisfied" is the canonical boolean control field');
    expect(prompt).toContain("Legacy names such as \"passed\" are not canonical handoff fields");
    expect(prompt).toContain("Generated list output configuration: none configured.");
    expect(prompt).toContain("Additional operator instructions:\nKeep it terse.");
    expect(prompt).toContain("User brief:\ncreate an evaluator role");
  });

  test("includes generated list output metadata in prompt context", () => {
    const prompt = buildRoleGenerationPrompt("create a planner role", {}, {
      output: "tasks",
      items: "state.tasks",
      listType: "array",
      itemType: "task",
      as: "task",
      cursor: "taskIndex",
      done: "end",
    });

    expect(prompt).toContain("Generated list output configuration:");
    expect(prompt).toContain("- output key: tasks");
    expect(prompt).toContain("- list type: array");
    expect(prompt).toContain("- item type: task");
    expect(prompt).toContain("- items path: state.tasks");
    expect(prompt).toContain("- item alias: task");
    expect(prompt).toContain("- cursor: taskIndex");
    expect(prompt).toContain("- done behavior: end");
    expect(prompt).toContain("adapter metadata for assignment and iteration");
    expect(prompt).toContain("generated role prompt must still use the canonical handoff envelope");
    expect(prompt).toContain("workItems, not in a placement-specific output key such as tasks");
  });

  test("applies roleGeneration model and thinking overrides", () => {
    const settings = resolveRoleGenerationSettings(fakePi("low"), fakeCtx(), {
      enabled: true,
      provider: "override-provider",
      model: "role-model",
      thinking: "minimal",
      api: "profile-api",
    });

    expect(settings.model).toBe(overrideModel);
    expect(settings.modelLabel).toBe("override-provider/role-model");
    expect(settings.provider).toBe("override-provider");
    expect(settings.api).toBe("profile-api");
    expect(settings.thinking).toBe("minimal");
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

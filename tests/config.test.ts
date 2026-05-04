import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { getUserMateriaAssetPath, getUserProfileConfigPath, loadConfig, loadProfileConfig, saveActiveLoadout, saveMateriaConfigPatch } from "../src/config.js";
import { getEffectivePipelineConfig, resolvePipeline } from "../src/pipeline.js";

async function writeConfig(config: unknown): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-config-"));
  const file = path.join(dir, "loadout.json");
  await writeFile(file, JSON.stringify(config), "utf8");
  return { dir, file };
}

describe("layered config loading and persistence", () => {
  test("creates and reads the user profile config safely", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = dir;
    try {
      const profile = await loadProfileConfig();
      const raw = JSON.parse(await readFile(getUserProfileConfigPath(), "utf8"));

      expect(profile.defaultSaveTarget).toBe("user");
      expect(raw.webui.autoOpenBrowser).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("loads user, project, and explicit config with explicit taking precedence", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-layered-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const explicit = path.join(cwd, "explicit.json");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await writeFile(getUserMateriaAssetPath(), JSON.stringify({
        activeLoadout: "UserLoadout",
        roles: { Build: { model: "user/model" } },
        loadouts: { UserLoadout: { entry: "planner", nodes: { planner: { type: "agent", role: "planner" } } } },
      }), "utf8");
      await mkdir(path.join(cwd, ".pi"), { recursive: true });
      await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
        activeLoadout: "ProjectLoadout",
        roles: { Build: { model: "project/model" } },
        loadouts: { ProjectLoadout: { entry: "builder", nodes: { builder: { type: "agent", role: "Build" } } } },
      }), "utf8");
      await writeFile(explicit, JSON.stringify({
        activeLoadout: "ExplicitLoadout",
        roles: { Build: { model: "explicit/model" } },
        loadouts: { ExplicitLoadout: { entry: "checker", nodes: { checker: { type: "agent", role: "Check" } } } },
      }), "utf8");

      const loaded = await loadConfig(cwd, explicit);

      expect(loaded.config.activeLoadout).toBe("ExplicitLoadout");
      expect(loaded.config.roles.Build.model).toBe("explicit/model");
      expect(loaded.config.loadouts?.UserLoadout).toBeDefined();
      expect(loaded.config.loadouts?.ProjectLoadout).toBeDefined();
      expect(loaded.config.loadouts?.ExplicitLoadout).toBeDefined();
      expect(loaded.layers?.map((layer) => layer.scope)).toEqual(["default", "user", "project", "explicit"]);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("WebUI-style saves default to user profile and only touch project when explicitly targeted", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-save-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const projectFile = path.join(cwd, ".pi", "pi-materia.json");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await mkdir(path.dirname(projectFile), { recursive: true });
      await writeFile(projectFile, JSON.stringify({ activeLoadout: "Full-Auto" }), "utf8");
      const beforeProject = await readFile(projectFile, "utf8");

      const userWritten = await saveMateriaConfigPatch(cwd, {
        roles: { Custom: { tools: "none", systemPrompt: "custom user materia" } },
        loadouts: { UserCreated: { entry: "custom", nodes: { custom: { type: "agent", role: "Custom" } } } },
      });
      expect(userWritten).toBe(getUserMateriaAssetPath());
      expect(await readFile(projectFile, "utf8")).toBe(beforeProject);

      const reloaded = await loadConfig(cwd);
      expect(reloaded.config.roles.Custom.systemPrompt).toBe("custom user materia");
      expect(reloaded.config.loadouts?.UserCreated?.entry).toBe("custom");

      const projectWritten = await saveMateriaConfigPatch(cwd, { activeLoadout: "Planning-Consult" }, { target: "project" });
      expect(projectWritten).toBe(projectFile);
      expect(JSON.parse(await readFile(projectFile, "utf8")).activeLoadout).toBe("Planning-Consult");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });
});

describe("config loadouts", () => {
  test("legacy top-level pipeline configs still resolve through loadConfig", async () => {
    const { dir, file } = await writeConfig({
      pipeline: {
        entry: "legacy",
        nodes: { legacy: { type: "agent", role: "planner" } },
      },
    });

    const loaded = await loadConfig(dir, file);
    const effective = getEffectivePipelineConfig(loaded.config);
    const pipeline = resolvePipeline(loaded.config);

    expect(effective.loadoutName).toBeUndefined();
    expect(loaded.config.loadouts).toBeUndefined();
    expect(pipeline.entry.id).toBe("legacy");
    expect(pipeline.entry.role.systemPrompt).toContain("planning role");
  });

  test("project config can define loadouts and activeLoadout without duplicating roles", async () => {
    const { dir, file } = await writeConfig({
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
    });

    const loaded = await loadConfig(dir, file);
    const pipeline = resolvePipeline(loaded.config);

    expect(loaded.config.activeLoadout).toBe("Planning-Consult");
    expect(Object.keys(loaded.config.loadouts ?? {})).toContain("Full-Auto");
    expect(loaded.config.roles.planner.systemPrompt).toContain("planning role");
    expect(loaded.config.roles.interactivePlan.systemPrompt).toContain("interactive");
    expect(pipeline.entry.id).toBe("interactivePlan");
  });

  test("bundled Planning-Consult resolves an interactive multi-turn JSON planner", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-bundled-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    let loaded;
    try {
      loaded = await loadConfig(cwd);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }

    expect(loaded.config.activeLoadout).toBe("Full-Auto");
    const fullAutoPlanner = loaded.config.loadouts?.["Full-Auto"]?.nodes.planner;
    const planningConsultPlanner = loaded.config.loadouts?.["Planning-Consult"]?.nodes.planner;
    expect(fullAutoPlanner).toMatchObject({ role: "planner" });
    expect(planningConsultPlanner).toMatchObject({
      type: "agent",
      role: "interactivePlan",
      parse: "json",
    });
    expect("multiTurn" in (planningConsultPlanner ?? {})).toBe(false);
    expect(loaded.config.roles.interactivePlan.multiTurn).toBe(true);

    const fullAutoPrompt = String(fullAutoPlanner?.prompt ?? "");
    const planningConsultPrompt = String(planningConsultPlanner?.prompt ?? "");
    expect(fullAutoPrompt).toContain("Return only JSON with shape");
    expect(fullAutoPrompt).toContain("Create an implementation plan for this request");
    expect(planningConsultPrompt).toContain("Collaboratively refine an implementation plan");
    expect(planningConsultPrompt).toContain("normal conversation");
    expect(planningConsultPrompt).toContain("Ask concise clarifying questions");
    expect(planningConsultPrompt).toContain("propose and refine task breakdowns and acceptance criteria conversationally");
    expect(planningConsultPrompt).toContain("Do not emit the structured task JSON during refinement");
    expect(planningConsultPrompt).toContain("Only after the user runs /materia continue");
    expect(planningConsultPrompt).toContain("Treat all normal user messages as refinement input");
    expect(planningConsultPrompt).toContain('{ "tasks": [{ "id": string, "title": string, "description": string, "acceptance": string[] }] }');
    expect(planningConsultPrompt).not.toContain("Return only JSON");

    const fullAuto = resolvePipeline(loaded.config);
    expect(fullAuto.nodes.planner.node.type).toBe("agent");
    expect(fullAuto.nodes.planner.role.multiTurn).toBeUndefined();
    expect(fullAuto.nodes.planner.role.systemPrompt).toContain("planning role");

    loaded.config.activeLoadout = "Planning-Consult";
    const planningConsult = resolvePipeline(loaded.config);
    expect(planningConsult.nodes.planner.node).toMatchObject({
      type: "agent",
      role: "interactivePlan",
      parse: "json",
    });
    expect("multiTurn" in planningConsult.nodes.planner.node).toBe(false);
    expect(planningConsult.nodes.planner.role.multiTurn).toBe(true);
    expect(planningConsult.nodes.planner.role.systemPrompt).toContain("interactive planning role");
  });
});

describe("active loadout persistence", () => {
  test("updates only the active loadout in the active project config", async () => {
    const { dir, file } = await writeConfig({
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
    });

    const written = await saveActiveLoadout(dir, "Planning-Consult", file);
    const raw = JSON.parse(await readFile(file, "utf8"));
    const reloaded = await loadConfig(dir, file);

    expect(written).toBe(file);
    expect(raw.activeLoadout).toBe("Planning-Consult");
    expect(raw.roles).toBeUndefined();
    expect(reloaded.config.activeLoadout).toBe("Planning-Consult");
    expect(resolvePipeline(reloaded.config).entry.id).toBe("interactivePlan");
  });

  test("creates a minimal project config override when using bundled defaults", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-loadout-"));
    const projectFile = path.join(dir, ".pi", "pi-materia.json");
    const defaultFile = path.resolve("config", "default.json");
    const beforeDefault = await readFile(defaultFile, "utf8");

    const written = await saveActiveLoadout(dir, "Planning-Consult");
    const raw = JSON.parse(await readFile(projectFile, "utf8"));
    const reloaded = await loadConfig(dir);

    expect(written).toBe(projectFile);
    expect(raw).toEqual({ activeLoadout: "Planning-Consult" });
    expect(await readFile(defaultFile, "utf8")).toBe(beforeDefault);
    expect(reloaded.config.activeLoadout).toBe("Planning-Consult");
    expect(resolvePipeline(reloaded.config).nodes.planner.role.systemPrompt).toContain("interactive planning role");
  });

  test("rejects unknown loadout names without changing the config file", async () => {
    const { dir, file } = await writeConfig({
      activeLoadout: "Full-Auto",
      loadouts: {
        "Full-Auto": {
          entry: "planner",
          nodes: { planner: { type: "agent", role: "planner" } },
        },
      },
    });
    const before = await readFile(file, "utf8");

    await expect(saveActiveLoadout(dir, "Missing", file)).rejects.toThrow(/Unknown Materia loadout "Missing"/);

    expect(await readFile(file, "utf8")).toBe(before);
  });
});

describe("config role model settings", () => {
  test("bundled default roles remain model-free", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-bundled-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    let loaded;
    try {
      loaded = await loadConfig(cwd);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }

    for (const role of Object.values(loaded.config.roles)) {
      expect(role.model).toBeUndefined();
      expect(role.thinking).toBeUndefined();
    }
  });

  test("project config can set model and thinking for one existing role only", async () => {
    const { dir, file } = await writeConfig({
      roles: {
        Build: {
          model: "anthropic/claude-3-7-sonnet-latest",
          thinking: "high",
        },
      },
    });

    const loaded = await loadConfig(dir, file);

    expect(loaded.config.roles.Build.model).toBe("anthropic/claude-3-7-sonnet-latest");
    expect(loaded.config.roles.Build.thinking).toBe("high");
    expect(loaded.config.roles.Build.tools).toBe("coding");
    expect(loaded.config.roles.Build.systemPrompt).toContain("pi-materia Build Materia role");
    expect(loaded.config.roles.planner.model).toBeUndefined();
    expect(loaded.config.roles.planner.thinking).toBeUndefined();
  });

  test("rejects non-string role model with a friendly error", async () => {
    const { dir, file } = await writeConfig({ roles: { Build: { model: 123 } } });

    await expect(loadConfig(dir, file)).rejects.toThrow(/Materia role "Build" has invalid model\. Expected a string/);
  });

  test("rejects non-string role thinking with a friendly error", async () => {
    const { dir, file } = await writeConfig({ roles: { Build: { thinking: true } } });

    await expect(loadConfig(dir, file)).rejects.toThrow(/Materia role "Build" has invalid thinking\. Expected a string/);
  });

  test("rejects non-boolean role multiTurn with a friendly error", async () => {
    const { dir, file } = await writeConfig({ roles: { interactivePlan: { multiTurn: "yes" } } });

    await expect(loadConfig(dir, file)).rejects.toThrow(/Materia role "interactivePlan" has invalid multiTurn\. Expected a boolean/);
  });
});

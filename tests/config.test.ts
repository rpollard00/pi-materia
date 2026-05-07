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
        materia: { Build: { model: "user/model" } },
        loadouts: { UserLoadout: { entry: "planner", nodes: { planner: { type: "agent", materia: "planner" } } } },
      }), "utf8");
      await mkdir(path.join(cwd, ".pi"), { recursive: true });
      await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
        activeLoadout: "ProjectLoadout",
        materia: { Build: { model: "project/model" } },
        loadouts: { ProjectLoadout: { entry: "builder", nodes: { builder: { type: "agent", materia: "Build" } } } },
      }), "utf8");
      await writeFile(explicit, JSON.stringify({
        activeLoadout: "ExplicitLoadout",
        materia: { Build: { model: "explicit/model" } },
        loadouts: { ExplicitLoadout: { entry: "checker", nodes: { checker: { type: "agent", materia: "Check" } } } },
      }), "utf8");

      const loaded = await loadConfig(cwd, explicit);

      expect(loaded.config.activeLoadout).toBe("ExplicitLoadout");
      expect(loaded.config.materia.Build.model).toBe("explicit/model");
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
        materia: { Custom: { tools: "none", prompt: "custom user materia" } },
        loadouts: { UserCreated: { entry: "custom", nodes: { custom: { type: "agent", materia: "Custom" } } } },
      });
      expect(userWritten).toBe(getUserMateriaAssetPath());
      expect(await readFile(projectFile, "utf8")).toBe(beforeProject);

      const reloaded = await loadConfig(cwd);
      expect(reloaded.config.materia.Custom.prompt).toBe("custom user materia");
      expect(reloaded.config.loadouts?.UserCreated?.entry).toBe("custom");

      const projectWritten = await saveMateriaConfigPatch(cwd, { activeLoadout: "Planning-Consult" }, { target: "project" });
      expect(projectWritten).toBe(projectFile);
      expect(JSON.parse(await readFile(projectFile, "utf8")).activeLoadout).toBe("Planning-Consult");

      const explicitFile = path.join(cwd, "explicit-save.json");
      await writeFile(explicitFile, JSON.stringify({ activeLoadout: "Full-Auto" }), "utf8");
      const explicitWritten = await saveMateriaConfigPatch(cwd, { activeLoadout: "ExplicitOnly" }, { target: "explicit", configuredPath: explicitFile });
      expect(explicitWritten).toBe(explicitFile);
      expect(JSON.parse(await readFile(explicitFile, "utf8")).activeLoadout).toBe("ExplicitOnly");
      expect(JSON.parse(await readFile(projectFile, "utf8")).activeLoadout).toBe("Planning-Consult");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });
});

describe("config loadouts", () => {
  test("bundled default config has no root pipeline and its active loadout resolves", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
    expect(rawDefault.pipeline).toBeUndefined();
    expect(rawDefault.activeLoadout).toBe("Full-Auto");
    expect(rawDefault.loadouts?.[rawDefault.activeLoadout]).toBeDefined();

    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-default-loadout-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      const loaded = await loadConfig(cwd);
      const effective = getEffectivePipelineConfig(loaded.config);
      const pipeline = resolvePipeline(loaded.config);

      expect(effective.loadoutName).toBe("Full-Auto");
      expect(loaded.config.loadouts?.["Full-Auto"]).toBeDefined();
      expect(pipeline.entry.id).toBe("ensureArtifactsIgnored");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("rejects loadout-level prompt fields so materia.prompt stays the only behavior prompt source", async () => {
    const withPrompt = await writeConfig({
      loadouts: {
        Custom: {
          entry: "planner",
          prompt: "obsolete loadout behavior",
          nodes: { planner: { type: "agent", materia: "planner" } },
        },
      },
    });
    await expect(loadConfig(withPrompt.dir, withPrompt.file)).rejects.toThrow(/loadout "Custom" configures obsolete prompt/);

    const withSystemPrompt = await writeConfig({
      loadouts: {
        Custom: {
          entry: "planner",
          systemPrompt: "obsolete loadout system behavior",
          nodes: { planner: { type: "agent", materia: "planner" } },
        },
      },
    });
    await expect(loadConfig(withSystemPrompt.dir, withSystemPrompt.file)).rejects.toThrow(/loadout "Custom" configures obsolete systemPrompt/);
  });

  test("bundled default loadout edges use explicit canonical conditions", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
    const canonical = new Set(["always", "satisfied", "not_satisfied"]);

    for (const [loadoutName, loadout] of Object.entries(rawDefault.loadouts ?? {}) as Array<[string, { nodes?: Record<string, { edges?: Array<{ when?: unknown }> }> }]>) {
      for (const [nodeName, node] of Object.entries(loadout.nodes ?? {})) {
        for (const [index, edge] of (node.edges ?? []).entries()) {
          expect(edge.when, `${loadoutName}.${nodeName}.edges[${index}].when`).toBeDefined();
          expect(canonical.has(edge.when as string), `${loadoutName}.${nodeName}.edges[${index}].when`).toBe(true);
        }
      }
    }
  });

  test("bundled Auto-Eval prompt emits the field consumed by satisfied edges", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
    const prompt = rawDefault.materia?.["Auto-Eval"]?.prompt;
    expect(prompt).toContain('"satisfied": boolean');
    expect(prompt).not.toContain('"passed": boolean');
  });

  test("rejects saved patches that try to add loadout-level prompt fields", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-save-reject-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await expect(saveMateriaConfigPatch(cwd, {
        loadouts: {
          Custom: {
            entry: "planner",
            prompt: "obsolete saved behavior",
            nodes: { planner: { type: "agent", materia: "planner" } },
          } as never,
        },
      })).rejects.toThrow(/loadout "Custom" configures obsolete prompt/);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("saved config patches use shared graph edge validation semantics", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-save-graph-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await expect(saveMateriaConfigPatch(cwd, {
        loadouts: {
          Custom: {
            entry: "Check",
            nodes: {
              Check: {
                type: "agent",
                materia: "Check",
                edges: [
                  { when: "always", to: "Done" },
                  { when: "satisfied", to: "Check" },
                ],
              },
              Done: { type: "agent", materia: "Done" },
            },
          },
        },
      })).rejects.toThrow(/loadout "Custom" graph is invalid: .*unreachable outgoing edge/);

      await expect(saveMateriaConfigPatch(cwd, {
        loadouts: {
          Custom: {
            entry: "Check",
            nodes: {
              Check: { type: "agent", materia: "Check", edges: [{ when: "satisfied", to: undefined as never }] },
            },
          },
        },
      })).rejects.toThrow(/Missing graph endpoint referenced by Check\.edges\[0\]\.to/);

      await expect(saveMateriaConfigPatch(cwd, {
        loadouts: {
          Custom: {
            entry: "Check",
            nodes: {
              Check: { type: "agent", materia: "Check", edges: [{ to: "Check" } as never] },
            },
          },
        },
      })).rejects.toThrow(/invalid edge condition at Check\.edges\[0\]\.when/);

      await expect(saveMateriaConfigPatch(cwd, {
        loadouts: {
          Custom: {
            entry: "Check",
            nodes: {
              Check: { type: "agent", materia: "Check", edges: [{ when: "$.passed == true" as never, to: "Check" }] },
            },
          },
        },
      })).rejects.toThrow(/Expected one of: always, satisfied, not_satisfied/);

      await expect(saveMateriaConfigPatch(cwd, {
        loadouts: {
          Custom: {
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
      })).resolves.toBe(getUserMateriaAssetPath());
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("project config can define loadouts and activeLoadout without duplicating materia", async () => {
    const { dir, file } = await writeConfig({
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
    });

    const loaded = await loadConfig(dir, file);
    const pipeline = resolvePipeline(loaded.config);

    expect(loaded.config.activeLoadout).toBe("Planning-Consult");
    expect(Object.keys(loaded.config.loadouts ?? {})).toContain("Full-Auto");
    expect(loaded.config.materia.planner.prompt).toContain("planning materia");
    expect(loaded.config.materia.interactivePlan.prompt).toContain("interactive");
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
    expect(fullAutoPlanner).toMatchObject({ materia: "planner" });
    expect(planningConsultPlanner).toMatchObject({
      type: "agent",
      materia: "interactivePlan",
      parse: "json",
    });
    expect("multiTurn" in (planningConsultPlanner ?? {})).toBe(false);
    expect(loaded.config.materia.interactivePlan.multiTurn).toBe(true);

    const fullAutoPrompt = loaded.config.materia.planner.prompt;
    const planningConsultPrompt = loaded.config.materia.interactivePlan.prompt;
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
    expect(fullAuto.nodes.planner.materia.multiTurn).toBeUndefined();
    expect(fullAuto.nodes.planner.materia.prompt).toContain("planning materia");

    loaded.config.activeLoadout = "Planning-Consult";
    const planningConsult = resolvePipeline(loaded.config);
    expect(planningConsult.nodes.planner.node).toMatchObject({
      type: "agent",
      materia: "interactivePlan",
      parse: "json",
    });
    expect("multiTurn" in planningConsult.nodes.planner.node).toBe(false);
    expect(planningConsult.nodes.planner.materia.multiTurn).toBe(true);
    expect(planningConsult.nodes.planner.materia.prompt).toContain("interactive planning materia");
  });
});

describe("active loadout persistence", () => {
  test("updates only the active loadout in the active project config", async () => {
    const { dir, file } = await writeConfig({
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
    });

    const written = await saveActiveLoadout(dir, "Planning-Consult", file);
    const raw = JSON.parse(await readFile(file, "utf8"));
    const reloaded = await loadConfig(dir, file);

    expect(written).toBe(file);
    expect(raw.activeLoadout).toBe("Planning-Consult");
    expect(raw.materia).toBeUndefined();
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
    expect(resolvePipeline(reloaded.config).nodes.planner.materia.prompt).toContain("interactive planning materia");
  });

  test("rejects unknown loadout names without changing the config file", async () => {
    const { dir, file } = await writeConfig({
      activeLoadout: "Full-Auto",
      loadouts: {
        "Full-Auto": {
          entry: "planner",
          nodes: { planner: { type: "agent", materia: "planner" } },
        },
      },
    });
    const before = await readFile(file, "utf8");

    await expect(saveActiveLoadout(dir, "Missing", file)).rejects.toThrow(/Unknown Materia loadout "Missing"/);

    expect(await readFile(file, "utf8")).toBe(before);
  });
});

describe("config materia model settings", () => {
  test("bundled default materia remain model-free", async () => {
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

    for (const materia of Object.values(loaded.config.materia)) {
      expect(materia.model).toBeUndefined();
      expect(materia.thinking).toBeUndefined();
    }
  });

  test("project config can set model and thinking for one existing materia only", async () => {
    const { dir, file } = await writeConfig({
      materia: {
        Build: {
          model: "anthropic/claude-3-7-sonnet-latest",
          thinking: "high",
        },
      },
    });

    const loaded = await loadConfig(dir, file);

    expect(loaded.config.materia.Build.model).toBe("anthropic/claude-3-7-sonnet-latest");
    expect(loaded.config.materia.Build.thinking).toBe("high");
    expect(loaded.config.materia.Build.tools).toBe("coding");
    expect(loaded.config.materia.Build.prompt).toContain("pi-materia Build Materia materia");
    expect(loaded.config.materia.planner.model).toBeUndefined();
    expect(loaded.config.materia.planner.thinking).toBeUndefined();
  });

  test("rejects non-string materia model with a friendly error", async () => {
    const { dir, file } = await writeConfig({ materia: { Build: { model: 123 } } });

    await expect(loadConfig(dir, file)).rejects.toThrow(/Materia "Build" has invalid model\. Expected a string/);
  });

  test("rejects non-string materia thinking with a friendly error", async () => {
    const { dir, file } = await writeConfig({ materia: { Build: { thinking: true } } });

    await expect(loadConfig(dir, file)).rejects.toThrow(/Materia "Build" has invalid thinking\. Expected a string/);
  });

  test("rejects non-boolean materia multiTurn with a friendly error", async () => {
    const { dir, file } = await writeConfig({ materia: { interactivePlan: { multiTurn: "yes" } } });

    await expect(loadConfig(dir, file)).rejects.toThrow(/Materia "interactivePlan" has invalid multiTurn\. Expected a boolean/);
  });
});

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { getUserMateriaAssetPath, getUserProfileConfigPath, loadConfig, loadProfileConfig, saveActiveLoadout, saveMateriaConfigPatch } from "../src/config/config.js";
import { CURRENT_PI_MATERIA_SCHEMA_VERSION } from "../src/config/migrations.js";
import { resolveToolScope } from "../src/domain/toolScope.js";
import { HANDOFF_CONTRACT_PROMPT_TEXT } from "../src/handoff/handoffContract.js";
import { getEffectivePipelineConfig, resolvePipeline } from "../src/runtime/pipeline.js";
import { paletteColors } from "../src/webui/client/src/loadoutModel.js";

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
      expect(profile.roleGeneration).toEqual({ enabled: true, useReadOnlyProjectContext: false });
      expect(raw.webui.autoOpenBrowser).toBe(false);
      expect(raw.roleGeneration.enabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("fills safe role-generation defaults for legacy profiles without the section", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = dir;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(getUserProfileConfigPath(), JSON.stringify({
        webui: { preferredPort: 4321 },
        defaultSaveTarget: "project",
      }), "utf8");

      const profile = await loadProfileConfig();

      expect(profile.webui?.preferredPort).toBe(4321);
      expect(profile.defaultSaveTarget).toBe("project");
      expect(profile.roleGeneration).toEqual({ enabled: true, useReadOnlyProjectContext: false });
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("normalizes role-generation profile config and warns for invalid fields", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    const previousWarn = console.warn;
    const warnings: string[] = [];
    process.env.PI_MATERIA_PROFILE_DIR = dir;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(getUserProfileConfigPath(), JSON.stringify({
        defaultSaveTarget: "project",
        roleGeneration: {
          enabled: false,
          model: "  role-model  ",
          provider: "  provider  ",
          api: "  openai-compatible  ",
          thinking: "  medium  ",
          extraInstructions: "  Prefer terse operational bullets.  ",
          useReadOnlyProjectContext: true,
          ignoredFutureField: 123,
        },
      }), "utf8");

      const profile = await loadProfileConfig();

      expect(profile.defaultSaveTarget).toBe("project");
      expect(profile.roleGeneration).toEqual({
        enabled: false,
        model: "role-model",
        provider: "provider",
        api: "openai-compatible",
        thinking: "medium",
        extraInstructions: "Prefer terse operational bullets.",
        useReadOnlyProjectContext: true,
      });
      expect(warnings).toEqual([]);

      await writeFile(getUserProfileConfigPath(), JSON.stringify({
        roleGeneration: {
          enabled: "yes",
          model: "",
          provider: "",
          api: false,
          thinking: 42,
          extraInstructions: ["nope"],
          useReadOnlyProjectContext: "sometimes",
        },
      }), "utf8");

      const fallback = await loadProfileConfig();

      expect(fallback.roleGeneration).toEqual({ enabled: true, useReadOnlyProjectContext: false });
      expect(warnings.join("\n")).toContain("roleGeneration.enabled");
      expect(warnings.join("\n")).toContain("roleGeneration.provider");
      expect(warnings.join("\n")).toContain("roleGeneration.api");
      expect(warnings.join("\n")).toContain("roleGeneration.useReadOnlyProjectContext");
    } finally {
      console.warn = previousWarn;
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
        loadouts: { UserLoadout: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "planner" } } } },
      }), "utf8");
      await mkdir(path.join(cwd, ".pi"), { recursive: true });
      await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
        activeLoadout: "ProjectLoadout",
        materia: { Build: { model: "project/model" } },
        loadouts: { ProjectLoadout: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Build" } } } },
      }), "utf8");
      await writeFile(explicit, JSON.stringify({
        activeLoadout: "ExplicitLoadout",
        materia: { Build: { model: "explicit/model" } },
        loadouts: { ExplicitLoadout: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Check" } } } },
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

  test("persists loadout deletion markers for non-default loadouts in the writable layer", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-delete-loadout-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const projectFile = path.join(cwd, ".pi", "pi-materia.json");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await mkdir(path.dirname(projectFile), { recursive: true });
      await writeFile(projectFile, JSON.stringify({
        activeLoadout: "ProjectOnly",
        loadouts: { ProjectOnly: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Build" } } } },
      }), "utf8");

      await saveMateriaConfigPatch(cwd, { activeLoadout: "Full-Auto", loadouts: { ProjectOnly: null } } as never, { target: "project" });

      expect(JSON.parse(await readFile(projectFile, "utf8")).loadouts.ProjectOnly).toBeNull();
      const reloaded = await loadConfig(cwd);
      expect(reloaded.config.loadouts?.ProjectOnly).toBeUndefined();
      expect(reloaded.config.loadouts?.["Full-Auto"]).toBeDefined();
      expect(reloaded.loadoutSources?.ProjectOnly).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("protects shipped default loadouts even when a higher layer overrides the same name", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-default-protect-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await mkdir(profile, { recursive: true });
      await writeFile(getUserMateriaAssetPath(), JSON.stringify({
        loadouts: { "Full-Auto": { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Build" } } } },
      }), "utf8");

      const loaded = await loadConfig(cwd);
      expect(loaded.loadoutSources?.["Full-Auto"]).toBe("default");
      expect(loaded.config.loadouts?.["Full-Auto"]).toBeDefined();

      await expect(saveMateriaConfigPatch(cwd, { loadouts: { "Full-Auto": null } } as never)).rejects.toThrow("Cannot delete shipped default");

      await writeFile(getUserMateriaAssetPath(), JSON.stringify({ loadouts: { "Full-Auto": null } }), "utf8");
      const reloaded = await loadConfig(cwd);
      expect(reloaded.config.loadouts?.["Full-Auto"]).toBeDefined();
      expect(reloaded.loadoutSources?.["Full-Auto"]).toBe("default");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("rejects programmatic attempts to save a shipped default loadout shadow copy", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-save-default-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await expect(saveMateriaConfigPatch(cwd, {
        loadouts: {
          "Full-Auto": { id: "default:full-auto", source: "default", entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Build" } } },
        },
      } as never)).rejects.toThrow('Cannot save shipped default Materia loadout "Full-Auto". Duplicate it before editing.');
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
        loadouts: { UserCreated: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Custom" } } } },
      });
      expect(userWritten).toBe(getUserMateriaAssetPath());
      expect(await readFile(projectFile, "utf8")).toBe(beforeProject);

      const reloaded = await loadConfig(cwd);
      expect(reloaded.config.materia.Custom.prompt).toBe("custom user materia");
      expect(reloaded.config.loadouts?.UserCreated?.entry).toBe("Socket-1");

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
      expect(loaded.config.materia.ensureArtifactsIgnored).toMatchObject({
        type: "utility",
        label: "Ensure artifacts ignored",
        group: "Utility",
        utility: "project.ensureIgnored",
        parse: "json",
        params: { patterns: [".pi/pi-materia/"] },
        assign: { artifactIgnore: "$" },
      });
      expect(loaded.config.materia.detectVcs).toMatchObject({
        type: "utility",
        label: "Detect VCS",
        group: "Utility",
        utility: "vcs.detect",
        parse: "json",
        assign: { vcs: "$" },
      });
      expect(pipeline.entry.id).toBe("Socket-1");
      expect(pipeline.sockets["Socket-1"].socket).toMatchObject({ type: "utility", utility: "project.ensureIgnored" });
      expect(pipeline.sockets["Socket-2"].socket).toMatchObject({ type: "utility", utility: "vcs.detect" });
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("loadConfig materializes declarative loop exits for existing saved loadouts", async () => {
    const saved = await writeConfig({
      activeLoadout: "Yolo",
      materia: {
        yoloPlanner: { tools: "readOnly", prompt: "Plan.", generator: true },
        yoloBuild: { tools: "coding", prompt: "Build." },
        yoloMaintain: { tools: "coding", prompt: "Maintain." },
      },
      loadouts: {
        Yolo: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { type: "agent", materia: "yoloPlanner", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-3": { type: "agent", materia: "yoloBuild", edges: [{ when: "always", to: "Socket-4" }] },
            "Socket-4": { type: "agent", materia: "yoloMaintain", edges: [{ when: "always", to: "Socket-3" }] },
          },
          loops: {
            loopSelection: {
              sockets: ["Socket-3", "Socket-4"],
              consumes: { from: "Socket-1", output: "workItems" },
              exit: { from: "Socket-4", when: "satisfied", to: "end" },
            },
          },
        },
      },
    });

    const loaded = await loadConfig(saved.dir, saved.file);

    expect(loaded.config.loadouts?.Yolo.sockets["Socket-4"].parse).toBe("json");
    expect(loaded.config.loadouts?.Yolo.sockets["Socket-4"].advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", when: "satisfied" });
    expect(loaded.config.loadouts?.Yolo.sockets["Socket-4"].edges).toEqual([{ when: "always", to: "Socket-3" }]);
    const pipeline = resolvePipeline(loaded.config);
    expect(pipeline.sockets["Socket-1"].socket.parse).toBe("json");
    expect(pipeline.sockets["Socket-1"].socket.assign?.workItems).toBe("$.workItems");
    expect(pipeline.sockets["Socket-4"].socket.advance).toEqual({ cursor: "workItemIndex", items: "state.workItems", when: "satisfied" });
  });

  test("loadConfig reports loop materialization conflicts instead of overwriting authored semantics", async () => {
    const saved = await writeConfig({
      activeLoadout: "ConflictingLoop",
      materia: {
        conflictPlanner: { tools: "readOnly", prompt: "Plan.", generator: true },
        conflictBuild: { tools: "coding", prompt: "Build." },
      },
      loadouts: {
        ConflictingLoop: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { type: "agent", materia: "conflictPlanner", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": {
              type: "agent",
              materia: "conflictBuild",
              parse: "json",
              advance: { cursor: "otherIndex", items: "state.workItems", done: "end", when: "satisfied" },
              edges: [{ when: "always", to: "Socket-2" }],
            },
          },
          loops: {
            taskIteration: {
              sockets: ["Socket-2"],
              consumes: { from: "Socket-1", output: "workItems" },
              exit: { from: "Socket-2", when: "satisfied", to: "end" },
            },
          },
        },
      },
    });

    await expect(loadConfig(saved.dir, saved.file)).rejects.toThrow(/existing advance block.*cursor: current "otherIndex", expected "workItemIndex"/);
  });

  test("rejects loadout-level prompt fields so materia.prompt stays the only behavior prompt source", async () => {
    const withPrompt = await writeConfig({
      loadouts: {
        Custom: {
          entry: "Socket-1",
          prompt: "obsolete loadout behavior",
          sockets: { "Socket-1": { type: "agent", materia: "planner" } },
        },
      },
    });
    await expect(loadConfig(withPrompt.dir, withPrompt.file)).rejects.toThrow(/loadout "Custom" configures obsolete prompt/);

    const withSystemPrompt = await writeConfig({
      loadouts: {
        Custom: {
          entry: "Socket-1",
          systemPrompt: "obsolete loadout system behavior",
          sockets: { "Socket-1": { type: "agent", materia: "planner" } },
        },
      },
    });
    await expect(loadConfig(withSystemPrompt.dir, withSystemPrompt.file)).rejects.toThrow(/loadout "Custom" configures obsolete systemPrompt/);
  });

  test("bundled default materia use palette colors, explicit parse modes, and canonical generator markers", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
    const allowedColors = new Set(paletteColors);
    const expectedParse = new Map([
      ["ensureArtifactsIgnored", "json"],
      ["detectVcs", "json"],
      ["Auto-Architect", "json"],
      ["Chain-Context", "json"],
      ["Build", "text"],
      ["Auto-Eval", "json"],
      ["Maintain", "json"],
      ["GitMaintain", "json"],
      ["Narrate", "text"],
      ["Auto-Plan", "json"],
      ["Interactive-Plan", "json"],
      ["Detect-VCS", "json"],
      ["Cover", "json"],
    ]);

    for (const [materiaId, materia] of Object.entries(rawDefault.materia ?? {}) as Array<[string, { color?: unknown; generator?: unknown; generates?: unknown; parse?: unknown }]>) {
      expect(typeof materia.color, `${materiaId}.color`).toBe("string");
      expect(allowedColors.has(materia.color as string), `${materiaId}.color`).toBe(true);
      expect(materia.parse, `${materiaId}.parse`).toBe(expectedParse.get(materiaId));
      expect(materia.generates, `${materiaId}.generates`).toBeUndefined();
    }

    const autoEval = rawDefault.materia?.["Auto-Eval"];
    expect(autoEval?.tools).toEqual({ type: "custom", tools: ["read", "grep", "find", "ls", "bash"] });
    const resolvedAutoEvalTools = resolveToolScope(autoEval.tools, ["read", "grep", "find", "ls", "bash", "edit", "write", "patch", "apply_patch"]);
    expect(resolvedAutoEvalTools).toEqual({ ok: true, value: { spec: { type: "custom", tools: ["read", "grep", "find", "ls", "bash"] }, source: "custom", tools: ["read", "grep", "find", "ls", "bash"] } });
    if (resolvedAutoEvalTools.ok) {
      expect(resolvedAutoEvalTools.value.tools).not.toContain("edit");
      expect(resolvedAutoEvalTools.value.tools).not.toContain("write");
      expect(resolvedAutoEvalTools.value.tools).not.toContain("patch");
      expect(resolvedAutoEvalTools.value.tools).not.toContain("apply_patch");
    }
    expect(autoEval?.prompt).toContain("Bash is available for evaluation commands");
    expect(autoEval?.prompt).toContain("do not use it to modify project files");

    const pipeline = resolvePipeline(rawDefault);
    const autoEvalSocket = Object.values(pipeline.sockets).find((socket) => socket.socket.type === "agent" && socket.socket.materia === "Auto-Eval");
    expect(autoEvalSocket?.socket.materia).toBe("Auto-Eval");
    expect(autoEvalSocket?.materia.prompt).toContain("Auto-Eval Materia materia");
    const socketTools = resolveToolScope(autoEvalSocket!.materia.tools, ["read", "grep", "find", "ls", "bash", "edit", "write", "patch", "apply_patch"]);
    expect(socketTools).toEqual({ ok: true, value: { spec: { type: "custom", tools: ["read", "grep", "find", "ls", "bash"] }, source: "custom", tools: ["read", "grep", "find", "ls", "bash"] } });

    expect(rawDefault.materia?.planner).toBeUndefined();
    expect(rawDefault.materia?.interactivePlan).toBeUndefined();
    expect(rawDefault.materia?.["Auto-Plan"]?.generator).toBe(true);
    expect(rawDefault.materia?.["Interactive-Plan"]?.generator).toBe(true);
    expect(rawDefault.materia?.["Auto-Architect"]).toMatchObject({
      type: "agent",
      tools: "readOnly",
      parse: "json",
      generator: true,
      color: "materia-color-cyan",
    });
    expect(rawDefault.materia?.["Auto-Architect"]?.prompt).toContain("software architect materia");
    expect(rawDefault.materia?.["Chain-Context"]).toMatchObject({
      type: "agent",
      tools: "readOnly",
      parse: "json",
      color: "materia-color-cyan",
    });
    expect(rawDefault.materia?.["Chain-Context"]?.prompt).toContain("state.previousCastContext");
    expect(rawDefault.materia?.["Chain-Context"]?.prompt).toContain("workItems");
    expect(rawDefault.materia?.["Chain-Context"]?.prompt).toContain("never use tasks");
  });

  test("bundled default loadout edges use explicit canonical conditions", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
    const canonical = new Set(["always", "satisfied", "not_satisfied"]);

    for (const [loadoutName, loadout] of Object.entries(rawDefault.loadouts ?? {}) as Array<[string, { sockets?: Record<string, { next?: unknown; parse?: unknown; edges?: Array<{ when?: unknown; to?: string }> }> }]>) {
      for (const [socketName, socket] of Object.entries(loadout.sockets ?? {})) {
        expect(socket.next, `${loadoutName}.${socketName}.next`).toBeUndefined();
        expect(["text", "json"].includes(String(socket.parse)), `${loadoutName}.${socketName}.parse`).toBe(true);
        for (const [index, edge] of (socket.edges ?? []).entries()) {
          expect(edge.when, `${loadoutName}.${socketName}.edges[${index}].when`).toBeDefined();
          expect(canonical.has(edge.when as string), `${loadoutName}.${socketName}.edges[${index}].when`).toBe(true);
          if (edge.when === "satisfied" || edge.when === "not_satisfied") {
            expect(socket.parse, `${loadoutName}.${socketName}.parse for ${edge.when}`).toBe("json");
          }
          expect(edge.to === "end" || Boolean(loadout.sockets?.[edge.to ?? ""]), `${loadoutName}.${socketName}.edges[${index}].to`).toBe(true);
        }
      }
    }
  });

  test("bundled default loadouts use canonical adapter socket ids", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));

    for (const [loadoutName, loadout] of Object.entries(rawDefault.loadouts ?? {}) as Array<[string, { entry?: string; sockets?: Record<string, { materia?: string; utility?: string; edges?: Array<{ to?: string }>; advance?: { done?: string } }>; loops?: Record<string, { sockets?: string[]; exit?: { from?: string; to?: string }; consumes?: { from?: string } }> }]>) {
      expect(() => resolvePipeline({ ...rawDefault, activeLoadout: loadoutName })).not.toThrow();

      const socketIds = Object.keys(loadout.sockets ?? {});
      expect(loadout.entry, `${loadoutName}.entry`).toBe("Socket-1");
      expect(socketIds, `${loadoutName}.sockets`).toEqual(socketIds.map((_, index) => `Socket-${index + 1}`));
      expect(Object.values(loadout.sockets ?? {}).map((socket) => socket.materia), `${loadoutName}.materia`).toContain("Build");

      for (const [socketId, socket] of Object.entries(loadout.sockets ?? {})) {
        expect(socketId, `${loadoutName}.${socketId}`).toMatch(/^Socket-\d+$/);
        expect(socketId, `${loadoutName}.${socketId}`).not.toBe(socket.materia ?? "");
        expect(socketId, `${loadoutName}.${socketId}`).not.toBe(socket.utility ?? "");
        for (const edge of socket.edges ?? []) {
          expect(edge.to === "end" || socketIds.includes(edge.to ?? ""), `${loadoutName}.${socketId}.edge.to`).toBe(true);
        }
        if (socket.advance?.done) expect(socket.advance.done, `${loadoutName}.${socketId}.advance.done`).toBe("end");
      }

      for (const [loopId, loop] of Object.entries(loadout.loops ?? {})) {
        for (const socketId of loop.sockets ?? []) expect(socketIds.includes(socketId), `${loadoutName}.${loopId}.sockets`).toBe(true);
        if (loop.exit?.from) expect(socketIds.includes(loop.exit.from), `${loadoutName}.${loopId}.exit.from`).toBe(true);
        if (loop.exit?.to && loop.exit.to !== "end") expect(socketIds.includes(loop.exit.to), `${loadoutName}.${loopId}.exit.to`).toBe(true);
        if (loop.consumes?.from) expect(socketIds.includes(loop.consumes.from), `${loadoutName}.${loopId}.consumes.from`).toBe(true);
      }
    }
  });

  test("bundled Auto-Eval prompt references the shared satisfied contract", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
    const prompt = rawDefault.materia?.["Auto-Eval"]?.prompt;
    expect(prompt).toContain("runtime-provided canonical handoff JSON contract");
    expect(HANDOFF_CONTRACT_PROMPT_TEXT).toContain('"satisfied" is the canonical boolean control field');
    expect(prompt).not.toContain('"satisfied": boolean');
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
            entry: "Socket-1",
            prompt: "obsolete saved behavior",
            sockets: { "Socket-1": { type: "agent", materia: "planner" } },
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
            entry: "Socket-1",
            sockets: {
              "Socket-1": {
                type: "agent",
                materia: "Check",
                edges: [
                  { when: "always", to: "Socket-2" },
                  { when: "satisfied", to: "Socket-1" },
                ],
              },
              "Socket-2": { type: "agent", materia: "Done" },
            },
          },
        },
      })).rejects.toThrow(/loadout "Custom" graph is invalid: .*unreachable outgoing edge/);

      await expect(saveMateriaConfigPatch(cwd, {
        loadouts: {
          Custom: {
            entry: "Socket-1",
            sockets: {
              "Socket-1": { type: "agent", materia: "Check", edges: [{ when: "satisfied", to: undefined as never }] },
            },
          },
        },
      })).rejects.toThrow(/Missing graph endpoint referenced by Socket-1\.edges\[0\]\.to/);

      await expect(saveMateriaConfigPatch(cwd, {
        loadouts: {
          Custom: {
            entry: "Socket-1",
            sockets: {
              "Socket-1": { type: "agent", materia: "Check", edges: [{ when: " " as never, to: "Socket-1" }] },
            },
          },
        },
      })).rejects.toThrow(/invalid edge condition at Socket-1\.edges\[0\]\.when/);

      await expect(saveMateriaConfigPatch(cwd, {
        loadouts: {
          Custom: {
            entry: "Socket-1",
            sockets: {
              "Socket-1": { type: "agent", materia: "Check", edges: [{ when: "$.passed == true" as never, to: "Socket-1" }] },
            },
          },
        },
      })).rejects.toThrow(/Expected one of: always, satisfied, not_satisfied/);

      const savedPath = await saveMateriaConfigPatch(cwd, {
        loadouts: {
          Custom: {
            entry: "Socket-1",
            sockets: {
              "Socket-1": { type: "agent", materia: "Build", next: "Socket-2" } as never,
              "Socket-2": {
                type: "agent",
                materia: "Auto-Eval",
                edges: [
                  { when: "satisfied", to: "Socket-3" },
                  { when: "satisfied", to: "Socket-1", maxTraversals: 3 },
                  { when: "not_satisfied", to: "Socket-1", maxTraversals: 3 },
                ],
              },
              "Socket-3": { type: "agent", materia: "Maintain", next: "Socket-1" } as never,
            },
          },
        },
      });
      expect(savedPath).toBe(getUserMateriaAssetPath());
      expect(await readFile(savedPath, "utf8")).not.toContain('"next"');
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
          entry: "Socket-1",
          sockets: { "Socket-1": { type: "agent", materia: "planner" } },
        },
        "Planning-Consult": {
          entry: "Socket-1",
          sockets: { "Socket-1": { type: "agent", materia: "Interactive-Plan" } },
        },
      },
    });

    const loaded = await loadConfig(dir, file);
    const pipeline = resolvePipeline(loaded.config);

    expect(loaded.config.activeLoadout).toMatch(/^Planning-Consult Copy/);
    expect(Object.keys(loaded.config.loadouts ?? {})).toEqual(expect.arrayContaining(["Full-Auto", "Planning-Consult"]));
    expect(Object.keys(loaded.config.loadouts ?? {}).some((name) => /^Full-Auto Copy/.test(name))).toBe(true);
    expect(Object.keys(loaded.config.loadouts ?? {}).some((name) => /^Planning-Consult Copy/.test(name))).toBe(true);
    expect(loaded.config.materia["Auto-Plan"].prompt).toContain("planning materia");
    expect(loaded.config.materia["Interactive-Plan"].prompt).toContain("interactive");
    expect(pipeline.entry.id).toBe("Socket-1");
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
    const fullAutoPlanner = loaded.config.loadouts?.["Full-Auto"]?.sockets["Socket-3"];
    const planningConsultPlanner = loaded.config.loadouts?.["Planning-Consult"]?.sockets["Socket-3"];
    expect(fullAutoPlanner).toMatchObject({ materia: "Auto-Plan" });
    expect(planningConsultPlanner).toMatchObject({
      type: "agent",
      materia: "Interactive-Plan",
      parse: "json",
    });
    expect("multiTurn" in (planningConsultPlanner ?? {})).toBe(false);
    expect(loaded.config.materia["Interactive-Plan"].multiTurn).toBe(true);

    const fullAutoPrompt = loaded.config.materia["Auto-Plan"].prompt;
    const planningConsultPrompt = loaded.config.materia["Interactive-Plan"].prompt;
    expect(fullAutoPrompt).toContain("runtime-provided canonical handoff JSON contract");
    expect(fullAutoPrompt).toContain("Create an implementation plan for this request");
    expect(fullAutoPrompt).toContain("workItems");
    expect(planningConsultPrompt).toContain("Collaboratively refine an implementation plan");
    expect(planningConsultPrompt).toContain("normal conversation");
    expect(planningConsultPrompt).toContain("Ask concise clarifying questions");
    expect(planningConsultPrompt).toContain("propose and refine work-item breakdowns and acceptance criteria conversationally");
    expect(planningConsultPrompt).toContain("Do not emit the structured workItems JSON during refinement");
    expect(planningConsultPrompt).toContain("Only after the user runs /materia continue");
    expect(planningConsultPrompt).toContain("Treat all normal user messages as refinement input");
    expect(planningConsultPrompt).toContain("workItems");
    expect(planningConsultPrompt).not.toContain("Return only JSON");

    const fullAuto = resolvePipeline(loaded.config);
    expect(fullAuto.sockets["Socket-3"].socket.type).toBe("agent");
    expect(fullAuto.sockets["Socket-3"].materia.multiTurn).toBeUndefined();
    expect(fullAuto.sockets["Socket-3"].materia.prompt).toContain("planning materia");
    expect(fullAuto.sockets["Socket-8"].socket).toMatchObject({ materia: "Auto-Architect", parse: "json" });

    loaded.config.activeLoadout = "Planning-Consult";
    const planningConsult = resolvePipeline(loaded.config);
    expect(planningConsult.sockets["Socket-3"].socket).toMatchObject({
      type: "agent",
      materia: "Interactive-Plan",
      parse: "json",
    });
    expect("multiTurn" in planningConsult.sockets["Socket-3"].socket).toBe(false);
    expect(planningConsult.sockets["Socket-3"].materia.multiTurn).toBe(true);
    expect(planningConsult.sockets["Socket-3"].materia.prompt).toContain("interactive planning materia");
  });
});

describe("active loadout persistence", () => {
  test("updates only the active loadout in the active project config", async () => {
    const { dir, file } = await writeConfig({
      loadouts: {
        "Full-Auto": {
          entry: "Socket-1",
          sockets: { "Socket-1": { type: "agent", materia: "planner" } },
        },
        "Planning-Consult": {
          entry: "Socket-1",
          sockets: { "Socket-1": { type: "agent", materia: "Interactive-Plan" } },
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
    expect(resolvePipeline(reloaded.config).entry.id).toBe("Socket-1");
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
    expect(raw).toMatchObject({ activeLoadout: "Planning-Consult", activeLoadoutId: "default:planning-consult", piMateria: { schemaVersion: CURRENT_PI_MATERIA_SCHEMA_VERSION } });
    expect(await readFile(defaultFile, "utf8")).toBe(beforeDefault);
    expect(reloaded.config.activeLoadout).toBe("Planning-Consult");
    expect(resolvePipeline(reloaded.config).sockets["Socket-3"].materia.prompt).toContain("interactive planning materia");
  });

  test("rejects unknown loadout names without changing the config file", async () => {
    const { dir, file } = await writeConfig({
      activeLoadout: "Full-Auto",
      loadouts: {
        "Full-Auto": {
          entry: "Socket-1",
          sockets: { "Socket-1": { type: "agent", materia: "planner" } },
        },
      },
    });
    const before = await readFile(file, "utf8");

    await expect(saveActiveLoadout(dir, "Missing", file)).rejects.toThrow(/Unknown Materia loadout "Missing"/);

    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.activeLoadout).toMatch(/^Full-Auto Copy/);
    expect(after).toMatchObject({ piMateria: { schemaVersion: CURRENT_PI_MATERIA_SCHEMA_VERSION } });
    expect(Object.keys(after.loadouts).some((name) => /^Full-Auto Copy/.test(name))).toBe(true);
  });
});

describe("config materia model settings", () => {
  test("bundled default materia omit model and thinking settings", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));

    for (const [materiaId, materia] of Object.entries(rawDefault.materia ?? {}) as Array<[string, { model?: unknown; thinking?: unknown }]>) {
      expect(materia.model, `${materiaId}.model`).toBeUndefined();
      expect(materia.thinking, `${materiaId}.thinking`).toBeUndefined();
    }
  });

  test("project config can explicitly override Auto-Eval default tools", async () => {
    const { dir, file } = await writeConfig({
      materia: {
        "Auto-Eval": {
          tools: "none",
        },
      },
    });
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      const loaded = await loadConfig(dir, file);

      expect(loaded.config.materia["Auto-Eval"].tools).toBe("none");
      expect(loaded.config.materia["Auto-Eval"].prompt).toContain("Auto-Eval Materia materia");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
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
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      const loaded = await loadConfig(dir, file);

      expect(loaded.config.materia.Build.model).toBe("anthropic/claude-3-7-sonnet-latest");
      expect(loaded.config.materia.Build.thinking).toBe("high");
      expect(loaded.config.materia.Build.tools).toBe("coding");
      expect(loaded.config.materia.Build.prompt).toContain("pi-materia Build Materia materia");
      expect(loaded.config.materia["Auto-Plan"].model).toBeUndefined();
      expect(loaded.config.materia["Auto-Plan"].thinking).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
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
    const { dir, file } = await writeConfig({ materia: { "Interactive-Plan": { multiTurn: "yes" } } });

    await expect(loadConfig(dir, file)).rejects.toThrow(/Materia "Interactive-Plan" has invalid multiTurn\. Expected a boolean/);
  });
});

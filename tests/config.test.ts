import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { clearStaleQuestDefaultLoadoutPreference, getUserMateriaAssetPath, getUserProfileConfigPath, loadConfig, loadProfileConfig, saveActiveLoadout, saveDefaultLoadoutPreference, saveMateriaConfigPatch, saveQuestDefaultLoadoutPreference, saveRoleGenerationModelPreference, saveRoleGenerationPreference } from "../src/config/config.js";
import { resolveShippedUtilityScriptPath } from "../src/config/shippedUtilities.js";
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
      expect(profile.questDefaultLoadoutId).toBe("default:full-auto");
      expect(profile.roleGeneration).toEqual({ enabled: true, useReadOnlyProjectContext: false });
      expect(raw.webui.autoOpenBrowser).toBe(false);
      expect(raw.questDefaultLoadoutId).toBe("default:full-auto");
      expect(raw.roleGeneration.enabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("normalizes legacy and cleared quest default loadout profile preferences independently", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-quest-default-"));
    const cwd = path.join(temp, "project");
    const profileDir = path.join(temp, "profile");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(profileDir, { recursive: true });
      await writeFile(getUserProfileConfigPath(), JSON.stringify({ defaultLoadoutId: "default:planning-consult", defaultSaveTarget: "user" }), "utf8");

      const migrated = await loadConfig(cwd);
      expect(migrated.defaultLoadoutId).toBe("default:planning-consult");
      expect(migrated.questDefaultLoadoutId).toBe("default:full-auto");
      expect(migrated.defaultLoadoutWarning).toBeUndefined();
      expect(migrated.questDefaultLoadoutWarning).toBeUndefined();

      await writeFile(getUserProfileConfigPath(), JSON.stringify({ defaultLoadoutId: "default:planning-consult", questDefaultLoadoutId: null, defaultSaveTarget: "user" }), "utf8");
      const cleared = await loadConfig(cwd);
      expect(cleared.defaultLoadoutId).toBe("default:planning-consult");
      expect(cleared.questDefaultLoadoutId).toBeNull();
      expect(cleared.questDefaultLoadoutWarning).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("persists regular and quest default loadout preferences independently", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-independent-defaults-"));
    const cwd = path.join(temp, "project");
    const profileDir = path.join(temp, "profile");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(profileDir, { recursive: true });

      await saveDefaultLoadoutPreference(cwd, "Planning-Consult");
      await saveQuestDefaultLoadoutPreference(cwd, "Full-Auto");
      const afterBoth = await loadProfileConfig();
      expect(afterBoth.defaultLoadoutId).toBe("default:planning-consult");
      expect(afterBoth.questDefaultLoadoutId).toBe("default:full-auto");

      await saveQuestDefaultLoadoutPreference(cwd, null);
      const afterQuestClear = await loadProfileConfig();
      expect(afterQuestClear.defaultLoadoutId).toBe("default:planning-consult");
      expect(afterQuestClear.questDefaultLoadoutId).toBeNull();

      await saveDefaultLoadoutPreference(cwd, "Hojo-Consult");
      const afterRegularChange = await loadProfileConfig();
      expect(afterRegularChange.defaultLoadoutId).toBe("default:hojo-consult");
      expect(afterRegularChange.questDefaultLoadoutId).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("saves and clears stale quest default loadout preferences separately from the regular default", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-quest-default-save-"));
    const cwd = path.join(temp, "project");
    const profileDir = path.join(temp, "profile");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(profileDir, { recursive: true });
      await writeFile(getUserProfileConfigPath(), JSON.stringify({ defaultLoadoutId: "default:planning-consult", questDefaultLoadoutId: "Missing", defaultSaveTarget: "user" }), "utf8");

      const stale = await loadConfig(cwd);
      expect(stale.defaultLoadoutId).toBe("default:planning-consult");
      expect(stale.questDefaultLoadoutId).toBeNull();
      expect(stale.questDefaultLoadoutWarning).toContain("Configured quest default Materia loadout \"Missing\" was not found");

      expect(await clearStaleQuestDefaultLoadoutPreference(cwd)).toBe(true);
      const afterClear = await loadProfileConfig();
      expect(afterClear.defaultLoadoutId).toBe("default:planning-consult");
      expect(afterClear.questDefaultLoadoutId).toBeNull();

      expect(await saveQuestDefaultLoadoutPreference(cwd, "Full-Auto")).toBe("default:full-auto");
      const afterSave = await loadProfileConfig();
      expect(afterSave.defaultLoadoutId).toBe("default:planning-consult");
      expect(afterSave.questDefaultLoadoutId).toBe("default:full-auto");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("syncs shipped utility scripts to the user profile and resolves default utilities through that copy", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-shipped-utilities-"));
    const cwd = path.join(temp, "project");
    const profileDir = path.join(temp, "profile");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      await mkdir(cwd, { recursive: true });
      const loaded = await loadConfig(cwd);
      const utilitiesDir = path.join(profileDir, "utilities");
      const manifest = JSON.parse(await readFile(path.join(utilitiesDir, ".pi-materia-shipped-utilities.json"), "utf8"));

      expect(await readdir(utilitiesDir)).toEqual(expect.arrayContaining(["detect-vcs.mjs", "ensure-ignored.mjs", ".pi-materia-shipped-utilities.json"]));
      expect(manifest.utilities["detect-vcs.mjs"].profileFile).toBe("detect-vcs.mjs");
      expect(manifest.utilities["ensure-ignored.mjs"].profileFile).toBe("ensure-ignored.mjs");
      expect(loaded.config.materia["Detect-VCS"]).toMatchObject({ command: ["node", path.join(utilitiesDir, "detect-vcs.mjs")] });
      expect(loaded.config.materia["Ignore-Artifacts"]).toMatchObject({ command: ["node", path.join(utilitiesDir, "ensure-ignored.mjs")] });
      expect(JSON.stringify(loaded.config.materia["Detect-VCS"])).not.toContain(process.cwd());
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("rejects unsafe shipped utility script names during profile resolution", async () => {
    const profileDir = await mkdtemp(path.join(tmpdir(), "pi-materia-shipped-unsafe-"));

    expect(() => resolveShippedUtilityScriptPath(profileDir, { kind: "shippedUtility", name: "../detect-vcs.mjs", runtime: "node" })).toThrow(/Invalid shipped utility script name/);
    expect(() => resolveShippedUtilityScriptPath(profileDir, { kind: "shippedUtility", name: "nested/detect-vcs.mjs", runtime: "node" })).toThrow(/Invalid shipped utility script name/);
    expect(() => resolveShippedUtilityScriptPath(profileDir, { kind: "shippedUtility", name: "detect-vcs.js", runtime: "node" })).toThrow(/Invalid shipped utility script name/);
  });

  test("preserves modified profile utility scripts by resolving shipped updates to a hash-suffixed copy", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-shipped-utilities-conflict-"));
    const cwd = path.join(temp, "project");
    const profileDir = path.join(temp, "profile");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      await mkdir(cwd, { recursive: true });
      await loadConfig(cwd);
      const utilitiesDir = path.join(profileDir, "utilities");
      await writeFile(path.join(utilitiesDir, "detect-vcs.mjs"), "// user modified\n", "utf8");

      const loaded = await loadConfig(cwd);
      const manifest = JSON.parse(await readFile(path.join(utilitiesDir, ".pi-materia-shipped-utilities.json"), "utf8"));
      const profileFile = manifest.utilities["detect-vcs.mjs"].profileFile;

      expect(await readFile(path.join(utilitiesDir, "detect-vcs.mjs"), "utf8")).toBe("// user modified\n");
      expect(profileFile).toMatch(/^detect-vcs\.[a-f0-9]{12}\.mjs$/);
      expect(manifest.utilities["detect-vcs.mjs"].conflict).toBe("detect-vcs.mjs");
      expect(loaded.config.materia["Detect-VCS"]).toMatchObject({ command: ["node", path.join(utilitiesDir, profileFile)] });
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

  test("saves and clears role-generation model preference without replacing sibling fields", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = dir;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(getUserProfileConfigPath(), JSON.stringify({
        roleGeneration: {
          enabled: false,
          thinking: "high",
          extraInstructions: "Keep it focused.",
          useReadOnlyProjectContext: true,
        },
      }), "utf8");

      await expect(saveRoleGenerationModelPreference("  openai-codex/gpt-5.5  ")).resolves.toBe("openai-codex/gpt-5.5");
      const saved = await loadProfileConfig();
      expect(saved.roleGeneration).toEqual({
        enabled: false,
        model: "openai-codex/gpt-5.5",
        thinking: "high",
        extraInstructions: "Keep it focused.",
        useReadOnlyProjectContext: true,
      });
      expect((await readdir(dir)).some((entry) => entry.endsWith(".tmp"))).toBe(false);

      await expect(saveRoleGenerationModelPreference("   ")).resolves.toBe(null);
      const cleared = await loadProfileConfig();
      expect(cleared.roleGeneration).toEqual({
        enabled: false,
        model: null,
        thinking: "high",
        extraInstructions: "Keep it focused.",
        useReadOnlyProjectContext: true,
      });
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("saves nullable role-generation thinking preference without replacing sibling fields", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = dir;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(getUserProfileConfigPath(), JSON.stringify({
        roleGeneration: {
          enabled: false,
          model: "provider/existing",
          extraInstructions: "Keep it focused.",
          useReadOnlyProjectContext: true,
        },
      }), "utf8");

      await expect(saveRoleGenerationPreference({ thinking: "  medium" })).resolves.toEqual({ model: "provider/existing", thinking: "medium" });
      expect((await loadProfileConfig()).roleGeneration).toEqual({
        enabled: false,
        model: "provider/existing",
        thinking: "medium",
        extraInstructions: "Keep it focused.",
        useReadOnlyProjectContext: true,
      });

      await expect(saveRoleGenerationPreference({ thinking: null })).resolves.toEqual({ model: "provider/existing", thinking: null });
      expect((await loadProfileConfig()).roleGeneration).toEqual({
        enabled: false,
        model: "provider/existing",
        thinking: null,
        extraInstructions: "Keep it focused.",
        useReadOnlyProjectContext: true,
      });
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("rejects invalid role-generation model preference before modifying profile", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = dir;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(getUserProfileConfigPath(), JSON.stringify({ roleGeneration: { model: "provider/existing", enabled: false } }), "utf8");
      const before = await readFile(getUserProfileConfigPath(), "utf8");

      await expect(saveRoleGenerationModelPreference("unqualified-model")).rejects.toThrow(/provider-qualified/);

      expect(await readFile(getUserProfileConfigPath(), "utf8")).toBe(before);
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
        loadouts: { UserLoadout: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } } },
      }), "utf8");
      await mkdir(path.join(cwd, ".pi"), { recursive: true });
      await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
        activeLoadout: "ProjectLoadout",
        materia: { Build: { model: "project/model" } },
        loadouts: { ProjectLoadout: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } } },
      }), "utf8");
      await writeFile(explicit, JSON.stringify({
        activeLoadout: "ExplicitLoadout",
        materia: { Build: { model: "explicit/model" } },
        loadouts: { ExplicitLoadout: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } } },
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

  test("reports materia sources and default materia ids across config layers", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-sources-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const projectFile = path.join(cwd, ".pi", "pi-materia.json");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await mkdir(profile, { recursive: true });
      await writeFile(getUserMateriaAssetPath(), JSON.stringify({
        materia: {
          Build: { prompt: "user build override" },
          UserOnly: { tools: "none", prompt: "user only" },
        },
      }), "utf8");
      await mkdir(path.dirname(projectFile), { recursive: true });
      await writeFile(projectFile, JSON.stringify({
        materia: { ProjectOnly: { tools: "none", prompt: "project only" } },
      }), "utf8");

      const loaded = await loadConfig(cwd);

      expect(loaded.materiaSources?.Build).toBe("user");
      expect(loaded.materiaSources?.UserOnly).toBe("user");
      expect(loaded.materiaSources?.ProjectOnly).toBe("project");
      expect(loaded.defaultMateriaIds).toContain("Build");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("deletes writable materia overrides without persisting tombstones and falls back to defaults", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-delete-materia-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await saveMateriaConfigPatch(cwd, { materia: { Build: { tools: "coding", prompt: "user build override" } } as never });
      expect((await loadConfig(cwd)).materiaSources?.Build).toBe("user");

      await saveMateriaConfigPatch(cwd, { materia: { Build: null } as never });

      const raw = JSON.parse(await readFile(getUserMateriaAssetPath(), "utf8"));
      expect(raw.materia?.Build).toBeUndefined();
      const reloaded = await loadConfig(cwd);
      expect(reloaded.config.materia.Build).toBeDefined();
      expect(reloaded.materiaSources?.Build).toBe("default");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("deletes custom materia only when loadouts remain valid or a fallback exists", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-delete-custom-materia-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const projectFile = path.join(cwd, ".pi", "pi-materia.json");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await mkdir(profile, { recursive: true });
      await writeFile(getUserMateriaAssetPath(), JSON.stringify({
        materia: { FallbackCustom: { tools: "none", prompt: "user fallback" } },
      }), "utf8");
      await mkdir(path.dirname(projectFile), { recursive: true });
      await writeFile(projectFile, JSON.stringify({
        materia: {
          ReferencedOnly: { tools: "none", prompt: "referenced" },
          FallbackCustom: { tools: "coding", prompt: "project override" },
          UnusedCustom: { tools: "none", prompt: "unused" },
        },
        loadouts: {
          UsesCustom: { entry: "Socket-1", sockets: { "Socket-1": { materia: "ReferencedOnly" }, "Socket-2": { materia: "FallbackCustom" } } },
        },
      }), "utf8");

      await expect(saveMateriaConfigPatch(cwd, { materia: { ReferencedOnly: null } as never }, { target: "project" })).rejects.toThrow(/unknown materia "ReferencedOnly"/);

      await saveMateriaConfigPatch(cwd, { materia: { UnusedCustom: null } as never }, { target: "project" });
      expect((await loadConfig(cwd)).config.materia.UnusedCustom).toBeUndefined();

      await saveMateriaConfigPatch(cwd, { materia: { FallbackCustom: null } as never }, { target: "project" });
      const reloaded = await loadConfig(cwd);
      expect(reloaded.config.materia.FallbackCustom?.prompt).toBe("user fallback");
      expect(reloaded.materiaSources?.FallbackCustom).toBe("user");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("rejects deleting built-in-only materia from writable config", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-delete-default-materia-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await expect(saveMateriaConfigPatch(cwd, { materia: { Build: null } as never })).rejects.toThrow("Cannot delete shipped default Materia definition");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("validates materia lockState for agent and utility definitions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-lockstate-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await saveMateriaConfigPatch(cwd, { materia: { Agent: { tools: "none", prompt: "agent", lockState: "locked" } } as never });
      await saveMateriaConfigPatch(cwd, { materia: { Utility: { utility: "project.noop", lockState: "unlocked" } } as never });
      await expect(saveMateriaConfigPatch(cwd, { materia: { BadAgent: { tools: "none", prompt: "agent", lockState: "bad" } } as never })).rejects.toThrow("invalid lockState");
      await expect(saveMateriaConfigPatch(cwd, { materia: { BadUtility: { utility: "project.noop", lockState: "bad" } } as never })).rejects.toThrow("invalid lockState");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("rejects content saves to locked materia while allowing lock metadata and deletion", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-locked-content-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await saveMateriaConfigPatch(cwd, { materia: { Agent: { tools: "none", prompt: "agent", lockState: "locked" } } as never });
      await expect(saveMateriaConfigPatch(cwd, { materia: { Agent: { prompt: "changed" } } as never })).rejects.toThrow("Unlock it before saving content changes");

      await saveMateriaConfigPatch(cwd, { materia: { Agent: { lockState: "unlocked" } } as never });
      let loaded = await loadConfig(cwd);
      expect(loaded.config.materia.Agent).toMatchObject({ prompt: "agent", lockState: "unlocked" });

      await saveMateriaConfigPatch(cwd, { materia: { Agent: { lockState: "locked" } } as never });
      await saveMateriaConfigPatch(cwd, { materia: { Agent: null } as never });
      loaded = await loadConfig(cwd);
      expect(loaded.config.materia.Agent).toBeUndefined();
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
        loadouts: { ProjectOnly: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } } },
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
        loadouts: { "Full-Auto": { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } } },
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
          "Full-Auto": { id: "default:full-auto", source: "default", entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } },
        },
      } as never)).rejects.toThrow('Cannot save shipped default Materia loadout "Full-Auto". Duplicate it before editing.');
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("save patches serialize utility sockets as canonical materia references", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-save-canonical-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      const savedPath = await saveMateriaConfigPatch(cwd, {
        materia: {
          Build: { tools: "coding", prompt: "build" },
          Checkpoint: { utility: "project.ensureIgnored", parse: "json", params: { patterns: [".pi/pi-materia/"] }, assign: { artifactIgnore: "$" }, timeoutMs: 1000 },
        },
        loadouts: {
          Custom: {
            entry: "Socket-1",
            sockets: {
              "Socket-1": { materia: "Checkpoint", edges: [{ when: "always", to: "Socket-2" }] },
              "Socket-2": { materia: "Build" },
            },
          },
        },
      });

      const raw = JSON.parse(await readFile(savedPath, "utf8"));
      expect(raw.loadouts.Custom.sockets["Socket-1"]).toEqual({ materia: "Checkpoint", socketKind: "entry", edges: [{ when: "always", to: "Socket-2" }] });
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
        loadouts: { UserCreated: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Custom" } } } },
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
      expect(loaded.config.materia["Ignore-Artifacts"]).toMatchObject({
        type: "utility",
        label: "Ignore-Artifacts",
        group: "Utility",
        command: ["node", expect.any(String)],
        parse: "json",
        params: { patterns: [".pi/pi-materia/"] },
      });
      expect(loaded.config.materia["Detect-VCS"]).toMatchObject({
        type: "utility",
        label: "Detect-VCS",
        group: "Utility",
        command: ["node", expect.any(String)],
        parse: "json",
      });
      expect(loaded.config.materia["Ignore-Artifacts"].assign).toBeUndefined();
      expect(loaded.config.materia["Detect-VCS"].assign).toBeUndefined();
      expect(pipeline.entry.id).toBe("Socket-1");
      expect(pipeline.sockets["Socket-1"].socket).toMatchObject({ materia: "Ignore-Artifacts" });
      expect(pipeline.sockets["Socket-1"].materiaId).toBe("Ignore-Artifacts");
      expect(pipeline.sockets["Socket-2"].socket).toMatchObject({ materia: "Detect-VCS" });
      expect(pipeline.sockets["Socket-2"].materiaId).toBe("Detect-VCS");
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
            "Socket-1": { materia: "yoloPlanner", edges: [{ when: "always", to: "Socket-3" }] },
            "Socket-3": { materia: "yoloBuild", edges: [{ when: "always", to: "Socket-4" }] },
            "Socket-4": { materia: "yoloMaintain", edges: [{ when: "always", to: "Socket-3" }] },
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
            "Socket-1": { materia: "conflictPlanner", edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": {
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
          sockets: { "Socket-1": { materia: "planner" } },
        },
      },
    });
    await expect(loadConfig(withPrompt.dir, withPrompt.file)).rejects.toThrow(/loadout "Custom" configures obsolete prompt/);

    const withSystemPrompt = await writeConfig({
      loadouts: {
        Custom: {
          entry: "Socket-1",
          systemPrompt: "obsolete loadout system behavior",
          sockets: { "Socket-1": { materia: "planner" } },
        },
      },
    });
    await expect(loadConfig(withSystemPrompt.dir, withSystemPrompt.file)).rejects.toThrow(/loadout "Custom" configures obsolete systemPrompt/);
  });

  test("bundled default materia use palette colors, explicit parse modes, and canonical generator markers", async () => {
    const rawDefault = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
    const allowedColors = new Set(paletteColors);
    const expectedParse = new Map([
      ["Ignore-Artifacts", "json"],
      ["Detect-VCS", "json"],
      ["Auto-Architect", "json"],
      ["Chain-Context", "json"],
      ["Build", "text"],
      ["Auto-Eval", "json"],
      ["Maintain", "json"],
      ["GitMaintain", "json"],
      ["Narrate", "text"],
      ["Auto-Plan", "json"],
      ["Interactive-Plan", "json"],
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
    expect(resolvedAutoEvalTools).toMatchObject({ ok: true, value: { spec: { type: "custom", tools: ["read", "grep", "find", "ls", "bash"] }, source: "custom", tools: ["read", "grep", "find", "ls", "bash"], configuredTools: ["read", "grep", "find", "ls", "bash"], activeTools: ["read", "grep", "find", "ls", "bash"], unavailableTools: [], warnings: [] } });
    if (resolvedAutoEvalTools.ok) {
      expect(resolvedAutoEvalTools.value.tools).not.toContain("edit");
      expect(resolvedAutoEvalTools.value.tools).not.toContain("write");
      expect(resolvedAutoEvalTools.value.tools).not.toContain("patch");
      expect(resolvedAutoEvalTools.value.tools).not.toContain("apply_patch");
    }
    expect(autoEval?.prompt).toContain("Bash is available for evaluation commands");
    expect(autoEval?.prompt).toContain("do not use it to modify project files");

    const pipeline = resolvePipeline(rawDefault);
    const autoEvalSocket = Object.values(pipeline.sockets).find((socket) => socket.socket.materia === "Auto-Eval");
    expect(autoEvalSocket?.socket.materia).toBe("Auto-Eval");
    expect(autoEvalSocket?.materia.prompt).toContain("Auto-Eval Materia materia");
    const socketTools = resolveToolScope(autoEvalSocket!.materia.tools, ["read", "grep", "find", "ls", "bash", "edit", "write", "patch", "apply_patch"]);
    expect(socketTools).toMatchObject({ ok: true, value: { spec: { type: "custom", tools: ["read", "grep", "find", "ls", "bash"] }, source: "custom", tools: ["read", "grep", "find", "ls", "bash"], configuredTools: ["read", "grep", "find", "ls", "bash"], activeTools: ["read", "grep", "find", "ls", "bash"], unavailableTools: [], warnings: [] } });

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

    const prompts = Object.fromEntries(
      ["Auto-Architect", "Auto-Plan", "Interactive-Plan", "Build", "Chain-Context", "Cover"].map((name) => [
        name,
        String(rawDefault.materia?.[name]?.prompt ?? ""),
      ]),
    );
    expect(prompts["Auto-Architect"]).toContain("Refine workItems directly; put per-item architecture guidance in each workItem.context string");
    expect(prompts["Auto-Architect"]).toContain("Include top-level context only for useful cross-cutting information when relevant");
    expect(prompts["Build"]).toContain("Current workItem context:");
    expect(prompts["Build"]).toContain("Accumulated handoff context, if any:");
    expect(prompts["Build"]).toContain("Global cross-cutting guidance, if any:");
    for (const [name, prompt] of Object.entries(prompts)) {
      if (name !== "Build" && name !== "Cover") expect(prompt, name).toContain("workItems");
      expect(prompt, name).not.toContain("architectureGuidance");
      expect(prompt, name).not.toContain("top-level architecture");
      expect(prompt, name).not.toContain("architecture guidance in guidance and architecture context fields");
      expect(prompt, name).not.toContain("return JSON with shape");
    }

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

    for (const [loadoutName, loadout] of Object.entries(rawDefault.loadouts ?? {}) as Array<[string, { sockets?: Record<string, { next?: unknown; materia?: string; parse?: unknown; edges?: Array<{ when?: unknown; to?: string }> }> }]>) {
      for (const [socketName, socket] of Object.entries(loadout.sockets ?? {})) {
        expect(socket.next, `${loadoutName}.${socketName}.next`).toBeUndefined();
        const materia = typeof socket.materia === "string" ? rawDefault.materia?.[socket.materia] : undefined;
        if (materia?.type !== "utility") expect(["text", "json"].includes(String(socket.parse)), `${loadoutName}.${socketName}.parse`).toBe(true);
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
    expect(prompt).toContain("compact JSON with evaluator fields relevant to this socket");
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
            sockets: { "Socket-1": { materia: "planner" } },
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
        materia: { Check: { tools: "none", prompt: "check" }, Done: { tools: "none", prompt: "done" } },
        loadouts: {
          Custom: {
            entry: "Socket-1",
            sockets: {
              "Socket-1": {
                materia: "Check",
                edges: [
                  { when: "always", to: "Socket-2" },
                  { when: "satisfied", to: "Socket-1" },
                ],
              },
              "Socket-2": { materia: "Done" },
            },
          },
        },
      })).rejects.toThrow(/loadout "Custom" graph is invalid: .*unreachable outgoing edge/);

      await expect(saveMateriaConfigPatch(cwd, {
        materia: { Check: { tools: "none", prompt: "check" } },
        loadouts: {
          Custom: {
            entry: "Socket-1",
            sockets: {
              "Socket-1": { materia: "Check", edges: [{ when: "satisfied", to: undefined as never }] },
            },
          },
        },
      })).rejects.toThrow(/Missing graph endpoint referenced by Socket-1\.edges\[0\]\.to/);

      await expect(saveMateriaConfigPatch(cwd, {
        materia: { Check: { tools: "none", prompt: "check" } },
        loadouts: {
          Custom: {
            entry: "Socket-1",
            sockets: {
              "Socket-1": { materia: "Check", edges: [{ when: " " as never, to: "Socket-1" }] },
            },
          },
        },
      })).rejects.toThrow(/invalid edge condition at Socket-1\.edges\[0\]\.when/);

      await expect(saveMateriaConfigPatch(cwd, {
        materia: { Check: { tools: "none", prompt: "check" } },
        loadouts: {
          Custom: {
            entry: "Socket-1",
            sockets: {
              "Socket-1": { materia: "Check", edges: [{ when: "$.passed == true" as never, to: "Socket-1" }] },
            },
          },
        },
      })).rejects.toThrow(/Expected one of: always, satisfied, not_satisfied/);

      const savedPath = await saveMateriaConfigPatch(cwd, {
        loadouts: {
          Custom: {
            entry: "Socket-1",
            sockets: {
              "Socket-1": { materia: "Build", edges: [{ when: 'always', to: 'Socket-2' }] } as never,
              "Socket-2": {
                materia: "Auto-Eval",
                edges: [
                  { when: "satisfied", to: "Socket-3" },
                  { when: "satisfied", to: "Socket-1", maxTraversals: 3 },
                  { when: "not_satisfied", to: "Socket-1", maxTraversals: 3 },
                ],
              },
              "Socket-3": { materia: "Maintain", edges: [{ when: 'always', to: 'Socket-1' }] } as never,
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

  test("saved config patches reject unknown materia references", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-save-refs-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await expect(saveMateriaConfigPatch(cwd, {
        loadouts: { Bad: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Missing" } } } },
      })).rejects.toThrow(/loadouts\.Bad\.sockets\.Socket-1\.materia: socket references unknown materia "Missing"/);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("saved config patches infer materia behavior without socket-level types", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-save-materia-type-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      const saved = await saveMateriaConfigPatch(cwd, {
        materia: { Custom: { tools: "coding", prompt: "Do it" } as never },
      });
      const raw = JSON.parse(await readFile(saved, "utf8"));
      expect(raw.materia.Custom.type).toBe("agent");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("project config can define loadouts and activeLoadout without duplicating materia", async () => {
    const { dir, file } = await writeConfig({
      activeLoadout: "Planning-Consult",
      materia: {},
      loadouts: {
        "Full-Auto": {
          entry: "Socket-1",
          sockets: { "Socket-1": { materia: "planner" } },
        },
        "Planning-Consult": {
          entry: "Socket-1",
          sockets: { "Socket-1": { materia: "Interactive-Plan" } },
        },
      },
    });

    const loaded = await loadConfig(dir, file);
    const pipeline = resolvePipeline(loaded.config);

    expect(loaded.config.activeLoadout).toBe("Planning-Consult");
    expect(Object.keys(loaded.config.loadouts ?? {})).toEqual(expect.arrayContaining(["Full-Auto", "Planning-Consult"]));
    expect(Object.keys(loaded.config.loadouts ?? {}).some((name) => /^Full-Auto Copy/.test(name))).toBe(false);
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
      materia: "Interactive-Plan",
      parse: "json",
    });
    expect("multiTurn" in (planningConsultPlanner ?? {})).toBe(false);
    expect(loaded.config.materia["Interactive-Plan"].multiTurn).toBe(true);

    const fullAutoPrompt = loaded.config.materia["Auto-Plan"].prompt;
    const planningConsultPrompt = loaded.config.materia["Interactive-Plan"].prompt;
    expect(fullAutoPrompt).toContain("compact JSON containing only plan fields relevant to the socket");
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
    expect(fullAuto.sockets["Socket-3"].socket).toEqual(expect.objectContaining({ materia: "Auto-Plan", parse: "json" }));
    expect(fullAuto.sockets["Socket-3"].materia.multiTurn).toBeUndefined();
    expect(fullAuto.sockets["Socket-3"].materia.prompt).toContain("planning materia");
    expect(fullAuto.sockets["Socket-4"].socket).toMatchObject({ materia: "Build" });
    expect(fullAuto.sockets["Socket-8"].socket).toMatchObject({ materia: "Auto-Architect", parse: "json" });

    loaded.config.activeLoadout = "Planning-Consult";
    const planningConsult = resolvePipeline(loaded.config);
    expect(planningConsult.sockets["Socket-3"].socket).toMatchObject({
      materia: "Interactive-Plan",
      parse: "json",
    });
    expect("type" in planningConsult.sockets["Socket-3"].socket).toBe(false);
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
          sockets: { "Socket-1": { materia: "planner" } },
        },
        "Planning-Consult": {
          entry: "Socket-1",
          sockets: { "Socket-1": { materia: "Interactive-Plan" } },
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
    expect(raw).toMatchObject({ activeLoadout: "Planning-Consult", activeLoadoutId: "default:planning-consult" });
    expect(raw.piMateria).toBeUndefined();
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
          sockets: { "Socket-1": { materia: "planner" } },
        },
      },
    });
    const before = await readFile(file, "utf8");

    await expect(saveActiveLoadout(dir, "Missing", file)).rejects.toThrow(/Unknown Materia loadout "Missing"/);

    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.activeLoadout).toBe("Full-Auto");
    expect(after.piMateria).toBeUndefined();
    expect(Object.keys(after.loadouts)).toContain("Full-Auto");
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

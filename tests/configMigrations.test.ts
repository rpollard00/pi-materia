import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, saveActiveLoadout, saveDefaultLoadoutPreference, saveMateriaConfigPatch } from "../src/config/config.js";
import { CURRENT_PI_MATERIA_SCHEMA_VERSION, LOADOUT_CONFIG_MIGRATIONS, assertValidMigrationRegistry, migrateConfigLayers } from "../src/config/migrations.js";
import type { MateriaProfileConfig, PiMateriaConfig } from "../src/types.js";

const minimalLoadout = (materia = "Build") => ({
  entry: "Socket-1",
  sockets: {
    "Socket-1": { type: "agent", materia },
  },
});

describe("pi-materia config migrations", () => {
  it("keeps migration ids unique, sorted, stable, and derives the current schema version", () => {
    expect(() => assertValidMigrationRegistry()).not.toThrow();
    expect(LOADOUT_CONFIG_MIGRATIONS.map((migration) => migration.id)).toEqual(["001-rename-non-default-loadout-collisions", "002-stamp-stable-loadout-ids"]);
    expect(CURRENT_PI_MATERIA_SCHEMA_VERSION).toBe(LOADOUT_CONFIG_MIGRATIONS.length);
  });

  it("treats missing metadata as version 0, stamps audit metadata, and is idempotent", () => {
    const layers = [
      { scope: "default" as const, path: "/default.json", loaded: true, config: { loadouts: { Alpha: minimalLoadout() } } as Partial<PiMateriaConfig> },
      { scope: "user" as const, path: "/user.json", loaded: true, config: { loadouts: { Beta: minimalLoadout() } } as Partial<PiMateriaConfig> },
    ];

    const first = migrateConfigLayers(layers);
    expect(first.layers[1].changed).toBe(true);
    expect(first.layers[1].config.piMateria?.schemaVersion).toBe(CURRENT_PI_MATERIA_SCHEMA_VERSION);
    expect(first.layers[1].config.piMateria?.migrations?.map((migration) => migration.id)).toEqual(["001-rename-non-default-loadout-collisions", "002-stamp-stable-loadout-ids"]);
    expect(first.layers[1].config.loadouts?.Beta?.id).toBe("user:beta");

    first.layers.forEach((layer) => { layer.changed = false; });
    const second = migrateConfigLayers(first.layers);
    expect(second.layers[1].changed).toBe(false);
    expect(second.layers[1].config.loadouts).toHaveProperty("Beta");
  });

  it("renames non-default display-name collisions while preserving default names and repointing unambiguous references", () => {
    const profile: MateriaProfileConfig = { defaultLoadoutId: "Alpha" };
    const layers = [
      { scope: "default" as const, path: "/default.json", loaded: true, config: { activeLoadout: "Alpha", loadouts: { Alpha: minimalLoadout() } } as Partial<PiMateriaConfig> },
      { scope: "user" as const, path: "/user.json", loaded: true, config: { activeLoadout: "Alpha", loadouts: { Alpha: minimalLoadout(), "Alpha Copy": minimalLoadout() } } as Partial<PiMateriaConfig> },
    ];

    const result = migrateConfigLayers(layers, profile);

    expect(result.layers[0].config.loadouts).toHaveProperty("Alpha");
    expect(result.layers[1].config.loadouts).not.toHaveProperty("Alpha");
    expect(result.layers[1].config.loadouts).toHaveProperty("Alpha Copy 2");
    expect(result.layers[1].config.activeLoadout).toBe("Alpha Copy 2");
    expect(result.layers[1].config.activeLoadoutId).toBe("user:alpha-copy-2");
    expect(profile.defaultLoadoutId).toBe("user:alpha-copy-2");
    expect(result.profileChanged).toBe(true);
    expect(result.audit["/user.json"].join("\n")).toContain("renamed loadout Alpha to Alpha Copy 2");
  });

  it("repoints changed layer active references to that layer's own rename before global ambiguity fallback", () => {
    const layers = [
      { scope: "default" as const, path: "/default.json", loaded: true, config: { loadouts: { Alpha: minimalLoadout() } } as Partial<PiMateriaConfig> },
      { scope: "user" as const, path: "/user.json", loaded: true, config: { activeLoadout: "Alpha", loadouts: { Alpha: minimalLoadout() } } as Partial<PiMateriaConfig> },
      { scope: "project" as const, path: "/project.json", loaded: true, config: { activeLoadout: "Alpha", loadouts: { Alpha: minimalLoadout() } } as Partial<PiMateriaConfig> },
    ];

    const result = migrateConfigLayers(layers);

    expect(result.layers[1].config.activeLoadout).toBe("Alpha Copy");
    expect(result.layers[1].config.activeLoadoutId).toBe("user:alpha-copy");
    expect(result.layers[2].config.activeLoadout).toBe("Alpha Copy 2");
    expect(result.layers[2].config.activeLoadoutId).toBe("project:alpha-copy-2");
  });

  it("leaves ambiguous legacy references untouched", () => {
    const layers = [
      { scope: "default" as const, path: "/default.json", loaded: true, config: { loadouts: { Alpha: minimalLoadout() } } as Partial<PiMateriaConfig> },
      { scope: "user" as const, path: "/user.json", loaded: true, config: { activeLoadout: "Alpha", loadouts: { Alpha: minimalLoadout() } } as Partial<PiMateriaConfig> },
      { scope: "project" as const, path: "/project.json", loaded: true, config: { loadouts: { Alpha: minimalLoadout() } } as Partial<PiMateriaConfig> },
      { scope: "explicit" as const, path: "/explicit.json", loaded: true, config: { activeLoadout: "Alpha", loadouts: { Beta: minimalLoadout() } } as Partial<PiMateriaConfig> },
    ];

    const result = migrateConfigLayers(layers);

    expect(result.layers[3].config.activeLoadout).toBe("Alpha");
    expect(result.layers[1].config.loadouts).toHaveProperty("Alpha Copy");
    expect(result.layers[2].config.loadouts).toHaveProperty("Alpha Copy 2");
  });

  it("preserves rollback-compatible profile migration audit metadata when normalizing and migrating", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-migrations-"));
    const cwd = path.join(temp, "project");
    const profileDir = path.join(temp, "profile");
    const previousProfile = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      await mkdir(profileDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(profileDir, "config.json"), JSON.stringify({
        piMateria: { schemaVersion: 1, migrations: [{ id: "001-rename-non-default-loadout-collisions", appliedAt: "2020-01-01T00:00:00.000Z", changes: ["kept"] }] },
        defaultLoadoutId: null,
      }, null, 2));

      await loadConfig(cwd);

      const writtenProfile = JSON.parse(await readFile(path.join(profileDir, "config.json"), "utf8"));
      expect(writtenProfile.piMateria.schemaVersion).toBe(CURRENT_PI_MATERIA_SCHEMA_VERSION);
      expect(writtenProfile.piMateria.migrations[0]).toEqual({ id: "001-rename-non-default-loadout-collisions", appliedAt: "2020-01-01T00:00:00.000Z", changes: ["kept"] });
      expect(writtenProfile.piMateria.migrations.map((migration: { id: string }) => migration.id)).toEqual(["001-rename-non-default-loadout-collisions", "002-stamp-stable-loadout-ids"]);
    } finally {
      if (previousProfile === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previousProfile;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("persists default loadout preferences as stable ids and resolves legacy display-name preferences", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-default-id-"));
    const cwd = path.join(temp, "project");
    const profileDir = path.join(temp, "profile");
    const previousProfile = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      await mkdir(profileDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await saveMateriaConfigPatch(cwd, { loadouts: { UserOnly: minimalLoadout() } }, { target: "user" });

      await expect(saveDefaultLoadoutPreference(cwd, "UserOnly")).resolves.toBe("user:useronly");
      let writtenProfile = JSON.parse(await readFile(path.join(profileDir, "config.json"), "utf8"));
      expect(writtenProfile.defaultLoadoutId).toBe("user:useronly");
      expect((await loadConfig(cwd)).defaultLoadoutId).toBe("user:useronly");

      await writeFile(path.join(profileDir, "config.json"), JSON.stringify({ defaultLoadoutId: "UserOnly" }, null, 2));
      const loadedLegacy = await loadConfig(cwd);
      expect(loadedLegacy.defaultLoadoutId).toBe("user:useronly");
      writtenProfile = JSON.parse(await readFile(path.join(profileDir, "config.json"), "utf8"));
      expect(writtenProfile.defaultLoadoutId).toBe("user:useronly");
    } finally {
      if (previousProfile === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previousProfile;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("migrates loaded user files atomically through loadConfig and rejects future duplicate-name ownership on save", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-migrations-"));
    const cwd = path.join(temp, "project");
    const profileDir = path.join(temp, "profile");
    const previousProfile = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      await mkdir(profileDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(profileDir, "materia.json"), JSON.stringify({
        loadouts: { "Full-Auto": minimalLoadout() },
      }, null, 2));

      const loaded = await loadConfig(cwd);
      expect(loaded.config.loadouts).toHaveProperty("Full-Auto");
      expect(loaded.config.loadouts).toHaveProperty("Full-Auto Copy");
      expect(loaded.loadoutSources?.["Full-Auto"]).toBe("default");
      expect(loaded.loadoutSources?.["Full-Auto Copy"]).toBe("user");

      const writtenUserConfig = JSON.parse(await readFile(path.join(profileDir, "materia.json"), "utf8"));
      expect(writtenUserConfig.piMateria.schemaVersion).toBe(CURRENT_PI_MATERIA_SCHEMA_VERSION);
      expect(writtenUserConfig.loadouts).toHaveProperty("Full-Auto Copy");
      expect(writtenUserConfig.loadouts["Full-Auto Copy"].id).toBe("user:full-auto-copy");
      expect(writtenUserConfig.loadouts).not.toHaveProperty("Full-Auto");

      await expect(saveMateriaConfigPatch(cwd, { loadouts: { "Full-Auto": minimalLoadout() } }, { target: "user" })).rejects.toThrow(/already owned by default scope/);
      await saveMateriaConfigPatch(cwd, { loadouts: { UserOnly: minimalLoadout() } }, { target: "user" });
      const regeneratedUserConfig = JSON.parse(await readFile(path.join(profileDir, "materia.json"), "utf8"));
      expect(regeneratedUserConfig.piMateria.schemaVersion).toBe(CURRENT_PI_MATERIA_SCHEMA_VERSION);
      expect(regeneratedUserConfig.loadouts.UserOnly.id).toBe("user:useronly");
      await saveActiveLoadout(cwd, "user:useronly");
      const projectConfig = JSON.parse(await readFile(path.join(cwd, ".pi", "pi-materia.json"), "utf8"));
      expect(projectConfig.activeLoadout).toBe("UserOnly");
      expect(projectConfig.activeLoadoutId).toBe("user:useronly");
      await expect(saveMateriaConfigPatch(cwd, { loadouts: { UserOnly: minimalLoadout() } }, { target: "project" })).rejects.toThrow(/already owned by user scope/);
    } finally {
      if (previousProfile === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previousProfile;
      await rm(temp, { recursive: true, force: true });
    }
  });
});

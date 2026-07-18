import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/config.js";
import {
  CENTRAL_CATALOG_LAYER_LABEL,
  centralCatalogSourceToPartial,
  isCentralCatalogSourceEmpty,
  type CentralCatalogConfigSource,
} from "../src/config/centralCatalogSource.js";
import { getUserMateriaAssetPath, getProjectConfigPath } from "../src/config/config.js";

/** Minimal valid materia definition for tests. */
function agentMateria(prompt: string): Record<string, unknown> {
  return { type: "agent", tools: "coding", prompt };
}

/** Minimal valid loadout referencing a materia by id. */
function singleSocketLoadout(materiaId: string): Record<string, unknown> {
  return { entry: "Socket-1", sockets: { "Socket-1": { materia: materiaId } } };
}

async function freshProject(): Promise<{ cwd: string; profileDir: string; restore: () => void }> {
  const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-central-layer-"));
  const cwd = path.join(temp, "project");
  const profileDir = path.join(temp, "profile");
  await mkdir(cwd, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  const previous = process.env.PI_MATERIA_PROFILE_DIR;
  process.env.PI_MATERIA_PROFILE_DIR = profileDir;
  return {
    cwd,
    profileDir,
    restore: () => {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    },
  };
}

describe("central catalog config layer", () => {
  test("isCentralCatalogSourceEmpty detects empty and absent sources", () => {
    expect(isCentralCatalogSourceEmpty(undefined)).toBe(true);
    expect(isCentralCatalogSourceEmpty({})).toBe(true);
    expect(isCentralCatalogSourceEmpty({ loadouts: {}, materia: {} })).toBe(true);
    expect(isCentralCatalogSourceEmpty({ materia: { Build: agentMateria("x") as never } })).toBe(false);
    expect(isCentralCatalogSourceEmpty({ loadouts: { "Central-Flow": singleSocketLoadout("Build") as never } })).toBe(false);
  });

  test("centralCatalogSourceToPartial shallow-clones loadouts and materia without a persisted source", () => {
    const source: CentralCatalogConfigSource = {
      loadouts: { "Central-Flow": singleSocketLoadout("Central-Build") as never },
      materia: { "Central-Build": agentMateria("central") as never },
    };
    const partial = centralCatalogSourceToPartial(source);
    expect(Object.keys(partial.loadouts ?? {})).toEqual(["Central-Flow"]);
    expect(Object.keys(partial.materia ?? {})).toEqual(["Central-Build"]);
    // Central definitions carry no persisted writable source field; provenance is
    // expressed through the `central` layer scope, not the persisted `source`.
    expect((partial.loadouts?.["Central-Flow"] as { source?: string }).source).toBeUndefined();
    expect((partial.materia?.["Central-Build"] as { source?: string }).source).toBeUndefined();
    // Shallow clone: the partial is a fresh top-level record, so layer merging
    // owns the map it normalizes without mutating the source's top-level map.
    expect(partial.materia).not.toBe((source as { materia: unknown }).materia);
    expect(partial.loadouts).not.toBe((source as { loadouts: unknown }).loadouts);
  });

  test("purely local workflow is unchanged when no central source is supplied", async () => {
    const { cwd, restore } = await freshProject();
    try {
      const loaded = await loadConfig(cwd);
      const scopes = loaded.layers?.map((layer) => layer.scope) ?? [];
      expect(scopes).not.toContain("central");
      expect(loaded.source).not.toContain(CENTRAL_CATALOG_LAYER_LABEL);
      // Precedence is unchanged from today: default < user < project < explicit.
      expect(scopes).toEqual(["default", "user", "project"]);
    } finally {
      restore();
    }
  });

  test("an empty central source is treated as absent", async () => {
    const { cwd, restore } = await freshProject();
    try {
      const loaded = await loadConfig(cwd, undefined, { centralSource: {} });
      const scopes = loaded.layers?.map((layer) => layer.scope) ?? [];
      expect(scopes).not.toContain("central");
    } finally {
      restore();
    }
  });

  test("surfaces central loadouts and materia with central provenance between default and user", async () => {
    const { cwd, restore } = await freshProject();
    try {
      const centralSource: CentralCatalogConfigSource = {
        loadouts: { "Central-Flow": singleSocketLoadout("Central-Build") as never },
        materia: { "Central-Build": agentMateria("central build") as never },
      };
      const loaded = await loadConfig(cwd, undefined, { centralSource });

      // Central sits above bundled defaults and below user config.
      const scopes = loaded.layers?.map((layer) => layer.scope) ?? [];
      expect(scopes).toEqual(["default", "central", "user", "project"]);
      const centralLayer = loaded.layers?.find((layer) => layer.scope === "central");
      expect(centralLayer).toBeDefined();
      expect(centralLayer?.loaded).toBe(true);
      // The central layer has no local backing file.
      expect(centralLayer?.path).toBeUndefined();

      expect(loaded.config.loadouts?.["Central-Flow"]).toBeDefined();
      expect(loaded.config.materia?.["Central-Build"]).toBeDefined();
      expect(loaded.loadoutSources?.["Central-Flow"]).toBe("central");
      expect(loaded.materiaSources?.["Central-Build"]).toBe("central");

      // Source string surfaces the central layer between default and user.
      expect(loaded.source).toContain(`default.json < ${CENTRAL_CATALOG_LAYER_LABEL}`);
    } finally {
      restore();
    }
  });

  test("local user definitions override central definitions for the same id/name", async () => {
    const { cwd, profileDir, restore } = await freshProject();
    try {
      await writeFile(
        getUserMateriaAssetPath(),
        JSON.stringify({
          loadouts: { "Central-Flow": { ...singleSocketLoadout("Central-Build"), id: "user:central-flow" } },
          materia: { "Central-Build": agentMateria("user wins") },
        }),
        "utf8",
      );
      const centralSource: CentralCatalogConfigSource = {
        loadouts: { "Central-Flow": { ...singleSocketLoadout("Central-Build"), id: "central:central-flow" } as never },
        materia: { "Central-Build": agentMateria("central wins over default") },
      };
      const loaded = await loadConfig(cwd, undefined, { centralSource });

      // Local (user) loadout wins over central: user id + user source.
      expect(loaded.config.loadouts?.["Central-Flow"].id).toBe("user:central-flow");
      expect(loaded.loadoutSources?.["Central-Flow"]).toBe("user");
      // Local (user) materia wins over central.
      expect(loaded.materiaSources?.["Central-Build"]).toBe("user");
      expect(loaded.config.materia?.["Central-Build"].prompt).toBe("user wins");
    } finally {
      restore();
    }
  });

  test("project definitions override central definitions", async () => {
    const { cwd, restore } = await freshProject();
    try {
      await mkdir(path.dirname(getProjectConfigPath(cwd)), { recursive: true });
      await writeFile(
        getProjectConfigPath(cwd),
        JSON.stringify({
          loadouts: { "Central-Flow": { ...singleSocketLoadout("Central-Build"), id: "project:central-flow" } },
        }),
        "utf8",
      );
      const centralSource: CentralCatalogConfigSource = {
        loadouts: { "Central-Flow": { ...singleSocketLoadout("Central-Build"), id: "central:central-flow" } as never },
        materia: { "Central-Build": agentMateria("central") },
      };
      const loaded = await loadConfig(cwd, undefined, { centralSource });
      expect(loaded.config.loadouts?.["Central-Flow"].id).toBe("project:central-flow");
      expect(loaded.loadoutSources?.["Central-Flow"]).toBe("project");
    } finally {
      restore();
    }
  });

  test("central materia overrides a bundled default materia by id, and is itself overridden locally", async () => {
    const { cwd, profileDir, restore } = await freshProject();
    try {
      // Central provides an override of the shipped default "Build" materia.
      const centralOverride: CentralCatalogConfigSource = {
        materia: { Build: agentMateria("central override of default Build") as never },
      };
      const withCentral = await loadConfig(cwd, undefined, { centralSource: centralOverride });
      expect(withCentral.materiaSources?.Build).toBe("central");
      expect(withCentral.config.materia?.Build.prompt).toBe("central override of default Build");

      // A local user override wins over the central override.
      await writeFile(
        getUserMateriaAssetPath(),
        JSON.stringify({ materia: { Build: agentMateria("user override wins") } }),
        "utf8",
      );
      const withUser = await loadConfig(cwd, undefined, { centralSource: centralOverride });
      expect(withUser.materiaSources?.Build).toBe("user");
      expect(withUser.config.materia?.Build.prompt).toBe("user override wins");
    } finally {
      restore();
    }
  });

  test("central loadouts cannot override shipped default loadouts by name (shipped-default immutability)", async () => {
    const { cwd, restore } = await freshProject();
    try {
      const centralSource: CentralCatalogConfigSource = {
        loadouts: { "Full-Auto": { ...singleSocketLoadout("Central-Build"), id: "central:full-auto" } as never },
        materia: { "Central-Build": agentMateria("central") },
      };
      const loaded = await loadConfig(cwd, undefined, { centralSource });
      // The shipped default Full-Auto is preserved; central cannot claim its name.
      expect(loaded.config.loadouts?.["Full-Auto"].id).toBe("default:full-auto");
      expect(loaded.loadoutSources?.["Full-Auto"]).toBe("default");
    } finally {
      restore();
    }
  });

  test("a central utility materia does not break load when the central layer has no path", async () => {
    const { cwd, restore } = await freshProject();
    try {
      const centralSource: CentralCatalogConfigSource = {
        materia: {
          "Central-Utility": { type: "utility", command: ["node", "/abs/central-script.mjs"] } as never,
        },
      };
      const loaded = await loadConfig(cwd, undefined, { centralSource });
      expect(loaded.materiaSources?.["Central-Utility"]).toBe("central");
      expect(loaded.config.materia?.["Central-Utility"].command).toEqual(["node", "/abs/central-script.mjs"]);
    } finally {
      restore();
    }
  });

  test("clearly marks a last-known central layer in loaded source metadata", async () => {
    const { cwd, restore } = await freshProject();
    try {
      const centralSource: CentralCatalogConfigSource = {
        materia: { "Central-Build": agentMateria("cached") as never },
        summaries: {},
        snapshot: {
          status: "last-known",
          fetchedAt: "2026-07-18T01:00:00.000Z",
          attemptedAt: "2026-07-18T02:00:00.000Z",
          reason: "Central catalog refresh failed; using the last-known in-memory snapshot.",
        },
      };
      const loaded = await loadConfig(cwd, undefined, { centralSource });

      expect(loaded.source).toContain("central (last-known snapshot from 2026-07-18T01:00:00.000Z)");
      expect(loaded.centralCatalogSnapshot?.status).toBe("last-known");
      expect(loaded.layers?.find((layer) => layer.scope === "central")?.centralCatalogSnapshot?.status).toBe("last-known");
      expect(loaded.materiaSources?.["Central-Build"]).toBe("central");
    } finally {
      restore();
    }
  });
});

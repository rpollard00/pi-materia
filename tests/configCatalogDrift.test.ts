import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig, getProjectConfigPath, getUserMateriaAssetPath } from "../src/config/config.js";
import {
  centralCatalogSummaryKey,
  type CentralCatalogConfigSource,
} from "../src/config/centralCatalogSource.js";
import { computeDefinitionDigest } from "../src/config/catalogDrift.js";
import { hashCentralContent } from "../src/central/controlPlane/centralCatalogRepository.js";
import type { CatalogOriginProvenance } from "../src/domain/catalogProvenance.js";

/** Minimal valid materia/loadout shapes for drift tests. */
function agentMateria(prompt: string): Record<string, unknown> {
  return { type: "agent", tools: "coding", prompt };
}
function singleSocketLoadout(materiaId: string): Record<string, unknown> {
  return { entry: "Socket-1", sockets: { "Socket-1": { materia: materiaId } } };
}

function origin(catalogItemId: string, catalogContentHash: string, version = "3"): CatalogOriginProvenance {
  return { catalogItemId, catalogVersion: version, catalogContentHash, source: "user" };
}

async function freshProject(): Promise<{ cwd: string; restore: () => void }> {
  const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-catalog-drift-"));
  const cwd = path.join(temp, "project");
  const profileDir = path.join(temp, "profile");
  await mkdir(cwd, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  const previous = process.env.PI_MATERIA_PROFILE_DIR;
  process.env.PI_MATERIA_PROFILE_DIR = profileDir;
  return {
    cwd,
    restore: () => {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    },
  };
}

async function writeUserConfig(value: unknown): Promise<void> {
  await mkdir(path.dirname(getUserMateriaAssetPath()), { recursive: true });
  await writeFile(getUserMateriaAssetPath(), JSON.stringify(value), "utf8");
}

describe("catalog drift detection in config layering", () => {
  test("computeDefinitionDigest matches the central catalog hash for the same content", () => {
    const def = agentMateria("central build");
    // Stripping catalogOrigin leaves the same content the central repository hashes.
    const { catalogOrigin: _omit, ...content } = { ...def, catalogOrigin: origin("x", "h") };
    expect(computeDefinitionDigest({ ...def, catalogOrigin: origin("x", "h") })).toBe(hashCentralContent({ definition: content }));
    // And differs when content differs.
    expect(computeDefinitionDigest(agentMateria("other"))).not.toBe(computeDefinitionDigest(agentMateria("central build")));
  });

  test("drift is left unset when no central summaries are available", async () => {
    const { cwd, restore } = await freshProject();
    try {
      await writeUserConfig({
        materia: { "Central-Build": { ...agentMateria("central build"), catalogOrigin: origin("team-build", "sha256:whatever") } },
      });
      // Central definitions present but no summaries → cannot resolve drift.
      const centralSource: CentralCatalogConfigSource = { materia: { "Central-Build": agentMateria("central build") as never } };
      const loaded = await loadConfig(cwd, undefined, { centralSource });
      expect(loaded.catalogDrift).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("materia drift resolves current/behind/diverged/orphaned and is surfaced in LoadedConfig", async () => {
    const { cwd, restore } = await freshProject();
    try {
      // Record the origin hash from the normalized loaded materia (digest-assisted
      // so the test does not assume normalization output).
      await writeUserConfig({
        materia: { "Central-Build": { ...agentMateria("central build"), catalogOrigin: origin("team-build", "sha256:placeholder") } },
      });
      const probe = await loadConfig(cwd);
      const digest = computeDefinitionDigest(probe.config.materia!["Central-Build"] as unknown as Record<string, unknown>);

      // Rewrite with the real origin hash so an unedited copy is "current".
      await writeUserConfig({
        materia: {
          "Central-Build": { ...agentMateria("central build"), catalogOrigin: origin("team-build", digest) },
        },
      });

      const currentCentral: CentralCatalogConfigSource = {
        summaries: { [centralCatalogSummaryKey("materia", "team-build")]: { version: "3", contentHash: digest } },
      };
      const loadedCurrent = await loadConfig(cwd, undefined, { centralSource: currentCentral });
      expect(loadedCurrent.catalogDrift?.materia?.["Central-Build"]).toEqual({
        status: "current",
        centralVersion: "3",
        centralContentHash: digest,
      });

      // Central moved, local unchanged → behind.
      const behindCentral: CentralCatalogConfigSource = {
        summaries: { [centralCatalogSummaryKey("materia", "team-build")]: { version: "5", contentHash: "sha256:central-new" } },
      };
      const loadedBehind = await loadConfig(cwd, undefined, { centralSource: behindCentral });
      expect(loadedBehind.catalogDrift?.materia?.["Central-Build"]).toEqual({
        status: "behind",
        centralVersion: "5",
        centralContentHash: "sha256:central-new",
      });

      const staleBehind = await loadConfig(cwd, undefined, {
        centralSource: {
          ...behindCentral,
          snapshot: {
            status: "last-known",
            fetchedAt: "2026-07-18T01:00:00.000Z",
            attemptedAt: "2026-07-18T02:00:00.000Z",
          },
        },
      });
      expect(staleBehind.catalogDrift?.materia?.["Central-Build"]).toEqual({
        status: "behind",
        centralVersion: "5",
        centralContentHash: "sha256:central-new",
        stale: true,
        reason: "Central catalog is unavailable; compared with the last-known snapshot from 2026-07-18T01:00:00.000Z.",
      });

      // Central moved and local edited → diverged.
      await writeUserConfig({
        materia: {
          "Central-Build": { ...agentMateria("locally edited"), catalogOrigin: origin("team-build", digest) },
        },
      });
      const loadedDiverged = await loadConfig(cwd, undefined, { centralSource: behindCentral });
      expect(loadedDiverged.catalogDrift?.materia?.["Central-Build"]).toEqual({
        status: "diverged",
        centralVersion: "5",
        centralContentHash: "sha256:central-new",
      });

      // Origin item gone from central summaries → orphaned. Drift detection
      // must NOT mutate the local file across this load.
      const orphanCentral: CentralCatalogConfigSource = { summaries: {} };
      const before = await readFile(getUserMateriaAssetPath(), "utf8");
      const loadedOrphan = await loadConfig(cwd, undefined, { centralSource: orphanCentral });
      expect(loadedOrphan.catalogDrift?.materia?.["Central-Build"]).toEqual({ status: "orphaned" });
      const after = await readFile(getUserMateriaAssetPath(), "utf8");
      expect(after).toBe(before);
    } finally {
      restore();
    }
  });

  test("loadout drift resolves behind against central summaries", async () => {
    const { cwd, restore } = await freshProject();
    try {
      await writeUserConfig({
        materia: { "Central-Build": agentMateria("central build") },
        loadouts: {
          "Central-Flow": { ...singleSocketLoadout("Central-Build"), id: "user:central-flow", source: "user", catalogOrigin: origin("team-flow", "sha256:placeholder") },
        },
      });
      const probe = await loadConfig(cwd);
      const digest = computeDefinitionDigest(probe.config.loadouts!["Central-Flow"] as unknown as Record<string, unknown>);

      // Rewrite with the real origin hash so the local copy is not seen as edited.
      await writeUserConfig({
        materia: { "Central-Build": agentMateria("central build") },
        loadouts: {
          "Central-Flow": { ...singleSocketLoadout("Central-Build"), id: "user:central-flow", source: "user", catalogOrigin: origin("team-flow", digest) },
        },
      });

      // Central moved, local unchanged → behind.
      const behindCentral: CentralCatalogConfigSource = {
        summaries: { [centralCatalogSummaryKey("loadout", "team-flow")]: { version: "4", contentHash: "sha256:central-new" } },
      };
      const loaded = await loadConfig(cwd, undefined, { centralSource: behindCentral });
      expect(loaded.catalogDrift?.loadouts?.["Central-Flow"]).toEqual({
        status: "behind",
        centralVersion: "4",
        centralContentHash: "sha256:central-new",
      });
      // current when the central summary matches the recorded origin hash.
      const currentCentral: CentralCatalogConfigSource = {
        summaries: { [centralCatalogSummaryKey("loadout", "team-flow")]: { version: "3", contentHash: digest } },
      };
      const loadedCurrent = await loadConfig(cwd, undefined, { centralSource: currentCentral });
      expect(loadedCurrent.catalogDrift?.loadouts?.["Central-Flow"]).toEqual({
        status: "current",
        centralVersion: "3",
        centralContentHash: digest,
      });
    } finally {
      restore();
    }
  });

  test("drift is not computed for default/central-owned definitions", async () => {
    const { cwd, restore } = await freshProject();
    try {
      // Central-layer materia carry no catalogOrigin; only local copies drift.
      const centralSource: CentralCatalogConfigSource = {
        materia: { "Central-Build": agentMateria("central build") as never },
        summaries: { [centralCatalogSummaryKey("materia", "team-build")]: { version: "3", contentHash: "sha256:central" } },
      };
      const loaded = await loadConfig(cwd, undefined, { centralSource });
      expect(loaded.materiaSources?.["Central-Build"]).toBe("central");
      expect(loaded.catalogDrift).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("purely local workflow is unchanged when no central source is supplied", async () => {
    const { cwd, restore } = await freshProject();
    try {
      await writeUserConfig({ materia: { Build: agentMateria("local only") } });
      const loaded = await loadConfig(cwd);
      expect(loaded.catalogDrift).toBeUndefined();
    } finally {
      restore();
    }
  });
});

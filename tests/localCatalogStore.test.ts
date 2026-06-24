import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { applyCatalogToLocalAction, type CatalogActionDeps } from "../src/application/catalogActions.js";
import type { ControlPlanePorts } from "../src/application/controlPlane.js";
import { loadConfig, getUserMateriaAssetPath } from "../src/config/config.js";
import { createInMemoryCentralPorts } from "../src/central/controlPlane/inMemoryCentralPorts.js";
import { hashCentralContent } from "../src/central/controlPlane/centralCatalogRepository.js";
import { createLocalConfigCatalogStore } from "../src/infrastructure/localControlPlane/catalogStore.js";
import { centralCatalogSummaryKey, type CentralCatalogConfigSource } from "../src/config/centralCatalogSource.js";
import type { CatalogLocalActionRequest } from "../src/domain/catalogActions.js";

function agentMateria(prompt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "agent", tools: "coding", prompt, ...extra };
}
function singleSocketLoadout(materiaId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { entry: "Socket-1", sockets: { "Socket-1": { materia: materiaId } }, ...extra };
}

async function freshProject(): Promise<{ cwd: string; restore: () => void }> {
  const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-catalog-actions-"));
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

/**
 * Real central control-plane ports backed by the in-memory catalog repository,
 * so create/update produce monotonic versions and real content hashes. The
 * catalog read port is wired to the same repository the admin writes to.
 */
function centralPorts(): ControlPlanePorts {
  return createInMemoryCentralPorts({ authMethods: [] });
}

function req(partial: Partial<CatalogLocalActionRequest> & Pick<CatalogLocalActionRequest, "action">): CatalogLocalActionRequest {
  return { kind: "materia", catalogItemId: "team-build", localKey: "Team-Build", target: "user", ...partial };
}

describe("local config catalog store — read/write", () => {
  test("readLocalDefinition returns undefined for an absent key and the definition when present", async () => {
    const { cwd, restore } = await freshProject();
    try {
      const store = createLocalConfigCatalogStore({ cwd });
      expect(await store.readLocalDefinition("materia", "Team-Build")).toBeUndefined();

      await writeUserConfig({ materia: { "Team-Build": agentMateria("local") } });
      const definition = await store.readLocalDefinition("materia", "Team-Build");
      expect(definition?.prompt).toBe("local");
    } finally {
      restore();
    }
  });

  test("writeLocalDefinition persists a materia with catalog origin through the local save path", async () => {
    const { cwd, restore } = await freshProject();
    try {
      const store = createLocalConfigCatalogStore({ cwd });
      const definition = { ...agentMateria("central build"), catalogOrigin: { catalogItemId: "team-build", catalogVersion: "1", catalogContentHash: "sha256:x", source: "user" } };
      const { path: written } = await store.writeLocalDefinition("materia", "Team-Build", definition, "user");
      expect(written).toBe(getUserMateriaAssetPath());

      const loaded = await loadConfig(cwd);
      expect(loaded.config.materia?.["Team-Build"].prompt).toBe("central build");
      expect(loaded.materiaSources?.["Team-Build"]).toBe("user");
      expect(loaded.config.materia?.["Team-Build"].catalogOrigin).toEqual({
        catalogItemId: "team-build",
        catalogVersion: "1",
        catalogContentHash: "sha256:x",
        source: "user",
      });
    } finally {
      restore();
    }
  });

  test("writeLocalDefinition stamps local ownership (source/id) on a promoted loadout", async () => {
    const { cwd, restore } = await freshProject();
    try {
      await writeUserConfig({ materia: { Build: agentMateria("build") } });
      const store = createLocalConfigCatalogStore({ cwd });
      // Promoted loadout content carries no local ownership metadata.
      const promoted = { ...singleSocketLoadout("Build"), catalogOrigin: { catalogItemId: "team-flow", catalogVersion: "1", catalogContentHash: "sha256:y", source: "project" } };
      await store.writeLocalDefinition("loadout", "Team-Flow", promoted, "project");

      const loaded = await loadConfig(cwd);
      const loadout = loaded.config.loadouts?.["Team-Flow"];
      expect(loadout?.source).toBe("project");
      expect(typeof loadout?.id).toBe("string");
      expect(loadout?.id).toBe("project:team-flow");
      expect(loadout?.catalogOrigin).toEqual({ catalogItemId: "team-flow", catalogVersion: "1", catalogContentHash: "sha256:y", source: "project" });
    } finally {
      restore();
    }
  });
});

describe("local config catalog store — immutability / ownership guardrails", () => {
  test("promoting a loadout onto a shipped default name is rejected by the local save path", async () => {
    const { cwd, restore } = await freshProject();
    try {
      await writeUserConfig({ materia: { Build: agentMateria("build") } });
      const store = createLocalConfigCatalogStore({ cwd });
      const promoted = { ...singleSocketLoadout("Build"), catalogOrigin: { catalogItemId: "team-flow", catalogVersion: "1", catalogContentHash: "sha256:y", source: "user" } };
      // "Full-Auto" is a shipped default loadout; the duplicate-ownership
      // guardrail must reject promoting onto it.
      await expect(store.writeLocalDefinition("loadout", "Full-Auto", promoted, "user")).rejects.toThrow(/already owned by default/);
    } finally {
      restore();
    }
  });

  test("writing a loadout with a default source marker is rejected (shipped-default immutability)", async () => {
    const { cwd, restore } = await freshProject();
    try {
      await writeUserConfig({ materia: { Build: agentMateria("build") } });
      const store = createLocalConfigCatalogStore({ cwd });
      // Even if a caller tried to smuggle a default source, the store strips
      // ownership via preparePromotedDefinition upstream; here we verify the
      // save path still rejects a raw default-source loadout directly.
      const smuggled = { ...singleSocketLoadout("Build"), source: "default" };
      await expect(store.writeLocalDefinition("loadout", "Smuggled-Flow", smuggled, "user")).rejects.toThrow(/Cannot save shipped default/);
    } finally {
      restore();
    }
  });
});

describe("central-to-local action — end-to-end through the real save path", () => {
  test("copy then update refreshes provenance and resolves drift to current", async () => {
    const { cwd, restore } = await freshProject();
    try {
      // Central publishes v1 via the real admin write path.
      const centralV1 = agentMateria("central build");
      const ports = centralPorts();
      await ports.admin.createCatalogItem({ id: "team-build", kind: "materia", content: { definition: centralV1 } });
      const deps: CatalogActionDeps = { catalog: ports.catalog, localStore: createLocalConfigCatalogStore({ cwd }) };

      // copy → new local definition with provenance.
      const copyResult = await applyCatalogToLocalAction(req({ action: "copy" }), deps);
      expect(copyResult.status).toBe("applied");
      if (copyResult.status !== "applied") return;
      expect(copyResult.origin.catalogVersion).toBe("1");

      // Reload and confirm provenance + that central drift is current for the copy.
      const centralSource: CentralCatalogConfigSource = {
        summaries: { [centralCatalogSummaryKey("materia", "team-build")]: { version: "1", contentHash: hashCentralContent({ definition: centralV1 }) } },
      };
      let loaded = await loadConfig(cwd, undefined, { centralSource });
      expect(loaded.config.materia?.["Team-Build"].catalogOrigin?.catalogVersion).toBe("1");
      expect(loaded.catalogDrift?.materia?.["Team-Build"]?.status).toBe("current");

      // Central publishes v2 with new content via the admin write path. The
      // local copy is now behind.
      const centralV2 = agentMateria("central build v2");
      await ports.admin.updateCatalogItem({ id: "team-build", kind: "materia", content: { definition: centralV2 } });
      const behindSource: CentralCatalogConfigSource = {
        summaries: { [centralCatalogSummaryKey("materia", "team-build")]: { version: "2", contentHash: hashCentralContent({ definition: centralV2 }) } },
      };
      loaded = await loadConfig(cwd, undefined, { centralSource: behindSource });
      expect(loaded.catalogDrift?.materia?.["Team-Build"]?.status).toBe("behind");

      // update without confirmation must NOT mutate local files.
      const beforeFile = await readFile(getUserMateriaAssetPath(), "utf8");
      const needsConfirm = await applyCatalogToLocalAction(req({ action: "update" }), deps);
      expect(needsConfirm.status).toBe("needs_confirmation");
      expect(await readFile(getUserMateriaAssetPath(), "utf8")).toBe(beforeFile);

      // update with confirmation refreshes to v2 and resolves drift to current.
      const updateResult = await applyCatalogToLocalAction(req({ action: "update", confirmOverwrite: true }), deps);
      expect(updateResult.status).toBe("applied");
      if (updateResult.status !== "applied") return;
      expect(updateResult.origin.catalogVersion).toBe("2");
      expect(updateResult.previousOrigin?.catalogVersion).toBe("1");

      loaded = await loadConfig(cwd, undefined, { centralSource: behindSource });
      expect(loaded.config.materia?.["Team-Build"].prompt).toBe("central build v2");
      expect(loaded.config.materia?.["Team-Build"].catalogOrigin?.catalogVersion).toBe("2");
      expect(loaded.catalogDrift?.materia?.["Team-Build"]?.status).toBe("current");
    } finally {
      restore();
    }
  });

  test("replace overwrites an unrelated local definition only with confirmation", async () => {
    const { cwd, restore } = await freshProject();
    try {
      await writeUserConfig({ materia: { "Team-Build": agentMateria("hand-authored") } });
      const ports = centralPorts();
      await ports.admin.createCatalogItem({ id: "team-build", kind: "materia", content: { definition: agentMateria("central build") } });
      const deps: CatalogActionDeps = { catalog: ports.catalog, localStore: createLocalConfigCatalogStore({ cwd }) };

      const beforeFile = await readFile(getUserMateriaAssetPath(), "utf8");
      const needsConfirm = await applyCatalogToLocalAction(req({ action: "replace" }), deps);
      expect(needsConfirm.status).toBe("needs_confirmation");
      expect(await readFile(getUserMateriaAssetPath(), "utf8")).toBe(beforeFile);

      const replaced = await applyCatalogToLocalAction(req({ action: "replace", confirmOverwrite: true }), deps);
      expect(replaced.status).toBe("applied");
      const loaded = await loadConfig(cwd);
      expect(loaded.config.materia?.["Team-Build"].prompt).toBe("central build");
      expect(loaded.config.materia?.["Team-Build"].catalogOrigin?.catalogItemId).toBe("team-build");
    } finally {
      restore();
    }
  });
});

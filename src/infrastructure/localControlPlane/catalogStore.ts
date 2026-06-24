import { loadConfig, saveMateriaConfigPatch } from "../../config/config.js";
import type { LocalCatalogStore } from "../../application/catalogActions.js";
import type { CatalogDefinitionKind, CatalogLocalTargetScope } from "../../domain/catalogActions.js";
import type { MateriaConfigPatch, MateriaSaveTarget } from "../../types.js";

/**
 * Local catalog store backed by the existing local config load/save path.
 *
 * Reads come from {@link loadConfig} (merged/normalized local config, including
 * ownership/source metadata). Writes go through {@link saveMateriaConfigPatch},
 * so every shipped-default immutability, loadout ownership/locking,
 * duplicate-name, and materia-reference guardrail is enforced for promoted
 * central definitions — exactly as for hand-edited local config
 * (docs/enterprise-control-plane.md §10, §12; docs/loadout-ownership-locking.md).
 *
 * This is the only local-write boundary for catalog promotions. It carries no
 * central dependency and changes no quest-board routes or semantics.
 */
export interface LocalConfigCatalogStoreOptions {
  cwd: string;
  /** Explicit config path, when an explicit target is active. */
  configuredPath?: string;
}

export function createLocalConfigCatalogStore(options: LocalConfigCatalogStoreOptions): LocalCatalogStore {
  const { cwd, configuredPath } = options;

  return {
    async readLocalDefinition(kind: CatalogDefinitionKind, localKey: string) {
      const loaded = await loadConfig(cwd, configuredPath);
      if (kind === "materia") {
        const definition = loaded.config.materia?.[localKey];
        return definition !== undefined ? (definition as unknown as Readonly<Record<string, unknown>>) : undefined;
      }
      const loadout = loaded.config.loadouts?.[localKey];
      return loadout !== undefined ? (loadout as unknown as Readonly<Record<string, unknown>>) : undefined;
    },

    async writeLocalDefinition(
      kind: CatalogDefinitionKind,
      localKey: string,
      definition: Readonly<Record<string, unknown>>,
      target: CatalogLocalTargetScope,
    ): Promise<{ path: string }> {
      // Build a single-definition patch and route through the normal local save
      // path. The save path owns id/source/lockState stamping, immutability,
      // ownership/locking, duplicate-name, and materia-reference validation, so
      // a promoted central definition becomes a proper local-owned definition.
      const patch = (
        kind === "materia"
          ? { materia: { [localKey]: definition } }
          : { loadouts: { [localKey]: definition } }
      ) as unknown as MateriaConfigPatch;
      const path = await saveMateriaConfigPatch(cwd, patch, { target: target as MateriaSaveTarget, configuredPath });
      return { path };
    },
  };
}

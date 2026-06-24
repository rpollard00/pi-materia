import {
  type CatalogAccessPort,
  type CatalogItem,
  type CatalogItemKind,
  type CatalogItemSummary,
  type CatalogQuery,
} from "../../application/controlPlane.js";
import type { LoadedConfig, MateriaConfigLayerScope } from "../../types.js";
import {
  LOCAL_DEFINITION_UPDATED_AT,
  LOCAL_DEFINITION_VERSION,
  type LocalControlPlaneAdapterOptions,
  hashLocalDefinition,
  localAdapterModeMetadata,
  localLoadoutItemId,
  localMateriaItemId,
  resolveLocalScope,
} from "./shared.js";

/**
 * Local catalog access port.
 *
 * Exposes existing local materia and loadout definitions as read-only catalog
 * DTOs so consumers have a unified read surface in local-only mode. Local
 * definitions are not centrally versioned/timestamped; `version`/`updatedAt` are
 * sentinels and `contentHash` is the meaningful change indicator
 * (docs/enterprise-control-plane.md §3.3, §14). Central catalog admin writes are
 * not available here (see {@link createLocalAdminMetadataPort}).
 */
export function createLocalCatalogAccessPort(options: LocalControlPlaneAdapterOptions): CatalogAccessPort {
  const mode = () => localAdapterModeMetadata(options);

  async function readItems(): Promise<CatalogItem[]> {
    if (!options.configSource) return [];
    const loaded = await options.configSource.getLoadedConfig();
    return [...buildMateriaItems(loaded), ...buildLoadoutItems(loaded)];
  }

  return {
    mode,
    async list(query?: CatalogQuery): Promise<CatalogItemSummary[]> {
      const items = await readItems();
      return items.filter((item) => matchesQuery(item, query)).map(toSummary);
    },
    async get(id: string, kind?: CatalogItemKind): Promise<CatalogItem | undefined> {
      const items = await readItems();
      return items.find((item) => item.id === id && (kind === undefined || item.kind === kind));
    },
    async head(id: string, kind?: CatalogItemKind): Promise<CatalogItemSummary | undefined> {
      const items = await readItems();
      const item = items.find((entry) => entry.id === id && (kind === undefined || entry.kind === kind));
      return item ? toSummary(item) : undefined;
    },
  };
}

function buildMateriaItems(loaded: LoadedConfig): CatalogItem[] {
  const materia = loaded.config.materia ?? {};
  const sources = loaded.materiaSources ?? {};
  return Object.entries(materia).map(([id, definition]) => {
    const definitionRecord = definition as unknown as Readonly<Record<string, unknown>>;
    return {
      ...materiaSummary(id, definitionRecord, resolveLocalScope(sources[id])),
      content: { definition: definitionRecord },
    };
  });
}

function buildLoadoutItems(loaded: LoadedConfig): CatalogItem[] {
  const loadouts = loaded.config.loadouts ?? {};
  const sources = loaded.loadoutSources ?? {};
  return Object.entries(loadouts).map(([name, loadout]) => {
    const definitionRecord = loadout as unknown as Readonly<Record<string, unknown>>;
    return {
      ...loadoutSummary(name, definitionRecord, resolveLocalScope(sources[name])),
      content: { definition: definitionRecord },
    };
  });
}

function materiaSummary(id: string, definition: Readonly<Record<string, unknown>>, scope: MateriaConfigLayerScope): CatalogItemSummary {
  return {
    id: localMateriaItemId(id),
    kind: "materia",
    name: id,
    version: LOCAL_DEFINITION_VERSION,
    updatedAt: LOCAL_DEFINITION_UPDATED_AT,
    contentHash: hashLocalDefinition(definition),
    provenance: { source: scope },
  };
}

function loadoutSummary(name: string, definition: Readonly<Record<string, unknown>>, scope: MateriaConfigLayerScope): CatalogItemSummary {
  return {
    id: localLoadoutItemId(name),
    kind: "loadout",
    name,
    version: LOCAL_DEFINITION_VERSION,
    updatedAt: LOCAL_DEFINITION_UPDATED_AT,
    contentHash: hashLocalDefinition(definition),
    provenance: { source: scope },
  };
}

function matchesQuery(summary: CatalogItemSummary, query: CatalogQuery | undefined): boolean {
  if (!query) return true;
  if (query.kind !== undefined && summary.kind !== query.kind) return false;
  if (query.search) {
    const needle = query.search.toLowerCase();
    const haystack = `${summary.id} ${summary.name ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function toSummary(item: CatalogItem): CatalogItemSummary {
  const { content: _content, ...summary } = item;
  return summary;
}

import type {
  CatalogAccessPort,
  CatalogItem,
  CatalogItemSummary,
} from "../../application/controlPlane.js";
import {
  centralCatalogSummaryKey,
  type CentralCatalogConfigSource,
  type CentralCatalogItemSummary,
} from "../../config/centralCatalogSource.js";
import type {
  CentralCatalogSnapshotMetadata,
  MateriaConfig,
  MateriaPipelineConfig,
} from "../../types.js";

/** Result of one best-effort refresh of the connected runtime's catalog layer. */
export interface CentralCatalogConfigSourceLoader {
  /**
   * Return a fresh source, a clearly marked in-memory last-known source, or
   * `undefined` when central is unavailable before any snapshot was obtained.
   */
  load(): Promise<CentralCatalogConfigSource | undefined>;
}

export interface CentralCatalogConfigSourceLoaderOptions {
  /** Stable clock used by tests and snapshot metadata. */
  readonly clock?: () => string;
  /** Optional diagnostic hook. It must not throw or affect local config loads. */
  readonly onRefreshFailure?: (error: unknown, usingLastKnownSnapshot: boolean) => void;
}

/**
 * Adapt the transport-neutral central catalog read port into the existing
 * read-only config source.
 *
 * A refresh is atomic: summaries and every corresponding definition must be
 * read before it replaces the last-known snapshot. The cache is deliberately
 * process-local; central reads never create or update a local file.
 */
export function createCentralCatalogConfigSourceLoader(
  catalog: CatalogAccessPort,
  options: CentralCatalogConfigSourceLoaderOptions = {},
): CentralCatalogConfigSourceLoader {
  const clock = options.clock ?? (() => new Date().toISOString());
  let lastKnown: CentralCatalogConfigSource | undefined;
  let inFlight: Promise<CentralCatalogConfigSource | undefined> | undefined;

  async function refresh(): Promise<CentralCatalogConfigSource | undefined> {
    const attemptedAt = clock();
    try {
      const source = await fetchCentralCatalogSource(catalog, attemptedAt);
      lastKnown = source;
      return cloneCentralSource(source);
    } catch (error) {
      const usingLastKnown = lastKnown !== undefined;
      try {
        options.onRefreshFailure?.(error, usingLastKnown);
      } catch {
        // Diagnostics must never turn an optional central read into a cast failure.
      }
      if (!lastKnown) return undefined;
      return cloneCentralSource(lastKnown, {
        status: "last-known",
        fetchedAt: lastKnown.snapshot?.fetchedAt ?? attemptedAt,
        attemptedAt,
        reason: "Central catalog refresh failed; using the last-known in-memory snapshot.",
      });
    }
  }

  return {
    load() {
      if (!inFlight) {
        inFlight = refresh().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },
  };
}

async function fetchCentralCatalogSource(
  catalog: CatalogAccessPort,
  fetchedAt: string,
): Promise<CentralCatalogConfigSource> {
  const summaries = [...await catalog.list()].sort(compareSummaries);
  const items = await Promise.all(summaries.map(async (summary) => {
    const item = await catalog.get(summary.id, summary.kind);
    if (!item) {
      throw new Error(`Central catalog changed while reading ${summary.kind}:${summary.id}; retry the snapshot.`);
    }
    if (item.id !== summary.id || item.kind !== summary.kind) {
      throw new Error(`Central catalog returned mismatched content for ${summary.kind}:${summary.id}.`);
    }
    return item;
  }));

  const loadouts: Record<string, MateriaPipelineConfig> = {};
  const materia: Record<string, MateriaConfig> = {};
  const sourceSummaries: Record<string, CentralCatalogItemSummary> = {};

  for (const item of items) {
    // Use metadata from the full item so a concurrent metadata/content update
    // cannot pair the newly fetched definition with an older list hash.
    const key = definitionKey(item);
    const definition = readDefinition(item);
    if (item.kind === "loadout") {
      if (Object.prototype.hasOwnProperty.call(loadouts, key)) {
        throw new Error(`Central catalog contains more than one loadout named ${JSON.stringify(key)}.`);
      }
      // A central layer's provenance is the layer itself. Never trust writable
      // local provenance embedded in a remotely published definition.
      delete definition.source;
      delete definition.catalogOrigin;
      loadouts[key] = definition as unknown as MateriaPipelineConfig;
    } else {
      delete definition.catalogOrigin;
      materia[key] = definition as unknown as MateriaConfig;
    }
    sourceSummaries[centralCatalogSummaryKey(item.kind, item.id)] = {
      version: item.version,
      contentHash: item.contentHash,
      updatedAt: item.updatedAt,
    };
  }

  const snapshot: CentralCatalogSnapshotMetadata = {
    status: "fresh",
    fetchedAt,
    attemptedAt: fetchedAt,
  };
  return {
    ...(Object.keys(loadouts).length > 0 ? { loadouts } : {}),
    ...(Object.keys(materia).length > 0 ? { materia } : {}),
    // Presence (including an empty record) means the list was read
    // successfully, allowing drift to resolve deleted origins as orphaned.
    summaries: sourceSummaries,
    snapshot,
  };
}

function definitionKey(summary: CatalogItemSummary): string {
  if (summary.kind === "materia") return summary.id;
  const name = summary.name?.trim();
  return name || summary.id;
}

function readDefinition(item: CatalogItem): Record<string, unknown> {
  const definition = item.content.definition;
  if (!isPlainObject(definition)) {
    throw new Error(`Central catalog definition ${item.kind}:${item.id} must be an object.`);
  }
  return cloneRecord(definition);
}

function compareSummaries(left: CatalogItemSummary, right: CatalogItemSummary): number {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function cloneCentralSource(
  source: CentralCatalogConfigSource,
  snapshot: CentralCatalogSnapshotMetadata | undefined = source.snapshot,
): CentralCatalogConfigSource {
  return {
    ...(source.loadouts ? { loadouts: cloneRecordMap(source.loadouts) } : {}),
    ...(source.materia ? { materia: cloneRecordMap(source.materia) } : {}),
    ...(source.summaries ? {
      summaries: Object.fromEntries(Object.entries(source.summaries).map(([key, value]) => [key, { ...value }])),
    } : {}),
    ...(snapshot ? { snapshot: { ...snapshot } } : {}),
  };
}

function cloneRecordMap<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, cloneValue(value)])) as Record<string, T>;
}

function cloneRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return cloneValue(record) as Record<string, unknown>;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

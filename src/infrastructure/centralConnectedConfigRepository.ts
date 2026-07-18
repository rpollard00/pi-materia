import type { ConfigRepository } from "../application/ports.js";
import type { CatalogAccessPort } from "../application/controlPlane.js";
import {
  createCentralHttpControlPlaneClient,
  type CentralHttpControlPlaneClientOptions,
} from "../central/client/index.js";
import { createCentralCatalogConfigSourceLoader } from "../central/client/catalogConfigSource.js";
import {
  loadCentralConnectedRuntimeConfig,
  type CentralConnectedRuntimeConfig,
} from "../central/config/index.js";
import {
  loadConfig,
  loadProfileConfig,
  resolveArtifactRoot,
  saveActiveLoadout,
  type LoadConfigOptions,
} from "../config/config.js";
import type { CentralCatalogConfigSource } from "../config/centralCatalogSource.js";
import { resolveLoadoutSelection } from "../loadout/defaultLoadoutResolver.js";
import type { LoadedConfig } from "../types.js";

interface LocalConfigAccess {
  load(cwd: string, configuredPath?: string, options?: LoadConfigOptions): Promise<LoadedConfig>;
  saveActiveLoadout(
    cwd: string,
    loadoutName: string,
    configuredPath?: string,
    options?: LoadConfigOptions,
  ): Promise<string>;
  resolveArtifactRoot(cwd: string, artifactDir?: string): string;
}

export interface CentralConnectedConfigRepositoryOptions {
  /** Resolve opt-in connection settings. Undefined guarantees local-only I/O. */
  readonly resolveRuntimeConfig?: () => Promise<CentralConnectedRuntimeConfig | undefined>;
  /** HTTP adapter seam used by tests; production uses the central HTTP client. */
  readonly createCatalogPort?: (options: CentralHttpControlPlaneClientOptions) => CatalogAccessPort;
  readonly local?: LocalConfigAccess;
  readonly clock?: () => string;
}

interface ActiveConnection {
  readonly config: CentralConnectedRuntimeConfig;
  readonly source: ReturnType<typeof createCentralCatalogConfigSourceLoader>;
}

interface ProcessLocalActiveSelection {
  readonly loadoutName: string;
  readonly loadoutId?: string;
}

const CENTRAL_ACTIVE_SELECTION_LABEL = "central (process-local active selection)";

/**
 * Compose local config persistence with an optional remote, read-only catalog
 * layer. Connection resolution and HTTP access happen lazily on `load`, so a
 * runtime with no central API URL follows the existing local-only path.
 */
export function createCentralConnectedConfigRepository(
  options: CentralConnectedConfigRepositoryOptions = {},
): ConfigRepository {
  const local = options.local ?? { load: loadConfig, saveActiveLoadout, resolveArtifactRoot };
  const resolveRuntimeConfig = options.resolveRuntimeConfig ?? defaultRuntimeConfigResolver;
  const createCatalogPort = options.createCatalogPort ?? ((clientOptions) => (
    createCentralHttpControlPlaneClient(clientOptions).catalog
  ));
  let connection: ActiveConnection | undefined;
  const activeSelections = new Map<string, ProcessLocalActiveSelection>();

  async function centralSource(): Promise<CentralCatalogConfigSource | undefined> {
    const config = await resolveRuntimeConfig();
    if (!config) {
      connection = undefined;
      activeSelections.clear();
      return undefined;
    }
    if (!connection || !sameRuntimeConfig(connection.config, config)) {
      const catalog = createCatalogPort({
        apiUrl: config.apiUrl,
        requestTimeoutMs: config.requestTimeoutMs,
        credentials: config.credentials,
        mode: "central-connected",
      });
      connection = {
        config,
        source: createCentralCatalogConfigSourceLoader(catalog, {
          ...(options.clock ? { clock: options.clock } : {}),
        }),
      };
    }
    return connection.source.load();
  }

  async function load(cwd: string, configuredPath?: string): Promise<LoadedConfig> {
    const source = await centralSource();
    const selectionKey = activeSelectionKey(cwd, configuredPath);
    if (!source) {
      const loaded = await local.load(cwd, configuredPath);
      return connection ? recoverUnavailableCentralSelection(loaded) : loaded;
    }
    try {
      const loaded = recoverUnavailableCentralSelection(await local.load(cwd, configuredPath, { centralSource: source }));
      return applyProcessLocalActiveSelection(loaded, activeSelections.get(selectionKey));
    } catch {
      // A malformed/internally inconsistent remote catalog must not prevent a
      // valid local cast. Re-run without the optional layer; if local config is
      // itself invalid, preserve that normal local failure. A legacy persisted
      // central-only identity is repaired in memory so the omitted layer cannot
      // leave local pipeline resolution unusable.
      try {
        return recoverUnavailableCentralSelection(await local.load(cwd, configuredPath));
      } catch (localError) {
        throw localError;
      }
    }
  }

  async function saveRuntimeActiveLoadout(
    cwd: string,
    loadoutName: string,
    configuredPath?: string,
  ): Promise<string> {
    const source = await centralSource();
    let usableSource = source;
    const selectionKey = activeSelectionKey(cwd, configuredPath);
    if (source) {
      try {
        const loaded = await local.load(cwd, configuredPath, { centralSource: source });
        const resolved = resolveLoadoutSelection(loadoutName, loaded.config.loadouts, loaded.loadoutSources);
        if (resolved && loaded.loadoutSources?.[resolved.loadoutName] === "central") {
          // Selecting a read-only remote definition is runtime state, not a
          // promotion. Keep it process-local so neither its content nor remote
          // identity is materialized in a writable local config file.
          activeSelections.set(selectionKey, {
            loadoutName: resolved.loadoutName,
            ...(resolved.loadoutId ? { loadoutId: resolved.loadoutId } : {}),
          });
          return CENTRAL_ACTIVE_SELECTION_LABEL;
        }
      } catch {
        // A malformed optional remote layer must not block selecting a local
        // loadout through the normal persistence path.
        usableSource = undefined;
      }
    }

    const writtenPath = await local.saveActiveLoadout(
      cwd,
      loadoutName,
      configuredPath,
      usableSource ? { centralSource: usableSource } : undefined,
    );
    activeSelections.delete(selectionKey);
    return writtenPath;
  }

  return {
    load,
    saveActiveLoadout: saveRuntimeActiveLoadout,
    resolveArtifactRoot: local.resolveArtifactRoot,
  };
}

async function defaultRuntimeConfigResolver(): Promise<CentralConnectedRuntimeConfig | undefined> {
  const profile = await loadProfileConfig();
  return loadCentralConnectedRuntimeConfig({ profile });
}

function activeSelectionKey(cwd: string, configuredPath: string | undefined): string {
  return `${cwd}\0${configuredPath ?? ""}`;
}

function applyProcessLocalActiveSelection(
  loaded: LoadedConfig,
  selection: ProcessLocalActiveSelection | undefined,
): LoadedConfig {
  if (!selection) return loaded;
  const resolved = resolveLoadoutSelection(
    selection.loadoutId ?? selection.loadoutName,
    loaded.config.loadouts,
    loaded.loadoutSources,
  );
  if (!resolved || loaded.loadoutSources?.[resolved.loadoutName] !== "central") return loaded;
  return {
    ...loaded,
    config: {
      ...loaded.config,
      activeLoadout: resolved.loadoutName,
      ...(resolved.loadoutId ? { activeLoadoutId: resolved.loadoutId } : {}),
    },
  };
}

function recoverUnavailableCentralSelection(loaded: LoadedConfig): LoadedConfig {
  const loadouts = loaded.config.loadouts ?? {};
  const activeName = loaded.config.activeLoadout?.trim();
  if (activeName && Object.prototype.hasOwnProperty.call(loadouts, activeName)) return loaded;

  // Older runtimes could persist a central selection by identity. If that
  // definition is absent from a fresh process during an outage (or was removed
  // centrally), prefer a still-resolvable stable id and otherwise fall back
  // deterministically to the first local/default loadout.
  const activeId = loaded.config.activeLoadoutId?.trim();
  const fallback = (activeId
    ? resolveLoadoutSelection(activeId, loadouts, loaded.loadoutSources)
    : null)
    ?? (() => {
      const firstName = Object.keys(loadouts)[0];
      return firstName ? resolveLoadoutSelection(firstName, loadouts, loaded.loadoutSources) : null;
    })();
  if (!fallback) return loaded;

  const { activeLoadoutId: _staleActiveLoadoutId, ...config } = loaded.config;
  return {
    ...loaded,
    config: {
      ...config,
      activeLoadout: fallback.loadoutName,
      ...(fallback.loadoutId ? { activeLoadoutId: fallback.loadoutId } : {}),
    },
  };
}

function sameRuntimeConfig(
  left: CentralConnectedRuntimeConfig,
  right: CentralConnectedRuntimeConfig,
): boolean {
  return left.apiUrl === right.apiUrl
    && left.requestTimeoutMs === right.requestTimeoutMs
    && left.credentials.readToken === right.credentials.readToken
    && left.credentials.adminToken === right.credentials.adminToken
    && left.credentials.telemetryToken === right.credentials.telemetryToken;
}

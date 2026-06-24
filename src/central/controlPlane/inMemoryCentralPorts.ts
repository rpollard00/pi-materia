import {
  centralAdminModeMetadata,
  type AdminMetadataPort,
  type AdminMetadataSnapshot,
  type CatalogAccessPort,
  type CatalogItem,
  type CatalogItemSummary,
  type CatalogItemWriteResult,
  type ControlPlaneModeMetadata,
  type ControlPlanePorts,
  type CreateCatalogItemInput,
  type DeleteCatalogItemInput,
  type ModelPolicyDocument,
  type ModelPolicyPort,
  type TelemetryIngestInput,
  type TelemetryIngestResult,
  type TelemetryStatusPort,
  type UpdateCatalogItemInput,
} from "../../application/controlPlane.js";
import type { AuthMethodKind } from "../../domain/auth.js";
import type { EnrichedEvent } from "../../domain/eventing.js";
import {
  createInMemoryCentralCatalogRepository,
  type CentralCatalogRepository,
  type InMemoryCentralCatalogRepositoryOptions,
} from "./centralCatalogRepository.js";
import {
  CENTRAL_IN_MEMORY_EVENT_CAP,
  nowIso,
} from "./shared.js";

/**
 * Minimal in-memory central control-plane ports.
 *
 * Backs the central server skeleton (docs/enterprise-control-plane.md §16.4)
 * with in-memory adapters that report `central-admin` topology and serve the
 * status surface. The implementations are intentionally minimal placeholders
 * except where a work item has landed:
 *
 * - **Catalog**: backed by the in-memory central catalog repository
 *   (§16.6). Read APIs serve loadout/materia definitions with stable ids,
 *   monotonic versions, timestamps, provenance, and content hashes; admin
 *   writes go through the admin port below. Central catalog data is **not**
 *   writable through normal local/project editing paths.
 * - **Model policy**: none served. Policy APIs are a later work item (§16.13).
 * - **Telemetry**: a small bounded in-memory event store so `status()` reports
 *   real counts. Full normalized ingestion/query is a later work item (§16.15,
 *   §16.16).
 * - **Admin**: server metadata plus the central catalog admin write surface
 *   (§16.6). Auth methods default to `["dev-token"]` and are configurable;
 *   dev-token auth + RBAC guards central routes (§16.5).
 *
 * The adapter never starts or touches a local repository session.
 */

export interface InMemoryCentralPortsOptions {
  /** Human-readable label surfaced through mode metadata and admin info. */
  label?: string;
  /** RFC3339 server start time surfaced through admin metadata. */
  startedAt?: string;
  /** Central API base URL surfaced through mode metadata. */
  centralApiBaseUrl?: string;
  /**
   * Auth method kinds the server reports in admin metadata. Defaults to
   * `["dev-token"]` now that dev-token auth guards central routes
   * (docs/enterprise-control-plane.md §13, §16.5). OAuth/OIDC is a future kind.
   */
  authMethods?: readonly AuthMethodKind[];
  /**
   * Inject an existing central catalog repository. Defaults to a fresh
   * in-memory repository, optionally seeded via {@link catalogSeed}.
   */
  catalogRepository?: CentralCatalogRepository;
  /** Initial central catalog items applied to a freshly created repository. */
  catalogSeed?: InMemoryCentralCatalogRepositoryOptions["seed"];
  /** Stable clock for catalog timestamps (tests); defaults to nowIso(). */
  catalogClock?: InMemoryCentralCatalogRepositoryOptions["clock"];
}

/** Internal record tying an ingested event to its originating runtime for query filtering. */
interface IngestedEventRecord {
  readonly runtimeId?: string;
  readonly event: EnrichedEvent;
}

export function createInMemoryCentralPorts(options: InMemoryCentralPortsOptions = {}): ControlPlanePorts {
  const modeMetadata: ControlPlaneModeMetadata = centralAdminModeMetadata({
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.centralApiBaseUrl !== undefined ? { centralApiBaseUrl: options.centralApiBaseUrl } : {}),
  });
  const startedAt = options.startedAt ?? nowIso();
  const authMethods: readonly AuthMethodKind[] = options.authMethods ?? ["dev-token"];
  const catalogRepository: CentralCatalogRepository =
    options.catalogRepository ??
    createInMemoryCentralCatalogRepository({
      ...(options.catalogSeed !== undefined ? { seed: options.catalogSeed } : {}),
      ...(options.catalogClock !== undefined ? { clock: options.catalogClock } : {}),
    });
  const store: IngestedEventRecord[] = [];

  function pushEvents(input: TelemetryIngestInput): number {
    const events = Array.isArray(input.events) ? input.events : [];
    for (const event of events) {
      if (store.length >= CENTRAL_IN_MEMORY_EVENT_CAP) store.shift();
      store.push({ ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}), event });
    }
    return events.length;
  }

  const catalog: CatalogAccessPort = {
    mode: () => modeMetadata,
    // Backed by the in-memory central catalog repository (§16.6). Read-only
    // here; admin writes go through the admin port below.
    async list(query?): Promise<CatalogItemSummary[]> {
      return catalogRepository.list(query);
    },
    async get(id: string, kind?): Promise<CatalogItem | undefined> {
      return catalogRepository.get(id, kind);
    },
    async head(id: string, kind?): Promise<CatalogItemSummary | undefined> {
      return catalogRepository.head(id, kind);
    },
  };

  const modelPolicy: ModelPolicyPort = {
    mode: () => modeMetadata,
    // Central model-policy APIs are a later work item (§16.13).
    async getActivePolicy(): Promise<ModelPolicyDocument | undefined> {
      return undefined;
    },
    async listPolicies(): Promise<ModelPolicyDocument[]> {
      return [];
    },
  };

  const telemetry: TelemetryStatusPort = {
    mode: () => modeMetadata,
    async ingest(input: TelemetryIngestInput): Promise<TelemetryIngestResult> {
      const accepted = pushEvents(input);
      return { accepted, ingestedAt: nowIso() };
    },
    async status() {
      const runtimeCount = new Set(
        store.map((record) => record.runtimeId).filter((value): value is string => value !== undefined),
      ).size;
      return {
        mode: "central-admin",
        capturedAt: nowIso(),
        healthy: true,
        eventCount: store.length,
        runtimeCount,
        ...(options.label !== undefined ? { label: options.label } : {}),
      };
    },
    async queryEvents(filter?): Promise<EnrichedEvent[]> {
      let records = store;
      if (filter?.runtimeId !== undefined) {
        records = records.filter((record) => record.runtimeId === filter.runtimeId);
      }
      let events = records.map((record) => record.event);
      if (filter?.castId !== undefined) {
        events = events.filter((event) => event.castId === filter.castId);
      }
      if (filter?.sinceSequence !== undefined) {
        events = events.filter((event) => event.sequence >= (filter.sinceSequence as number));
      }
      if (filter?.limit !== undefined && Number.isFinite(filter.limit)) {
        events = events.slice(0, Math.max(0, Math.floor(filter.limit)));
      }
      return events;
    },
  };

  const admin: AdminMetadataPort = {
    mode: () => modeMetadata,
    async getMetadata(): Promise<AdminMetadataSnapshot> {
      return {
        server: {
          mode: "central-admin",
          // Dev-token auth + RBAC is wired (§16.5); reports the configured method kinds.
          authMethods,
          capabilities: modeMetadata.capabilities,
          ...(options.label !== undefined ? { label: options.label } : {}),
          startedAt,
        },
      };
    },
    // Central catalog admin writes: the only path that may write central
    // catalog data (§16.6). Routed through the in-memory repository.
    async createCatalogItem(input: CreateCatalogItemInput): Promise<CatalogItemWriteResult> {
      return catalogRepository.create(input);
    },
    async updateCatalogItem(input: UpdateCatalogItemInput): Promise<CatalogItemWriteResult> {
      return catalogRepository.update(input);
    },
    async deleteCatalogItem(input: DeleteCatalogItemInput): Promise<CatalogItemWriteResult> {
      return catalogRepository.delete(input);
    },
  };

  return { catalog, modelPolicy, telemetry, admin };
}

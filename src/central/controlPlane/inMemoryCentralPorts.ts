import {
  centralAdminModeMetadata,
  type AdminMetadataPort,
  type AdminMetadataSnapshot,
  type CatalogAccessPort,
  type CatalogItem,
  type CatalogItemSummary,
  type CatalogItemWriteResult,
  type CentralModelCatalog,
  type ControlPlaneModeMetadata,
  type ControlPlanePorts,
  type CreateCatalogItemInput,
  type CreateModelPolicyInput,
  type DeleteCatalogItemInput,
  type DeleteModelPolicyInput,
  type ModelPolicyDocument,
  type ModelPolicyPort,
  type ModelPolicyWriteResult,
  type SetActiveModelPolicyInput,
  type TelemetryIngestInput,
  type TelemetryIngestResult,
  type TelemetryStatusPort,
  type UpdateCatalogItemInput,
  type UpdateModelPolicyInput,
} from "../../application/controlPlane.js";
import type { AuthMethodKind } from "../../domain/auth.js";
import type { EnrichedEvent } from "../../domain/eventing.js";
import {
  createInMemoryCentralCatalogRepository,
  type CentralCatalogRepository,
  type InMemoryCentralCatalogRepositoryOptions,
} from "./centralCatalogRepository.js";
import type { CentralModelPolicyRepository } from "./centralModelPolicyRepository.js";
import {
  createInMemoryModelPolicyRepository,
  type InMemoryModelPolicyRepositoryOptions,
} from "./inMemoryModelPolicyRepository.js";
import {
  CENTRAL_IN_MEMORY_EVENT_CAP,
  nowIso,
} from "./shared.js";

/**
 * Central control-plane port composition with in-memory defaults.
 *
 * Backs the central server (docs/enterprise-control-plane.md §16.4), reports
 * `central-admin` topology, and serves the status surface. Catalog/policy
 * repositories and the telemetry port are injectable; production startup
 * supplies their SQLite implementations while tests may retain these
 * lightweight defaults:
 *
 * - **Catalog**: backed by the configured central catalog repository
 *   (§16.6). Read APIs serve loadout/materia definitions with stable ids,
 *   monotonic versions, timestamps, provenance, and content hashes; admin
 *   writes go through the admin port below. Central catalog data is **not**
 *   writable through normal local/project editing paths.
 * - **Model policy**: backed by the configured model-policy repository
 *   (§16.13). Read APIs serve policy documents with monotonic versions,
 *   timestamps, and an active designation; admin writes go through the admin
 *   port below. Optional central model-catalog metadata is seeded and served
 *   separately from local Pi model availability (§11).
 * - **Telemetry**: production composition injects the durable SQLite telemetry
 *   port. The bounded in-memory store remains only as an explicit lightweight
 *   test/development fallback. Normalized ingestion is exposed through the
 *   central HTTP route `POST /api/telemetry/ingest` (§16.15), and monitoring
 *   reads remain available at `GET /api/status` and
 *   `GET /api/telemetry/events` (§15, §16.16).
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
  /**
   * Inject an existing central model-policy repository. Defaults to a fresh
   * in-memory repository, optionally seeded via {@link policySeed}.
   */
  policyRepository?: CentralModelPolicyRepository;
  /** Initial central model-policy documents applied to a freshly created repository. */
  policySeed?: InMemoryModelPolicyRepositoryOptions["seed"];
  /** Stable clock for model-policy timestamps (tests); defaults to nowIso(). */
  policyClock?: InMemoryModelPolicyRepositoryOptions["clock"];
  /**
   * Inject a telemetry/status adapter. Production server composition supplies
   * the SQLite implementation; omit for the bounded in-memory fallback.
   */
  telemetryPort?: TelemetryStatusPort;
  /**
   * Optional central model-catalog metadata, served read-only and independently
   * from local Pi model availability (§11). Omit when no central catalog is
   * configured.
   */
  modelCatalog?: CentralModelCatalog;
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
  const policyRepository: CentralModelPolicyRepository =
    options.policyRepository ??
    createInMemoryModelPolicyRepository({
      ...(options.policySeed !== undefined ? { seed: options.policySeed } : {}),
      ...(options.policyClock !== undefined ? { clock: options.policyClock } : {}),
    });
  const modelCatalog: CentralModelCatalog | undefined = options.modelCatalog;
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
    // Backed by the configured central catalog repository (§16.6). Read-only
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
    // Backed by the configured model-policy repository (§16.13). Read-only here;
    // admin writes go through the admin port below. Optional model-catalog
    // metadata is served separately from local Pi model availability (§11).
    async getActivePolicy(): Promise<ModelPolicyDocument | undefined> {
      return policyRepository.getActive();
    },
    async getActivePolicyId(): Promise<string | undefined> {
      return policyRepository.getActivePolicyId();
    },
    async listPolicies(): Promise<ModelPolicyDocument[]> {
      return policyRepository.list();
    },
    async getPolicy(id: string): Promise<ModelPolicyDocument | undefined> {
      return policyRepository.get(id);
    },
    async getModelCatalog(): Promise<CentralModelCatalog | undefined> {
      return modelCatalog;
    },
  };

  const telemetry: TelemetryStatusPort = options.telemetryPort ?? {
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
    // catalog data (§16.6). Routed through the configured repository.
    async createCatalogItem(input: CreateCatalogItemInput): Promise<CatalogItemWriteResult> {
      return catalogRepository.create(input);
    },
    async updateCatalogItem(input: UpdateCatalogItemInput): Promise<CatalogItemWriteResult> {
      return catalogRepository.update(input);
    },
    async deleteCatalogItem(input: DeleteCatalogItemInput): Promise<CatalogItemWriteResult> {
      return catalogRepository.delete(input);
    },
    // Central model-policy admin writes: the only path that may write central
    // model-policy data (§16.13). Routed through the configured repository.
    async createModelPolicy(input: CreateModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return policyRepository.create(input);
    },
    async updateModelPolicy(input: UpdateModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return policyRepository.update(input);
    },
    async deleteModelPolicy(input: DeleteModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return policyRepository.remove(input);
    },
    async setActiveModelPolicy(input: SetActiveModelPolicyInput): Promise<ModelPolicyWriteResult> {
      return policyRepository.setActive(input);
    },
  };

  return { catalog, modelPolicy, telemetry, admin };
}

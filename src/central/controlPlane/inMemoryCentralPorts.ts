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
import type { EnrichedEvent } from "../../domain/eventing.js";
import {
  CENTRAL_IN_MEMORY_EVENT_CAP,
  nowIso,
} from "./shared.js";

/**
 * Minimal in-memory central control-plane ports.
 *
 * Backs the central server skeleton (docs/enterprise-control-plane.md §16.4)
 * with in-memory adapters that report `central-admin` topology and serve the
 * status surface. The implementations are intentionally minimal placeholders:
 *
 * - **Catalog**: empty. The versioned central catalog repository is a later
 *   work item (§16.6); admin writes are rejected here until that lands.
 * - **Model policy**: none served. Policy APIs are a later work item (§16.13).
 * - **Telemetry**: a small bounded in-memory event store so `status()` reports
 *   real counts. Full normalized ingestion/query is a later work item (§16.15,
 *   §16.16).
 * - **Admin**: server metadata only, with no configured auth methods. The
 *   dev-token auth + RBAC surface is a later work item (§16.5).
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
    // Central catalog repository is a later work item (§16.6).
    async list(): Promise<CatalogItemSummary[]> {
      return [];
    },
    async get(_id: string): Promise<CatalogItem | undefined> {
      return undefined;
    },
    async head(_id: string): Promise<CatalogItemSummary | undefined> {
      return undefined;
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
          // Dev-token auth + RBAC is a later work item (§16.5).
          authMethods: [],
          capabilities: modeMetadata.capabilities,
          ...(options.label !== undefined ? { label: options.label } : {}),
          startedAt,
        },
      };
    },
    // Central catalog admin writes require the catalog repository (§16.6).
    async createCatalogItem(_input: CreateCatalogItemInput): Promise<CatalogItemWriteResult> {
      throw new Error("Central catalog repository is not available in the skeleton; catalog admin writes arrive in a later work item.");
    },
    async updateCatalogItem(_input: UpdateCatalogItemInput): Promise<CatalogItemWriteResult> {
      throw new Error("Central catalog repository is not available in the skeleton; catalog admin writes arrive in a later work item.");
    },
    async deleteCatalogItem(_input: DeleteCatalogItemInput): Promise<CatalogItemWriteResult> {
      throw new Error("Central catalog repository is not available in the skeleton; catalog admin writes arrive in a later work item.");
    },
  };

  return { catalog, modelPolicy, telemetry, admin };
}

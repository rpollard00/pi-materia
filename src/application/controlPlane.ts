import type { AuditMetadata } from "../domain/audit.js";
import type { AuthMethodKind } from "../domain/auth.js";
// Catalog origin provenance and drift resolution are pure domain invariants
// (docs/enterprise-control-plane.md §14). Re-exported here so the control-plane
// DTO surface stays the stable import path for adapters/central code.
export {
  CATALOG_DRIFT_STATUSES,
  isCatalogDriftStatus,
  isValidCatalogOriginProvenance,
  readCatalogOriginProvenance,
  resolveCatalogDrift,
  type CatalogDriftCentralSummary,
  type CatalogDriftInfo,
  type CatalogDriftStatus,
  type CatalogOriginProvenance,
  type CatalogOriginScope,
} from "../domain/catalogProvenance.js";
import type { EnrichedEvent } from "../domain/eventing.js";
import type { Permission } from "../domain/identity.js";
import type { MateriaThinkingLevel } from "../domain/thinking.js";
import type { ScopePath } from "../domain/scope.js";
// Model-policy contracts are pure domain invariants (docs/enterprise-control-plane.md
// §11). Re-exported here so the control-plane DTO surface stays the stable import
// path for adapters/central/UI code, mirroring the catalog-provenance re-export.
import type {
  ModelPolicyDocument,
} from "../domain/modelPolicy.js";

export {
  MODEL_POLICY_SEVERITIES,
  availableRuntimeModel,
  evaluateModelPolicy,
  isModelPolicyModelRef,
  isModelPolicySeverity,
  isModelPolicyThinkingConstraint,
  isValidModelPolicyDocument,
  modelPolicyAllowsThinking,
  modelPolicyAllowsValue,
  modelPolicyDeniesValue,
  policyHasConstraints,
  policySeverity,
  selectPolicyPreferredModel,
  suggestThinkingLevel,
  toAvailableRuntimeModels,
  unavailablePreferredModels,
  type AvailableRuntimeModel,
  type AvailableRuntimeModels,
  type ModelPolicyCandidate,
  type ModelPolicyDecisionStatus,
  type ModelPolicyDenialReason,
  type ModelPolicyDocument,
  type ModelPolicyEvaluation,
  type ModelPolicyModelRef,
  type ModelPolicyPreferredSuggestion,
  type ModelPolicySeverity,
  type ModelPolicyThinkingConstraint,
} from "../domain/modelPolicy.js";

/**
 * Control-plane application DTOs and ports.
 *
 * Application-layer contracts only: no HTTP, OAuth, persistence, WebUI, or
 * runtime-adapter types. Ports return DTOs, never concrete adapter or transport
 * types. Each port exposes {@link ControlPlaneModeMetadata} so clients can
 * distinguish `local-only`, `central-connected`, and `central-admin`
 * capabilities. The quest board is intentionally **not** part of this
 * abstraction; quest APIs remain local-session functionality
 * (see docs/enterprise-control-plane.md §7, §9).
 *
 * These ports decouple pi-materia from any concrete central transport:
 * - the local control-plane adapter implements them for `local-only`/
 *   `central-connected` by wrapping existing local config/model/monitoring;
 * - a central client/server implements them against the central control plane
 *   for `central-connected`/`central-admin`.
 *
 * Pure helpers here (mode derivation, capability defaults, guards) carry no IO
 * and are safe for both adapters and tests to reuse.
 */

// ───────────────────────────────────────────────────────────────────────
// Mode metadata (docs/enterprise-control-plane.md §2, §7, §8)
// ───────────────────────────────────────────────────────────────────────

export const CONTROL_PLANE_MODES = ["local-only", "central-connected", "central-admin"] as const;
export type ControlPlaneMode = (typeof CONTROL_PLANE_MODES)[number];

export function isControlPlaneMode(value: unknown): value is ControlPlaneMode {
  return typeof value === "string" && (CONTROL_PLANE_MODES as readonly string[]).includes(value);
}

/**
 * Per-surface capability flags. Let the frontend render central
 * catalog/model-policy/admin state separately from local runtime/session state.
 * `hasLocalSession` on the mode metadata covers local-session availability.
 */
export interface ControlPlaneCapabilities {
  /** Central catalog reads are available. */
  catalog: boolean;
  /** Central model-policy reads are available. */
  modelPolicy: boolean;
  /** Central telemetry/status reads are available. */
  telemetry: boolean;
  /** Central admin metadata reads are available. */
  admin: boolean;
}

/**
 * Connection topology and capability metadata, exposed by every control-plane
 * port via `mode()`. Lets clients distinguish the three operating modes and
 * discover whether a local session and/or a central control plane is attached.
 */
export interface ControlPlaneModeMetadata {
  mode: ControlPlaneMode;
  /** True when a local repository/session is attached (`local-only`/`central-connected`). */
  hasLocalSession: boolean;
  /** True when a central control plane is reachable/configured (`central-connected`/`central-admin`). */
  hasCentral: boolean;
  /** Central API base URL when a central control plane is configured. */
  centralApiBaseUrl?: string;
  /** Per-surface availability, used by UIs to render central vs. local surfaces. */
  capabilities: ControlPlaneCapabilities;
  /** Optional human-readable label, e.g. server build/version. */
  label?: string;
}

/** Resolve the operating mode from connection topology. */
export function deriveControlPlaneMode(input: { hasLocalSession: boolean; hasCentral: boolean }): ControlPlaneMode {
  if (input.hasCentral && !input.hasLocalSession) return "central-admin";
  if (input.hasCentral) return "central-connected";
  return "local-only";
}

/** Default per-surface capabilities: all central surfaces are available iff central is reachable. */
export function defaultCapabilities(hasCentral: boolean): ControlPlaneCapabilities {
  if (!hasCentral) return { catalog: false, modelPolicy: false, telemetry: false, admin: false };
  return { catalog: true, modelPolicy: true, telemetry: true, admin: true };
}

/** Mode metadata for the `local-only` runtime (default; no central dependency). */
export function localOnlyModeMetadata(label?: string): ControlPlaneModeMetadata {
  return {
    mode: "local-only",
    hasLocalSession: true,
    hasCentral: false,
    capabilities: defaultCapabilities(false),
    ...(label !== undefined ? { label } : {}),
  };
}

/** Mode metadata for a `central-connected` local runtime. */
export function centralConnectedModeMetadata(options?: { centralApiBaseUrl?: string; label?: string }): ControlPlaneModeMetadata {
  return {
    mode: "central-connected",
    hasLocalSession: true,
    hasCentral: true,
    capabilities: defaultCapabilities(true),
    ...(options?.centralApiBaseUrl !== undefined ? { centralApiBaseUrl: options.centralApiBaseUrl } : {}),
    ...(options?.label !== undefined ? { label: options.label } : {}),
  };
}

/** Mode metadata for a `central-admin` surface (no local repository session). */
export function centralAdminModeMetadata(options?: { centralApiBaseUrl?: string; label?: string }): ControlPlaneModeMetadata {
  return {
    mode: "central-admin",
    hasLocalSession: false,
    hasCentral: true,
    capabilities: defaultCapabilities(true),
    ...(options?.centralApiBaseUrl !== undefined ? { centralApiBaseUrl: options.centralApiBaseUrl } : {}),
    ...(options?.label !== undefined ? { label: options.label } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────
// Catalog DTOs (docs/enterprise-control-plane.md §3.3, §10, §14)
// ───────────────────────────────────────────────────────────────────────

export const CATALOG_ITEM_KINDS = ["loadout", "materia"] as const;
export type CatalogItemKind = (typeof CATALOG_ITEM_KINDS)[number];

export function isCatalogItemKind(value: unknown): value is CatalogItemKind {
  return typeof value === "string" && (CATALOG_ITEM_KINDS as readonly string[]).includes(value);
}

/** Provenance recorded on a central catalog item itself (§14.1). */
export interface CatalogItemProvenance {
  /** Component/source that authored the item, e.g. "central" or an upstream repository id. */
  source?: string;
  author?: string;
  /** Optional upstream repository id this item was imported from. */
  repositoryId?: string;
  /** Forward-compatible extra provenance fields. */
  [key: string]: unknown;
}

/**
 * Normalized definition payload for a catalog item. Opaque to the port contract:
 * a materia item carries a materia definition shape, a loadout item carries a
 * loadout definition shape. Concrete repositories validate the payload against
 * the domain materia/loadout shapes; the port DTO stays transport-agnostic.
 */
export interface CatalogItemContent {
  readonly definition: Readonly<Record<string, unknown>>;
}

/** Stable, hashable summary of a catalog item used for listing and drift comparison. */
export interface CatalogItemSummary {
  /** Stable central id of the catalog item. */
  id: string;
  kind: CatalogItemKind;
  name?: string;
  description?: string;
  /** Central version (monotonic string) at last update. */
  version: string;
  /** RFC3339 timestamp of the last central update. */
  updatedAt: string;
  /** Content hash of the central definition. */
  contentHash: string;
  provenance?: CatalogItemProvenance;
}

/** A full catalog item: summary plus its definition content. */
export interface CatalogItem extends CatalogItemSummary {
  content: CatalogItemContent;
}

/** Filter for catalog listing queries. */
export interface CatalogQuery {
  kind?: CatalogItemKind;
  /** Substring match against name/id, when supported by the adapter. */
  search?: string;
}

// ───────────────────────────────────────────────────────────────────────
// Model-policy contracts: see re-export block above and src/domain/modelPolicy.ts
// (docs/enterprise-control-plane.md §11). The ModelPolicyPort below is the
// application-level port; DTOs/evaluation live in the domain layer.
// ───────────────────────────────────────────────────────────────────────

/**
 * Model-policy admin write DTOs. Only admin APIs may write central model-policy
 * documents (§3.3, §11); normal local/project editing paths must not be able to
 * write them. These mirror the catalog admin write DTOs and back the central
 * {@link AdminMetadataPort} write surface.
 */

/** Input to create a central model-policy document. */
export interface CreateModelPolicyInput {
  /** Policy id; authoritative — also assigned to the stored document's `id`. */
  id: string;
  /** Constraint document. `id`/`version`/`updatedAt` are managed by the store. */
  document: ModelPolicyDocument;
  /** Mark this policy as the active one after creating it. */
  setActive?: boolean;
  /** Authoring principal id, recorded for audit. */
  principalId?: string;
}

/** Input to update a central model-policy document. */
export interface UpdateModelPolicyInput {
  id: string;
  /** Replacement constraint document, when provided. */
  document?: ModelPolicyDocument;
  /** Expected current version for optimistic concurrency; omit to ignore. */
  expectedVersion?: string;
  /** Mark this policy as the active one after updating it. */
  setActive?: boolean;
  principalId?: string;
}

/** Input to delete a central model-policy document. */
export interface DeleteModelPolicyInput {
  id: string;
  expectedVersion?: string;
  principalId?: string;
}

/** Input to designate the active model-policy document. */
export interface SetActiveModelPolicyInput {
  id: string;
  principalId?: string;
}

/** Outcome of a model-policy admin write action. */
export interface ModelPolicyWriteResult {
  action: "created" | "updated" | "deleted" | "activated";
  /** Stored policy document after the write (omitted for `deleted`). */
  policy?: ModelPolicyDocument;
  /** Id of the active policy after the write, when one is active. */
  activePolicyId?: string;
  /** Optional audit record produced for the write. */
  audit?: AuditMetadata;
}

// ───────────────────────────────────────────────────────────────────────
// Central model-catalog metadata (docs/enterprise-control-plane.md §11)
// ───────────────────────────────────────────────────────────────────────

/**
 * A model the central control plane knows about, independent of local Pi
 * runtime availability. Optional presentation metadata only — it never
 * constrains selection on its own; model-policy documents do (§11).
 */
export interface CentralModelCatalogEntry {
  /** Model value (matches the local Pi model-registry value space, e.g. "zai/glm-4.6"). */
  value: string;
  label?: string;
  vendor?: string;
  /** Thinking levels the central catalog records for this model, when known. */
  supportedThinkingLevels?: readonly MateriaThinkingLevel[];
  deprecated?: boolean;
  notes?: string;
}

/** Optional central model-catalog metadata served separately from local Pi model availability. */
export interface CentralModelCatalog {
  entries: readonly CentralModelCatalogEntry[];
  /** RFC3339 timestamp the catalog was last updated centrally. */
  updatedAt?: string;
}

// ───────────────────────────────────────────────────────────────────────
// Telemetry/status DTOs (docs/enterprise-control-plane.md §15)
// ───────────────────────────────────────────────────────────────────────

/** Origin metadata accompanying a telemetry batch ingested by the control plane. */
export interface TelemetryIngestInput {
  /** Enriched runtime events emitted by a local pi-materia runtime. */
  events: readonly EnrichedEvent[];
  /** Originating runtime identity, when known. */
  runtimeId?: string;
  /** Scope the events originated from. */
  scope?: ScopePath;
}

/** Result of ingesting a telemetry batch. */
export interface TelemetryIngestResult {
  /** Number of events accepted into the control-plane store. */
  accepted: number;
  /** RFC3339 timestamp of ingestion. */
  ingestedAt: string;
}

/** Filter for telemetry event queries (future monitoring views). */
export interface TelemetryEventFilter {
  runtimeId?: string;
  castId?: string;
  /** Inclusive lower sequence-number bound. */
  sinceSequence?: number;
  /** Maximum number of events to return. */
  limit?: number;
}

/** Monitoring/status snapshot exposed by the control plane. */
export interface ControlPlaneStatusSnapshot {
  mode: ControlPlaneMode;
  /** RFC3339 timestamp this snapshot was generated. */
  capturedAt: string;
  /** Number of distinct runtimes that have reported telemetry, when known. */
  runtimeCount?: number;
  /** Number of ingested events currently held, when known. */
  eventCount?: number;
  /** Whether the control plane is healthy/reachable from the caller's perspective. */
  healthy?: boolean;
  /** Optional server build/version label. */
  label?: string;
  /** Forward-compatible snapshot metadata. */
  metadata?: Readonly<Record<string, unknown>>;
}

// ───────────────────────────────────────────────────────────────────────
// Admin metadata DTOs (docs/enterprise-control-plane.md §3.3, §13)
// ───────────────────────────────────────────────────────────────────────

/** Server identity and configured auth surface (admin metadata). */
export interface ControlPlaneServerInfo {
  mode: ControlPlaneMode;
  /** Stable service identity, when the adapter represents a standalone server. */
  service?: string;
  label?: string;
  /** Package/build version currently serving the API. */
  buildVersion?: string;
  /** Current central persistence schema version understood by the server build. */
  schemaVersion?: number;
  /** Auth methods currently configured (e.g. `["dev-token"]`). */
  authMethods: readonly AuthMethodKind[];
  /** RFC3339 server start time, when known. */
  startedAt?: string;
  capabilities?: ControlPlaneCapabilities;
}

/** Principal summary for admin views. Carries no secrets. */
export interface AdminPrincipalSummary {
  principalId: string;
  subject?: string;
  tenantId: string;
  roleIds: readonly string[];
}

/** Role summary for admin views. */
export interface AdminRoleSummary {
  roleId: string;
  name?: string;
  permissions: readonly Permission[];
}

/** Effective, secret-free access granted to the principal reading admin metadata. */
export interface AdminAccessSummary {
  principalId: string;
  roleIds: readonly string[];
  permissions: readonly Permission[];
}

/** Admin metadata snapshot: server info, principal/role summaries, and optional caller access. */
export interface AdminMetadataSnapshot {
  server: ControlPlaneServerInfo;
  principals?: readonly AdminPrincipalSummary[];
  roles?: readonly AdminRoleSummary[];
  /** Request-principal access, when metadata came from an authenticated server route. */
  access?: AdminAccessSummary;
}

// Catalog admin write DTOs. Only admin APIs may write central catalog data
// (§3.3); normal local/project editing paths must not be able to write it.

/** Input to create a central catalog item. */
export interface CreateCatalogItemInput {
  id: string;
  kind: CatalogItemKind;
  name?: string;
  description?: string;
  content: CatalogItemContent;
  provenance?: CatalogItemProvenance;
  /** Authoring principal id, recorded for audit. */
  principalId?: string;
}

/** Input to update a central catalog item. */
export interface UpdateCatalogItemInput {
  id: string;
  kind?: CatalogItemKind;
  name?: string;
  description?: string;
  content?: CatalogItemContent;
  provenance?: CatalogItemProvenance;
  principalId?: string;
  /** Expected current version for optimistic concurrency; omit to ignore. */
  expectedVersion?: string;
}

/** Input to delete a central catalog item. */
export interface DeleteCatalogItemInput {
  id: string;
  kind?: CatalogItemKind;
  principalId?: string;
  expectedVersion?: string;
}

/** Outcome of a catalog admin write action. */
export interface CatalogItemWriteResult {
  action: "created" | "updated" | "deleted";
  summary: CatalogItemSummary;
  /** Optional audit record produced for the write. */
  audit?: AuditMetadata;
}

// ───────────────────────────────────────────────────────────────────────
// Ports (docs/enterprise-control-plane.md §7)
// ───────────────────────────────────────────────────────────────────────

/**
 * Read-only catalog access. Central catalog data is **not** writable through
 * this port; writes go through {@link AdminMetadataPort}. No quest-board APIs
 * exist on this or any control-plane port.
 */
export interface CatalogAccessPort {
  mode(): ControlPlaneModeMetadata;
  /** List catalog item summaries, optionally filtered by kind/search. */
  list(query?: CatalogQuery): Promise<CatalogItemSummary[]>;
  /** Fetch a full catalog item by id (and optional kind), or undefined when absent. */
  get(id: string, kind?: CatalogItemKind): Promise<CatalogItem | undefined>;
  /** Fetch only the current version/hash summary for drift comparison. */
  head(id: string, kind?: CatalogItemKind): Promise<CatalogItemSummary | undefined>;
}

/**
 * Read access to central model-policy documents, independent of local model
 * availability (docs/enterprise-control-plane.md §11). Also serves optional
 * central model-catalog metadata; both are read-only here. Admin writes for
 * policy documents go through {@link AdminMetadataPort}, the only central model
 * policy write path. When no policy is configured, selection behavior is
 * preserved exactly by callers (§11).
 */
export interface ModelPolicyPort {
  mode(): ControlPlaneModeMetadata;
  /** Active policy document for the calling scope/principal, or undefined when none configured. */
  getActivePolicy(): Promise<ModelPolicyDocument | undefined>;
  /** Id of the active policy document, or undefined when none is active. */
  getActivePolicyId(): Promise<string | undefined>;
  /** All known policy documents (for admin views). */
  listPolicies(): Promise<ModelPolicyDocument[]>;
  /** Fetch a single policy document by id, or undefined when absent. */
  getPolicy(id: string): Promise<ModelPolicyDocument | undefined>;
  /** Optional central model-catalog metadata, independent of local Pi model availability. */
  getModelCatalog(): Promise<CentralModelCatalog | undefined>;
}

/**
 * Telemetry/status surface. Ingest is a fan-out **sink** (it records and serves
 * events but never issues lifecycle/claim/state commands back into pi-materia,
 * per §6). Local artifact monitoring is unchanged and not replaced by this port.
 */
export interface TelemetryStatusPort {
  mode(): ControlPlaneModeMetadata;
  /** Ingest enriched runtime events emitted by a local pi-materia runtime. */
  ingest(input: TelemetryIngestInput): Promise<TelemetryIngestResult>;
  /** Read a monitoring/status snapshot. */
  status(): Promise<ControlPlaneStatusSnapshot>;
  /** Query ingested events for future monitoring views. */
  queryEvents(filter?: TelemetryEventFilter): Promise<EnrichedEvent[]>;
}

/**
 * Admin metadata and catalog/model-policy administration. Carries
 * server/principal/role metadata reads plus the central catalog and model-policy
 * admin write surfaces (the only paths that may write central catalog/policy
 * data). All actions are RBAC-guarded at the central server; local session
 * behavior is not gated by this port.
 */
export interface AdminMetadataPort {
  mode(): ControlPlaneModeMetadata;
  /** Read admin metadata snapshot (server info + principal/role summaries). */
  getMetadata(): Promise<AdminMetadataSnapshot>;
  createCatalogItem(input: CreateCatalogItemInput): Promise<CatalogItemWriteResult>;
  updateCatalogItem(input: UpdateCatalogItemInput): Promise<CatalogItemWriteResult>;
  deleteCatalogItem(input: DeleteCatalogItemInput): Promise<CatalogItemWriteResult>;
  /** Create a central model-policy document (the only model-policy write path). */
  createModelPolicy(input: CreateModelPolicyInput): Promise<ModelPolicyWriteResult>;
  /** Update a central model-policy document. */
  updateModelPolicy(input: UpdateModelPolicyInput): Promise<ModelPolicyWriteResult>;
  /** Delete a central model-policy document. */
  deleteModelPolicy(input: DeleteModelPolicyInput): Promise<ModelPolicyWriteResult>;
  /** Designate the active model-policy document. */
  setActiveModelPolicy(input: SetActiveModelPolicyInput): Promise<ModelPolicyWriteResult>;
}

/**
 * Aggregation of the four control-plane ports. Adapters may implement any
 * subset; the local adapter implements all four against local data, while a
 * central client/server implements them against the central control plane.
 */
export interface ControlPlanePorts {
  catalog: CatalogAccessPort;
  modelPolicy: ModelPolicyPort;
  telemetry: TelemetryStatusPort;
  admin: AdminMetadataPort;
}

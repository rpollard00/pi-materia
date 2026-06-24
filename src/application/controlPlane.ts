import type { AuditMetadata } from "../domain/audit.js";
import type { AuthMethodKind } from "../domain/auth.js";
import type { EnrichedEvent } from "../domain/eventing.js";
import type { Permission } from "../domain/identity.js";
import type { ScopePath } from "../domain/scope.js";
import { MATERIA_THINKING_LEVELS, isMateriaThinkingLevel, type MateriaThinkingLevel } from "../thinking.js";

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

/** Provenance recorded on a local definition that originated from a central catalog item (§14.1). */
export interface CatalogOriginProvenance {
  /** Stable central id of the origin catalog item. */
  catalogItemId: string;
  /** Central version recorded at copy/update/replace time. */
  catalogVersion: string;
  /** Central content hash recorded at copy/update/replace time. */
  catalogContentHash: string;
  /** Local scope the definition now lives in; never `central` for a writable local file. */
  source: "user" | "project" | "explicit";
}

export const CATALOG_DRIFT_STATUSES = ["current", "behind", "diverged", "orphaned"] as const;
export type CatalogDriftStatus = (typeof CATALOG_DRIFT_STATUSES)[number];

export function isCatalogDriftStatus(value: unknown): value is CatalogDriftStatus {
  return typeof value === "string" && (CATALOG_DRIFT_STATUSES as readonly string[]).includes(value);
}

/** Drift of a local definition against its central origin, resolved at load time (§14.2). */
export interface CatalogDriftInfo {
  status: CatalogDriftStatus;
  /** Current central version (resolved at load), when central was reachable. */
  centralVersion?: string;
  /** Current central content hash (resolved at load), when central was reachable. */
  centralContentHash?: string;
  /** True when central was unreachable and drift could not be computed. */
  stale?: boolean;
  reason?: string;
}

/** Filter for catalog listing queries. */
export interface CatalogQuery {
  kind?: CatalogItemKind;
  /** Substring match against name/id, when supported by the adapter. */
  search?: string;
}

// ───────────────────────────────────────────────────────────────────────
// Model-policy DTOs (docs/enterprise-control-plane.md §11)
// ───────────────────────────────────────────────────────────────────────

/** A model reference by its local Pi model-registry value (e.g. "zai/glm-4.6"). */
export interface ModelPolicyModelRef {
  value: string;
  label?: string;
}

/** Thinking-level constraint applied to model selection. */
export interface ModelPolicyThinkingConstraint {
  /** Allowed thinking levels; when present, selection is constrained to these. */
  allow?: readonly MateriaThinkingLevel[];
  /** Maximum thinking level allowed, inclusive. */
  max?: MateriaThinkingLevel;
}

/** How a policy violation is treated when it cannot be satisfied exactly. */
export type ModelPolicySeverity = "advisory" | "enforced";

export const MODEL_POLICY_SEVERITIES = ["advisory", "enforced"] as const;

export function isModelPolicySeverity(value: unknown): value is ModelPolicySeverity {
  return typeof value === "string" && (MODEL_POLICY_SEVERITIES as readonly string[]).includes(value);
}

/**
 * A model-policy document. Constraints map to §11 behavior:
 * - `deny` is hard (denied models must not be selected);
 * - `allow` constrains the selectable set;
 * - `prefer` is advisory (warn/fallback when unavailable locally);
 * - `thinking` constrains thinking-level selection where required.
 *
 * The local Pi model registry remains the available-runtime source of truth.
 * When no policy is configured, existing local selection behavior is preserved.
 */
export interface ModelPolicyDocument {
  id: string;
  name?: string;
  description?: string;
  /** Allowed model values; when present, selection is constrained to these. */
  allow?: readonly ModelPolicyModelRef[];
  /** Denied model values; hard exclusion. */
  deny?: readonly ModelPolicyModelRef[];
  /** Preferred model values; advisory unless available and allowed. */
  prefer?: readonly ModelPolicyModelRef[];
  thinking?: ModelPolicyThinkingConstraint;
  /** Default severity for unsatisfiable constraints. Per-constraint behavior follows §11. */
  severity?: ModelPolicySeverity;
  /** Central version of the policy document (provenance/drift). */
  version?: string;
  /** RFC3339 timestamp the policy was last updated centrally. */
  updatedAt?: string;
}

/** True when a model value matches a policy reference list (exact value match). */
export function modelPolicyAllowsValue(refs: readonly ModelPolicyModelRef[] | undefined, value: string | undefined): boolean {
  if (refs === undefined || refs.length === 0) return true;
  if (value === undefined) return false;
  return refs.some((ref) => ref.value === value);
}

/** True when a model value is explicitly denied by a policy reference list. */
export function modelPolicyDeniesValue(refs: readonly ModelPolicyModelRef[] | undefined, value: string | undefined): boolean {
  if (refs === undefined || value === undefined) return false;
  return refs.some((ref) => ref.value === value);
}

/** True when a thinking level satisfies a thinking constraint; undefined constraint = always allowed. */
export function modelPolicyAllowsThinking(constraint: ModelPolicyThinkingConstraint | undefined, level: MateriaThinkingLevel | undefined): boolean {
  if (constraint === undefined) return true;
  if (constraint.allow !== undefined) {
    if (level === undefined) return false;
    if (!constraint.allow.includes(level)) return false;
  }
  if (constraint.max !== undefined && level !== undefined) {
    if (thinkingRank(level) > thinkingRank(constraint.max)) return false;
  }
  return true;
}

const THINKING_RANK: Record<MateriaThinkingLevel, number> = Object.fromEntries(
  MATERIA_THINKING_LEVELS.map((level, index) => [level, index]),
) as Record<MateriaThinkingLevel, number>;

function thinkingRank(level: MateriaThinkingLevel): number {
  return THINKING_RANK[level];
}

/** Guard for thinking constraint shape (used by policy DTO construction/validation). */
export function isModelPolicyThinkingConstraint(value: unknown): value is ModelPolicyThinkingConstraint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.allow !== undefined) {
    if (!Array.isArray(record.allow) || !record.allow.every((entry) => isMateriaThinkingLevel(entry))) return false;
  }
  if (record.max !== undefined && !isMateriaThinkingLevel(record.max)) return false;
  return true;
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
  label?: string;
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

/** Admin metadata snapshot: server info plus optional principal/role summaries. */
export interface AdminMetadataSnapshot {
  server: ControlPlaneServerInfo;
  principals?: readonly AdminPrincipalSummary[];
  roles?: readonly AdminRoleSummary[];
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

/** Read access to central model-policy documents, independent of local model availability. */
export interface ModelPolicyPort {
  mode(): ControlPlaneModeMetadata;
  /** Active policy document for the calling scope/principal, or undefined when none configured. */
  getActivePolicy(): Promise<ModelPolicyDocument | undefined>;
  /** All known policy documents (for admin views). */
  listPolicies(): Promise<ModelPolicyDocument[]>;
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
 * Admin metadata and catalog administration. Carries server/principal/role
 * metadata reads plus the central catalog admin write surface (the only path
 * that may write central catalog data). All actions are RBAC-guarded at the
 * central server; local session behavior is not gated by this port.
 */
export interface AdminMetadataPort {
  mode(): ControlPlaneModeMetadata;
  /** Read admin metadata snapshot (server info + principal/role summaries). */
  getMetadata(): Promise<AdminMetadataSnapshot>;
  createCatalogItem(input: CreateCatalogItemInput): Promise<CatalogItemWriteResult>;
  updateCatalogItem(input: UpdateCatalogItemInput): Promise<CatalogItemWriteResult>;
  deleteCatalogItem(input: DeleteCatalogItemInput): Promise<CatalogItemWriteResult>;
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

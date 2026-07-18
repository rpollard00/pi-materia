import type { CatalogAccessPort, CatalogItemKind } from "./controlPlane.js";
import {
  type CatalogDefinitionKind,
  type CatalogLocalAction,
  type CatalogLocalActionDecision,
  type CatalogLocalActionRequest,
  type CatalogLocalTargetScope,
  type CatalogOriginProvenance,
  evaluateCatalogLocalAction,
  isCatalogDefinitionKind,
  isCatalogLocalAction,
  isCatalogLocalTargetScope,
  readCatalogOriginProvenance,
} from "../domain/catalogActions.js";

/**
 * Explicit central-to-local catalog actions — application use case.
 *
 * Orchestrates the copy/update/replace flows defined in
 * docs/enterprise-control-plane.md §12. Reads the central catalog item through
 * {@link CatalogAccessPort}, reads the existing local definition through
 * {@link LocalCatalogStore}, evaluates the pure domain decision, and — only when
 * the decision is `apply` — writes the promoted definition to the local target
 * scope via the store. Never writes on `needs_confirmation` or `rejected`, so
 * central updates are never applied silently.
 *
 * This module is application-layer only: no HTTP, persistence, or file-IO. The
 * {@link LocalCatalogStore} port is the single local-write boundary; the
 * infrastructure adapter implements it against the existing local config save
 * path, preserving shipped-default immutability, loadout ownership/locking, and
 * duplicate-name guardrails. Central-to-local actions belong on the local
 * runtime (which has a local config to write to); the central/admin server has
 * no local session and does not expose these actions
 * (docs/enterprise-control-plane.md §3.3, §8).
 */

/**
 * Local catalog store port: read/write local materia/loadout definitions.
 *
 * Implemented by the infrastructure local-control-plane adapter, which wraps the
 * existing local config load/save path (`loadConfig` + `saveMateriaConfigPatch`)
 * so all shipped-default immutability, loadout ownership/locking, and
 * duplicate-name guardrails are preserved for promoted central definitions.
 *
 * Definitions flow as opaque records (`Record<string, unknown>`): materia items
 * carry a materia definition shape, loadout items carry a loadout definition
 * shape. Concrete validation/normalization happens in the local save path.
 */
export interface LocalCatalogStore {
  /**
   * Read the current local definition at the key (from the merged/normalized
   * local config), or undefined when absent. Reads include ownership/source
   * metadata so origin matching works.
   */
  readLocalDefinition(
    kind: CatalogDefinitionKind,
    localKey: string,
  ): Promise<Readonly<Record<string, unknown>> | undefined>;
  /**
   * Persist a single promoted definition to the target local scope, returning
   * the written file path. Must route through the local save path so ownership,
   * locking, and immutability guardrails are enforced.
   */
  writeLocalDefinition(
    kind: CatalogDefinitionKind,
    localKey: string,
    definition: Readonly<Record<string, unknown>>,
    target: CatalogLocalTargetScope,
  ): Promise<{ path: string }>;
}

export interface CatalogActionDeps {
  /** Central catalog read access (the source of definitions being promoted). */
  catalog: CatalogAccessPort;
  /** Local definition read/write boundary (the promotion target). */
  localStore: LocalCatalogStore;
}

/** Outcome of applying a central-to-local catalog action. */
export type CatalogLocalActionResult =
  | {
      status: "applied";
      action: CatalogLocalAction;
      kind: CatalogDefinitionKind;
      localKey: string;
      target: CatalogLocalTargetScope;
      /** Written local file path. */
      path: string;
      /** True when an existing local definition was overwritten. */
      overwrite: boolean;
      /** True when the write changed existing local semantic content. */
      contentChanged: boolean;
      /** Catalog origin recorded on the promoted definition. */
      origin: CatalogOriginProvenance;
      /** Previous catalog origin on the overwritten definition, when any. */
      previousOrigin?: CatalogOriginProvenance;
    }
  | {
      status: "needs_confirmation";
      action: CatalogLocalAction;
      kind: CatalogDefinitionKind;
      localKey: string;
      target: CatalogLocalTargetScope;
      reason: string;
      /** Provenance the confirmed overwrite would record. */
      origin: CatalogOriginProvenance;
      /** Provenance currently recorded on the local definition, when any. */
      previousOrigin?: CatalogOriginProvenance;
    }
  | {
      status: "rejected";
      action: CatalogLocalAction;
      kind: CatalogDefinitionKind;
      localKey: string;
      target: CatalogLocalTargetScope;
      reason: string;
      /** Rejection reason code from the domain decision, or `not_found`. */
      code: string;
      /** Provenance currently recorded on the conflicting local definition. */
      previousOrigin?: CatalogOriginProvenance;
    };

/**
 * Apply an explicit central-to-local catalog action (copy/update/replace).
 *
 * Flow:
 * 1. Validate the request (throws `TypeError` on malformed input — the caller,
 *    e.g. an HTTP route, maps this to a 400).
 * 2. Read the central catalog item. If absent → `rejected` (`not_found`).
 * 3. Read the existing local definition and its previous origin.
 * 4. Evaluate the pure domain decision.
 * 5. Only on `apply`, write the promoted definition through the local store and
 *    return `applied` with the written path and overwrite/contentChanged flags.
 *
 * `kind` is the application {@link CatalogItemKind} and is forwarded to the
 * structurally-identical domain kind.
 */
export async function applyCatalogToLocalAction(
  request: CatalogLocalActionRequest,
  deps: CatalogActionDeps,
): Promise<CatalogLocalActionResult> {
  validateCatalogLocalActionRequest(request);
  const kind = request.kind;

  const item = await deps.catalog.get(request.catalogItemId, kind as CatalogItemKind);
  if (item === undefined) {
    return rejectedResult(request, "not_found", `Central catalog item "${kind}:${request.catalogItemId}" was not found.`);
  }

  const existing = await deps.localStore.readLocalDefinition(kind, request.localKey);
  const previousOrigin = existing !== undefined ? readCatalogOriginProvenance(existing) : undefined;

  const decision: CatalogLocalActionDecision = evaluateCatalogLocalAction({
    request,
    existingDefinition: existing,
    centralVersion: item.version,
    centralContentHash: item.contentHash,
    centralDefinition: item.content.definition,
  });

  if (decision.status === "rejected") {
    return rejectedResult(request, decision.code, decision.reason, previousOrigin);
  }
  if (decision.status === "needs_confirmation") {
    return {
      status: "needs_confirmation",
      action: request.action,
      kind,
      localKey: request.localKey,
      target: request.target,
      reason: decision.reason,
      origin: decision.origin,
      ...(previousOrigin !== undefined ? { previousOrigin } : {}),
    };
  }

  const { path } = await deps.localStore.writeLocalDefinition(kind, request.localKey, decision.definition, request.target);
  return {
    status: "applied",
    action: request.action,
    kind,
    localKey: request.localKey,
    target: request.target,
    path,
    overwrite: decision.overwrite,
    contentChanged: decision.contentChanged,
    origin: decision.origin,
    ...(previousOrigin !== undefined ? { previousOrigin } : {}),
  };
}

/** Validate a central-to-local action request. Throws `TypeError` on invalid input. */
export function validateCatalogLocalActionRequest(request: CatalogLocalActionRequest): void {
  if (!isPlainObject(request)) throw new TypeError("catalog action request must be an object");
  if (!isCatalogLocalAction(request.action)) throw new TypeError("catalog action request.action must be 'copy', 'update', or 'replace'");
  if (!isCatalogDefinitionKind(request.kind)) throw new TypeError("catalog action request.kind must be 'loadout' or 'materia'");
  if (!isNonEmptyString(request.catalogItemId)) throw new TypeError("catalog action request.catalogItemId must be a non-empty string");
  if (!isNonEmptyString(request.localKey)) throw new TypeError("catalog action request.localKey must be a non-empty string");
  if (!isCatalogLocalTargetScope(request.target)) throw new TypeError("catalog action request.target must be 'user', 'project', or 'explicit'");
  if (request.confirmOverwrite !== undefined && typeof request.confirmOverwrite !== "boolean") {
    throw new TypeError("catalog action request.confirmOverwrite must be a boolean when provided");
  }
}

function rejectedResult(
  request: CatalogLocalActionRequest,
  code: string,
  reason: string,
  previousOrigin?: CatalogOriginProvenance,
): CatalogLocalActionResult {
  return {
    status: "rejected",
    action: request.action,
    kind: request.kind,
    localKey: request.localKey,
    target: request.target,
    reason,
    code,
    ...(previousOrigin !== undefined ? { previousOrigin } : {}),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

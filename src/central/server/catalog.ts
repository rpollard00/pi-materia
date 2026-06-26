import {
  type AdminMetadataPort,
  type CatalogAccessPort,
  type CatalogItemContent,
  type CatalogItemKind,
  type CatalogItemProvenance,
  type CatalogItemWriteResult,
  type CatalogQuery,
  type CreateCatalogItemInput,
  isCatalogItemKind,
} from "../../application/controlPlane.js";
import { requirePermission, type CentralAuth } from "../auth/index.js";
import {
  CatalogConflictError,
  CatalogNotFoundError,
  CatalogVersionMismatchError,
} from "../controlPlane/centralCatalogRepository.js";
import { CENTRAL_CONTROL_PLANE_SCOPE, CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { errorMessage, isPlainObject, readJsonBody, sendJson } from "./http.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Central catalog HTTP routes.
 *
 * The HTTP surface for the in-memory central catalog repository
 * (docs/enterprise-control-plane.md §3.3, §10, §16.6). Reads go through the
 * {@link CatalogAccessPort}; admin writes go through the {@link AdminMetadataPort}
 * — the only path that may write central catalog data. Central catalog data is
 * therefore not writable through normal local/project editing paths: those edit
 * local config files and the local control-plane admin port rejects central
 * catalog writes (`src/infrastructure/localControlPlane/adminPort.ts`).
 *
 * Routes (kind is a path segment so materia and loadout definitions with the
 * same id do not collide):
 * - `GET    /api/catalog`                      → list summaries (`?kind=`/`?search=`)
 * - `POST   /api/catalog`                      → create item (body: id/kind/content/…)
 * - `GET    /api/catalog/:kind/:id`            → full item (summary + content)
 * - `GET    /api/catalog/:kind/:id/summary`    → summary only (drift head)
 * - `PATCH  /api/catalog/:kind/:id`            → update fields (`?expectedVersion=`)
 * - `DELETE /api/catalog/:kind/:id`            → delete (`?expectedVersion=`)
 *
 * Authorization follows §13: route matching precedes auth (unknown sub-paths
 * return 404, not 401), then each matched route calls {@link requirePermission}.
 * Reads require `catalog.read`; admin writes require `catalog.write` and stamp
 * the acting principal id into the audit record.
 */

export interface CentralCatalogRouteDeps {
  catalog: CatalogAccessPort;
  admin: AdminMetadataPort;
  auth: CentralAuth;
}

const CATALOG_PATH_PREFIX = "/api/catalog";
const SCOPE = CENTRAL_CONTROL_PLANE_SCOPE;
const SERVICE = CENTRAL_SERVICE_ID;

/** Sub-path segments allowed after `:kind/:id` (only `summary` today). */
const ITEM_SUB_ACTIONS = ["summary"] as const;

/**
 * Dispatch a `/api/catalog*` request. Returns 404 for unknown sub-paths and 405
 * for unsupported methods without invoking auth, so the dispatcher's "route
 * matching precedes auth" behavior is preserved.
 */
export async function handleCentralCatalogRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CentralCatalogRouteDeps,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const segments = url.pathname
    .slice(CATALOG_PATH_PREFIX.length)
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map(decodeSegment);

  // Collection: /api/catalog
  if (segments.length === 0) {
    if (req.method === "GET") {
      await handleList(req, res, url, deps);
      return;
    }
    if (req.method === "POST") {
      await handleCreate(req, res, deps);
      return;
    }
    sendMethodNotAllowed(res, "Use GET to list catalog items or POST to create one.");
    return;
  }

  // Item routes need at least kind + id.
  if (segments.length < 2) {
    sendNotFound(res);
    return;
  }
  const kind = segments[0];
  const id = segments[1];
  if (!isCatalogItemKind(kind)) {
    sendNotFound(res);
    return;
  }

  // Item: /api/catalog/:kind/:id
  if (segments.length === 2) {
    if (req.method === "GET") {
      await handleGet(req, res, deps, kind, id);
      return;
    }
    if (req.method === "PATCH") {
      await handleUpdate(req, res, url, deps, kind, id);
      return;
    }
    if (req.method === "DELETE") {
      await handleDelete(req, res, url, deps, kind, id);
      return;
    }
    sendMethodNotAllowed(res, "Use GET to read, PATCH to update, or DELETE to remove a catalog item.");
    return;
  }

  // Item summary: /api/catalog/:kind/:id/summary
  if (segments.length === 3 && segments[2] === ITEM_SUB_ACTIONS[0]) {
    if (req.method === "GET") {
      await handleHead(req, res, deps, kind, id);
      return;
    }
    sendMethodNotAllowed(res, "Use GET to read a catalog item summary.");
    return;
  }

  sendNotFound(res);
}

// ───────────────────────────────────────────────────────────────────────
// Reads (catalog.read)
// ───────────────────────────────────────────────────────────────────────

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CentralCatalogRouteDeps,
): Promise<void> {
  if (requirePermission({ auth: deps.auth, req, res, permission: "catalog.read" }) === undefined) return;
  const query = parseListQuery(url.searchParams);
  if (!query.ok) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: query.error });
    return;
  }
  const items = await deps.catalog.list(query.value);
  sendJson(res, 200, { ok: true, scope: SCOPE, service: SERVICE, items });
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CentralCatalogRouteDeps,
  kind: CatalogItemKind,
  id: string,
): Promise<void> {
  if (requirePermission({ auth: deps.auth, req, res, permission: "catalog.read" }) === undefined) return;
  const item = await deps.catalog.get(id, kind);
  if (item === undefined) {
    sendNotFound(res);
    return;
  }
  sendJson(res, 200, { ok: true, scope: SCOPE, service: SERVICE, item });
}

async function handleHead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CentralCatalogRouteDeps,
  kind: CatalogItemKind,
  id: string,
): Promise<void> {
  if (requirePermission({ auth: deps.auth, req, res, permission: "catalog.read" }) === undefined) return;
  const summary = await deps.catalog.head(id, kind);
  if (summary === undefined) {
    sendNotFound(res);
    return;
  }
  sendJson(res, 200, { ok: true, scope: SCOPE, service: SERVICE, summary });
}

// ───────────────────────────────────────────────────────────────────────
// Admin writes (catalog.write)
// ───────────────────────────────────────────────────────────────────────

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CentralCatalogRouteDeps,
): Promise<void> {
  const context = requirePermission({ auth: deps.auth, req, res, permission: "catalog.write" });
  if (context === undefined) return;
  const body = await readJsonObject(req, res);
  if (body === undefined) return;
  const parsed = parseCreateBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: parsed.error });
    return;
  }
  const input: CreateCatalogItemInput = { ...parsed.value, principalId: context.principal.id };
  try {
    const result = await deps.admin.createCatalogItem(input);
    sendWriteResult(res, 201, result);
  } catch (error) {
    sendWriteError(res, error);
  }
}

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CentralCatalogRouteDeps,
  kind: CatalogItemKind,
  id: string,
): Promise<void> {
  const context = requirePermission({ auth: deps.auth, req, res, permission: "catalog.write" });
  if (context === undefined) return;
  const body = await readJsonObject(req, res);
  if (body === undefined) return;
  const parsed = parseUpdateBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: parsed.error });
    return;
  }
  const expectedVersion = readExpectedVersion(url.searchParams);
  try {
    // kind is intentionally fixed by the path: no kind-move via PATCH. Callers
    // who need to move kinds delete + create.
    const result = await deps.admin.updateCatalogItem({
      id,
      kind,
      ...parsed.value,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      principalId: context.principal.id,
    });
    sendWriteResult(res, 200, result);
  } catch (error) {
    sendWriteError(res, error);
  }
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CentralCatalogRouteDeps,
  kind: CatalogItemKind,
  id: string,
): Promise<void> {
  const context = requirePermission({ auth: deps.auth, req, res, permission: "catalog.write" });
  if (context === undefined) return;
  const expectedVersion = readExpectedVersion(url.searchParams);
  try {
    const result = await deps.admin.deleteCatalogItem({
      id,
      kind,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      principalId: context.principal.id,
    });
    sendWriteResult(res, 200, result);
  } catch (error) {
    sendWriteError(res, error);
  }
}

// ───────────────────────────────────────────────────────────────────────
// Envelope helpers
// ───────────────────────────────────────────────────────────────────────

function sendWriteResult(res: ServerResponse, status: number, result: CatalogItemWriteResult): void {
  sendJson(res, status, { ok: true, scope: SCOPE, service: SERVICE, result });
}

function sendNotFound(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, scope: SCOPE, service: SERVICE, error: "Not found" });
}

function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  sendJson(res, 405, { ok: false, scope: SCOPE, service: SERVICE, error: "Method not allowed", allow });
}

/**
 * Map a catalog repository write error to its HTTP envelope. Known write errors
 * (conflict / not-found / version-mismatch / structural validation) become the
 * matching 4xx; anything else is rethrown so the server-level handler emits a
 * 500 envelope.
 */
function sendWriteError(res: ServerResponse, error: unknown): void {
  if (error instanceof CatalogVersionMismatchError) {
    sendJson(res, 409, {
      ok: false,
      scope: SCOPE,
      service: SERVICE,
      error: error.message,
      code: "version_mismatch",
      currentVersion: error.currentVersion,
    });
    return;
  }
  if (error instanceof CatalogConflictError) {
    sendJson(res, 409, { ok: false, scope: SCOPE, service: SERVICE, error: error.message, code: "conflict" });
    return;
  }
  if (error instanceof CatalogNotFoundError) {
    sendJson(res, 404, { ok: false, scope: SCOPE, service: SERVICE, error: error.message, code: "not_found" });
    return;
  }
  if (error instanceof TypeError) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: error.message, code: "validation" });
    return;
  }
  throw error;
}

// ───────────────────────────────────────────────────────────────────────
// Body / query parsing
// ───────────────────────────────────────────────────────────────────────

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function fail<T = never>(error: string): Parsed<T> {
  return { ok: false, error };
}

/** Read and validate a JSON object body, sending a 400 envelope on failure. */
async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: errorMessage(error) });
    return undefined;
  }
  if (!isPlainObject(body)) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: "Request body must be a JSON object." });
    return undefined;
  }
  return body;
}

function parseListQuery(searchParams: URLSearchParams): Parsed<CatalogQuery> {
  const query: CatalogQuery = {};
  const kind = searchParams.get("kind");
  if (kind !== null) {
    if (!isCatalogItemKind(kind)) {
      return fail(`catalog list 'kind' query param must be 'loadout' or 'materia', got "${kind}".`);
    }
    query.kind = kind;
  }
  const search = searchParams.get("search");
  if (search !== null && search.length > 0) query.search = search;
  return { ok: true, value: query };
}

type CreateBody = Omit<CreateCatalogItemInput, "principalId">;

function parseCreateBody(body: Record<string, unknown>): Parsed<CreateBody> {
  if (typeof body.id !== "string" || body.id.trim().length === 0) {
    return fail("catalog item id must be a non-empty string.");
  }
  if (!isCatalogItemKind(body.kind)) {
    return fail("catalog item kind must be 'loadout' or 'materia'.");
  }
  const content = parseContent(body.content);
  if (!content.ok) return content;
  const value: CreateBody = { id: body.id, kind: body.kind, content: content.value };
  const name = parseOptionalString(body.name, "name");
  if (!name.ok) return name;
  if (name.value !== undefined) value.name = name.value;
  const description = parseOptionalString(body.description, "description");
  if (!description.ok) return description;
  if (description.value !== undefined) value.description = description.value;
  if (body.provenance !== undefined) {
    if (!isPlainObject(body.provenance)) return fail("catalog item provenance must be an object when provided.");
    value.provenance = body.provenance as CatalogItemProvenance;
  }
  return { ok: true, value };
}

interface UpdateBody {
  name?: string;
  description?: string;
  content?: CatalogItemContent;
  provenance?: CatalogItemProvenance;
}

function parseUpdateBody(body: Record<string, unknown>): Parsed<UpdateBody> {
  const value: UpdateBody = {};
  const name = parseOptionalString(body.name, "name");
  if (!name.ok) return name;
  if (name.value !== undefined) value.name = name.value;
  const description = parseOptionalString(body.description, "description");
  if (!description.ok) return description;
  if (description.value !== undefined) value.description = description.value;
  if (body.content !== undefined) {
    const content = parseContent(body.content);
    if (!content.ok) return content;
    value.content = content.value;
  }
  if (body.provenance !== undefined) {
    if (!isPlainObject(body.provenance)) return fail("catalog item provenance must be an object when provided.");
    value.provenance = body.provenance as CatalogItemProvenance;
  }
  return { ok: true, value };
}

function parseContent(content: unknown): Parsed<CatalogItemContent> {
  if (!isPlainObject(content)) return fail("catalog item content must be an object.");
  const definition = content.definition;
  if (!isPlainObject(definition)) return fail("catalog item content.definition must be an object.");
  return { ok: true, value: { definition } };
}

function parseOptionalString(value: unknown, field: string): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return fail(`catalog item ${field} must be a string when provided.`);
  return { ok: true, value };
}

function readExpectedVersion(searchParams: URLSearchParams): string | undefined {
  const raw = searchParams.get("expectedVersion");
  if (raw === null || raw.length === 0) return undefined;
  return raw;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

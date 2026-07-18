import {
  type CreateModelPolicyInput,
  type DeleteModelPolicyInput,
  type ModelPolicyDocument,
  type ModelPolicyPort,
  type ModelPolicyWriteResult,
  type SetActiveModelPolicyInput,
  type UpdateModelPolicyInput,
  isValidModelPolicyDocument,
} from "../../application/controlPlane.js";
import { requirePermission, type CentralAuth } from "../auth/index.js";
import {
  CentralModelPolicyWriteError,
  ModelPolicyConflictError,
  ModelPolicyNotFoundError,
  ModelPolicyVersionMismatchError,
} from "../controlPlane/centralModelPolicyRepository.js";
import type { AdminMetadataPort } from "../../application/controlPlane.js";
import { CENTRAL_CONTROL_PLANE_SCOPE, CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { errorMessage, isPlainObject, readJsonBody, sendJson } from "./http.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Central model-policy HTTP routes.
 *
 * The HTTP surface for the configured central model-policy repository
 * (docs/enterprise-control-plane.md §11, §16.13). Policy documents are served
 * independently from local Pi model availability so the WebUI can render central
 * policy state as a separate surface. Reads go through the {@link ModelPolicyPort};
 * admin writes go through the {@link AdminMetadataPort} — the only path that may
 * write central model-policy data. Central policy data is therefore not writable
 * through normal local/project editing paths.
 *
 * Routes:
 * - `GET    /api/model-policy`                  → active policy (+ activePolicyId)
 * - `POST   /api/model-policy/active`           → designate the active policy
 * - `GET    /api/model-policy/policies`         → list policy documents
 * - `POST   /api/model-policy/policies`         → create a policy document
 * - `GET    /api/model-policy/policies/:id`     → fetch a policy document
 * - `PATCH  /api/model-policy/policies/:id`     → update a policy (`?expectedVersion=`)
 * - `DELETE /api/model-policy/policies/:id`     → delete a policy (`?expectedVersion=`)
 *
 * Authorization follows §13: route matching precedes auth (unknown sub-paths
 * return 404, not 401), then each matched route calls {@link requirePermission}.
 * Reads require `model-policy.read`; admin writes require `model-policy.write`
 * and stamp the acting principal id into the audit record.
 */

export interface CentralModelPolicyRouteDeps {
  modelPolicy: ModelPolicyPort;
  admin: AdminMetadataPort;
  auth: CentralAuth;
}

const MODEL_POLICY_PATH_PREFIX = "/api/model-policy";
const SCOPE = CENTRAL_CONTROL_PLANE_SCOPE;
const SERVICE = CENTRAL_SERVICE_ID;

/**
 * Dispatch a `/api/model-policy*` request. Returns 404 for unknown sub-paths and
 * 405 for unsupported methods without invoking auth, so the dispatcher's "route
 * matching precedes auth" behavior is preserved.
 */
export async function handleCentralModelPolicyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CentralModelPolicyRouteDeps,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const segments = url.pathname
    .slice(MODEL_POLICY_PATH_PREFIX.length)
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map(decodeSegment);

  // Root: /api/model-policy — the active policy.
  if (segments.length === 0) {
    if (req.method === "GET") {
      await handleActive(req, res, deps);
      return;
    }
    sendMethodNotAllowed(res, "Use GET to read the active model policy.");
    return;
  }

  const first = segments[0];

  // Active designation: /api/model-policy/active
  if (first === "active" && segments.length === 1) {
    if (req.method === "POST") {
      await handleSetActive(req, res, deps);
      return;
    }
    sendMethodNotAllowed(res, "Use POST to designate the active model policy.");
    return;
  }

  // Collection: /api/model-policy/policies
  if (first === "policies" && segments.length === 1) {
    if (req.method === "GET") {
      await handleList(req, res, deps);
      return;
    }
    if (req.method === "POST") {
      await handleCreate(req, res, deps);
      return;
    }
    sendMethodNotAllowed(res, "Use GET to list model policies or POST to create one.");
    return;
  }

  // Item: /api/model-policy/policies/:id
  if (first === "policies" && segments.length === 2) {
    const id = segments[1];
    if (req.method === "GET") {
      await handleGet(req, res, deps, id);
      return;
    }
    if (req.method === "PATCH") {
      await handleUpdate(req, res, url, deps, id);
      return;
    }
    if (req.method === "DELETE") {
      await handleDelete(req, res, url, deps, id);
      return;
    }
    sendMethodNotAllowed(res, "Use GET to read, PATCH to update, or DELETE to remove a model policy.");
    return;
  }

  sendNotFound(res);
}

// ───────────────────────────────────────────────────────────────────────
// Reads (model-policy.read)
// ───────────────────────────────────────────────────────────────────────

async function handleActive(req: IncomingMessage, res: ServerResponse, deps: CentralModelPolicyRouteDeps): Promise<void> {
  if (requirePermission({ auth: deps.auth, req, res, permission: "model-policy.read" }) === undefined) return;
  const policy = await deps.modelPolicy.getActivePolicy();
  const activePolicyId = await deps.modelPolicy.getActivePolicyId();
  sendJson(res, 200, {
    ok: true,
    scope: SCOPE,
    service: SERVICE,
    ...(activePolicyId !== undefined ? { activePolicyId } : {}),
    ...(policy !== undefined ? { policy } : {}),
  });
}

async function handleList(req: IncomingMessage, res: ServerResponse, deps: CentralModelPolicyRouteDeps): Promise<void> {
  if (requirePermission({ auth: deps.auth, req, res, permission: "model-policy.read" }) === undefined) return;
  const policies = await deps.modelPolicy.listPolicies();
  const activePolicyId = await deps.modelPolicy.getActivePolicyId();
  sendJson(res, 200, {
    ok: true,
    scope: SCOPE,
    service: SERVICE,
    ...(activePolicyId !== undefined ? { activePolicyId } : {}),
    policies,
  });
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CentralModelPolicyRouteDeps,
  id: string,
): Promise<void> {
  if (requirePermission({ auth: deps.auth, req, res, permission: "model-policy.read" }) === undefined) return;
  const policy = await deps.modelPolicy.getPolicy(id);
  if (policy === undefined) {
    sendNotFound(res);
    return;
  }
  sendJson(res, 200, { ok: true, scope: SCOPE, service: SERVICE, policy });
}

// ───────────────────────────────────────────────────────────────────────
// Admin writes (model-policy.write)
// ───────────────────────────────────────────────────────────────────────

async function handleCreate(req: IncomingMessage, res: ServerResponse, deps: CentralModelPolicyRouteDeps): Promise<void> {
  const context = requirePermission({ auth: deps.auth, req, res, permission: "model-policy.write" });
  if (context === undefined) return;
  const body = await readJsonObject(req, res);
  if (body === undefined) return;
  const parsed = parseCreateBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: parsed.error });
    return;
  }
  const input: CreateModelPolicyInput = { ...parsed.value, principalId: context.principal.id };
  try {
    const result = await deps.admin.createModelPolicy(input);
    sendWriteResult(res, 201, result);
  } catch (error) {
    sendWriteError(res, error);
  }
}

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CentralModelPolicyRouteDeps,
  id: string,
): Promise<void> {
  const context = requirePermission({ auth: deps.auth, req, res, permission: "model-policy.write" });
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
    const result = await deps.admin.updateModelPolicy({
      id,
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
  deps: CentralModelPolicyRouteDeps,
  id: string,
): Promise<void> {
  const context = requirePermission({ auth: deps.auth, req, res, permission: "model-policy.write" });
  if (context === undefined) return;
  const expectedVersion = readExpectedVersion(url.searchParams);
  try {
    const result = await deps.admin.deleteModelPolicy({
      id,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      principalId: context.principal.id,
    });
    sendWriteResult(res, 200, result);
  } catch (error) {
    sendWriteError(res, error);
  }
}

async function handleSetActive(req: IncomingMessage, res: ServerResponse, deps: CentralModelPolicyRouteDeps): Promise<void> {
  const context = requirePermission({ auth: deps.auth, req, res, permission: "model-policy.write" });
  if (context === undefined) return;
  const body = await readJsonObject(req, res);
  if (body === undefined) return;
  const id = parseIdBody(body);
  if (!id.ok) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: id.error });
    return;
  }
  try {
    const result = await deps.admin.setActiveModelPolicy({ id: id.value, principalId: context.principal.id });
    sendWriteResult(res, 200, result);
  } catch (error) {
    sendWriteError(res, error);
  }
}

// ───────────────────────────────────────────────────────────────────────
// Envelope helpers
// ───────────────────────────────────────────────────────────────────────

function sendWriteResult(res: ServerResponse, status: number, result: ModelPolicyWriteResult): void {
  sendJson(res, status, { ok: true, scope: SCOPE, service: SERVICE, result });
}

function sendNotFound(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, scope: SCOPE, service: SERVICE, error: "Not found" });
}

function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  sendJson(res, 405, { ok: false, scope: SCOPE, service: SERVICE, error: "Method not allowed", allow });
}

/**
 * Map a model-policy repository write error to its HTTP envelope. Known write
 * errors (conflict / not-found / version-mismatch / structural validation)
 * become the matching 4xx; anything else is rethrown so the server-level
 * handler emits a 500 envelope.
 */
function sendWriteError(res: ServerResponse, error: unknown): void {
  if (error instanceof ModelPolicyVersionMismatchError) {
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
  if (error instanceof ModelPolicyConflictError) {
    sendJson(res, 409, { ok: false, scope: SCOPE, service: SERVICE, error: error.message, code: "conflict" });
    return;
  }
  if (error instanceof ModelPolicyNotFoundError) {
    sendJson(res, 404, { ok: false, scope: SCOPE, service: SERVICE, error: error.message, code: "not_found" });
    return;
  }
  if (error instanceof TypeError) {
    sendJson(res, 400, { ok: false, scope: SCOPE, service: SERVICE, error: error.message, code: "validation" });
    return;
  }
  // Defensive: the abstract base should never escape unmapped, but guard anyway.
  if (error instanceof CentralModelPolicyWriteError) {
    sendJson(res, error.statusCode, { ok: false, scope: SCOPE, service: SERVICE, error: error.message });
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

type CreateBody = Omit<CreateModelPolicyInput, "principalId">;

function parseCreateBody(body: Record<string, unknown>): Parsed<CreateBody> {
  const id = parseIdBody(body);
  if (!id.ok) return id;
  const document = parseDocument(body.document);
  if (!document.ok) return document;
  const value: CreateBody = { id: id.value, document: document.value };
  if (body.setActive !== undefined) {
    if (typeof body.setActive !== "boolean") return fail("model policy setActive must be a boolean when provided.");
    value.setActive = body.setActive;
  }
  return { ok: true, value };
}

interface UpdateBody {
  document?: ModelPolicyDocument;
  setActive?: boolean;
}

function parseUpdateBody(body: Record<string, unknown>): Parsed<UpdateBody> {
  const value: UpdateBody = {};
  if (body.document !== undefined) {
    const document = parseDocument(body.document);
    if (!document.ok) return document;
    value.document = document.value;
  }
  if (body.setActive !== undefined) {
    if (typeof body.setActive !== "boolean") return fail("model policy setActive must be a boolean when provided.");
    value.setActive = body.setActive;
  }
  return { ok: true, value };
}

function parseDocument(document: unknown): Parsed<ModelPolicyDocument> {
  if (!isPlainObject(document)) return fail("model policy document must be an object.");
  if (!isValidModelPolicyDocument(document)) {
    return fail("model policy document failed structural validation (valid id required; ref lists and thinking constraints must be well-formed).");
  }
  return { ok: true, value: document as ModelPolicyDocument };
}

function parseIdBody(body: Record<string, unknown>): Parsed<string> {
  if (typeof body.id !== "string" || body.id.trim().length === 0) {
    return fail("model policy id must be a non-empty string.");
  }
  return { ok: true, value: body.id };
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

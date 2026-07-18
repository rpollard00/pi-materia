import {
  isCatalogItemKind,
  isControlPlaneMode,
  isValidModelPolicyDocument,
  type AdminMetadataSnapshot,
  type CatalogItem,
  type CatalogItemSummary,
  type CatalogItemWriteResult,
  type CentralModelCatalog,
  type ControlPlaneStatusSnapshot,
  type ModelPolicyDocument,
  type ModelPolicyWriteResult,
  type TelemetryIngestResult,
} from "../../application/controlPlane.js";
import { validateAuditMetadata } from "../../domain/audit.js";
import { isAuthMethodKind } from "../../domain/auth.js";
import { isEventSeverity, type EnrichedEvent } from "../../domain/eventing.js";
import { isMateriaThinkingLevel } from "../../domain/thinking.js";

interface ActivePolicyResponse {
  readonly activePolicyId?: string;
  readonly policy?: ModelPolicyDocument;
}

/** Successful catalog collection envelope. */
export function readCatalogListResponse(value: unknown): CatalogItemSummary[] {
  const envelope = successEnvelope(value);
  if (!Array.isArray(envelope.items)) fail("items must be an array");
  return envelope.items.map((item, index) => catalogSummary(item, `items[${index}]`));
}

/** Successful full catalog-item envelope. */
export function readCatalogItemResponse(value: unknown): CatalogItem {
  const envelope = successEnvelope(value);
  const summary = catalogSummary(envelope.item, "item");
  const item = object(envelope.item, "item");
  const content = object(item.content, "item.content");
  object(content.definition, "item.content.definition");
  return { ...summary, content: content as unknown as CatalogItem["content"] };
}

/** Successful catalog head envelope. */
export function readCatalogHeadResponse(value: unknown): CatalogItemSummary {
  const envelope = successEnvelope(value);
  return catalogSummary(envelope.summary, "summary");
}

/** Successful active-policy envelope (both fields are intentionally optional). */
export function readActivePolicyResponse(value: unknown): ActivePolicyResponse {
  const envelope = successEnvelope(value);
  const result: { activePolicyId?: string; policy?: ModelPolicyDocument } = {};
  if (envelope.activePolicyId !== undefined) result.activePolicyId = nonEmptyString(envelope.activePolicyId, "activePolicyId");
  if (envelope.policy !== undefined) result.policy = policyDocument(envelope.policy, "policy");
  return result;
}

/** Successful model-policy collection envelope. */
export function readPolicyListResponse(value: unknown): ModelPolicyDocument[] {
  const envelope = successEnvelope(value);
  if (!Array.isArray(envelope.policies)) fail("policies must be an array");
  return envelope.policies.map((policy, index) => policyDocument(policy, `policies[${index}]`));
}

/** Successful single model-policy envelope. */
export function readPolicyResponse(value: unknown): ModelPolicyDocument {
  const envelope = successEnvelope(value);
  return policyDocument(envelope.policy, "policy");
}

/** Successful optional model-catalog envelope. */
export function readModelCatalogResponse(value: unknown): CentralModelCatalog | undefined {
  const envelope = successEnvelope(value);
  if (envelope.catalog === undefined) return undefined;
  const catalog = object(envelope.catalog, "catalog");
  if (!Array.isArray(catalog.entries)) fail("catalog.entries must be an array");
  catalog.entries.forEach((entry, index) => validateModelCatalogEntry(entry, `catalog.entries[${index}]`));
  if (catalog.updatedAt !== undefined) nonEmptyString(catalog.updatedAt, "catalog.updatedAt");
  return catalog as unknown as CentralModelCatalog;
}

/** Successful telemetry-ingestion envelope. */
export function readTelemetryIngestResponse(value: unknown): TelemetryIngestResult {
  const envelope = successEnvelope(value);
  const result = object(envelope.result, "result");
  nonNegativeInteger(result.accepted, "result.accepted");
  nonEmptyString(result.ingestedAt, "result.ingestedAt");
  return result as unknown as TelemetryIngestResult;
}

/** Successful central status envelope. */
export function readStatusResponse(value: unknown): ControlPlaneStatusSnapshot {
  const envelope = successEnvelope(value);
  const status = object(envelope.status, "status");
  if (!isControlPlaneMode(status.mode)) fail("status.mode must be a known control-plane mode");
  nonEmptyString(status.capturedAt, "status.capturedAt");
  if (status.runtimeCount !== undefined) nonNegativeInteger(status.runtimeCount, "status.runtimeCount");
  if (status.eventCount !== undefined) nonNegativeInteger(status.eventCount, "status.eventCount");
  if (status.healthy !== undefined && typeof status.healthy !== "boolean") fail("status.healthy must be a boolean when provided");
  if (status.label !== undefined) string(status.label, "status.label");
  if (status.metadata !== undefined) object(status.metadata, "status.metadata");
  return status as unknown as ControlPlaneStatusSnapshot;
}

/** Successful telemetry event-query envelope. */
export function readTelemetryEventsResponse(value: unknown): EnrichedEvent[] {
  const envelope = successEnvelope(value);
  if (!Array.isArray(envelope.events)) fail("events must be an array");
  return envelope.events.map((event, index) => enrichedEvent(event, `events[${index}]`));
}

/** Successful admin metadata envelope. */
export function readAdminMetadataResponse(value: unknown): AdminMetadataSnapshot {
  const envelope = successEnvelope(value);
  const metadata = object(envelope.metadata, "metadata");
  const server = object(metadata.server, "metadata.server");
  if (!isControlPlaneMode(server.mode)) fail("metadata.server.mode must be a known control-plane mode");
  if (!Array.isArray(server.authMethods) || !server.authMethods.every(isAuthMethodKind)) {
    fail("metadata.server.authMethods must contain known auth method kinds");
  }
  if (server.label !== undefined) string(server.label, "metadata.server.label");
  if (server.startedAt !== undefined) nonEmptyString(server.startedAt, "metadata.server.startedAt");
  if (server.capabilities !== undefined) validateCapabilities(server.capabilities, "metadata.server.capabilities");

  if (metadata.principals !== undefined) {
    if (!Array.isArray(metadata.principals)) fail("metadata.principals must be an array when provided");
    metadata.principals.forEach((principal, index) => validatePrincipalSummary(principal, `metadata.principals[${index}]`));
  }
  if (metadata.roles !== undefined) {
    if (!Array.isArray(metadata.roles)) fail("metadata.roles must be an array when provided");
    metadata.roles.forEach((role, index) => validateRoleSummary(role, `metadata.roles[${index}]`));
  }
  return metadata as unknown as AdminMetadataSnapshot;
}

/** Successful catalog-write envelope. */
export function readCatalogWriteResponse(
  value: unknown,
  expectedAction: CatalogItemWriteResult["action"],
): CatalogItemWriteResult {
  const envelope = successEnvelope(value);
  const result = object(envelope.result, "result");
  if (result.action !== expectedAction) fail(`result.action must be ${expectedAction}`);
  catalogSummary(result.summary, "result.summary");
  validateOptionalAudit(result.audit, "result.audit");
  return result as unknown as CatalogItemWriteResult;
}

/** Successful model-policy write envelope. */
export function readModelPolicyWriteResponse(
  value: unknown,
  expectedAction: ModelPolicyWriteResult["action"],
): ModelPolicyWriteResult {
  const envelope = successEnvelope(value);
  const result = object(envelope.result, "result");
  if (result.action !== expectedAction) fail(`result.action must be ${expectedAction}`);
  if (result.policy !== undefined) policyDocument(result.policy, "result.policy");
  if (expectedAction !== "deleted" && expectedAction !== "activated" && result.policy === undefined) {
    fail(`result.policy is required for ${expectedAction}`);
  }
  if (result.activePolicyId !== undefined) nonEmptyString(result.activePolicyId, "result.activePolicyId");
  validateOptionalAudit(result.audit, "result.audit");
  return result as unknown as ModelPolicyWriteResult;
}

function successEnvelope(value: unknown): Record<string, unknown> {
  const envelope = object(value, "response");
  if (envelope.ok !== true) fail("response.ok must be true");
  return envelope;
}

function catalogSummary(value: unknown, path: string): CatalogItemSummary {
  const summary = object(value, path);
  nonEmptyString(summary.id, `${path}.id`);
  if (!isCatalogItemKind(summary.kind)) fail(`${path}.kind must be loadout or materia`);
  if (summary.name !== undefined) string(summary.name, `${path}.name`);
  if (summary.description !== undefined) string(summary.description, `${path}.description`);
  nonEmptyString(summary.version, `${path}.version`);
  nonEmptyString(summary.updatedAt, `${path}.updatedAt`);
  nonEmptyString(summary.contentHash, `${path}.contentHash`);
  if (summary.provenance !== undefined) {
    const provenance = object(summary.provenance, `${path}.provenance`);
    for (const field of ["source", "author", "repositoryId"] as const) {
      if (provenance[field] !== undefined) string(provenance[field], `${path}.provenance.${field}`);
    }
  }
  return summary as unknown as CatalogItemSummary;
}

function policyDocument(value: unknown, path: string): ModelPolicyDocument {
  if (!isValidModelPolicyDocument(value)) fail(`${path} must be a structurally valid model-policy document`);
  return value;
}

function validateModelCatalogEntry(value: unknown, path: string): void {
  const entry = object(value, path);
  nonEmptyString(entry.value, `${path}.value`);
  for (const field of ["label", "vendor", "notes"] as const) {
    if (entry[field] !== undefined) string(entry[field], `${path}.${field}`);
  }
  if (entry.deprecated !== undefined && typeof entry.deprecated !== "boolean") fail(`${path}.deprecated must be a boolean`);
  if (entry.supportedThinkingLevels !== undefined) {
    if (!Array.isArray(entry.supportedThinkingLevels) || !entry.supportedThinkingLevels.every(isMateriaThinkingLevel)) {
      fail(`${path}.supportedThinkingLevels must contain known thinking levels`);
    }
  }
}

function enrichedEvent(value: unknown, path: string): EnrichedEvent {
  const event = object(value, path);
  nonEmptyString(event.type, `${path}.type`);
  nonEmptyString(event.eventId, `${path}.eventId`);
  nonEmptyString(event.occurredAt, `${path}.occurredAt`);
  finiteNumber(event.sequence, `${path}.sequence`);
  nonEmptyString(event.castId, `${path}.castId`);
  nonEmptyString(event.socketId, `${path}.socketId`);
  nonEmptyString(event.materia, `${path}.materia`);
  finiteNumber(event.visit, `${path}.visit`);
  if (event.severity !== undefined && (typeof event.severity !== "string" || !isEventSeverity(event.severity))) {
    fail(`${path}.severity must be a known event severity`);
  }
  for (const field of ["message", "materiaLabel", "itemKey", "itemLabel"] as const) {
    if (event[field] !== undefined) string(event[field], `${path}.${field}`);
  }
  if (event.payload !== undefined) object(event.payload, `${path}.payload`);
  if (event.source !== undefined) {
    const source = object(event.source, `${path}.source`);
    if (source.materia !== undefined) string(source.materia, `${path}.source.materia`);
    if (source.socketId !== undefined) string(source.socketId, `${path}.source.socketId`);
  }
  return event as unknown as EnrichedEvent;
}

function validateCapabilities(value: unknown, path: string): void {
  const capabilities = object(value, path);
  for (const field of ["catalog", "modelPolicy", "telemetry", "admin"] as const) {
    if (typeof capabilities[field] !== "boolean") fail(`${path}.${field} must be a boolean`);
  }
}

function validatePrincipalSummary(value: unknown, path: string): void {
  const principal = object(value, path);
  nonEmptyString(principal.principalId, `${path}.principalId`);
  nonEmptyString(principal.tenantId, `${path}.tenantId`);
  if (principal.subject !== undefined) string(principal.subject, `${path}.subject`);
  stringArray(principal.roleIds, `${path}.roleIds`);
}

function validateRoleSummary(value: unknown, path: string): void {
  const role = object(value, path);
  nonEmptyString(role.roleId, `${path}.roleId`);
  if (role.name !== undefined) string(role.name, `${path}.name`);
  stringArray(role.permissions, `${path}.permissions`);
}

function validateOptionalAudit(value: unknown, path: string): void {
  if (value === undefined) return;
  const result = validateAuditMetadata(value, path);
  if (!result.ok) fail(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${path} must be an object`);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${path} must be a non-empty string`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} must be a string`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    fail(`${path} must contain non-empty strings`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} must be a finite number`);
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(`${path} must be a non-negative integer`);
  return value;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  HANDOFF_LEGACY_NON_CANONICAL_ALIASES,
} from "./handoffContract.js";
import { deriveSocketOutputRequirements, socketConsumesSatisfied, type SocketOutputFieldType, type SocketOutputRequirements } from "./socketOutputRequirements.js";
import type { MateriaPipelineSocketConfig } from "../types.js";

export interface HandoffValidationOptions {
  socketId?: string;
  socket?: MateriaPipelineSocketConfig;
  requirements?: SocketOutputRequirements;
  /** True when normalized graph semantics identify this socket as a workItems-producing generator/planner. */
  workItemsProducer?: boolean;
}

export interface HandoffValidationIssue {
  path: string;
  message: string;
  expected?: SocketOutputFieldType | "json_object" | "present";
  reason?: string;
}

export class HandoffJsonValidationError extends Error {
  readonly socketId: string;
  readonly issues: HandoffValidationIssue[];

  constructor(socketId: string, issues: HandoffValidationIssue[]) {
    super(formatHandoffValidationErrorMessage(socketId, issues));
    this.name = "HandoffJsonValidationError";
    this.socketId = socketId;
    this.issues = issues;
  }
}

export function validateHandoffJsonOutput(value: unknown, options: HandoffValidationOptions): Record<string, unknown> {
  const socketId = options.socketId ?? "unknown";
  const socketLabel = `socket "${socketId}"`;
  const requirements = options.requirements ?? (options.socket
    ? deriveSocketOutputRequirements({ socket: options.socket, socketId, workItemsProducer: options.workItemsProducer })
    : undefined);
  const issues: HandoffValidationIssue[] = [];

  if (!isPlainJsonObject(value)) {
    throw new HandoffJsonValidationError(socketId, [{
      path: "$",
      expected: "json_object",
      message: `Invalid handoff JSON output for ${socketLabel}: expected a JSON object at the top level.`,
      reason: requirements?.jsonObjectReason ?? "Socket parse mode is json.",
    }]);
  }

  if (!requirements) return value;

  const consumedPayloadPathSet = new Set(requirements.consumedPayloadPaths.map((path) => path.payloadPath));
  for (const rule of requirements.reservedFieldTypeRules) {
    const required = rule.required || consumedPayloadPathSet.has(rule.path);
    const present = Object.prototype.hasOwnProperty.call(value, rule.field);
    if (!present && !required) continue;
    if (!present) {
      issues.push({
        path: rule.path,
        expected: rule.type,
        message: `Missing required reserved field "${rule.field}" at ${rule.path}; expected ${articleForType(rule.type)} ${rule.type}.`,
        reason: rule.reason,
      });
      continue;
    }
    if (!matchesType(value[rule.field], rule.type)) {
      issues.push({
        path: rule.path,
        expected: rule.type,
        message: `Reserved field "${rule.field}" at ${rule.path} must be ${articleForType(rule.type)} ${rule.type}.`,
        reason: rule.reason,
      });
    }
  }

  const checkedRequiredPaths = new Set(requirements.reservedFieldTypeRules.map((rule) => rule.path));
  for (const requirement of requirements.requiredFields) {
    if (checkedRequiredPaths.has(requirement.path)) continue;
    const current = getJsonPath(value, requirement.path);
    if (!current.exists) {
      issues.push({
        path: requirement.path,
        expected: requirement.type,
        message: `Missing required field "${requirement.field}" at ${requirement.path}; expected ${articleForType(requirement.type)} ${requirement.type}.`,
        reason: requirement.reason,
      });
      continue;
    }
    if (!matchesType(current.value, requirement.type)) {
      issues.push({
        path: requirement.path,
        expected: requirement.type,
        message: `Field "${requirement.field}" at ${requirement.path} must be ${articleForType(requirement.type)} ${requirement.type}.`,
        reason: requirement.reason,
      });
    }
  }

  const requiredPaths = new Set(requirements.requiredFields.map((requirement) => requirement.path));
  for (const consumed of requirements.consumedPayloadPaths) {
    if (consumed.payloadPath === "$" || requiredPaths.has(consumed.payloadPath) || checkedRequiredPaths.has(consumed.payloadPath)) continue;
    const current = getJsonPath(value, consumed.payloadPath);
    if (!current.exists) {
      issues.push({
        path: consumed.payloadPath,
        expected: "present",
        message: `Missing payload path ${consumed.payloadPath} consumed by assignment to ${consumed.targetPath}.`,
        reason: consumed.reason,
      });
    }
  }

  if (issues.length > 0) {
    addLegacySatisfiedHint(value, issues);
    throw new HandoffJsonValidationError(socketId, issues);
  }

  return value;
}

export function requiresSatisfiedControl(socket: MateriaPipelineSocketConfig): boolean {
  return socketConsumesSatisfied(socket);
}

export function handoffValidationIssues(error: unknown): HandoffValidationIssue[] | undefined {
  return error instanceof HandoffJsonValidationError ? error.issues : undefined;
}

function formatHandoffValidationErrorMessage(socketId: string, issues: HandoffValidationIssue[]): string {
  const detail = issues.map((issue) => issue.message).join(" ");
  return `Invalid handoff JSON output for socket "${socketId}": ${detail}`;
}

function addLegacySatisfiedHint(value: Record<string, unknown>, issues: HandoffValidationIssue[]): void {
  if (!issues.some((issue) => issue.path === "$.satisfied" && issue.expected === "boolean")) return;
  const legacyFields = HANDOFF_LEGACY_NON_CANONICAL_ALIASES.filter((field) => Object.prototype.hasOwnProperty.call(value, field));
  if (legacyFields.length === 0) return;
  issues.push({
    path: legacyFields.map((field) => `$.${field}`).join(", "),
    expected: "boolean",
    message: `Legacy field ${legacyFields.map((field) => JSON.stringify(field)).join(", ")} is not canonical and is not used for routing.`,
    reason: "Use the canonical satisfied field for satisfied/not_satisfied control flow.",
  });
}

function matchesType(value: unknown, type: SocketOutputFieldType): boolean {
  switch (type) {
    case "array": return Array.isArray(value);
    case "boolean": return typeof value === "boolean";
    case "object": return isPlainJsonObject(value);
    case "string": return typeof value === "string";
    case "unknown": return value !== undefined;
  }
}

function getJsonPath(root: Record<string, unknown>, path: string): { exists: boolean; value?: unknown } {
  if (path === "$") return { exists: true, value: root };
  if (!path.startsWith("$.")) return { exists: false };
  let current: unknown = root;
  for (const part of path.slice(2).split(".")) {
    if (current === undefined || current === null) return { exists: false };
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      const index = Number(part);
      if (index >= current.length) return { exists: false };
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) return { exists: false };
    current = (current as Record<string, unknown>)[part];
  }
  return { exists: true, value: current };
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function articleForType(type: string): string {
  return /^[aeiou]/i.test(type) ? "an" : "a";
}

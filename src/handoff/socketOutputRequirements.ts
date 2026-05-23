import {
  HANDOFF_FEEDBACK_FIELD,
  HANDOFF_MISSING_FIELD,
  HANDOFF_NOT_SATISFIED_EDGE_CONDITION,
  HANDOFF_SATISFIED_EDGE_CONDITION,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
} from "../domain/handoff.js";
import type { MateriaEdgeCondition, MateriaParseMode, MateriaPipelineSocketConfig } from "../types.js";

export type SocketOutputFieldType = "array" | "boolean" | "object" | "string" | "unknown";

export interface SocketOutputFieldRequirement {
  /** Top-level payload field name. */
  field: string;
  /** JSONPath-like current-payload path consumed by the runtime. */
  path: string;
  type: SocketOutputFieldType;
  reason: string;
}

export interface SocketOutputConsumedPath {
  /** Assignment target path in runtime state. */
  targetPath: string;
  /** JSONPath-like source path in the current payload. */
  payloadPath: string;
  /** Top-level payload field read by this source path, when it is statically known. */
  topLevelField?: string;
  reason: string;
}

export interface SocketOutputTypeRule {
  field: string;
  path: string;
  type: SocketOutputFieldType;
  required: boolean;
  reason: string;
}

export interface SocketOutputRequirementsInput {
  socket: Pick<MateriaPipelineSocketConfig, "parse" | "assign" | "edges" | "advance">;
  socketId?: string;
  /** WorkItems-producing socket ids from normalized loadout graph analysis. */
  workItemProducingSocketIds?: ReadonlySet<string> | readonly string[];
  /** True when normalized graph semantics identify this socket as a workItems-producing generator/planner. */
  workItemsProducer?: boolean;
}

export interface SocketOutputRequirements {
  parse: MateriaParseMode;
  requiresJsonObject: boolean;
  jsonObjectReason?: string;
  requiredFields: SocketOutputFieldRequirement[];
  consumedPayloadPaths: SocketOutputConsumedPath[];
  reservedFieldTypeRules: SocketOutputTypeRule[];
}

const SATISFACTION_CONDITIONS = new Set<MateriaEdgeCondition>([
  HANDOFF_SATISFIED_EDGE_CONDITION,
  HANDOFF_NOT_SATISFIED_EDGE_CONDITION,
]);

const RESERVED_JSON_FIELD_TYPES: readonly Omit<SocketOutputTypeRule, "required" | "reason">[] = [
  { field: HANDOFF_SATISFIED_FIELD, path: `$.${HANDOFF_SATISFIED_FIELD}`, type: "boolean" },
  { field: HANDOFF_FEEDBACK_FIELD, path: `$.${HANDOFF_FEEDBACK_FIELD}`, type: "string" },
  { field: HANDOFF_MISSING_FIELD, path: `$.${HANDOFF_MISSING_FIELD}`, type: "array" },
];

export function deriveSocketOutputRequirements(input: SocketOutputRequirementsInput): SocketOutputRequirements {
  const parse = input.socket.parse ?? "text";
  if (parse !== "json") {
    return {
      parse,
      requiresJsonObject: false,
      requiredFields: [],
      consumedPayloadPaths: [],
      reservedFieldTypeRules: [],
    };
  }

  const consumedPayloadPaths = deriveConsumedPayloadPaths(input.socket.assign);
  const requiredFields = new Map<string, SocketOutputFieldRequirement>();

  if (socketConsumesSatisfied(input.socket)) {
    addRequiredField(requiredFields, {
      field: HANDOFF_SATISFIED_FIELD,
      path: `$.${HANDOFF_SATISFIED_FIELD}`,
      type: "boolean",
      reason: "Current socket control flow uses satisfied/not_satisfied routing or advancement.",
    });
  }

  if (isWorkItemsProducer(input)) {
    addRequiredField(requiredFields, {
      field: HANDOFF_WORK_ITEMS_FIELD,
      path: `$.${HANDOFF_WORK_ITEMS_FIELD}`,
      type: "array",
      reason: "Normalized graph semantics identify this socket as a workItems-producing generator/planner output.",
    });
  }

  if (assignMapsWorkItemsFromPayload(input.socket.assign)) {
    addRequiredField(requiredFields, {
      field: HANDOFF_WORK_ITEMS_FIELD,
      path: `$.${HANDOFF_WORK_ITEMS_FIELD}`,
      type: "array",
      reason: "Socket assignment maps runtime workItems from $.workItems.",
    });
  }

  const requiredFieldNames = new Set(Array.from(requiredFields.values()).map((field) => field.field));
  return {
    parse,
    requiresJsonObject: true,
    jsonObjectReason: "Socket parse mode is json, so the model output must be one top-level JSON object.",
    requiredFields: Array.from(requiredFields.values()),
    consumedPayloadPaths,
    reservedFieldTypeRules: RESERVED_JSON_FIELD_TYPES.map((rule) => ({
      ...rule,
      required: requiredFieldNames.has(rule.field),
      reason: requiredFieldNames.has(rule.field)
        ? "This reserved field is required by the current socket requirements and must have its canonical type."
        : "When present, this reserved canonical handoff field must have its canonical type.",
    })),
  };
}

export function socketConsumesSatisfied(socket: Pick<MateriaPipelineSocketConfig, "edges" | "advance">): boolean {
  return (socket.edges ?? []).some((edge) => SATISFACTION_CONDITIONS.has(edge.when)) || SATISFACTION_CONDITIONS.has(socket.advance?.when as MateriaEdgeCondition);
}

export function deriveConsumedPayloadPaths(assign: Record<string, string> | undefined): SocketOutputConsumedPath[] {
  return Object.entries(assign ?? {})
    .flatMap(([targetPath, sourcePath]) => {
      const payloadPath = normalizePayloadPath(sourcePath);
      if (!payloadPath) return [];
      return [{
        targetPath,
        payloadPath,
        topLevelField: topLevelFieldFromPayloadPath(payloadPath),
        reason: `Socket assignment maps ${targetPath} from ${payloadPath}.`,
      }];
    })
    .sort((a, b) => a.targetPath.localeCompare(b.targetPath) || a.payloadPath.localeCompare(b.payloadPath));
}

export function normalizePayloadPath(sourcePath: string): string | undefined {
  const trimmed = sourcePath.trim();
  if (trimmed === "$") return "$";
  if (trimmed.startsWith("$.")) return trimmed;
  return undefined;
}

export function topLevelFieldFromPayloadPath(payloadPath: string): string | undefined {
  if (payloadPath === "$") return undefined;
  return payloadPath.startsWith("$.") ? payloadPath.slice(2).split(".")[0] : undefined;
}

function isWorkItemsProducer(input: SocketOutputRequirementsInput): boolean {
  if (input.workItemsProducer === true) return true;
  if (!input.socketId || !input.workItemProducingSocketIds) return false;
  const ids = input.workItemProducingSocketIds;
  return typeof (ids as ReadonlySet<string>).has === "function" ? (ids as ReadonlySet<string>).has(input.socketId) : (ids as readonly string[]).includes(input.socketId);
}

function assignMapsWorkItemsFromPayload(assign: Record<string, string> | undefined): boolean {
  return Object.entries(assign ?? {}).some(([targetPath, sourcePath]) => targetPath === HANDOFF_WORK_ITEMS_FIELD && normalizePayloadPath(sourcePath) === `$.${HANDOFF_WORK_ITEMS_FIELD}`);
}

function addRequiredField(requirements: Map<string, SocketOutputFieldRequirement>, requirement: SocketOutputFieldRequirement): void {
  const existing = requirements.get(requirement.field);
  if (!existing) {
    requirements.set(requirement.field, requirement);
    return;
  }
  requirements.set(requirement.field, { ...existing, reason: `${existing.reason} ${requirement.reason}` });
}

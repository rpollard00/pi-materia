import { EVENT_SIDECHANNEL_FIELD, type MateriaEventObject } from "../domain/eventing.js";
import type { HandoffWorkItem } from "../domain/handoff.js";
import {
  AgentHandoffBuilderError,
  cloneAgentHandoffBuilderScope,
  type AgentHandoffBuilderScope,
  type AgentHandoffCommit,
  type AgentHandoffEnvelope,
  type AgentHandoffOutput,
} from "./agentHandoffBuilderTypes.js";

const CANONICAL_EVENT_FIELDS = ["type", "severity", "message", "payload", "source"] as const;

export function buildAgentHandoffOutput(
  envelope: AgentHandoffEnvelope,
  events: readonly MateriaEventObject[] | undefined,
): AgentHandoffOutput {
  const output: AgentHandoffOutput = cloneAgentHandoffEnvelope(envelope);
  if (events !== undefined) output[EVENT_SIDECHANNEL_FIELD] = events.map(cloneEvent);
  return output;
}

export function cloneHandoffWorkItem(value: HandoffWorkItem): HandoffWorkItem {
  return { title: value.title, context: value.context };
}

export function cloneAgentHandoffEnvelope(value: AgentHandoffEnvelope): AgentHandoffEnvelope {
  const clone: AgentHandoffEnvelope = {};
  if (value.workItems !== undefined) clone.workItems = value.workItems.map(cloneHandoffWorkItem);
  if (value.satisfied !== undefined) clone.satisfied = value.satisfied;
  if (value.context !== undefined) clone.context = value.context;
  return clone;
}

export function cloneAgentHandoffCommit(value: AgentHandoffCommit): AgentHandoffCommit {
  return {
    scope: cloneAgentHandoffBuilderScope(value.scope),
    envelope: cloneAgentHandoffEnvelope(value.envelope),
    output: buildAgentHandoffOutput(value.output, value.output[EVENT_SIDECHANNEL_FIELD]),
    json: value.json,
  };
}

/** Rebuild known event fields in contract order and recursively sort payload keys. */
export function canonicalizeAgentHandoffEvent(
  value: MateriaEventObject,
  path: string,
  scope: AgentHandoffBuilderScope,
): MateriaEventObject {
  const source = value as MateriaEventObject & Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const ancestors = new Set<object>();
  for (const field of CANONICAL_EVENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      result[field] = canonicalizeJsonValue(source[field], `${path}.${field}`, scope, ancestors);
    }
  }
  const canonicalFields = new Set<string>(CANONICAL_EVENT_FIELDS);
  for (const field of Object.keys(source).filter((field) => !canonicalFields.has(field)).sort()) {
    result[field] = canonicalizeJsonValue(source[field], `${path}.${field}`, scope, ancestors);
  }
  return result as unknown as MateriaEventObject;
}

function cloneEvent(value: MateriaEventObject): MateriaEventObject {
  return canonicalizeAgentHandoffEvent(value, `$.${EVENT_SIDECHANNEL_FIELD}[]`, {
    castId: "clone",
    socketId: "clone",
    socketVisit: 1,
    finalizationAttempt: 1,
  });
}

function canonicalizeJsonValue(
  value: unknown,
  path: string,
  scope: AgentHandoffBuilderScope,
  ancestors: Set<object>,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw invalidJsonEventValue(scope, path);
  if (ancestors.has(value)) {
    throw invalidJsonEventValue(scope, path, "event data must not contain circular references");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalizeJsonValue(item, `${path}[${index}]`, scope, ancestors));
    }
    if (!isPlainObject(value)) throw invalidJsonEventValue(scope, path);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalizeJsonValue(value[key], `${path}.${key}`, scope, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function invalidJsonEventValue(
  scope: AgentHandoffBuilderScope,
  path: string,
  message = "event data must contain only JSON-compatible values",
): AgentHandoffBuilderError {
  return new AgentHandoffBuilderError("invalid_value", scope, [{ path, message }]);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

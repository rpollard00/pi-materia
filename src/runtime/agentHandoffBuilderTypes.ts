import type { MateriaEventObject } from "../domain/eventing.js";
import type { HandoffEnvelope } from "../domain/handoff.js";
import type { HandoffValidationIssue } from "../handoff/handoffValidation.js";
import type { SocketOutputRequirements } from "../handoff/socketOutputRequirements.js";

export interface AgentHandoffBuilderScope {
  /** Cast/run identity within the Pi session. */
  readonly castId: string;
  /** Active socket placement. */
  readonly socketId: string;
  /** Distinguishes repeated visits to the same socket in one cast. */
  readonly socketVisit: number;
  /** Distinguishes clean finalization retries within one socket visit. */
  readonly finalizationAttempt: number;
}

export interface AgentHandoffBuilderOptions {
  readonly scope: AgentHandoffBuilderScope;
  readonly requirements: SocketOutputRequirements;
  /** True when normalized graph semantics identify this socket as a generator. */
  readonly workItemsProducer?: boolean;
  /** JSON agent sockets permit the event side-channel by default. */
  readonly allowEventSideChannel?: boolean;
}

export type AgentHandoffEnvelope = Partial<
  Pick<HandoffEnvelope, "workItems" | "satisfied" | "context">
>;

export type AgentHandoffOutput = AgentHandoffEnvelope & {
  event?: MateriaEventObject[];
};

export interface AgentHandoffCommit {
  readonly scope: AgentHandoffBuilderScope;
  /** Canonical handoff fields, without the event side-channel. */
  readonly envelope: AgentHandoffEnvelope;
  /** Socket output passed to the normal commit path; event is present only when submitted. */
  readonly output: AgentHandoffOutput;
  /** Runtime-owned deterministic serialization of {@link output}. */
  readonly json: string;
}

export type AgentHandoffBuilderErrorCode =
  | "invalid_scope"
  | "unsupported_socket"
  | "unsupported_field"
  | "obsolete_field"
  | "misplaced_field"
  | "invalid_value"
  | "closed";

/** Field-level failure raised before invalid values enter the accumulator. */
export class AgentHandoffBuilderError extends Error {
  readonly code: AgentHandoffBuilderErrorCode;
  readonly scope: AgentHandoffBuilderScope;
  readonly issues: readonly HandoffValidationIssue[];

  constructor(
    code: AgentHandoffBuilderErrorCode,
    scope: AgentHandoffBuilderScope,
    issues: readonly HandoffValidationIssue[],
  ) {
    super(`Agent handoff builder rejected submission for socket "${scope.socketId}": ${issues.map((issue) => `${issue.path}: ${issue.message}`).join(" ")}`);
    this.name = "AgentHandoffBuilderError";
    this.code = code;
    this.scope = cloneAgentHandoffBuilderScope(scope);
    this.issues = issues.map((issue) => ({ ...issue }));
  }
}

export function validateAgentHandoffBuilderScope(value: AgentHandoffBuilderScope): AgentHandoffBuilderScope {
  const provisional = value && typeof value === "object"
    ? value
    : { castId: "unknown", socketId: "unknown", socketVisit: 0, finalizationAttempt: 0 };
  const issue = typeof provisional.castId !== "string" || provisional.castId.trim().length === 0
    ? { path: "$.scope.castId", message: "castId must be a non-empty string" }
    : typeof provisional.socketId !== "string" || provisional.socketId.trim().length === 0
      ? { path: "$.scope.socketId", message: "socketId must be a non-empty string" }
      : !Number.isSafeInteger(provisional.socketVisit) || provisional.socketVisit < 1
        ? { path: "$.scope.socketVisit", message: "socketVisit must be a positive safe integer" }
        : !Number.isSafeInteger(provisional.finalizationAttempt) || provisional.finalizationAttempt < 1
          ? { path: "$.scope.finalizationAttempt", message: "finalizationAttempt must be a positive safe integer" }
          : undefined;
  if (issue) {
    throw new AgentHandoffBuilderError("invalid_scope", cloneAgentHandoffBuilderScope(provisional), [issue]);
  }
  return Object.freeze(cloneAgentHandoffBuilderScope(provisional));
}

export function cloneAgentHandoffBuilderScope(value: AgentHandoffBuilderScope): AgentHandoffBuilderScope {
  return {
    castId: value.castId,
    socketId: value.socketId,
    socketVisit: value.socketVisit,
    finalizationAttempt: value.finalizationAttempt,
  };
}

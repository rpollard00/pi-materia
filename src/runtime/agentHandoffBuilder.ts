import {
  EVENT_SIDECHANNEL_FIELD,
  validateMateriaEventArray,
  type MateriaEventObject,
} from "../domain/eventing.js";
import {
  HANDOFF_CONTEXT_FIELD,
  HANDOFF_LEGACY_NON_CANONICAL_ALIASES,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_TEXT_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
  parseHandoffWorkItem,
  type HandoffWorkItem,
} from "../domain/handoff.js";
import {
  validateHandoffJsonOutput,
  type HandoffValidationIssue,
} from "../handoff/handoffValidation.js";
import {
  buildAgentHandoffOutput,
  canonicalizeAgentHandoffEvent,
  cloneAgentHandoffCommit,
  cloneAgentHandoffEnvelope,
  cloneHandoffWorkItem,
} from "./agentHandoffSerialization.js";
import {
  AgentHandoffBuilderError,
  cloneAgentHandoffBuilderScope,
  validateAgentHandoffBuilderScope,
  type AgentHandoffBuilderErrorCode,
  type AgentHandoffBuilderOptions,
  type AgentHandoffBuilderScope,
  type AgentHandoffCommit,
  type AgentHandoffEnvelope,
  type AgentHandoffOutput,
} from "./agentHandoffBuilderTypes.js";

export {
  AgentHandoffBuilderError,
  type AgentHandoffBuilderErrorCode,
  type AgentHandoffBuilderOptions,
  type AgentHandoffBuilderScope,
  type AgentHandoffCommit,
  type AgentHandoffEnvelope,
  type AgentHandoffOutput,
} from "./agentHandoffBuilderTypes.js";

const OBSOLETE_AGENT_HANDOFF_FIELDS = new Set<string>([
  ...HANDOFF_LEGACY_NON_CANONICAL_ALIASES,
  "tasks",
  "summary",
  "guidance",
  "decisions",
  "risks",
  "feedback",
  "missing",
  "state",
]);

/**
 * Runtime-owned accumulator for one agent finalization attempt.
 *
 * Values are validated on submission, while commit retains the authoritative
 * socket-aware handoff validator. The builder never applies assignments,
 * routing, events, or state itself: its serialized output must still enter the
 * normal socket-output commit path.
 */
export class AgentHandoffBuilder {
  readonly scope: AgentHandoffBuilderScope;

  private includeWorkItems = false;
  private readonly workItems: HandoffWorkItem[] = [];
  private satisfied: boolean | undefined;
  private context: string | undefined;
  private includeEvents = false;
  private events: MateriaEventObject[] = [];
  private lifecycle: "open" | "committing" | "committed" | "discarded" = "open";
  private committed: AgentHandoffCommit | undefined;

  constructor(private readonly options: AgentHandoffBuilderOptions) {
    this.scope = validateAgentHandoffBuilderScope(options.scope);
    this.assertSupportedSocket();
  }

  /** Include an explicitly empty workItems array. */
  beginWorkItems(): void {
    this.assertOpen();
    this.assertFieldPlacement(HANDOFF_WORK_ITEMS_FIELD);
    this.includeWorkItems = true;
  }

  /** Replace the complete workItems value atomically after validating every item. */
  setWorkItems(value: unknown): void {
    this.assertOpen();
    this.assertFieldPlacement(HANDOFF_WORK_ITEMS_FIELD);
    if (!Array.isArray(value)) {
      throw this.failure("invalid_value", `$.${HANDOFF_WORK_ITEMS_FIELD}`, `handoff field ${JSON.stringify(HANDOFF_WORK_ITEMS_FIELD)} must be an array`, "array");
    }
    const parsed = value.map((item, index) => this.parseWorkItem(item, index));
    this.workItems.splice(0, this.workItems.length, ...parsed);
    this.includeWorkItems = true;
  }

  /** Append one work item, preserving tool invocation order. */
  addWorkItem(value: unknown): number {
    this.assertOpen();
    this.assertFieldPlacement(HANDOFF_WORK_ITEMS_FIELD);
    this.workItems.push(this.parseWorkItem(value, this.workItems.length));
    this.includeWorkItems = true;
    return this.workItems.length;
  }

  setSatisfied(value: unknown): void {
    this.assertOpen();
    this.assertFieldPlacement(HANDOFF_SATISFIED_FIELD);
    if (typeof value !== "boolean") {
      throw this.failure("invalid_value", `$.${HANDOFF_SATISFIED_FIELD}`, `handoff field ${JSON.stringify(HANDOFF_SATISFIED_FIELD)} must be a boolean`, "boolean");
    }
    this.satisfied = value;
  }

  setContext(value: unknown): void {
    this.assertOpen();
    this.assertFieldPlacement(HANDOFF_CONTEXT_FIELD);
    if (typeof value !== "string") {
      throw this.failure("invalid_value", `$.${HANDOFF_CONTEXT_FIELD}`, `handoff field ${JSON.stringify(HANDOFF_CONTEXT_FIELD)} must be a string`, "string");
    }
    this.context = value;
  }

  /** Replace the optional event side-channel atomically. */
  setEvents(value: unknown): void {
    this.assertOpen();
    this.assertFieldPlacement(EVENT_SIDECHANNEL_FIELD);
    if (!Array.isArray(value)) {
      throw this.failure("invalid_value", `$.${EVENT_SIDECHANNEL_FIELD}`, "event side-channel must be an array when submitted", "array");
    }
    const validated = validateMateriaEventArray(value);
    if (!validated.ok) {
      throw new AgentHandoffBuilderError(
        "invalid_value",
        this.scope,
        validated.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      );
    }
    this.events = validated.value.map((event, index) => canonicalizeAgentHandoffEvent(event, `$.event[${index}]`, this.scope));
    this.includeEvents = true;
  }

  /** Append one event, preserving submission order. */
  addEvent(value: unknown): number {
    this.assertOpen();
    this.assertFieldPlacement(EVENT_SIDECHANNEL_FIELD);
    const index = this.events.length;
    const validated = validateMateriaEventArray([value]);
    if (!validated.ok) {
      throw new AgentHandoffBuilderError(
        "invalid_value",
        this.scope,
        validated.issues.map((issue) => ({
          path: issue.path.replace("$.event[0]", `$.event[${index}]`),
          message: issue.message,
        })),
      );
    }
    this.events.push(canonicalizeAgentHandoffEvent(validated.value[0]!, `$.event[${index}]`, this.scope));
    this.includeEvents = true;
    return this.events.length;
  }

  /** Generic checked entry point for adapters that receive a field name. */
  submitField(field: unknown, value: unknown): void {
    this.assertOpen();
    if (typeof field !== "string") {
      throw this.failure("unsupported_field", "$", "handoff field name must be a string");
    }
    switch (field) {
      case HANDOFF_WORK_ITEMS_FIELD: return this.setWorkItems(value);
      case HANDOFF_SATISFIED_FIELD: return this.setSatisfied(value);
      case HANDOFF_CONTEXT_FIELD: return this.setContext(value);
      case EVENT_SIDECHANNEL_FIELD: return this.setEvents(value);
      case HANDOFF_TEXT_FIELD:
        throw this.failure(
          "unsupported_field",
          `$.${field}`,
          `${JSON.stringify(field)} is canonical only for renderable-prose sockets and is not supported by this handoff builder`,
        );
      default: {
        const obsolete = OBSOLETE_AGENT_HANDOFF_FIELDS.has(field);
        throw this.failure(
          obsolete ? "obsolete_field" : "unsupported_field",
          `$.${field}`,
          obsolete
            ? `obsolete agent handoff field ${JSON.stringify(field)} is not part of the canonical contract`
            : `unsupported agent handoff field ${JSON.stringify(field)}`,
        );
      }
    }
  }

  /** Current complete socket output in deterministic outer-field order. */
  snapshot(): AgentHandoffOutput {
    this.assertNotDiscarded();
    return buildAgentHandoffOutput(this.snapshotEnvelope(), this.includeEvents ? this.events : undefined);
  }

  /** Current canonical handoff value without event side-channel data. */
  snapshotEnvelope(): AgentHandoffEnvelope {
    this.assertNotDiscarded();
    const envelope: AgentHandoffEnvelope = {};
    if (this.includeWorkItems) envelope.workItems = this.workItems.map(cloneHandoffWorkItem);
    if (this.satisfied !== undefined) envelope.satisfied = this.satisfied;
    if (this.context !== undefined) envelope.context = this.context;
    return envelope;
  }

  /**
   * Validate and serialize exactly once. The optional callback is the host
   * boundary; rejection reopens this builder so the commit can be retried.
   */
  async commit(
    onCommit?: (commit: AgentHandoffCommit) => void | Promise<void>,
  ): Promise<AgentHandoffCommit> {
    this.assertOpen();
    this.lifecycle = "committing";
    try {
      const envelope = this.snapshotEnvelope();
      validateHandoffJsonOutput(envelope, {
        socketId: this.scope.socketId,
        requirements: this.options.requirements,
        agentOutput: true,
        workItemsProducer: this.options.workItemsProducer,
      });
      const output = buildAgentHandoffOutput(envelope, this.includeEvents ? this.events : undefined);
      const commit: AgentHandoffCommit = {
        scope: cloneAgentHandoffBuilderScope(this.scope),
        envelope: cloneAgentHandoffEnvelope(envelope),
        output,
        json: JSON.stringify(output),
      };
      await onCommit?.(cloneAgentHandoffCommit(commit));
      this.committed = commit;
      this.lifecycle = "committed";
      return cloneAgentHandoffCommit(commit);
    } catch (error) {
      this.lifecycle = "open";
      throw error;
    }
  }

  committedValue(): AgentHandoffCommit | undefined {
    return this.committed ? cloneAgentHandoffCommit(this.committed) : undefined;
  }

  /** Invalidate and clear partial values so a later scope cannot reuse them. */
  discard(): void {
    if (this.lifecycle === "committing") {
      throw this.failure("closed", "$", "handoff builder commit is already in progress");
    }
    this.workItems.length = 0;
    this.events.length = 0;
    this.includeWorkItems = false;
    this.includeEvents = false;
    this.satisfied = undefined;
    this.context = undefined;
    this.committed = undefined;
    this.lifecycle = "discarded";
  }

  private assertSupportedSocket(): void {
    const requirements = this.options.requirements;
    if (!requirements.requiresJsonObject || requirements.parse !== "json") {
      throw this.failure("unsupported_socket", "$", "runtime-owned agent handoffs require a JSON-output socket");
    }
    if (requirements.renderableTextIntent) {
      throw this.failure(
        "unsupported_socket",
        `$.${HANDOFF_TEXT_FIELD}`,
        "renderable-text sockets are not representable by this workItems/satisfied/context handoff builder",
      );
    }
    const unsupportedRequired = requirements.requiredFields.find((field) => !isBuilderPayloadField(field.field));
    if (unsupportedRequired) {
      throw this.failure("unsupported_socket", unsupportedRequired.path, `socket requires unsupported payload field ${JSON.stringify(unsupportedRequired.field)}`);
    }
    const unsupportedConsumed = requirements.consumedPayloadPaths.find(
      (path) => path.payloadPath !== "$" && path.topLevelField !== undefined && !isBuilderPayloadField(path.topLevelField),
    );
    if (unsupportedConsumed) {
      throw this.failure("unsupported_socket", unsupportedConsumed.payloadPath, `socket consumes unsupported payload field ${JSON.stringify(unsupportedConsumed.topLevelField)}`);
    }
  }

  private assertFieldPlacement(field: string): void {
    if (field === HANDOFF_CONTEXT_FIELD) return;
    if (field === EVENT_SIDECHANNEL_FIELD) {
      if (this.options.allowEventSideChannel !== false) return;
      throw this.failure("misplaced_field", `$.${field}`, "event side-channel data is not permitted for this finalization strategy");
    }
    if (field === HANDOFF_WORK_ITEMS_FIELD && this.allowsWorkItems()) return;
    if (field === HANDOFF_SATISFIED_FIELD && this.allowsSatisfied()) return;
    throw this.failure("misplaced_field", `$.${field}`, `handoff field ${JSON.stringify(field)} is not consumed or required by this socket placement`);
  }

  private allowsWorkItems(): boolean {
    return this.options.workItemsProducer === true || this.fieldIsRequiredOrConsumed(HANDOFF_WORK_ITEMS_FIELD);
  }

  private allowsSatisfied(): boolean {
    return this.options.requirements.reservedFieldTypeRules.some(
      (rule) => rule.field === HANDOFF_SATISFIED_FIELD && rule.required,
    ) || this.fieldIsRequiredOrConsumed(HANDOFF_SATISFIED_FIELD);
  }

  private fieldIsRequiredOrConsumed(field: string): boolean {
    return this.options.requirements.requiredFields.some((requirement) => requirement.field === field)
      || this.options.requirements.consumedPayloadPaths.some((path) => path.topLevelField === field);
  }

  private parseWorkItem(value: unknown, index: number): HandoffWorkItem {
    const path = `$.${HANDOFF_WORK_ITEMS_FIELD}.${index}`;
    if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "id")) {
      throw this.failure("obsolete_field", `${path}.id`, "agent-authored work items must not include runtime-derived id fields");
    }
    const parsed = parseHandoffWorkItem(value, path);
    if (!parsed.ok) {
      throw new AgentHandoffBuilderError(
        "invalid_value",
        this.scope,
        parsed.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      );
    }
    return cloneHandoffWorkItem(parsed.value);
  }

  private assertOpen(): void {
    if (this.lifecycle === "open") return;
    const message = this.lifecycle === "committing"
      ? "handoff builder commit is already in progress"
      : this.lifecycle === "committed"
        ? "handoff builder has already been committed"
        : "handoff builder has been discarded";
    throw this.failure("closed", "$", message);
  }

  private assertNotDiscarded(): void {
    if (this.lifecycle === "discarded") {
      throw this.failure("closed", "$", "handoff builder has been discarded");
    }
  }

  private failure(
    code: AgentHandoffBuilderErrorCode,
    path: string,
    message: string,
    expected?: HandoffValidationIssue["expected"],
  ): AgentHandoffBuilderError {
    return new AgentHandoffBuilderError(code, this.scope, [{ path, message, ...(expected ? { expected } : {}) }]);
  }
}

function isBuilderPayloadField(field: string): boolean {
  return field === HANDOFF_WORK_ITEMS_FIELD
    || field === HANDOFF_SATISFIED_FIELD
    || field === HANDOFF_CONTEXT_FIELD;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

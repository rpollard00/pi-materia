import {
  HANDOFF_CONTEXT_FIELD,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_TEXT_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
  parseHandoffWorkItem,
  type HandoffEnvelope,
  type HandoffWorkItem,
} from "../domain/handoff.js";
import {
  validateHandoffJsonOutput,
} from "../handoff/handoffValidation.js";
import type { SocketOutputRequirements } from "../handoff/socketOutputRequirements.js";

export type PrototypeHandoffEnvelope = Partial<HandoffEnvelope>;

export interface ToolBackedHandoffCommit {
  /** Canonical, sparse handoff value assembled from tool arguments. */
  envelope: PrototypeHandoffEnvelope;
  /** Runtime-owned serialization of {@link envelope}. */
  json: string;
}

export interface ToolBackedHandoffSubmissionOptions {
  socketId?: string;
  requirements?: SocketOutputRequirements;
  workItemsProducer?: boolean;
}

/**
 * Isolated prototype accumulator for tool-backed agent handoffs.
 *
 * This deliberately has no cast/session integration. Production lifecycle,
 * socket scoping, capability selection, persistence, and fallback routing are
 * separate concerns. The prototype proves that accepted tool argument values
 * can be accumulated and serialized without asking the model to escape a full
 * JSON envelope.
 */
export class ToolBackedHandoffSubmission {
  private includeWorkItems = false;
  private readonly workItems: HandoffWorkItem[] = [];
  private satisfied: boolean | undefined;
  private context: string | undefined;
  private text: string | undefined;
  private committed: ToolBackedHandoffCommit | undefined;
  private committing = false;

  constructor(private readonly options: ToolBackedHandoffSubmissionOptions = {}) {}

  beginWorkItems(): void {
    this.assertOpen();
    this.includeWorkItems = true;
  }

  addWorkItem(value: HandoffWorkItem): number {
    this.assertOpen();
    const parsed = parseHandoffWorkItem(value, `$.${HANDOFF_WORK_ITEMS_FIELD}.${this.workItems.length}`);
    if (!parsed.ok) {
      throw new Error(parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join(" "));
    }
    this.includeWorkItems = true;
    this.workItems.push(parsed.value);
    return this.workItems.length;
  }

  setSatisfied(value: boolean): void {
    this.assertOpen();
    this.satisfied = value;
  }

  setContext(value: string): void {
    this.assertOpen();
    this.context = value;
  }

  setText(value: string): void {
    this.assertOpen();
    this.text = value;
  }

  snapshot(): PrototypeHandoffEnvelope {
    const envelope: PrototypeHandoffEnvelope = {};
    // Assignment order is the canonical envelope order. JSON serialization is
    // runtime-owned and therefore independent of tool invocation order.
    if (this.includeWorkItems) envelope[HANDOFF_WORK_ITEMS_FIELD] = this.workItems.map(cloneWorkItem);
    if (this.satisfied !== undefined) envelope[HANDOFF_SATISFIED_FIELD] = this.satisfied;
    if (this.context !== undefined) envelope[HANDOFF_CONTEXT_FIELD] = this.context;
    if (this.text !== undefined) envelope[HANDOFF_TEXT_FIELD] = this.text;
    return envelope;
  }

  async commit(
    onCommit?: (commit: ToolBackedHandoffCommit) => void | Promise<void>,
  ): Promise<ToolBackedHandoffCommit> {
    this.assertOpen();
    this.committing = true;
    try {
      const envelope = this.snapshot();
      const validated = validateHandoffJsonOutput(envelope, {
        socketId: this.options.socketId ?? "tool-backed-prototype",
        requirements: this.options.requirements,
        agentOutput: true,
        workItemsProducer: this.options.workItemsProducer,
      }) as PrototypeHandoffEnvelope;
      const commit = {
        envelope: cloneEnvelope(validated),
        json: JSON.stringify(validated),
      };
      // Treat the host callback as the commit boundary. If persistence rejects,
      // leave the accumulator open so the tool call can be retried.
      await onCommit?.(cloneCommit(commit));
      this.committed = commit;
      return cloneCommit(commit);
    } finally {
      this.committing = false;
    }
  }

  committedValue(): ToolBackedHandoffCommit | undefined {
    return this.committed ? cloneCommit(this.committed) : undefined;
  }

  private assertOpen(): void {
    if (this.committed) throw new Error("The tool-backed handoff prototype has already been committed.");
    if (this.committing) throw new Error("The tool-backed handoff prototype commit is already in progress.");
  }
}

function cloneWorkItem(item: HandoffWorkItem): HandoffWorkItem {
  return { title: item.title, context: item.context };
}

function cloneEnvelope(value: PrototypeHandoffEnvelope): PrototypeHandoffEnvelope {
  const clone: PrototypeHandoffEnvelope = {};
  if (value.workItems !== undefined) clone.workItems = value.workItems.map(cloneWorkItem);
  if (value.satisfied !== undefined) clone.satisfied = value.satisfied;
  if (value.context !== undefined) clone.context = value.context;
  if (value.text !== undefined) clone.text = value.text;
  return clone;
}

function cloneCommit(value: ToolBackedHandoffCommit): ToolBackedHandoffCommit {
  return { envelope: cloneEnvelope(value.envelope), json: value.json };
}

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

export interface ExperimentTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ExperimentUsage {
  tokens: ExperimentTokenUsage;
  /** Provider-reported token-value cost; it is not necessarily a billed charge. */
  reportedCost: number;
}

export type RawToolArgumentSyntax = "valid_json" | "malformed_json" | "not_captured";
export type ToolExecutionOutcome =
  | "succeeded"
  | "schema_rejected"
  | "commit_rejected"
  | "duplicate_commit"
  | "unknown_tool"
  | "execution_rejected"
  | "not_executed";

/** Sanitized trace: argument content is deliberately not retained. */
export interface ToolArgumentTrace {
  providerTurn: number;
  toolName: string;
  rawBytes: number;
  rawSyntax: RawToolArgumentSyntax;
  piParsedArgumentType: "object" | "array" | "null" | "other" | "not_available";
  execution: ToolExecutionOutcome;
}

export interface ToolExperimentDiagnostics {
  toolCalls: number;
  commitCalls: number;
  successfulCommitCalls: number;
  malformedRawArguments: number;
  uncapturedRawArguments: number;
  schemaRejections: number;
  commitRejections: number;
  missingCommit: number;
  duplicateCommit: number;
  unknownToolCalls: number;
  executionRejections: number;
  assistantTextResponses: number;
  assistantErrorResponses: number;
  providerAutoRetries: number;
  argumentTraces: ToolArgumentTrace[];
}

interface PendingArgumentTrace {
  providerTurn: number;
  toolName: string;
  raw: string;
}

/**
 * Records provider-streamed tool argument deltas before Pi's parsed arguments
 * reach schema validation. Raw values are reduced to syntax/size diagnostics.
 */
export class ToolArgumentStreamRecorder {
  private readonly pending = new Map<string, PendingArgumentTrace>();
  private readonly traceByCallId = new Map<string, ToolArgumentTrace>();
  private readonly completed: ToolArgumentTrace[] = [];

  observe(event: AssistantMessageEvent, providerTurn: number): void {
    if (event.type === "toolcall_start") {
      // Capture only emitted deltas. `partial` is a mutable streaming object and
      // may already contain later bytes when an async subscriber observes the
      // start event; seeding from it would double-count those bytes.
      this.pending.set(traceKey(providerTurn, event.contentIndex), {
        providerTurn,
        toolName: streamedToolName(event, event.contentIndex),
        raw: "",
      });
      return;
    }
    if (event.type === "toolcall_delta") {
      const key = traceKey(providerTurn, event.contentIndex);
      const pending = this.pending.get(key) ?? {
        providerTurn,
        toolName: streamedToolName(event, event.contentIndex),
        raw: "",
      };
      pending.raw += event.delta;
      this.pending.set(key, pending);
      return;
    }
    if (event.type !== "toolcall_end") return;

    const key = traceKey(providerTurn, event.contentIndex);
    const pending = this.pending.get(key);
    const raw = pending?.raw ?? "";
    const trace: ToolArgumentTrace = {
      providerTurn,
      toolName: event.toolCall.name,
      rawBytes: new TextEncoder().encode(raw).byteLength,
      rawSyntax: classifyRawSyntax(raw),
      piParsedArgumentType: argumentType(event.toolCall.arguments),
      execution: "not_executed",
    };
    this.pending.delete(key);
    this.traceByCallId.set(event.toolCall.id, trace);
    this.completed.push(trace);
  }

  recordExecution(toolCallId: string, outcome: ToolExecutionOutcome): void {
    const trace = this.traceByCallId.get(toolCallId);
    if (trace) trace.execution = outcome;
  }

  /** Preserve interrupted/incomplete streamed calls as syntax diagnostics. */
  finishProviderTurn(providerTurn: number): void {
    for (const [key, pending] of this.pending) {
      if (pending.providerTurn !== providerTurn) continue;
      this.completed.push({
        providerTurn,
        toolName: pending.toolName,
        rawBytes: new TextEncoder().encode(pending.raw).byteLength,
        rawSyntax: classifyRawSyntax(pending.raw),
        piParsedArgumentType: "not_available",
        execution: "not_executed",
      });
      this.pending.delete(key);
    }
  }

  traces(): ToolArgumentTrace[] {
    return this.completed.map((trace) => ({ ...trace }));
  }
}

/** Collects sanitized, per-session metrics from Pi's real AgentSession event loop. */
export class HandoffExperimentObserver {
  private providerTurn = 0;
  private readonly usage = emptyUsage();
  private readonly argumentRecorder = new ToolArgumentStreamRecorder();
  private readonly counters = {
    toolCalls: 0,
    commitCalls: 0,
    successfulCommitCalls: 0,
    schemaRejections: 0,
    commitRejections: 0,
    duplicateCommit: 0,
    unknownToolCalls: 0,
    executionRejections: 0,
    assistantTextResponses: 0,
    assistantErrorResponses: 0,
    providerAutoRetries: 0,
  };

  constructor(private readonly commitToolName?: string) {}

  observe(event: AgentSessionEvent): void {
    if (event.type === "turn_start") {
      this.providerTurn += 1;
      return;
    }
    if (event.type === "message_update") {
      this.argumentRecorder.observe(event.assistantMessageEvent, this.providerTurn);
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.argumentRecorder.finishProviderTurn(this.providerTurn);
      this.recordAssistant(event.message);
      return;
    }
    if (event.type === "tool_execution_start") {
      this.counters.toolCalls += 1;
      if (event.toolName === this.commitToolName) this.counters.commitCalls += 1;
      return;
    }
    if (event.type === "tool_execution_end") {
      const outcome = classifyToolExecution(event.toolName, event.isError, resultText(event.result), this.commitToolName);
      this.argumentRecorder.recordExecution(event.toolCallId, outcome);
      if (outcome === "succeeded" && event.toolName === this.commitToolName) this.counters.successfulCommitCalls += 1;
      else if (outcome === "schema_rejected") this.counters.schemaRejections += 1;
      else if (outcome === "commit_rejected") this.counters.commitRejections += 1;
      else if (outcome === "duplicate_commit") this.counters.duplicateCommit += 1;
      else if (outcome === "unknown_tool") this.counters.unknownToolCalls += 1;
      else if (outcome === "execution_rejected") this.counters.executionRejections += 1;
      return;
    }
    if (event.type === "auto_retry_start") this.counters.providerAutoRetries += 1;
  }

  currentProviderTurn(): number {
    return this.providerTurn;
  }

  measuredUsage(): ExperimentUsage {
    return {
      tokens: { ...this.usage.tokens },
      reportedCost: this.usage.reportedCost,
    };
  }

  diagnostics(missingCommit: number): ToolExperimentDiagnostics {
    const argumentTraces = this.argumentRecorder.traces();
    return {
      ...this.counters,
      malformedRawArguments: argumentTraces.filter((trace) => trace.rawSyntax === "malformed_json").length,
      uncapturedRawArguments: argumentTraces.filter((trace) => trace.rawSyntax === "not_captured").length,
      missingCommit,
      argumentTraces,
    };
  }

  private recordAssistant(message: AssistantMessage): void {
    this.usage.tokens.input += finite(message.usage.input);
    this.usage.tokens.output += finite(message.usage.output);
    this.usage.tokens.cacheRead += finite(message.usage.cacheRead);
    this.usage.tokens.cacheWrite += finite(message.usage.cacheWrite);
    this.usage.tokens.total += finite(message.usage.totalTokens);
    this.usage.reportedCost += finite(message.usage.cost?.total);
    if (message.stopReason === "error") this.counters.assistantErrorResponses += 1;
    if (message.content.some((part) => part.type === "text" && part.text.trim().length > 0)) {
      this.counters.assistantTextResponses += 1;
    }
  }
}

export function emptyUsage(): ExperimentUsage {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    reportedCost: 0,
  };
}

function classifyToolExecution(
  toolName: string,
  isError: boolean,
  text: string,
  commitToolName: string | undefined,
): ToolExecutionOutcome {
  if (!isError) return "succeeded";
  if (/Validation failed for tool/i.test(text)) return "schema_rejected";
  if (/Tool .+ not found/i.test(text)) return "unknown_tool";
  if (toolName === commitToolName && /already (?:been )?committed|commit is already in progress/i.test(text)) {
    return "duplicate_commit";
  }
  if (toolName === commitToolName) return "commit_rejected";
  return "execution_rejected";
}

function resultText(result: unknown): string {
  const value = result && typeof result === "object" ? result as { content?: unknown } : undefined;
  if (!Array.isArray(value?.content)) return "";
  return value.content.map((part) => {
    const item = part as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? item.text : "";
  }).join("\n");
}

function streamedToolName(event: AssistantMessageEvent, contentIndex: number): string {
  if (!("partial" in event)) return "unknown_tool";
  const block = event.partial.content[contentIndex] as { name?: unknown } | undefined;
  return typeof block?.name === "string" && block.name ? block.name : "unknown_tool";
}

function classifyRawSyntax(raw: string): RawToolArgumentSyntax {
  if (!raw.trim()) return "not_captured";
  try {
    JSON.parse(raw);
    return "valid_json";
  } catch {
    return "malformed_json";
  }
}

function argumentType(value: unknown): ToolArgumentTrace["piParsedArgumentType"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "other";
}

function traceKey(providerTurn: number, contentIndex: number): string {
  return `${providerTurn}:${contentIndex}`;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

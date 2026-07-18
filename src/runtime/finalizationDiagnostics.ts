import type {
  MateriaCastState,
  MateriaFinalizationFailureCategory,
} from "../types.js";
import type { HandoffValidationIssue } from "../handoff/handoffValidation.js";
import { isAgentHandoffToolName } from "./agentHandoffTools.js";

export interface HandoffToolExecutionEndEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly result: {
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  };
}

interface FinalizationToolFailure {
  readonly category: MateriaFinalizationFailureCategory;
  readonly issues: readonly HandoffValidationIssue[];
}

export interface FinalizationDiagnosticDependencies {
  appendEvent(
    runState: MateriaCastState["runState"],
    type: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  saveState(state: MateriaCastState): void;
}

/** Record content-free diagnostics for both Pi schema and tool execution failures. */
export async function handleFinalizationToolExecutionEnd(
  state: MateriaCastState | undefined,
  event: HandoffToolExecutionEndEvent,
  deps: FinalizationDiagnosticDependencies,
): Promise<void> {
  if (!state?.active || !event.isError || !isAgentHandoffToolName(event.toolName)) return;
  const finalization = state.agentFinalization;
  if (!finalization || finalization.strategy !== "tool_backed" || finalization.phase !== "active") return;

  const failure = classifyHandoffToolFailure(event);
  const attempt = (finalization.toolFailureCount ?? 0) + 1;
  finalization.toolFailureCount = attempt;
  state.updatedAt = Date.now();
  deps.saveState(state);
  await deps.appendEvent(state.runState, "agent_finalization_failure", {
    strategy: "tool_backed",
    failureCategory: failure.category,
    attempt,
    finalizationAttempt: finalization.finalizationAttempt,
    tool: event.toolName,
    toolCallId: event.toolCallId,
    issueCount: failure.issues.length,
    issuePaths: [...new Set(failure.issues.map((issue) => issue.path))],
    retryable: true,
    socket: finalization.socketId,
    visit: finalization.socketVisit,
  });
}

function classifyHandoffToolFailure(event: HandoffToolExecutionEndEvent): FinalizationToolFailure {
  const text = (event.result.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  const issues = parseFieldIssues(text);

  if (/^(?:Materia handoff argument validation failed|Validation failed for tool)\b/m.test(text)) {
    return { category: "tool_argument_validation", issues };
  }
  if (/^Materia handoff contract violation\./m.test(text)) {
    return { category: "contract_violation", issues };
  }
  if (/^Materia handoff protocol violation\./m.test(text)) {
    return { category: "tool_protocol_violation", issues };
  }
  return { category: "tool_execution_failure", issues };
}

function parseFieldIssues(text: string): HandoffValidationIssue[] {
  // Defensive split: current handoff tools sanitize schema failures before Pi's
  // validator, but never inspect or persist the argument echo if an older Pi
  // implementation still supplies one.
  const safeSection = text.split(/\n\s*Received arguments:/i, 1)[0] ?? "";
  const issues: HandoffValidationIssue[] = [];
  for (const line of safeSection.split("\n")) {
    const match = line.match(/^\s*-\s+([^:]+):\s*(.+?)\s*$/);
    if (!match) continue;
    issues.push({ path: normalizeValidationPath(match[1]!), message: match[2]! });
  }
  return issues;
}

function normalizeValidationPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "root" || trimmed === "$" || trimmed === "/") return "$";
  if (trimmed.startsWith("$.")) return trimmed;
  if (trimmed.startsWith("/")) return `$.${trimmed.slice(1).replaceAll("/", ".")}`;
  if (trimmed.startsWith("root.")) return `$.${trimmed.slice("root.".length)}`;
  return `$.${trimmed}`;
}

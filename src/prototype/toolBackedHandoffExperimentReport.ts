import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { emptyUsage, type ExperimentUsage, type ToolExperimentDiagnostics } from "./toolBackedHandoffExperimentMetrics.js";

export type DirectExperimentOutcome =
  | "accepted"
  | "empty_output"
  | "provider_error"
  | "json_syntax"
  | "contract_rejection"
  | "semantic_mismatch";

export type ToolExperimentOutcome = "accepted" | "provider_error" | "missing_commit" | "semantic_mismatch";

export interface DirectExperimentRun {
  strategy: "direct_json";
  repetition: number;
  firstSubmissionOutcome: DirectExperimentOutcome;
  eventualOutcome: DirectExperimentOutcome;
  recoveryPrompts: number;
  providerTurns: number;
  providerAutoRetries: number;
  latencyMs: number;
  usage: ExperimentUsage;
  bareJsonOnAcceptedSubmission: boolean;
}

export interface ToolBackedExperimentRun {
  strategy: "tool_backed";
  repetition: number;
  firstPromptOutcome: ToolExperimentOutcome;
  firstProviderTurnCommitted: boolean;
  eventualOutcome: ToolExperimentOutcome;
  recoveryPrompts: number;
  commitProviderTurn: number | null;
  providerTurns: number;
  latencyMs: number;
  usage: ExperimentUsage;
  diagnostics: ToolExperimentDiagnostics;
}

export type ToolHandoffExperimentRun = DirectExperimentRun | ToolBackedExperimentRun;

export interface ExperimentStrategySummary {
  runs: number;
  eventualAccepted: number;
  recoveryPrompts: number;
  providerTurns: number;
  totalLatencyMs: number;
  meanLatencyMs: number;
  usage: ExperimentUsage;
}

export interface ToolHandoffExperimentSummary {
  directJson: ExperimentStrategySummary & {
    firstSubmissionAccepted: number;
    emptyOutputs: number;
    providerErrors: number;
    jsonSyntaxFailures: number;
    contractRejections: number;
    semanticMismatches: number;
  };
  toolBacked: ExperimentStrategySummary & {
    firstPromptAccepted: number;
    firstProviderTurnCommitted: number;
    malformedRawArguments: number;
    uncapturedRawArguments: number;
    schemaRejections: number;
    commitRejections: number;
    missingCommit: number;
    duplicateCommit: number;
    unknownToolCalls: number;
    executionRejections: number;
  };
}

export interface ToolHandoffProviderEvidence {
  schemaVersion: 1;
  kind: "paired-pi-agent-session-provider-experiment";
  capturedAt: string;
  configuration: {
    caseId: string;
    semanticPayloadSha256: string;
    provider: string;
    model: string;
    api: string;
    thinking: ThinkingLevel;
    repetitions: number;
    maxRecoveryPrompts: number;
    transport: "sse";
    piAgentLoop: "createAgentSession";
    providerToolArgumentsObserved: "streamed toolcall_delta events before Pi schema validation";
    schemaValidation: "Pi validateToolArguments before tool execution";
    providerStrictSchemaGuarantee: false;
    costInterpretation: "provider-reported token value; subscription providers may not bill this amount per call";
  };
  runs: ToolHandoffExperimentRun[];
  summary: ToolHandoffExperimentSummary;
  limitations: string[];
}

export function summarizeToolHandoffExperiment(runs: readonly ToolHandoffExperimentRun[]): ToolHandoffExperimentSummary {
  const direct = runs.filter((run): run is DirectExperimentRun => run.strategy === "direct_json");
  const tool = runs.filter((run): run is ToolBackedExperimentRun => run.strategy === "tool_backed");
  const directBase = summarizeStrategy(direct, (run) => run.eventualOutcome === "accepted");
  const toolBase = summarizeStrategy(tool, (run) => run.eventualOutcome === "accepted");

  return {
    directJson: {
      ...directBase,
      firstSubmissionAccepted: direct.filter((run) => run.firstSubmissionOutcome === "accepted").length,
      emptyOutputs: direct.filter((run) => hasOutcome(run, "empty_output")).length,
      providerErrors: direct.filter((run) => hasOutcome(run, "provider_error")).length,
      jsonSyntaxFailures: direct.filter((run) => hasOutcome(run, "json_syntax")).length,
      contractRejections: direct.filter((run) => hasOutcome(run, "contract_rejection")).length,
      semanticMismatches: direct.filter((run) => hasOutcome(run, "semantic_mismatch")).length,
    },
    toolBacked: {
      ...toolBase,
      firstPromptAccepted: tool.filter((run) => run.firstPromptOutcome === "accepted").length,
      firstProviderTurnCommitted: tool.filter((run) => run.firstProviderTurnCommitted).length,
      malformedRawArguments: sum(tool, (run) => run.diagnostics.malformedRawArguments),
      uncapturedRawArguments: sum(tool, (run) => run.diagnostics.uncapturedRawArguments),
      schemaRejections: sum(tool, (run) => run.diagnostics.schemaRejections),
      commitRejections: sum(tool, (run) => run.diagnostics.commitRejections),
      missingCommit: sum(tool, (run) => run.diagnostics.missingCommit),
      duplicateCommit: sum(tool, (run) => run.diagnostics.duplicateCommit),
      unknownToolCalls: sum(tool, (run) => run.diagnostics.unknownToolCalls),
      executionRejections: sum(tool, (run) => run.diagnostics.executionRejections),
    },
  };
}

function hasOutcome(run: DirectExperimentRun, outcome: DirectExperimentOutcome): boolean {
  return run.firstSubmissionOutcome === outcome || run.eventualOutcome === outcome;
}

function summarizeStrategy<T extends ToolHandoffExperimentRun>(
  runs: readonly T[],
  accepted: (run: T) => boolean,
): ExperimentStrategySummary {
  const totalLatencyMs = sum(runs, (run) => run.latencyMs);
  const usage = runs.reduce((total, run) => addUsage(total, run.usage), emptyUsage());
  return {
    runs: runs.length,
    eventualAccepted: runs.filter(accepted).length,
    recoveryPrompts: sum(runs, (run) => run.recoveryPrompts),
    providerTurns: sum(runs, (run) => run.providerTurns),
    totalLatencyMs,
    meanLatencyMs: runs.length > 0 ? Math.round(totalLatencyMs / runs.length) : 0,
    usage,
  };
}

function addUsage(target: ExperimentUsage, value: ExperimentUsage): ExperimentUsage {
  target.tokens.input += value.tokens.input;
  target.tokens.output += value.tokens.output;
  target.tokens.cacheRead += value.tokens.cacheRead;
  target.tokens.cacheWrite += value.tokens.cacheWrite;
  target.tokens.total += value.tokens.total;
  target.reportedCost += value.reportedCost;
  return target;
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

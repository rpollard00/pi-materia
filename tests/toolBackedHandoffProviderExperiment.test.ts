import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
  TOOL_HANDOFF_EXPERIMENT_CASE_ID,
  TOOL_HANDOFF_EXPERIMENT_ENVELOPE,
} from "../src/prototype/toolBackedHandoffExperimentCase.js";
import { ToolArgumentStreamRecorder } from "../src/prototype/toolBackedHandoffExperimentMetrics.js";
import {
  summarizeToolHandoffExperiment,
  type ToolHandoffProviderEvidence,
} from "../src/prototype/toolBackedHandoffExperimentReport.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "finalization");
const providerEvidencePath = path.join(fixtureRoot, "tool-backed-provider-evidence.json");

describe("tool-backed handoff provider experiment", () => {
  test("classifies raw provider argument syntax without retaining argument content", () => {
    const recorder = new ToolArgumentStreamRecorder();
    const partial = assistantMessage();
    const malformed = String.raw`{"context":"C:\materia"}`;

    recorder.observe({ type: "toolcall_start", contentIndex: 0, partial } as AssistantMessageEvent, 1);
    recorder.observe({ type: "toolcall_delta", contentIndex: 0, delta: malformed, partial } as AssistantMessageEvent, 1);
    recorder.observe({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "call-1", name: "set_context", arguments: { context: "C:\\materia" } },
      partial,
    } as AssistantMessageEvent, 1);
    recorder.recordExecution("call-1", "succeeded");

    expect(recorder.traces()).toEqual([{
      providerTurn: 1,
      toolName: "set_context",
      rawBytes: new TextEncoder().encode(malformed).byteLength,
      rawSyntax: "malformed_json",
      piParsedArgumentType: "object",
      execution: "succeeded",
    }]);
    expect(JSON.stringify(recorder.traces())).not.toContain("materia");
  });

  test("summarizes retries, latency, token use, and all requested tool failure categories", () => {
    const usage = {
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 17 },
      reportedCost: 0.01,
    };
    const summary = summarizeToolHandoffExperiment([
      {
        strategy: "direct_json",
        repetition: 1,
        firstSubmissionOutcome: "json_syntax",
        eventualOutcome: "accepted",
        recoveryPrompts: 1,
        providerTurns: 2,
        providerAutoRetries: 0,
        latencyMs: 100,
        usage,
        bareJsonOnAcceptedSubmission: true,
      },
      {
        strategy: "tool_backed",
        repetition: 1,
        firstPromptOutcome: "missing_commit",
        firstProviderTurnCommitted: false,
        eventualOutcome: "accepted",
        recoveryPrompts: 1,
        commitProviderTurn: 3,
        providerTurns: 3,
        latencyMs: 200,
        usage,
        diagnostics: {
          toolCalls: 4,
          commitCalls: 2,
          successfulCommitCalls: 1,
          malformedRawArguments: 1,
          uncapturedRawArguments: 2,
          schemaRejections: 3,
          commitRejections: 4,
          missingCommit: 5,
          duplicateCommit: 6,
          unknownToolCalls: 7,
          executionRejections: 8,
          assistantTextResponses: 1,
          assistantErrorResponses: 0,
          providerAutoRetries: 0,
          argumentTraces: [],
        },
      },
    ]);

    expect(summary.directJson).toMatchObject({
      eventualAccepted: 1,
      firstSubmissionAccepted: 0,
      jsonSyntaxFailures: 1,
      recoveryPrompts: 1,
      providerTurns: 2,
      meanLatencyMs: 100,
    });
    expect(summary.toolBacked).toMatchObject({
      eventualAccepted: 1,
      firstPromptAccepted: 0,
      malformedRawArguments: 1,
      uncapturedRawArguments: 2,
      schemaRejections: 3,
      commitRejections: 4,
      missingCommit: 5,
      duplicateCommit: 6,
      unknownToolCalls: 7,
      executionRejections: 8,
      recoveryPrompts: 1,
      providerTurns: 3,
      meanLatencyMs: 200,
    });
    expect(summary.toolBacked.usage).toEqual(usage);
  });

  test("checked-in evidence came from paired Pi agent sessions and remains internally consistent", async () => {
    const evidence = JSON.parse(await readFile(providerEvidencePath, "utf8")) as ToolHandoffProviderEvidence;

    expect(evidence.kind).toBe("paired-pi-agent-session-provider-experiment");
    expect(evidence.configuration.caseId).toBe(TOOL_HANDOFF_EXPERIMENT_CASE_ID);
    expect(evidence.configuration.piAgentLoop).toBe("createAgentSession");
    expect(evidence.configuration.providerStrictSchemaGuarantee).toBe(false);
    expect(evidence.configuration.repetitions).toBeGreaterThanOrEqual(3);
    expect(evidence.runs).toHaveLength(evidence.configuration.repetitions * 2);
    expect(evidence.summary).toEqual(summarizeToolHandoffExperiment(evidence.runs));
    expect(evidence.summary.directJson.providerTurns).toBeGreaterThanOrEqual(evidence.summary.directJson.runs);
    expect(evidence.summary.toolBacked.providerTurns).toBeGreaterThanOrEqual(evidence.summary.toolBacked.runs);

    const traces = evidence.runs.flatMap((run) => run.strategy === "tool_backed" ? run.diagnostics.argumentTraces : []);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((trace) => !("raw" in trace) && !("arguments" in trace))).toBe(true);
    expect(TOOL_HANDOFF_EXPERIMENT_ENVELOPE.workItems[0].context).toContain("C:\\Users\\materia");
  });
});

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}

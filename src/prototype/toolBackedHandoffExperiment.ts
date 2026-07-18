import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { validateHandoffJsonOutput } from "../handoff/handoffValidation.js";
import { deriveSocketOutputRequirements } from "../handoff/socketOutputRequirements.js";
import { parseSocketJson } from "../utilities/json.js";
import { HandoffExperimentObserver } from "./toolBackedHandoffExperimentMetrics.js";
import {
  cloneExperimentEnvelope,
  commonExperimentPayloadPrompt,
  directExperimentPrompt,
  directExperimentRecoveryPrompt,
  experimentPayloadHash,
  toolExperimentPrompt,
  toolExperimentRecoveryPrompt,
  TOOL_HANDOFF_EXPERIMENT_CASE_ID,
  TOOL_HANDOFF_EXPERIMENT_ENVELOPE,
  type ToolHandoffExperimentEnvelope,
} from "./toolBackedHandoffExperimentCase.js";
import {
  summarizeToolHandoffExperiment,
  type DirectExperimentOutcome,
  type DirectExperimentRun,
  type ToolBackedExperimentRun,
  type ToolExperimentOutcome,
  type ToolHandoffExperimentRun,
  type ToolHandoffProviderEvidence,
} from "./toolBackedHandoffExperimentReport.js";
import { createToolBackedHandoffPrototype, TOOL_BACKED_HANDOFF_NAMES } from "./toolBackedHandoffTools.js";
import type { ToolBackedHandoffCommit } from "./toolBackedHandoffSubmission.js";

export {
  TOOL_HANDOFF_EXPERIMENT_CASE_ID,
  TOOL_HANDOFF_EXPERIMENT_ENVELOPE,
} from "./toolBackedHandoffExperimentCase.js";
export { summarizeToolHandoffExperiment } from "./toolBackedHandoffExperimentReport.js";
export type { ToolHandoffExperimentEnvelope } from "./toolBackedHandoffExperimentCase.js";
export type {
  DirectExperimentOutcome,
  DirectExperimentRun,
  ToolBackedExperimentRun,
  ToolExperimentOutcome,
  ToolHandoffExperimentRun,
  ToolHandoffExperimentSummary,
  ToolHandoffProviderEvidence,
} from "./toolBackedHandoffExperimentReport.js";

export interface RunToolHandoffProviderExperimentOptions {
  provider: string;
  model: string;
  thinking?: ThinkingLevel;
  repetitions?: number;
  maxRecoveryPrompts?: number;
  cwd?: string;
  agentDir?: string;
  envelope?: ToolHandoffExperimentEnvelope;
}

interface ExperimentRuntime {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Model<Api>;
  cwd: string;
  agentDir: string;
  thinking: ThinkingLevel;
  maxRecoveryPrompts: number;
  envelope: ToolHandoffExperimentEnvelope;
  commonPayloadPrompt: string;
}

const EXPERIMENT_SOCKET_ID = "Tool-Handoff-Provider-Experiment";
const EXPERIMENT_REQUIREMENTS = deriveSocketOutputRequirements({
  socket: {
    parse: "json",
    assign: { workItems: "$.workItems" },
    edges: [{ when: "satisfied", to: "end" }],
  },
  socketId: EXPERIMENT_SOCKET_ID,
  workItemsProducer: true,
});

export async function runToolHandoffProviderExperiment(
  options: RunToolHandoffProviderExperimentOptions,
): Promise<ToolHandoffProviderEvidence> {
  const runtime = createExperimentRuntime(options);
  const repetitions = positiveInteger(options.repetitions ?? 3, "repetitions");
  const runs: ToolHandoffExperimentRun[] = [];

  // Alternate cohort order to avoid making every tool run pay the same warm/cold
  // provider-cache position. Each session itself remains isolated and in-memory.
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    if (repetition % 2 === 1) {
      runs.push(await runDirectExperiment(runtime, repetition));
      runs.push(await runToolExperiment(runtime, repetition));
    } else {
      runs.push(await runToolExperiment(runtime, repetition));
      runs.push(await runDirectExperiment(runtime, repetition));
    }
  }

  return {
    schemaVersion: 1,
    kind: "paired-pi-agent-session-provider-experiment",
    capturedAt: new Date().toISOString(),
    configuration: {
      caseId: TOOL_HANDOFF_EXPERIMENT_CASE_ID,
      semanticPayloadSha256: experimentPayloadHash(runtime.envelope),
      provider: runtime.model.provider,
      model: runtime.model.id,
      api: runtime.model.api,
      thinking: runtime.thinking,
      repetitions,
      maxRecoveryPrompts: runtime.maxRecoveryPrompts,
      transport: "sse",
      piAgentLoop: "createAgentSession",
      providerToolArgumentsObserved: "streamed toolcall_delta events before Pi schema validation",
      schemaValidation: "Pi validateToolArguments before tool execution",
      providerStrictSchemaGuarantee: false,
      costInterpretation: "provider-reported token value; subscription providers may not bill this amount per call",
    },
    runs,
    summary: summarizeToolHandoffExperiment(runs),
    limitations: [
      "This controlled sample measures one available model/provider and one escaping-heavy semantic payload; it is not a general tool-calling success rate.",
      "The selected provider receives tool schemas, but this experiment does not claim native strict/constrained JSON-schema decoding. Pi performs local validation after provider argument parsing.",
      "Raw argument syntax is observable only when the provider adapter emits complete toolcall_delta text. Calls without complete deltas are categorized as not_captured rather than assumed valid.",
      "Pi's provider adapter can repair some malformed JSON string controls or backslashes while assembling streamed arguments; malformedRawArguments reports the pre-validation streamed text, while schemaRejections reports the later local validation boundary.",
      "Tool-backed submission still depends on the model choosing tools, supplying semantically correct values, and committing. Missing/duplicate commit and weak or emulated tool support remain separate failure classes.",
      "Tool-backed runs normally require more provider turns than direct JSON because the narrow accumulator calls are intentionally sequential.",
    ],
  };
}

async function runDirectExperiment(runtime: ExperimentRuntime, repetition: number): Promise<DirectExperimentRun> {
  const observer = new HandoffExperimentObserver();
  const { session } = await createExperimentSession(runtime, observer, []);
  const startedAt = performance.now();
  let recoveryPrompts = 0;
  let latestText = "";
  let firstSubmissionOutcome: DirectExperimentOutcome = "empty_output";
  let eventualOutcome: DirectExperimentOutcome = "empty_output";

  try {
    await session.prompt(directExperimentPrompt(runtime.commonPayloadPrompt), promptOptions());
    latestText = lastAssistantText(session.messages);
    firstSubmissionOutcome = evaluateDirectOutput(latestText, session.messages, runtime.envelope);
    eventualOutcome = firstSubmissionOutcome;

    while (eventualOutcome !== "accepted" && recoveryPrompts < runtime.maxRecoveryPrompts) {
      recoveryPrompts += 1;
      await session.prompt(directExperimentRecoveryPrompt(eventualOutcome), promptOptions());
      latestText = lastAssistantText(session.messages);
      eventualOutcome = evaluateDirectOutput(latestText, session.messages, runtime.envelope);
    }
  } finally {
    session.dispose();
  }

  return {
    strategy: "direct_json",
    repetition,
    firstSubmissionOutcome,
    eventualOutcome,
    recoveryPrompts,
    providerTurns: observer.currentProviderTurn(),
    providerAutoRetries: observer.diagnostics(0).providerAutoRetries,
    latencyMs: Math.round(performance.now() - startedAt),
    usage: observer.measuredUsage(),
    bareJsonOnAcceptedSubmission: eventualOutcome === "accepted" && isBareJsonObject(latestText),
  };
}

async function runToolExperiment(runtime: ExperimentRuntime, repetition: number): Promise<ToolBackedExperimentRun> {
  const observer = new HandoffExperimentObserver(TOOL_BACKED_HANDOFF_NAMES.commit);
  let committed: ToolBackedHandoffCommit | undefined;
  let commitProviderTurn: number | null = null;
  const prototype = createToolBackedHandoffPrototype({
    socketId: EXPERIMENT_SOCKET_ID,
    requirements: EXPERIMENT_REQUIREMENTS,
    workItemsProducer: true,
    onCommit: (value) => {
      committed = value;
      commitProviderTurn = observer.currentProviderTurn();
    },
  });
  const tools = [
    prototype.tools.addWorkItem,
    prototype.tools.setSatisfied,
    prototype.tools.setContext,
    prototype.tools.commit,
  ];
  const { session } = await createExperimentSession(runtime, observer, tools);
  const startedAt = performance.now();
  let recoveryPrompts = 0;
  let missingCommit = 0;
  let firstPromptOutcome: ToolExperimentOutcome = "missing_commit";

  try {
    await session.prompt(toolExperimentPrompt(runtime.commonPayloadPrompt), promptOptions());
    firstPromptOutcome = toolOutcome(committed, session.messages, runtime.envelope);

    while (!committed && recoveryPrompts < runtime.maxRecoveryPrompts) {
      missingCommit += 1;
      recoveryPrompts += 1;
      await session.prompt(toolExperimentRecoveryPrompt(), promptOptions());
    }
    if (!committed) missingCommit += 1;
  } finally {
    session.dispose();
  }

  return {
    strategy: "tool_backed",
    repetition,
    firstPromptOutcome,
    firstProviderTurnCommitted: commitProviderTurn === 1,
    eventualOutcome: toolOutcome(committed, session.messages, runtime.envelope),
    recoveryPrompts,
    commitProviderTurn,
    providerTurns: observer.currentProviderTurn(),
    latencyMs: Math.round(performance.now() - startedAt),
    usage: observer.measuredUsage(),
    diagnostics: observer.diagnostics(missingCommit),
  };
}

async function createExperimentSession(
  runtime: ExperimentRuntime,
  observer: HandoffExperimentObserver,
  customTools: ReturnType<typeof createToolBackedHandoffPrototype>["tools"][keyof ReturnType<typeof createToolBackedHandoffPrototype>["tools"]][],
) {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    transport: "sse",
  });
  const toolNames = customTools.map((tool) => tool.name);
  const result = await createAgentSession({
    cwd: runtime.cwd,
    agentDir: runtime.agentDir,
    authStorage: runtime.authStorage,
    modelRegistry: runtime.modelRegistry,
    model: runtime.model,
    thinkingLevel: runtime.thinking,
    noTools: toolNames.length === 0 ? "all" : "builtin",
    ...(toolNames.length > 0 ? { tools: toolNames, customTools } : {}),
    resourceLoader: isolatedResourceLoader(),
    sessionManager: SessionManager.inMemory(runtime.cwd),
    settingsManager,
  });
  result.session.subscribe((event) => observer.observe(event));
  return result;
}

function createExperimentRuntime(options: RunToolHandoffProviderExperimentOptions): ExperimentRuntime {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const agentDir = path.resolve(options.agentDir ?? getAgentDir());
  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
  const model = modelRegistry.find(options.provider, options.model);
  if (!model) throw new Error(`Unknown experiment model ${options.provider}/${options.model}.`);
  if (!modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`No configured authentication for experiment model ${options.provider}/${options.model}.`);
  }
  const envelope = cloneExperimentEnvelope(options.envelope ?? TOOL_HANDOFF_EXPERIMENT_ENVELOPE);
  const maxRecoveryPrompts = nonNegativeInteger(options.maxRecoveryPrompts ?? 1, "maxRecoveryPrompts");
  return {
    authStorage,
    modelRegistry,
    model,
    cwd,
    agentDir,
    thinking: options.thinking ?? "minimal",
    maxRecoveryPrompts,
    envelope,
    commonPayloadPrompt: commonExperimentPayloadPrompt(envelope),
  };
}

function isolatedResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are running one isolated finalization-format experiment. Follow the requested output strategy exactly and copy supplied semantic values without editing them.",
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function evaluateDirectOutput(text: string, messages: readonly unknown[], expected: ToolHandoffExperimentEnvelope): DirectExperimentOutcome {
  const last = lastAssistantMessage(messages);
  if (last?.stopReason === "error") return "provider_error";
  if (!text.trim()) return "empty_output";
  let parsed: unknown;
  try {
    parsed = parseSocketJson<unknown>(EXPERIMENT_SOCKET_ID, text);
  } catch {
    return "json_syntax";
  }
  let validated: Record<string, unknown>;
  try {
    validated = validateHandoffJsonOutput(parsed, {
      socketId: EXPERIMENT_SOCKET_ID,
      requirements: EXPERIMENT_REQUIREMENTS,
      agentOutput: true,
      workItemsProducer: true,
    });
  } catch {
    return "contract_rejection";
  }
  return isDeepStrictEqual(validated, expected) ? "accepted" : "semantic_mismatch";
}

function toolOutcome(
  committed: ToolBackedHandoffCommit | undefined,
  messages: readonly unknown[],
  expected: ToolHandoffExperimentEnvelope,
): ToolExperimentOutcome {
  if (committed) return isDeepStrictEqual(committed.envelope, expected) ? "accepted" : "semantic_mismatch";
  return lastAssistantMessage(messages)?.stopReason === "error" ? "provider_error" : "missing_commit";
}

function lastAssistantText(messages: readonly unknown[]): string {
  const message = lastAssistantMessage(messages);
  return message?.content.map((part) => part.type === "text" ? part.text : "").join("\n").trim() ?? "";
}

function lastAssistantMessage(messages: readonly unknown[]): AssistantMessage | undefined {
  for (const value of [...messages].reverse()) {
    const message = value as Partial<AssistantMessage>;
    if (message.role === "assistant" && Array.isArray(message.content)) return message as AssistantMessage;
  }
  return undefined;
}

function isBareJsonObject(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function promptOptions() {
  return { expandPromptTemplates: false, source: "extension" as const };
}

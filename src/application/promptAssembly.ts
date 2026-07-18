import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import {
  formatEventEmissionContextText,
  formatHandoffContractDocText,
  formatHandoffJsonFinalInstruction,
  HANDOFF_WORK_ITEMS_FIELD,
} from "../handoff/handoffContract.js";
import { deriveSocketOutputRequirements } from "../handoff/socketOutputRequirements.js";
import { isToolBackedFinalizationActive } from "../runtime/finalizationStrategy.js";
import { AGENT_HANDOFF_TOOL_NAMES } from "../runtime/agentHandoffTools.js";
import { effectiveResolvedSocketConfig } from "../runtime/resolvedMateria.js";
import type { MateriaAgentConfig, MateriaCastState, MateriaJsonOutputValidationKind, ResolvedMateriaAgentSocket, ResolvedMateriaSocket } from "../types.js";
import { renderReworkFeedbackPromptContext } from "./reworkFeedback.js";
import { isMateriaDisplayNoise, stripEventSideChannelField, stripRenderableTextField } from "./handoffPromptSanitization.js";
import { currentItem, getPath, isPlainObject, readObjectField } from "./workflowTransitions.js";

// Central prompt assembly policy for the handoff contract:
// - synthetic cast context owns the shared handoff contract summary for JSON sockets in final-output mode;
// - socket-local prompt suffixes stay thin: JSON-only formatting, generated-output placement,
//   and multi-turn finalization/refinement behavior;
// - plain-text agent sockets receive no JSON-only handoff contract unless their local prompt asks for one.
export function buildSocketPrompt(state: MateriaCastState, socket: ResolvedMateriaSocket): string {
  if (!isAgentResolvedSocket(socket)) throw new Error(`Utility socket "${socket.id}" does not have an agent prompt.`);
  return materiaPrompt(socket.materia, state, [renderReworkFeedbackPromptContext(state, socket.id), socketAdapterContextInstruction(state, socket), multiTurnTurnInstruction(state, socket), singleTurnJsonFormatInstruction(socket, state)]);
}

export function buildMultiTurnFinalizationPrompt(state: MateriaCastState, socket: ResolvedMateriaSocket): string {
  if (!isAgentResolvedSocket(socket)) throw new Error(`Utility socket "${socket.id}" does not have an agent prompt.`);
  return materiaPrompt(socket.materia, state, [
    buildSyntheticCastContext(state),
    renderReworkFeedbackPromptContext(state, socket.id),
    socketAdapterContextInstruction(state, socket),
    "Command-triggered finalization: the user ran /materia continue for this multi-turn socket. This is the only finalization mechanism and this is the finalization turn.",
    finalFormatInstruction(socket, state),
  ]);
}

export function multiTurnTurnInstruction(state: MateriaCastState, socket: ResolvedMateriaSocket): string | undefined {
  if (!isMultiTurnResolvedAgentSocket(socket)) return undefined;
  return state.multiTurnFinalizing ? finalFormatInstruction(socket, state) : multiTurnRefinementGuidance();
}

export function multiTurnRefinementGuidance(): string {
  return "Current multi-turn mode: refinement conversation. /materia continue is the only way to finalize this multi-turn socket. Until the user runs /materia continue, respond conversationally, incorporate refinement feedback, and do not emit final JSON, final structured output, or other final machine-parseable output. If the refinement appears complete or the conversation is stalling, prompt the user to run /materia continue when they are ready for the final output.";
}

export function singleTurnJsonFormatInstruction(socket: ResolvedMateriaSocket, state?: MateriaCastState): string | undefined {
  if (!isAgentResolvedSocket(socket)) return undefined;
  if (socket.materia.multiTurn === true) return undefined;
  if (state && isToolBackedFinalizationActive(state, socket)) return toolBackedFinalizationInstruction();
  return jsonHandoffContractInstruction(socket);
}

export function jsonHandoffContractInstruction(socket: ResolvedMateriaSocket): string | undefined {
  if (!isAgentResolvedSocket(socket)) return undefined;
  if (effectiveResolvedSocketConfig(socket).parse !== "json") return undefined;
  const requirements = deriveSocketOutputRequirements({
    socket: effectiveResolvedSocketConfig(socket),
    socketId: socket.id,
    workItemsProducer: Boolean(canonicalGeneratorConfigFor(socket.materia)),
  });
  return formatHandoffJsonFinalInstruction(requirements);
}

export function finalFormatInstruction(socket: ResolvedMateriaSocket, state?: MateriaCastState): string {
  if (!isAgentResolvedSocket(socket)) return "";
  if (state && isToolBackedFinalizationActive(state, socket)) return toolBackedFinalizationInstruction();
  return jsonHandoffContractInstruction(socket) ?? "Final output format: return the final plain-text implementation summary for this socket. Do not emit routing JSON or evaluator control fields unless the local socket prompt explicitly asks for them.";
}

export function toolBackedFinalizationInstruction(): string {
  return [
    "Final output protocol: tool-backed materia handoff submission is active for this socket.",
    `Submit each applicable value with the active materia_handoff setter tools, then call ${AGENT_HANDOFF_TOOL_NAMES.commit} as the sole final tool call.`,
    "Do not emit the handoff as textual JSON, do not mix a textual envelope with tool submissions, and do not continue after commit. Runtime code validates and serializes the canonical envelope.",
  ].join("\n");
}

export interface JsonOutputRepairPromptInput {
  validationKind: MateriaJsonOutputValidationKind;
  errorMessage: string;
  validationIssues?: Array<{ path: string; message: string; expected?: string; reason?: string }>;
  invalidOutputExcerpt: string;
  originalFinalOutputInstructions: string;
}

export function buildJsonOutputRepairPrompt(input: JsonOutputRepairPromptInput): string {
  const label = input.validationKind === "json_parse" ? "JSON parse" : "socket JSON payload validation";
  return [
    `Your previous final JSON response was invalid (${label} failed). Regenerate the final response now.`,
    `Validation error: ${input.errorMessage}`,
    formatValidationIssuesForRepair(input.validationIssues),
    "Bounded excerpt of your invalid output:",
    "```text",
    input.invalidOutputExcerpt,
    "```",
    "Return only corrected JSON. Do not include markdown fences, prose, commentary, or explanations.",
    "Preserve the required final JSON-only output requirements for this socket:",
    input.originalFinalOutputInstructions,
  ].filter(Boolean).join("\n");
}

function formatValidationIssuesForRepair(issues: JsonOutputRepairPromptInput["validationIssues"]): string | undefined {
  if (!issues?.length) return undefined;
  return [
    "Structured validation issues for the current socket requirements:",
    ...issues.map((issue) => `- ${issue.path}: ${issue.message}${issue.reason ? ` (${issue.reason})` : ""}`),
  ].join("\n");
}

export function buildJsonOutputRepairRetryPrompt(state: MateriaCastState, socket: ResolvedMateriaSocket): string | undefined {
  if (!state.jsonOutputRepair || !isFinalJsonOutputSocket(state, socket)) return undefined;
  const contextState = { ...state, lastAssistantText: undefined, lastOutput: undefined };
  return materiaPrompt(socket.materia, state, [
    buildSyntheticCastContext(contextState),
    buildJsonOutputRepairPrompt({
      validationKind: state.jsonOutputRepair.validationKind,
      errorMessage: state.jsonOutputRepair.errorMessage,
      validationIssues: state.jsonOutputRepair.validationIssues,
      invalidOutputExcerpt: state.jsonOutputRepair.invalidOutputExcerpt,
      originalFinalOutputInstructions: finalFormatInstruction(socket, state),
    }),
  ]);
}

export function isFinalJsonOutputSocket(state: MateriaCastState, socket: ResolvedMateriaSocket): socket is ResolvedMateriaAgentSocket {
  if (!isAgentResolvedSocket(socket) || effectiveResolvedSocketConfig(socket).parse !== "json") return false;
  return !isMultiTurnResolvedAgentSocket(socket) || state.multiTurnFinalizing === true;
}

export function socketAdapterContextInstruction(state: MateriaCastState, socket: ResolvedMateriaSocket): string | undefined {
  if (!isAgentResolvedSocket(socket)) return undefined;
  if (effectiveResolvedSocketConfig(socket).parse === "json") return generatorJsonAdapterContextInstruction(state, socket);
  const workItem = currentItem(state) ?? getPath(state.data, "currentWorkItem") ?? getPath(state.data, "workItem");
  const guidance = getPath(state.data, "guidance") ?? {};
  return [
    "Socket adapter context: this placement supplies the current workItem and global guidance; the reusable materia should focus on its behavior, not graph placement, routing, assignment, or iteration.",
    formatCurrentWorkItemForPrompt(workItem, state.currentItemLabel),
    `Global guidance JSON: ${JSON.stringify(guidance ?? {}, null, 2)}`,
    "For text/build sockets, consume the current workItem title/context plus global guidance and return a concise implementation summary. The socket adapter will handle downstream state and graph flow.",
  ].join("\n");
}

export function formatCurrentWorkItemForPrompt(workItem: unknown, fallbackLabel?: string): string {
  if (!workItem) return "Current workItem: none";
  const titleValue = readObjectField(workItem, "title") ?? fallbackLabel;
  const contextValue = readObjectField(workItem, "context");
  const title = typeof titleValue === "string" && titleValue.trim() ? titleValue : "(untitled)";
  const context = typeof contextValue === "string" ? contextValue : "";
  return ["Current workItem:", `Title: ${title}`, "Context:", context].join("\n");
}

export function generatorJsonAdapterContextInstruction(state: MateriaCastState, socket: ResolvedMateriaAgentSocket): string | undefined {
  const generator = canonicalGeneratorConfigFor(socket.materia);
  if (!generator) return undefined;
  if (isMultiTurnResolvedAgentSocket(socket) && state.multiTurnFinalizing !== true) return undefined;
  const upstreamWorkItems = getPath(state.data, HANDOFF_WORK_ITEMS_FIELD);
  const toolBacked = isToolBackedFinalizationActive(state, socket);
  return [
    toolBacked
      ? "Generator socket adapter context: generated-output stage. Submit generated workItems through the active materia handoff tools; runtime code owns the JSON envelope."
      : "Generator socket adapter context: generated-output stage. Return JSON only and expose generated output as workItems.",
    `Generated output assignment: ${JSON.stringify(generator.output)} must come from $.${HANDOFF_WORK_ITEMS_FIELD}.`,
    toolBacked
      ? `Call ${AGENT_HANDOFF_TOOL_NAMES.addWorkItem} once per final work item in order; do not place generated units in textual JSON or other fields.`
      : `Emit top-level ${HANDOFF_WORK_ITEMS_FIELD} as an array of work-item objects; do not place generated units in other fields.`,
    "Each generated work item must contain only title:string and context:string; put all item-specific guidance in the workItem.context text string.",
    Array.isArray(upstreamWorkItems) ? `Upstream generated workItems JSON for this generator stage:\n${JSON.stringify(upstreamWorkItems, null, 2)}` : undefined,
    "If upstream workItems are present, consume them as input context and transform/refine them into a new top-level workItems array.",
  ].filter(Boolean).join("\n");
}

export function buildTimeoutRecoveryHint(state: MateriaCastState, recoveryKey: string): string | undefined {
  const reason = state.recoveryReasons?.[recoveryKey];
  if (reason !== "tool_timeout") return undefined;
  if (state.recoveryHintSuppressed) return undefined;
  const originalMessage = state.recoveryErrorMessages?.[recoveryKey] ?? "";
  const durationMatch = originalMessage.match(/timed?\s*out[^]*?(\d+)\s*(?:seconds?|secs?|s)/i);
  const durationHint = durationMatch ? ` after ${durationMatch[1]}s` : "";
  const attempt = state.recoveryAttempts?.[recoveryKey] ?? 0;
  const attemptHint = attempt > 0 ? ` (retry #${attempt})` : "";
  return [
    "⚠️ TIMEOUT RECOVERY HINT — READ THIS BEFORE PROCEEDING:",
    `The previous bash command timed out${durationHint}${attemptHint}. Do NOT repeat the same long-running or interactive command.`,
    "- Do not run interactive smoke tests, watch modes, or any command that waits for stdin or a prompt.",
    "- Use targeted, one-shot commands with explicit shorter timeouts (e.g. add timeout flags).",
    "- If you need to verify behavior, run individual test files or use --run flags instead of --watch.",
    "- If a previous command is still running, do not re-run it. Move on to the next step.",
  ].join("\n");
}

export function activeMateriaSystemPrompt(state: MateriaCastState, materia: MateriaAgentConfig): string {
  const socket = activeResolvedSocket(state);
  const suffixes = socket && isAgentResolvedSocket(socket) ? [renderReworkFeedbackPromptContext(state, socket.id), socketAdapterContextInstruction(state, socket), multiTurnTurnInstruction(state, socket), singleTurnJsonFormatInstruction(socket, state)] : [];
  return [renderTemplate(materia.prompt, state), ...suffixes].filter(Boolean).join("\n\n");
}

export function renderTemplate(template: string, state: MateriaCastState): string {
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_match, key: string) => stringifyTemplateValue(resolveTemplateValue(key, state)));
}

export function resolveTemplateValue(key: string, state: MateriaCastState): unknown {
  const trimmed = key.trim();
  if (trimmed === "request") return state.request;
  if (trimmed === "stateJson") return JSON.stringify(state.data, null, 2);
  if (trimmed === "itemJson") return JSON.stringify(currentItem(state), null, 2);
  if (trimmed === "lastOutput") return state.lastOutput ?? "";
  if (trimmed === "lastJson") return state.lastJson ?? "";
  if (trimmed.startsWith("state.")) return getPath(state.data, trimmed.slice("state.".length));
  if (trimmed.startsWith("cursor.")) return state.cursors[trimmed.slice("cursor.".length)];
  if (trimmed.startsWith("item.")) return getPath(currentItem(state), trimmed.slice("item.".length));
  if (trimmed.startsWith("lastJson.")) return getPath(state.lastJson, trimmed.slice("lastJson.".length));
  return getPath(state.data, trimmed);
}

export function buildIsolatedMateriaContext(messages: unknown[], state: MateriaCastState): unknown[] {
  if (!shouldUseIsolatedMateriaContext(state)) return messages;
  // Anchor on the active socket's own hidden materia prompt: match the latest
  // pi-materia-prompt custom message whose details.socketId and materiaName
  // agree with the current cast state. This excludes prior socket prompts that
  // also carry a <materia-instructions> block, which content-only discovery
  // cannot distinguish from the current socket's prompt.
  const materiaStart = findActiveMateriaPromptIndex(messages, {
    socketId: currentSocketId(state),
    materiaName: state.currentMateria,
  });
  if (materiaStart < 0) return messages;
  // Drop pi-materia orchestration-only custom messages (visible "◆ Materia" /
  // "Casting <name>" transition cards, quest runner status cards, and anything
  // tagged details.orchestration/prefix/eventType) that the runtime emits around
  // the hidden pi-materia-prompt. They are user-facing display only and must
  // never become agent context. The hidden pi-materia-prompt itself,
  // assistant/tool/toolResult turns, and genuine user refinement messages are
  // preserved because they are not display-only orchestration custom messages.
  const preserved = messages.slice(materiaStart).filter((message) => !isOrchestrationOnlyMessage(message));
  return [createUserMessage(buildSyntheticCastContext(state)), ...preserved];
}

export function shouldUseIsolatedMateriaContext(state: MateriaCastState): boolean {
  return state.active && (state.awaitingResponse || isPausedMultiTurnRefinement(state));
}

export function isPausedMultiTurnRefinement(state: MateriaCastState): boolean {
  return !state.awaitingResponse && currentSocketState(state) === "awaiting_user_refinement" && isActiveMultiTurnSocket(state);
}

export function isActiveMultiTurnSocket(state: MateriaCastState): boolean {
  if (!state.active) return false;
  const socket = activeResolvedSocket(state);
  return Boolean(socket && isMultiTurnResolvedAgentSocket(socket));
}

export function buildSyntheticCastContext(state: MateriaCastState): string {
  const previousOutput = sanitizePreviousOutput(state);
  const activeMultiTurn = isActiveMultiTurnSocket(state);
  const multiTurnRefining = activeMultiTurn && state.multiTurnFinalizing !== true;
  const mode = activeMultiTurn
    ? `multi-turn refinement (${state.multiTurnFinalizing === true ? "/materia continue finalization" : currentSocketState(state) === "awaiting_user_refinement" ? "awaiting user refinement or /materia continue" : currentSocketState(state) ?? "active"})`
    : currentSocketState(state) ?? "active";
  return [
    "Materia isolated context.",
    "Use only this cast context, the current materia prompt, and any tool results from this materia turn. Do not rely on unrelated earlier visible transcript messages.",
    multiTurnRefining ? multiTurnRefinementGuidance() : undefined,
    syntheticHandoffContractContext(state),
    syntheticEventEmissionContext(state),
    "",
    `Cast id: ${state.castId}`,
    `Original request: ${state.request}`,
    `Current socket: ${currentSocketId(state) ?? "-"}`,
    `Current materia: ${state.currentMateria ?? "-"}`,
    `Current item: ${state.currentItemLabel ?? "-"}`,
    `Mode: ${mode}`,
    `Effective model: ${state.currentMateriaModel?.label ?? "active Pi model"}`,
    `Effective thinking: ${state.currentMateriaModel?.thinking ?? "active Pi thinking"}`,
    `Artifact directory: ${state.runDir}`,
    "",
    "Generic cast data:",
    JSON.stringify(state.data, null, 2),
    "",
    previousOutput ? `Previous output:\n${previousOutput}` : undefined,
  ].filter(Boolean).join("\n");
}

/**
 * Returns the previous socket's output for the automatic "Previous output"
 * prompt section, with unassigned renderable text sanitized out.
 *
 * JSON sockets store their authoritative parsed payload in `state.lastJson`
 * and a matching re-stringified copy in `lastOutput`/`lastAssistantText`
 * (with the `event` side-channel already stripped). When those agree, the
 * previous output is canonical JSON handoff and we defensively strip the
 * `event` side-channel and the renderable `text` payload from the parsed form
 * so only intentional fields reach following materia — prose flows only
 * through explicit assignment (e.g. `assign: { "prNotes": "$.text" }`) or
 * templating, and event side-channel data never leaks as default context.
 * The authoritative raw JSON stays in `state.lastJson` and the `lastJson`
 * artifact for debugging and replay; this helper only affects the displayed
 * previous-output context.
 *
 * Display-card/banner strings that leak from the runtime UI into
 * `lastAssistantText`/`lastOutput` (e.g. "Casting **X**", "◆ Materia: ...",
 * or prompt-banner eventType text) are suppressed entirely: they are
 * orchestration-only and must never become agent input.
 *
 * Free-text (parse:"text") outputs never match a parsed `lastJson`, so they
 * are passed through unchanged (unless they are display noise). Returns
 * undefined when there is no previous output, the output is display noise, or
 * the previous JSON output carried only a renderable `text` payload, so no
 * empty/noisy section is emitted.
 */
export function sanitizePreviousOutput(state: MateriaCastState): string | undefined {
  const latestOutput = state.lastAssistantText ?? state.lastOutput;
  if (typeof latestOutput !== "string" || latestOutput.length === 0) return undefined;
  // Suppress orchestration-only display cards/banner strings leaked from the
  // runtime UI so they cannot become agent input via previous output.
  if (isMateriaDisplayNoise(latestOutput)) return undefined;
  const lastJson = state.lastJson;
  if (!isPlainObject(lastJson)) return latestOutput;
  // Defensively strip the event side-channel. The runtime normally strips
  // event before storing lastJson and re-stringifying lastOutput, but this
  // guarantees event data never reaches downstream prompts via this path even
  // for stale/unexpected payloads. Returns the same reference when there is
  // no event field.
  const eventStripped = stripEventSideChannelField(lastJson);
  // Identify canonical JSON handoff via agreement between the parsed form and
  // the raw output. JSON sockets set both to the same compact re-stringified
  // payload on completion, so agreement reliably identifies canonical JSON
  // handoff without touching free-text (parse:"text") outputs, which never
  // pair lastJson with their own raw text this way. Accept agreement against
  // either the event-stripped form (normal) or the raw event-bearing form
  // (defensive), then re-emit with event + renderable text stripped.
  const agreesClean = JSON.stringify(eventStripped) === latestOutput;
  const agreesRawWithEvent = eventStripped !== lastJson && JSON.stringify(lastJson) === latestOutput;
  if (agreesClean || agreesRawWithEvent) {
    return stripRenderableTextField(eventStripped);
  }
  return latestOutput;
}

export function syntheticHandoffContractContext(state: MateriaCastState): string | undefined {
  const socket = activeResolvedSocket(state);
  if (!socket || !isAgentResolvedSocket(socket) || effectiveResolvedSocketConfig(socket).parse !== "json") return undefined;

  const activeMultiTurn = isActiveMultiTurnSocket(state);
  if (activeMultiTurn && state.multiTurnFinalizing !== true) return undefined;
  if (isToolBackedFinalizationActive(state, socket)) {
    return [
      "Canonical handoff contract context:",
      "The active materia_handoff tools expose only fields consumed by this socket. Submit exact semantic values through those tools and finish with materia_handoff_commit; runtime validation remains authoritative.",
    ].join("\n\n");
  }

  const requirements = deriveSocketOutputRequirements({
    socket: effectiveResolvedSocketConfig(socket),
    socketId: socket.id,
    workItemsProducer: Boolean(canonicalGeneratorConfigFor(socket.materia)),
  });
  const exposureMode = activeMultiTurn ? "/materia continue finalization" : "single-turn JSON sockets";
  return [
    "Canonical handoff contract context:",
    `Synthetic context exposure policy: include this concise contract summary only for ${exposureMode} that are already expected to produce final JSON. Do not expose it during multi-turn refinement; refinement turns must remain conversational until /materia continue. The authoritative final-output instructions are still injected separately by prompt assembly.`,
    formatHandoffContractDocText({ renderableTextIntent: requirements.renderableTextIntent }),
  ].join("\n\n");
}

/**
 * Returns concise event emission instructions for JSON-output agent sockets.
 *
 * Per docs/runtime-eventing.md §11, this is injected into synthetic cast
 * context to teach JSON-output materia how to emit optional `event` arrays.
 * Text sockets are never shown this context since they cannot produce JSON.
 * Field references are scoped to the active socket's renderable-text intent,
 * so non-text sockets (planner/evaluator/maintainer/chain-context) never see
 * `text` in the event side-channel wording.
 */
export function syntheticEventEmissionContext(state: MateriaCastState): string | undefined {
  const socket = activeResolvedSocket(state);
  if (!socket || !isAgentResolvedSocket(socket) || effectiveResolvedSocketConfig(socket).parse !== "json") return undefined;

  const activeMultiTurn = isActiveMultiTurnSocket(state);
  if (activeMultiTurn && state.multiTurnFinalizing !== true) return undefined;
  if (isToolBackedFinalizationActive(state, socket)) {
    return `Optional event side-channel data must be submitted one event at a time with ${AGENT_HANDOFF_TOOL_NAMES.emitEvent} when that tool is active; do not author an event JSON array.`;
  }

  const requirements = deriveSocketOutputRequirements({
    socket: effectiveResolvedSocketConfig(socket),
    socketId: socket.id,
    workItemsProducer: Boolean(canonicalGeneratorConfigFor(socket.materia)),
  });
  return formatEventEmissionContextText({ renderableTextIntent: requirements.renderableTextIntent });
}

/** Active socket identity used to anchor prompt discovery on the current turn. */
export interface ActiveMateriaPromptLookup {
  /** Current socket id. When set, only prompts with a matching details.socketId are preferred. */
  socketId?: string;
  /** Current materia name. When set, only prompts with a matching details.materiaName are preferred. */
  materiaName?: string;
}

interface MateriaPromptCandidate {
  socketId?: string;
  materiaName?: string;
  hasMetadata: boolean;
}

/**
 * Locate the active socket's hidden materia prompt so buildIsolatedMateriaContext
 * can anchor isolated agent context on it.
 *
 * Discovery prefers metadata-aware matching for the active socket: the latest
 * pi-materia-prompt custom message whose details.socketId and materiaName match
 * the current cast state. This excludes prior socket prompts even when they too
 * contain a <materia-instructions> block, which content-only discovery cannot
 * distinguish. When a socket-anchored lookup is requested but only a prior
 * socket's prompt is present, no content fallback occurs: the prior prompt is
 * excluded rather than leaked, and the caller returns the transcript unchanged.
 *
 * The defensive content-only fallback is reached only when metadata cannot
 * anchor discovery — either the lookup carries no socket id/materia name, or no
 * candidate pi-materia-prompt message carries socket/materia details at all
 * (older runtime versions, tests, mocks). In that case the latest message that
 * contains a <materia-instructions> block is selected, preserving prior behavior.
 */
export function findActiveMateriaPromptIndex(messages: unknown[], lookup?: ActiveMateriaPromptLookup): number {
  const hasLookupCriteria = Boolean(lookup && (lookup.socketId || lookup.materiaName));
  let sawPromptWithMetadata = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = readMateriaPromptCandidate(messages[i]);
    if (!candidate) continue;
    if (candidate.hasMetadata) sawPromptWithMetadata = true;
    if (hasLookupCriteria && materiaPromptCandidateMatches(candidate, lookup!)) return i;
  }

  // A socket-anchored lookup was requested and at least one prompt carried
  // socket/materia metadata, yet none matched the active socket. Do not fall
  // back to content-only discovery: that could surface a prior socket's prompt.
  if (hasLookupCriteria && sawPromptWithMetadata) return -1;

  // Defensive fallback: metadata cannot anchor discovery (no lookup criteria, or
  // no candidate carries socket/materia details). Fall back to content-only
  // discovery of the latest <materia-instructions> block.
  return findContentAnchoredPromptIndex(messages);
}

/** Reads the socket/materia metadata (if any) from a pi-materia-prompt message. */
function readMateriaPromptCandidate(message: unknown): MateriaPromptCandidate | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as { customType?: unknown; details?: unknown };
  if (record.customType !== "pi-materia-prompt") return undefined;
  const details = typeof record.details === "object" && record.details !== null ? (record.details as Record<string, unknown>) : {};
  const socketId = typeof details.socketId === "string" ? details.socketId : undefined;
  const materiaName = typeof details.materiaName === "string" ? details.materiaName : undefined;
  return { socketId, materiaName, hasMetadata: socketId !== undefined || materiaName !== undefined };
}

/** A candidate matches when it carries metadata that agrees with the lookup. */
function materiaPromptCandidateMatches(candidate: MateriaPromptCandidate, lookup: ActiveMateriaPromptLookup): boolean {
  if (!candidate.hasMetadata) return false;
  if (lookup.socketId !== undefined && candidate.socketId !== lookup.socketId) return false;
  if (lookup.materiaName !== undefined && candidate.materiaName !== lookup.materiaName) return false;
  return true;
}

function findContentAnchoredPromptIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { content?: unknown; role?: unknown };
    if (isToolOrAssistantMessage(message)) continue;
    const text = messageContentText(message.content);
    if (text.includes("<materia-instructions>") && text.includes("</materia-instructions>")) return i;
  }
  return -1;
}

export function isToolOrAssistantMessage(message: { role?: unknown }): boolean {
  return message.role === "assistant" || message.role === "tool" || message.role === "toolResult";
}

/**
 * Detects pi-materia orchestration-only custom messages that must never become
 * agent context. Visible during-cast transition/status cards and quest runner
 * lifecycle cards (plus any card explicitly flagged orchestration) are
 * user-facing display only; they carry no agent input and are filtered from
 * isolated materia context even when the runtime appends them after the hidden
 * pi-materia-prompt. A message is orchestration-only when it is `role: "custom"`
 * and its details carry `orchestration === true`, `prefix === "materia"`,
 * `prefix === "quest"`, or `eventType === "materia_prompt"`. The hidden
 * pi-materia-prompt carries none of these signatures, so it is always preserved.
 * Only `role: "custom"` messages are considered, so the materia prompt,
 * assistant/tool/toolResult turns, and ordinary user refinement messages are
 * always preserved. See sendMateriaTurn in src/runtime/agentPromptDispatch.ts
 * (prefix "materia" / eventType "materia_prompt" transition cards) and
 * sendQuestMessage in src/index.ts (prefix "quest" lifecycle cards).
 */
export function isOrchestrationOnlyMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const record = message as { role?: unknown; details?: unknown };
  if (record.role !== "custom") return false;
  const details = record.details;
  if (typeof details !== "object" || details === null) return false;
  const detailRecord = details as { orchestration?: unknown; prefix?: unknown; eventType?: unknown };
  if (detailRecord.orchestration === true) return true;
  // Defense-in-depth: transition/status cards are orchestration display messages
  // even when the explicit flag is missing. During casts the runtime emits a
  // visible "◆ Materia" / "Casting <name>" card (prefix "materia", eventType
  // "materia_prompt") right before the hidden pi-materia-prompt, and the quest
  // runner emits prefix "quest" lifecycle cards. The hidden pi-materia-prompt
  // itself carries none of these signatures (no orchestration/prefix/eventType
  // in its details), so it is always preserved as agent context. Only
  // role:"custom" messages are considered, so user/assistant/tool/toolResult
  // turns and ordinary user refinement messages are never filtered.
  if (detailRecord.prefix === "materia" || detailRecord.prefix === "quest") return true;
  return detailRecord.eventType === "materia_prompt";
}

export function createUserMessage(content: string): unknown {
  return { role: "user", content, timestamp: Date.now() };
}

export function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const value = part as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).join("\n");
}

export function materiaPrompt(materia: MateriaAgentConfig, state: MateriaCastState, sections: (string | undefined)[]): string {
  return ["<materia-instructions>", renderTemplate(materia.prompt, state), "</materia-instructions>", ...sections.filter(Boolean)].join("\n\n");
}

export function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function activeResolvedSocket(state: MateriaCastState): ResolvedMateriaSocket | undefined {
  const socketId = currentSocketId(state);
  return socketId ? resolvedPipelineSockets(state)[socketId] : undefined;
}

export function resolvedSocketConfig<TSocket extends ResolvedMateriaSocket>(socket: TSocket): TSocket["socket"] {
  return socket.socket;
}

export function isAgentResolvedSocket(socket: ResolvedMateriaSocket): socket is ResolvedMateriaAgentSocket {
  return "prompt" in socket.materia;
}

export function isMultiTurnResolvedAgentSocket(socket: ResolvedMateriaSocket): socket is ResolvedMateriaAgentSocket {
  return isAgentResolvedSocket(socket) && socket.materia.multiTurn === true;
}

export function currentSocketId(state: MateriaCastState): string | undefined {
  return state.currentSocketId;
}

export function currentSocketState(state: MateriaCastState): MateriaCastState["socketState"] {
  return state.socketState;
}

export function resolvedPipelineSockets(state: MateriaCastState): Record<string, ResolvedMateriaSocket> {
  return state.pipeline.sockets ?? {};
}

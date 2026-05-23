import { canonicalGeneratorConfigFor } from "../graph/generator.js";
import {
  HANDOFF_CONTRACT_DOC_TEXT,
  formatHandoffJsonFinalInstruction,
  HANDOFF_WORK_ITEMS_FIELD,
} from "../handoff/handoffContract.js";
import { deriveSocketOutputRequirements } from "../handoff/socketOutputRequirements.js";
import type { MateriaAgentConfig, MateriaCastState, MateriaJsonOutputValidationKind, ResolvedMateriaAgentSocket, ResolvedMateriaSocket } from "../types.js";
import { currentItem, getPath } from "./workflowTransitions.js";

// Central prompt assembly policy for the handoff contract:
// - synthetic cast context owns the shared handoff contract summary for JSON sockets in final-output mode;
// - socket-local prompt suffixes stay thin: JSON-only formatting, generated-output placement,
//   and multi-turn finalization/refinement behavior;
// - plain-text agent sockets receive no JSON-only handoff contract unless their local prompt asks for one.
export function buildSocketPrompt(state: MateriaCastState, socket: ResolvedMateriaSocket): string {
  if (!isAgentResolvedSocket(socket)) throw new Error(`Utility socket "${socket.id}" does not have an agent prompt.`);
  return materiaPrompt(socket.materia, state, [socketAdapterContextInstruction(state, socket), multiTurnTurnInstruction(state, socket), singleTurnJsonFormatInstruction(socket)]);
}

export function buildMultiTurnFinalizationPrompt(state: MateriaCastState, socket: ResolvedMateriaSocket): string {
  if (!isAgentResolvedSocket(socket)) throw new Error(`Utility socket "${socket.id}" does not have an agent prompt.`);
  return materiaPrompt(socket.materia, state, [
    buildSyntheticCastContext(state),
    socketAdapterContextInstruction(state, socket),
    "Command-triggered finalization: the user ran /materia continue for this multi-turn socket. This is the only finalization mechanism and this is the finalization turn.",
    finalFormatInstruction(socket),
  ]);
}

export function multiTurnTurnInstruction(state: MateriaCastState, socket: ResolvedMateriaSocket): string | undefined {
  if (!isMultiTurnResolvedAgentSocket(socket)) return undefined;
  return state.multiTurnFinalizing ? finalFormatInstruction(socket) : multiTurnRefinementGuidance();
}

export function multiTurnRefinementGuidance(): string {
  return "Current multi-turn mode: refinement conversation. /materia continue is the only way to finalize this multi-turn socket. Until the user runs /materia continue, respond conversationally, incorporate refinement feedback, and do not emit final JSON, final structured output, or other final machine-parseable output. If the refinement appears complete or the conversation is stalling, prompt the user to run /materia continue when they are ready for the final output.";
}

export function singleTurnJsonFormatInstruction(socket: ResolvedMateriaSocket): string | undefined {
  if (!isAgentResolvedSocket(socket)) return undefined;
  if (socket.materia.multiTurn === true) return undefined;
  return jsonHandoffContractInstruction(socket);
}

export function jsonHandoffContractInstruction(socket: ResolvedMateriaSocket): string | undefined {
  if (!isAgentResolvedSocket(socket)) return undefined;
  if (resolvedSocketConfig(socket).parse !== "json") return undefined;
  const requirements = deriveSocketOutputRequirements({
    socket: resolvedSocketConfig(socket),
    socketId: socket.id,
    workItemsProducer: Boolean(canonicalGeneratorConfigFor(socket.materia)),
  });
  return formatHandoffJsonFinalInstruction(requirements);
}

export function finalFormatInstruction(socket: ResolvedMateriaSocket): string {
  if (!isAgentResolvedSocket(socket)) return "";
  return jsonHandoffContractInstruction(socket) ?? "Final output format: return the final plain-text implementation summary for this socket. Do not emit routing JSON or evaluator control fields unless the local socket prompt explicitly asks for them.";
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
      originalFinalOutputInstructions: finalFormatInstruction(socket),
    }),
  ]);
}

export function isFinalJsonOutputSocket(state: MateriaCastState, socket: ResolvedMateriaSocket): socket is ResolvedMateriaAgentSocket {
  if (!isAgentResolvedSocket(socket) || resolvedSocketConfig(socket).parse !== "json") return false;
  return !isMultiTurnResolvedAgentSocket(socket) || state.multiTurnFinalizing === true;
}

export function socketAdapterContextInstruction(state: MateriaCastState, socket: ResolvedMateriaSocket): string | undefined {
  if (!isAgentResolvedSocket(socket)) return undefined;
  if (resolvedSocketConfig(socket).parse === "json") return generatorJsonAdapterContextInstruction(state, socket);
  const workItem = currentItem(state) ?? getPath(state.data, "currentWorkItem") ?? getPath(state.data, "workItem");
  const guidance = getPath(state.data, "guidance") ?? {};
  return [
    "Socket adapter context: this placement supplies the current workItem and global guidance; the reusable materia should focus on its behavior, not graph placement, routing, assignment, or iteration.",
    `Current workItem JSON: ${JSON.stringify(workItem ?? null, null, 2)}`,
    `Global guidance JSON: ${JSON.stringify(guidance ?? {}, null, 2)}`,
    "For text/build sockets, consume the current workItem plus global guidance and return a concise implementation summary. The socket adapter will handle downstream state and graph flow.",
  ].join("\n");
}

export function generatorJsonAdapterContextInstruction(state: MateriaCastState, socket: ResolvedMateriaAgentSocket): string | undefined {
  const generator = canonicalGeneratorConfigFor(socket.materia);
  if (!generator) return undefined;
  if (isMultiTurnResolvedAgentSocket(socket) && state.multiTurnFinalizing !== true) return undefined;
  const upstreamWorkItems = getPath(state.data, HANDOFF_WORK_ITEMS_FIELD);
  return [
    "Generator socket adapter context: generated-output stage. Return JSON only and expose generated output as workItems.",
    `Generated output assignment: ${JSON.stringify(generator.output)} must come from $.${HANDOFF_WORK_ITEMS_FIELD}.`,
    `Emit top-level ${HANDOFF_WORK_ITEMS_FIELD} as an array of work-item objects; do not place generated units in other fields.`,
    Array.isArray(upstreamWorkItems) ? `Upstream generated workItems JSON for this generator stage:\n${JSON.stringify(upstreamWorkItems, null, 2)}` : undefined,
    "If upstream workItems are present, consume them as input context and transform/refine them into a new top-level workItems array.",
  ].filter(Boolean).join("\n");
}

export function activeMateriaSystemPrompt(state: MateriaCastState, materia: MateriaAgentConfig): string {
  const socket = activeResolvedSocket(state);
  const suffixes = socket && isAgentResolvedSocket(socket) ? [socketAdapterContextInstruction(state, socket), multiTurnTurnInstruction(state, socket), singleTurnJsonFormatInstruction(socket)] : [];
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
  const materiaStart = findActiveMateriaPromptIndex(messages);
  if (materiaStart < 0) return messages;
  return [createUserMessage(buildSyntheticCastContext(state)), ...messages.slice(materiaStart)];
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
  const latestOutput = state.lastAssistantText ?? state.lastOutput;
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
    latestOutput ? `Previous output:\n${latestOutput}` : undefined,
  ].filter(Boolean).join("\n");
}

export function syntheticHandoffContractContext(state: MateriaCastState): string | undefined {
  const socket = activeResolvedSocket(state);
  if (!socket || !isAgentResolvedSocket(socket) || resolvedSocketConfig(socket).parse !== "json") return undefined;

  const activeMultiTurn = isActiveMultiTurnSocket(state);
  if (activeMultiTurn && state.multiTurnFinalizing !== true) return undefined;

  const exposureMode = activeMultiTurn ? "/materia continue finalization" : "single-turn JSON sockets";
  return [
    "Canonical handoff contract context:",
    `Synthetic context exposure policy: include this concise contract summary only for ${exposureMode} that are already expected to produce final JSON. Do not expose it during multi-turn refinement; refinement turns must remain conversational until /materia continue. The authoritative final-output instructions are still injected separately by prompt assembly.`,
    HANDOFF_CONTRACT_DOC_TEXT,
  ].join("\n\n");
}

export function findActiveMateriaPromptIndex(messages: unknown[]): number {
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

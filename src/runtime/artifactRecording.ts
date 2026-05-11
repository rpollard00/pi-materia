import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildSyntheticCastContext } from "../application/promptAssembly.js";
import { recordNodeOutput, recordNodeRefinement, writeContextArtifact as writeContextArtifactFile } from "../infrastructure/castArtifacts.js";
import type { MateriaCastState, ResolvedMateriaSocket } from "../types.js";
import { formatModelSource, formatThinkingSource } from "./modelSelection.js";
import { currentRefinementTurn, currentSocketId, currentSocketVisit, isMultiTurnResolvedAgentSocket, nextRefinementTurn, socketMateriaName, socketVisit } from "./sessionState.js";

export async function recordSocketOutput(state: MateriaCastState, socket: ResolvedMateriaSocket, text: string, entryId: string): Promise<string> {
  const finalizedRefinement = isMultiTurnResolvedAgentSocket(socket);
  return recordNodeOutput({ state, socketId: socket.id, materia: socketMateriaName(socket), visit: socketVisit(state, socket.id), text, entryId, kind: "node_output", finalized: finalizedRefinement || undefined, refinementTurn: finalizedRefinement ? currentRefinementTurn(state, socket.id) : undefined, materiaModel: state.currentMateriaModel });
}

export async function recordMultiTurnRefinement(state: MateriaCastState, socket: ResolvedMateriaSocket, text: string, entryId: string): Promise<{ artifact: string; turn: number }> {
  const turn = nextRefinementTurn(state, socket.id);
  const artifact = await recordNodeRefinement({ state, socketId: socket.id, materia: socketMateriaName(socket), visit: socketVisit(state, socket.id), text, entryId, kind: "node_refinement", refinementTurn: turn, materiaModel: state.currentMateriaModel });
  return { artifact, turn };
}

export async function writeContextArtifact(pi: ExtensionAPI, state: MateriaCastState, prompt: string, suffix?: string): Promise<string> {
  const materiaModel = state.currentMateriaModel;
  return writeContextArtifactFile({
    state,
    prompt,
    suffix,
    syntheticContext: buildSyntheticCastContext(state),
    activeTools: pi.getActiveTools(),
    socketId: currentSocketId(state),
    visit: currentSocketVisit(state, 1),
    model: materiaModel?.label ?? "active Pi model",
    modelSource: formatModelSource(materiaModel),
    thinking: materiaModel?.thinking ?? (materiaModel?.thinkingExplicit ? materiaModel.requestedThinking : undefined) ?? "active Pi thinking",
    thinkingSource: formatThinkingSource(materiaModel),
  });
}

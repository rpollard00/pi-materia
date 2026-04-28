import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { MateriaRunState } from "./types.js";

export function updateWidget(ctx: ExtensionCommandContext, state: MateriaRunState): void {
  const elapsed = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
  ctx.ui.setWidget("materia", [
    `Materia Cast ${state.runId}`,
    `node: ${state.currentNode ?? "-"}`,
    `role: ${state.currentRole ?? "-"}`,
    `task: ${state.currentTask ?? "-"}`,
    `attempt: ${state.attempt ?? "-"}`,
    `elapsed: ${elapsed}s`,
    `tokens: ${state.usage.tokens.total}`,
    `cost: $${state.usage.cost.total.toFixed(4)}`,
    `last: ${state.lastMessage ?? "-"}`,
  ], { placement: "belowEditor" });
}

import type { Quest, QuestBoard } from "../domain/questBoard.js";
import type { QuestStatusSnapshot, QuestStartResult } from "../application/useCases.js";

export function renderQuestStatus(snapshot: QuestStatusSnapshot): string[] {
  const board = snapshot.board;
  const activeQuest = snapshot.activeQuest;
  const lines = [
    "pi-materia quest board",
    `Storage: ${snapshot.boardPath}`,
    `Runner: ${board.runner.enabled ? "enabled" : "stopped"}${board.runner.activeQuestId ? ` (active ${board.runner.activeQuestId})` : ""}`,
    `Quests: ${board.quests.length} total, ${snapshot.pendingCount} pending`,
  ];

  if (snapshot.activeCast?.active) lines.push(`Active cast: ${snapshot.activeCast.castId} (${snapshot.activeCast.phase})`);
  if (activeQuest) lines.push(`Active quest: ${formatQuestSummary(activeQuest)}`);
  else lines.push("Active quest: none");

  const recent = recentFinishedQuests(board, 5);
  if (recent.length > 0) {
    lines.push("Recent results:");
    for (const quest of recent) lines.push(`- ${formatQuestSummary(quest)}${quest.lastResult?.finishedAt ? ` at ${quest.lastResult.finishedAt}` : ""}`);
  } else {
    lines.push("Recent results: none");
  }

  lines.push("Commands: /materia quest add [--loadout <name>] <prompt> | run [id] | runonce [id] | start [id] | stop | status");
  lines.push("Run: run enables continuous back-to-back processing; runonce launches one pending quest only; start is a compatibility alias for run.");
  lines.push("Stop: stop disables future auto-advance without aborting the active cast.");
  return lines;
}

export function renderQuestAdded(quest: Quest, boardPath: string): string[] {
  return [
    `Added quest ${quest.id}: ${quest.title}`,
    `Status: ${quest.status}`,
    ...(quest.loadoutOverride ? [`Loadout override: ${quest.loadoutOverride}`] : []),
    `Storage: ${boardPath}`,
  ];
}

export type QuestStartRenderMode = "run" | "runonce" | "start" | "auto-advance";

export function renderQuestStarted(result: QuestStartResult, mode: QuestStartRenderMode): string[] {
  const action = questStartAction(mode);
  return [
    `${action} quest ${result.quest.id}: ${result.quest.title}`,
    `Cast: ${result.state.castId}`,
    `Runner: ${result.board.runner.enabled ? "enabled" : "stopped"}`,
    `Mode: ${questStartModeDescription(mode)}`,
    ...(result.effectiveLoadout ? [`Loadout: ${result.effectiveLoadout.effectiveLoadoutName}${result.effectiveLoadout.effectiveLoadoutId ? ` (${result.effectiveLoadout.effectiveLoadoutId})` : ""}`] : []),
  ];
}

function questStartAction(mode: QuestStartRenderMode): string {
  if (mode === "runonce") return "Launched";
  if (mode === "start") return "Started continuous quest runner (start alias) and launched";
  if (mode === "auto-advance") return "Auto-advanced continuous quest runner and launched";
  return "Started continuous quest runner and launched";
}

function questStartModeDescription(mode: QuestStartRenderMode): string {
  if (mode === "runonce") return "one-shot runonce; runner state unchanged";
  if (mode === "start") return "continuous run via start compatibility alias; auto-advances while enabled";
  if (mode === "auto-advance") return "continuous auto-advance; use /materia quest stop to prevent future launches";
  return "continuous run; auto-advances while enabled until /materia quest stop";
}

export function renderQuestStopped(board: QuestBoard): string[] {
  return [
    "Quest runner stopped. Active casts are not aborted; use /materia abort if needed.",
    `Runner: ${board.runner.enabled ? "enabled" : "stopped"}`,
    `Pending: ${board.quests.filter((quest) => quest.status === "pending").length}`,
  ];
}

function recentFinishedQuests(board: QuestBoard, limit: number): Quest[] {
  return board.quests
    .filter((quest) => quest.status === "succeeded" || quest.status === "failed" || quest.status === "blocked")
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

function formatQuestSummary(quest: Quest): string {
  const cast = quest.currentCastId ?? quest.lastCastId;
  return `${quest.id} [${quest.status}] ${quest.title}${cast ? ` (cast ${cast})` : ""}`;
}

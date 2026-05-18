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

  lines.push("Help: /materia quest add [--loadout <name>] <prompt> | run [id] | start [id] | stop | status");
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

export function renderQuestStarted(result: QuestStartResult, mode: "run" | "start"): string[] {
  return [
    `${mode === "start" ? "Started quest runner and launched" : "Launched"} quest ${result.quest.id}: ${result.quest.title}`,
    `Cast: ${result.state.castId}`,
    `Runner: ${result.board.runner.enabled ? "enabled" : "stopped"}`,
    ...(result.effectiveLoadout ? [`Loadout: ${result.effectiveLoadout.effectiveLoadoutName}${result.effectiveLoadout.effectiveLoadoutId ? ` (${result.effectiveLoadout.effectiveLoadoutId})` : ""}`] : []),
  ];
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

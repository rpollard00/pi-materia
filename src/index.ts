import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActiveCastConflictError, ActiveQuestConflictError, AutoCastCommandValidationError, CastCatalogUseCases, CastExecutionUseCases, LoadoutUseCases, QuestRunnerUseCases, configuredConfigPath, type CastStartOptions, type CastStateRepository, type QuestStartResult } from "./application/index.js";
import type { MateriaCastState } from "./types.js";
import { currentCastSocketId } from "./runtime/castStateAccessors.js";
import { publishActiveLoadoutChange } from "./presentation/activeLoadoutEvents.js";
import { registerMateriaRenderer } from "./presentation/renderer.js";
import { closeMateriaWebUiForSession, initializeDefaultLoadoutPreference, type MateriaWebUiQuestControlCallbacks } from "./webui/launcher.js";
import { loadConfig, saveQuestDefaultLoadoutPreference } from "./config/config.js";
import { loadoutPickerCandidates } from "./loadout/loadoutPickerCandidates.js";
import { ensureMateriaWebUi } from "./webui/service.js";
import type { MateriaQuestControlResult, MateriaQuestNoStartReason } from "./webui/server/index.js";
import { clearMateriaAuxiliaryWidgets, clearWidgetTicker, updateMateriaWebUiStatusWidget, updateWidget } from "./presentation/ui.js";
import { createMateriaPluginAdapters } from "./runtime/pluginAdapters.js";
import { FileQuestBoardRepository, QuestBoardPersistenceError } from "./infrastructure/index.js";
import type { QuestMovePlacement } from "./domain/questBoard.js";
import { renderQuestAdded, renderQuestDefaultLoadoutStatus, renderQuestList, renderQuestRequeued, renderQuestStarted, renderQuestStatus, renderQuestStopped, type QuestListFilter, type QuestListOptions } from "./presentation/questBoard.js";
export { renderCastList } from "./infrastructure/index.js";
export type { QuestListFilter, QuestListOptions } from "./presentation/questBoard.js";

type QuestListArgs = QuestListOptions;

export default function piMateria(pi: ExtensionAPI) {
  registerMateriaRenderer(pi);
  let activeContext: ExtensionContext | undefined;
  const adapters = createMateriaPluginAdapters();
  const getConfiguredConfigPath = () => configuredConfigPath(pi, adapters.environment);
  const loadoutUseCases = new LoadoutUseCases({ configs: adapters.configs, pipeline: adapters.pipeline, logger: adapters.logger });
  const castCatalogUseCases = new CastCatalogUseCases({ configs: adapters.configs, states: adapters.states, artifacts: adapters.artifacts });
  const castExecutionUseCases = new CastExecutionUseCases({ states: adapters.states, context: adapters.context, agentTurns: adapters.agentTurns, lifecycle: adapters.lifecycle, statusPresenter: adapters.statusPresenter, loadouts: loadoutUseCases, configs: adapters.configs, pipeline: adapters.pipeline });
  const createQuestBoardRepository = (cwd: string) => new FileQuestBoardRepository(cwd);
  const createQuestRunnerUseCases = (cwd: string, boards = createQuestBoardRepository(cwd)) => new QuestRunnerUseCases({ boards, casts: castExecutionUseCases, loadouts: loadoutUseCases, states: adapters.states, logger: adapters.logger });
  const autoAdvanceCwds = new Set<string>();
  const createWebUiQuestControls = (ctx: ExtensionContext): MateriaWebUiQuestControlCallbacks => ({
    runQuest: async (input) => {
      const boards = createQuestBoardRepository(ctx.cwd);
      const useCases = createQuestRunnerUseCases(ctx.cwd, boards);
      try {
        if (autoAdvanceCwds.has(ctx.cwd)) return { ok: false, code: "active_quest_conflict", message: "Quest runner is already advancing this board." };
        autoAdvanceCwds.add(ctx.cwd);
        try {
          const result = await useCases.runContinuous({ pi, session: ctx, cwd: ctx.cwd, configuredPath: getConfiguredConfigPath(), ...(input.questId ? { questId: input.questId } : {}) });
          const started = result.started[0];
          if (started) sendQuestStartedMessages({ pi, ctx, started: result.started, firstMode: "run" });
          return {
            ok: true,
            action: "run",
            boardPath: boards.boardPath,
            board: result.board,
            ...(started ? { started: mapWebUiQuestStart(started) } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
            message: started ? `Started quest ${started.quest.id} as cast ${started.state.castId}.` : questControlNoStartMessage(result.reason, input.questId, result.board.quests.length),
          };
        } finally {
          autoAdvanceCwds.delete(ctx.cwd);
        }
      } catch (error) {
        return mapWebUiQuestControlError("Could not run quest", error);
      }
    },
    runQuestOnce: async (input) => {
      const boards = createQuestBoardRepository(ctx.cwd);
      const useCases = createQuestRunnerUseCases(ctx.cwd, boards);
      try {
        const result = await useCases.runOnce({ pi, session: ctx, cwd: ctx.cwd, configuredPath: getConfiguredConfigPath(), ...(input.questId ? { questId: input.questId } : {}) });
        const board = result?.board ?? (await boards.loadOrCreate());
        if (result) {
          sendQuestMessage(pi, renderQuestStarted(result, "runonce"), "runonce");
          ctx.ui.notify(`pi-materia quest ${result.quest.id} launched as cast ${result.state.castId}.`, "info");
        }
        const reason = input.questId ? "not_found" : "waiting";
        return {
          ok: true,
          action: "runonce",
          boardPath: boards.boardPath,
          board,
          ...(result ? { started: mapWebUiQuestStart(result) } : { reason }),
          message: result ? `Started quest ${result.quest.id} as cast ${result.state.castId}.` : questControlNoStartMessage(reason, input.questId, board.quests.length),
        };
      } catch (error) {
        return mapWebUiQuestControlError("Could not run quest once", error);
      }
    },
    stopQuestRunner: async () => {
      const boards = createQuestBoardRepository(ctx.cwd);
      const useCases = createQuestRunnerUseCases(ctx.cwd, boards);
      try {
        const board = await useCases.stopRunner();
        sendQuestMessage(pi, renderQuestStopped(board), "stop");
        ctx.ui.notify("pi-materia quest runner stopped. Active casts were not aborted.", "info");
        return { ok: true, action: "stop", boardPath: boards.boardPath, board, reason: "runner_stopped", message: "Quest runner stopped. Active casts were not aborted." };
      } catch (error) {
        return mapWebUiQuestControlError("Could not stop quest runner", error);
      }
    },
  });

  pi.registerFlag("materia-config", {
    description: "Path to a pi-materia loadout/config JSON file",
    type: "string",
  });

  pi.on("context", (event, ctx) => {
    activeContext = ctx;
    const messages = castExecutionUseCases.buildIsolatedContext(event.messages, ctx);
    if (!messages) return;
    return { messages: messages as typeof event.messages };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    activeContext = ctx;
    const systemPrompt = await castExecutionUseCases.prepareAgentStart({ pi, session: ctx, systemPrompt: event.systemPrompt });
    if (!systemPrompt) return;
    return { systemPrompt };
  });

  pi.on("agent_end", async (event, ctx) => {
    activeContext = ctx;
    const before = adapters.states.loadActive(ctx);
    await castExecutionUseCases.handleAgentEnd(pi, event, ctx);
    const after = adapters.states.loadActive(ctx);
    if (before?.active && after && after.castId === before.castId && !after.active) {
      const boards = createQuestBoardRepository(ctx.cwd);
      if (existsSync(boards.boardPath)) await settleQuestCastAndMaybeAutoAdvance({ pi, ctx, state: after, useCases: createQuestRunnerUseCases(ctx.cwd, boards), configuredPath: getConfiguredConfigPath(), guard: autoAdvanceCwds, settlementSource: "agent_end" });
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    await initializeDefaultLoadoutPreference(ctx, getConfiguredConfigPath(), pi);
    const boards = createQuestBoardRepository(ctx.cwd);
    if (existsSync(boards.boardPath)) {
      try {
        const reconciled = await createQuestRunnerUseCases(ctx.cwd, boards).reconcileOnSessionStart();
        if (reconciled.reconciled.length > 0) ctx.ui.notify(`pi-materia quest runner blocked ${reconciled.reconciled.length} stale running quest(s) after session restart. Use /materia quest status before resuming automation.`, "warning");
      } catch (error) {
        ctx.ui.notify(`pi-materia quest reconciliation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
    const state = adapters.states.loadActive(ctx);
    if (!state?.active) return;
    ctx.ui.setStatus("materia", adapters.statusPresenter.statusLabel(state));
    ctx.ui.notify(`pi-materia cast ${state.castId} restored in ${state.phase}. Use /materia status for details.`, "info");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearWidgetTicker(ctx);
    closeMateriaWebUiForSession(ctx);
  });

  pi.registerCommand("materia", {
    description: "Run pi-materia commands: /materia cast <task>, /materia autocast <loadout|materia:name> <prompt>, link, recast, revive, casts, quest, grid, loadout, ui, status, continue, abort.",
    getArgumentCompletions: (prefix) => getMateriaArgumentCompletions(prefix, activeContext, adapters.states, getConfiguredConfigPath),
    handler: async (args, ctx) => {
      activeContext = ctx;
      const trimmedArgs = args.trimStart();
      const [subcommand, ...rest] = trimmedArgs.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "quest") {
        const questArgs = trimmedArgs.replace(/^quest(?:\s+|$)/, "");
        if (!isNonBlockingQuestCommand(questArgs)) await ctx.waitForIdle();
        await handleQuestCommand({ args: questArgs, ctx, pi, useCases: createQuestRunnerUseCases(ctx.cwd), loadouts: loadoutUseCases, configuredPath: getConfiguredConfigPath(), autoAdvanceGuard: autoAdvanceCwds, questControls: createWebUiQuestControls(ctx) });
        return;
      }

      if (subcommand === "ui") {
        try {
          const result = await ensureMateriaWebUi({ ctx, mode: "explicit", configuredPath: getConfiguredConfigPath(), pi, questControls: createWebUiQuestControls(ctx) });
          if (!result.ok) return;
          const reused = result.status === "reused";
          const lines = [`WebUI ${reused ? "ready" : "started"}: ${truncateLine(result.url, 110)}`];
          clearMateriaAuxiliaryWidgets(ctx);
          updateMateriaWebUiStatusWidget(ctx, { url: result.url, status: result.status });
          ctx.ui.notify(`Materia WebUI ${reused ? "ready" : "started"}: ${result.url}`, "info");
          pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "ui", materiaName: "orchestrator", eventType: "ui", url: result.url, sessionKey: result.sessionKey } });
          pi.appendEntry("pi-materia-webui", { url: result.url, sessionKey: result.sessionKey, reused, startedAt: Date.now() });
        } catch (error) {
          ctx.ui.notify(`pi-materia ui failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "autocast") {
        const argumentsText = trimmedArgs.replace(/^autocast(?:\s+|$)/, "");
        try {
          const { loaded, pipeline, autocast, effectiveLoadout } = await castExecutionUseCases.startAutoCast({ pi, session: ctx, cwd: ctx.cwd, argumentsText, rawCommand: `/materia ${trimmedArgs.trim()}`, configuredPath: getConfiguredConfigPath() });
          autoStartMateriaWebUi({ ctx, pi, configuredPath: getConfiguredConfigPath(), questControls: createWebUiQuestControls(ctx) });
          ctx.ui.notify(`pi-materia autocast config: ${loaded.source}`, "info");
          if (autocast.mode === "loadout") {
            ctx.ui.notify(`pi-materia autocast temporary loadout: ${effectiveLoadout?.effectiveLoadoutName ?? autocast.requestedTarget} (active loadout unchanged)`, "info");
          } else {
            const materiaName = autocast.resolvedMateria.name ?? autocast.resolvedMateria.id;
            ctx.ui.notify(`pi-materia autocast virtual materia loadout: ${materiaName} (${autocast.virtualLoadout.name}; active loadout unchanged)`, "info");
          }
          ctx.ui.notify(`pi-materia grid entry: ${pipeline.entry.id}`, "info");
        } catch (error) {
          if (error instanceof ActiveCastConflictError) {
            ctx.ui.notify(`A pi-materia cast is already active (${error.castId}). Use /materia status or /materia abort.`, "error");
            return;
          }
          if (error instanceof AutoCastCommandValidationError) {
            ctx.ui.notify(error.message, "error");
            return;
          }
          ctx.ui.setStatus("materia", "failed");
          ctx.ui.notify(`pi-materia autocast failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      const autoStartsWebUi = shouldAutoStartWebUi(subcommand);
      if (autoStartsWebUi) {
        autoStartMateriaWebUi({ ctx, pi, configuredPath: getConfiguredConfigPath(), questControls: createWebUiQuestControls(ctx) });
      }

      if (!autoStartsWebUi && !isNonBlockingMateriaCommand(subcommand)) await ctx.waitForIdle();

      if (subcommand === "link") {
        const argumentsText = trimmedArgs.replace(/^link(?:\s+|$)/, "");
        if (!argumentsText.trim()) {
          ctx.ui.notify("Usage: /materia link [--from <castId>] <target> [<target> ...] -- <prompt>", "error");
          return;
        }
        try {
          const { loaded, pipeline, link } = await castExecutionUseCases.startLinkedCast({ pi, session: ctx, cwd: ctx.cwd, argumentsText, rawCommand: `/materia ${trimmedArgs.trim()}`, configuredPath: getConfiguredConfigPath() });
          ctx.ui.notify(`pi-materia link config: ${loaded.source}`, "info");
          ctx.ui.notify(`pi-materia linked virtual loadout: ${link.virtualLoadout.name}`, "info");
          ctx.ui.notify(`pi-materia grid entry: ${pipeline.entry.id}`, "info");
        } catch (error) {
          if (error instanceof ActiveCastConflictError) {
            ctx.ui.notify(`A pi-materia cast is already active (${error.castId}). Use /materia status or /materia abort.`, "error");
            return;
          }
          ctx.ui.setStatus("materia", "failed");
          ctx.ui.notify(`pi-materia link failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "grid") {
        try {
          const { loaded, lines } = await loadoutUseCases.prepareGrid(ctx.cwd, getConfiguredConfigPath());
          clearMateriaAuxiliaryWidgets(ctx);
          ctx.ui.notify(`pi-materia grid loaded from ${loaded.source}`, "info");
          pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "grid", materiaName: "orchestrator", eventType: "grid" } });
          pi.appendEntry("pi-materia-grid", { source: loaded.source, lines });
        } catch (error) {
          ctx.ui.notify(`pi-materia grid failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "loadout") {
        const requestedLoadout = rest.join(" ").trim();
        try {
          const configuredPath = getConfiguredConfigPath();
          if (requestedLoadout) {
            const { loaded, writtenPath: written } = await loadoutUseCases.selectActiveLoadout({ cwd: ctx.cwd, requestedLoadout, configuredPath, activeCast: adapters.states.loadActive(ctx) });
            clearMateriaAuxiliaryWidgets(ctx);
            publishActiveLoadoutChange(pi, ctx, {
              source: "command",
              loaded,
              writtenPath: written,
              notifyMessage: `pi-materia active loadout set to ${loaded.config.activeLoadout ?? requestedLoadout} (${written})`,
            });
          } else {
            const { lines } = await loadoutUseCases.listLoadouts(ctx.cwd, configuredPath);
            clearMateriaAuxiliaryWidgets(ctx);
            pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "loadout", materiaName: "orchestrator", eventType: "loadout" } });
          }
        } catch (error) {
          if (error instanceof ActiveCastConflictError) {
            ctx.ui.notify(error.message, "error");
            pi.sendMessage({ customType: "pi-materia", content: error.message, display: true, details: { prefix: "loadout", materiaName: "orchestrator", eventType: "loadout", source: "command", error: error.code, castId: error.castId } });
          } else {
            ctx.ui.notify(`pi-materia loadout failed: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        }
        return;
      }


      if (subcommand === "casts") {
        try {
          const { lines } = await castCatalogUseCases.listCasts({ cwd: ctx.cwd, session: ctx, configuredPath: getConfiguredConfigPath() });
          clearMateriaAuxiliaryWidgets(ctx);
          pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "casts", materiaName: "orchestrator", eventType: "casts" } });
        } catch (error) {
          ctx.ui.notify(`pi-materia casts failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "status") {
        const state = castExecutionUseCases.status(ctx);
        if (!state) {
          ctx.ui.notify("No pi-materia cast state in this session.", "info");
          return;
        }
        const lines = updateWidget(ctx, state, { replaceOwner: true }) ?? [];
        pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "status", materiaName: "orchestrator", eventType: "status" } });
        return;
      }

      if (subcommand === "abort") {
        const state = castExecutionUseCases.abortActive(pi, ctx);
        if (!state) {
          ctx.ui.notify("No active pi-materia cast to abort.", "info");
          return;
        }
        updateWidget(ctx, state.runState);
        ctx.ui.setStatus("materia", undefined);
        ctx.ui.notify(`pi-materia cast ${state.castId} aborted.`, "warning");
        const boards = createQuestBoardRepository(ctx.cwd);
        if (existsSync(boards.boardPath)) await settleQuestCastAndMaybeAutoAdvance({ pi, ctx, state, useCases: createQuestRunnerUseCases(ctx.cwd, boards), configuredPath: getConfiguredConfigPath(), guard: autoAdvanceCwds, settlementSource: "command" });
        return;
      }

      if (subcommand === "continue") {
        try {
          await castExecutionUseCases.continueCast(pi, ctx);
        } catch (error) {
          ctx.ui.notify(`pi-materia continue failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "recast") {
        try {
          const requestedCastId = rest.join(" ").trim();
          const castId = await castExecutionUseCases.resumeLatestOrRequested(pi, ctx, requestedCastId);
          if (!castId) {
            ctx.ui.notify("No failed or aborted pi-materia casts are available to recast.", "info");
            return;
          }
        } catch (error) {
          ctx.ui.notify(`pi-materia recast failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "revive") {
        try {
          const requestedCastId = rest.join(" ").trim();
          const castId = await castExecutionUseCases.reviveLatestOrRequested(pi, ctx, requestedCastId);
          if (!castId) {
            ctx.ui.notify("No failed pi-materia casts exhausted by same-socket recovery or edge traversal are available to revive. Use /materia recast [cast-id] for general failed or aborted casts.", "info");
            return;
          }
        } catch (error) {
          ctx.ui.notify(`pi-materia revive failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand !== "cast") {
        ctx.ui.notify("Usage: /materia cast <task>, /materia autocast <loadout|materia:name> <prompt>, /materia link [--from <castId>] <target> [<target> ...] -- <prompt>, /materia recast [cast-id], /materia revive [cast-id] (after same-socket recovery exhaustion or edge traversal exhaustion; extends the exhausted allowance then recasts), /materia casts, /materia grid, /materia loadout [name], /materia ui, /materia status, /materia continue, or /materia abort", "error");
        return;
      }

      const request = rest.join(" ").trim();
      if (!request) {
        ctx.ui.notify("Usage: /materia cast <high-level software task>", "error");
        return;
      }

      try {
        const { loaded, pipeline } = await castExecutionUseCases.startCast({ pi, session: ctx, cwd: ctx.cwd, request, configuredPath: getConfiguredConfigPath() });
        ctx.ui.notify(`pi-materia config: ${loaded.source}`, "info");
        ctx.ui.notify(`pi-materia grid entry: ${pipeline.entry.id}`, "info");
      } catch (error) {
        if (error instanceof ActiveCastConflictError) {
          ctx.ui.notify(`A pi-materia cast is already active (${error.castId}). Use /materia status or /materia abort.`, "error");
          return;
        }
        ctx.ui.setStatus("materia", "failed");
        ctx.ui.notify(`pi-materia cast failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

interface QuestCommandInput {
  args: string;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  useCases: QuestRunnerUseCases<ExtensionContext, ExtensionAPI>;
  loadouts: LoadoutUseCases;
  configuredPath?: string;
  autoAdvanceGuard: Set<string>;
  questControls?: MateriaWebUiQuestControlCallbacks;
}

async function handleQuestCommand(input: QuestCommandInput): Promise<void> {
  const tokens = tokenizeCommandArgs(input.args);
  const action = tokens[0] ?? "status";
  const rest = tokens.slice(1);

  if (action === "status") {
    await showQuestStatus(input);
    return;
  }

  if (action === "default-loadout") {
    await handleQuestDefaultLoadoutCommand(input, rest);
    return;
  }

  if (action === "list") {
    const parsed = parseQuestListArgs(rest);
    if (!parsed.ok) {
      input.ctx.ui.notify(parsed.error, "error");
      return;
    }
    await showQuestList(input, parsed.args);
    return;
  }

  if (action === "move") {
    const parsed = parseQuestMoveArgs(rest);
    if (!parsed.ok) {
      input.ctx.ui.notify(parsed.error, "error");
      return;
    }
    try {
      const result = await input.useCases.moveQuest(parsed.args);
      const targetText = result.target ? ` ${parsed.args.placement} ${result.target.id}` : " first";
      sendQuestMessage(input.pi, [`Moved quest ${result.quest.id}${targetText}.`, "Pending quest order updated in .pi/pi-materia/quest-board.json."], "move");
      input.ctx.ui.notify(`Moved pi-materia quest ${result.quest.id}${targetText}.`, "info");
    } catch (error) {
      notifyQuestError(input.ctx, "move", error);
    }
    return;
  }

  if (action === "stop") {
    if (rest.length > 0) {
      input.ctx.ui.notify("Usage: /materia quest stop", "error");
      return;
    }
    try {
      const board = await input.useCases.stopRunner();
      sendQuestMessage(input.pi, renderQuestStopped(board), "stop");
      input.ctx.ui.notify("pi-materia quest runner stopped. Active casts were not aborted.", "info");
    } catch (error) {
      notifyQuestError(input.ctx, "stop", error);
    }
    return;
  }

  if (action === "requeue" || action === "unblock" || action === "unfail") {
    if (rest.length !== 1) {
      input.ctx.ui.notify(`Usage: /materia quest ${action} <quest-id-or-prefix>`, "error");
      return;
    }
    try {
      const { board, quest } = await input.useCases.requeueQuest({ questRef: rest[0]! });
      const status = await input.useCases.getStatus(input.ctx);
      sendQuestMessage(input.pi, renderQuestRequeued(quest, status.boardPath), action);
      input.ctx.ui.notify(`Requeued pi-materia quest ${quest.id}.`, "info");
      if (board.runner.enabled) {
        await drainQuestBoard({ pi: input.pi, ctx: input.ctx, useCases: input.useCases, configuredPath: input.configuredPath, guard: input.autoAdvanceGuard });
      }
    } catch (error) {
      notifyQuestError(input.ctx, action, error);
    }
    return;
  }

  if (action === "add") {
    const parsed = parseQuestAddArgs(rest);
    if (!parsed.ok) {
      input.ctx.ui.notify(parsed.error, "error");
      return;
    }
    try {
      if (parsed.loadoutOverride) await input.loadouts.loadForCast(input.ctx.cwd, input.configuredPath, parsed.loadoutOverride);
      const { quest } = await input.useCases.addQuest({ prompt: parsed.prompt, ...(parsed.loadoutOverride ? { loadoutOverride: parsed.loadoutOverride } : {}) });
      const status = await input.useCases.getStatus(input.ctx);
      sendQuestMessage(input.pi, renderQuestAdded(quest, status.boardPath), "add");
      input.ctx.ui.notify(`Added pi-materia quest ${quest.id}.`, "info");
    } catch (error) {
      notifyQuestError(input.ctx, "add", error);
    }
    return;
  }

  if (action === "run" || action === "start") {
    if (rest.length > 1) {
      input.ctx.ui.notify(`Usage: /materia quest ${action} [id]`, "error");
      return;
    }
    const questId = rest[0];
    autoStartMateriaWebUi({ ctx: input.ctx, pi: input.pi, configuredPath: input.configuredPath, questControls: input.questControls });
    try {
      if (input.autoAdvanceGuard.has(input.ctx.cwd)) return;
      input.autoAdvanceGuard.add(input.ctx.cwd);
      try {
        const result = await input.useCases.runContinuous({ pi: input.pi, session: input.ctx, cwd: input.ctx.cwd, configuredPath: input.configuredPath, ...(questId ? { questId } : {}) });
        const started = result.started[0];
        if (!started) {
          input.ctx.ui.notify(result.reason === "not_found" ? questStartNotFoundMessage(result.board.quests.length, questId) : "pi-materia quest runner enabled and waiting for pending quests.", result.reason === "not_found" ? "error" : "info");
          return;
        }
        sendQuestStartedMessages({ pi: input.pi, ctx: input.ctx, started: result.started, firstMode: action });
      } finally {
        input.autoAdvanceGuard.delete(input.ctx.cwd);
      }
    } catch (error) {
      notifyQuestError(input.ctx, action, error);
    }
    return;
  }

  if (action === "runonce") {
    if (rest.length > 1) {
      input.ctx.ui.notify("Usage: /materia quest runonce [id]", "error");
      return;
    }
    const questId = rest[0];
    autoStartMateriaWebUi({ ctx: input.ctx, pi: input.pi, configuredPath: input.configuredPath, questControls: input.questControls });
    try {
      const result = await input.useCases.runOnce({ pi: input.pi, session: input.ctx, cwd: input.ctx.cwd, configuredPath: input.configuredPath, ...(questId ? { questId } : {}) });
      if (!result) {
        const status = await input.useCases.getStatus(input.ctx);
        input.ctx.ui.notify(questStartNotFoundMessage(status.board.quests.length, questId), "error");
        return;
      }
      sendQuestMessage(input.pi, renderQuestStarted(result, "runonce"), "runonce");
      input.ctx.ui.notify(`pi-materia quest ${result.quest.id} launched as cast ${result.state.castId}.`, "info");
    } catch (error) {
      notifyQuestError(input.ctx, action, error);
    }
    return;
  }

  input.ctx.ui.notify("Usage: /materia quest [status], /materia quest default-loadout [<name-or-id>|--clear], /materia quest list [pending|all|succeeded|failed] [--limit <n>], /materia quest add [--loadout <name>] <prompt>, /materia quest move <quest> --first|--before <target>|--onto <target>, /materia quest requeue <quest-id-or-prefix>, /materia quest unblock <quest-id-or-prefix>, /materia quest unfail <quest-id-or-prefix>, /materia quest run [id], /materia quest runonce [id], /materia quest start [id], or /materia quest stop", "error");
}

async function handleQuestDefaultLoadoutCommand(input: QuestCommandInput, tokens: string[]): Promise<void> {
  if (tokens.length === 0) {
    try {
      const loaded = await loadConfig(input.ctx.cwd, input.configuredPath);
      sendQuestMessage(input.pi, renderQuestDefaultLoadoutStatus(loaded), "default-loadout");
    } catch (error) {
      notifyQuestError(input.ctx, "default-loadout", error);
    }
    return;
  }

  if (tokens.length === 1 && tokens[0] === "--clear") {
    try {
      await saveQuestDefaultLoadoutPreference(input.ctx.cwd, null, input.configuredPath);
      const loaded = await loadConfig(input.ctx.cwd, input.configuredPath);
      sendQuestMessage(input.pi, renderQuestDefaultLoadoutStatus(loaded), "default-loadout");
      input.ctx.ui.notify("pi-materia quest default loadout cleared.", "info");
    } catch (error) {
      notifyQuestError(input.ctx, "default-loadout", error);
    }
    return;
  }

  if (tokens.includes("--clear")) {
    input.ctx.ui.notify("Usage: /materia quest default-loadout [<name-or-id>|--clear]", "error");
    return;
  }

  const requestedLoadout = tokens.join(" ").trim();
  if (!requestedLoadout) {
    input.ctx.ui.notify("Usage: /materia quest default-loadout [<name-or-id>|--clear]", "error");
    return;
  }

  try {
    const questDefaultLoadoutId = await saveQuestDefaultLoadoutPreference(input.ctx.cwd, requestedLoadout, input.configuredPath);
    const loaded = await loadConfig(input.ctx.cwd, input.configuredPath);
    sendQuestMessage(input.pi, renderQuestDefaultLoadoutStatus(loaded), "default-loadout");
    input.ctx.ui.notify(`pi-materia quest default loadout set to ${questDefaultLoadoutId ?? requestedLoadout}.`, "info");
  } catch (error) {
    notifyQuestError(input.ctx, "default-loadout", error);
  }
}

async function showQuestStatus(input: QuestCommandInput): Promise<void> {
  try {
    const status = await input.useCases.getStatus(input.ctx);
    const loaded = await loadConfig(input.ctx.cwd, input.configuredPath);
    sendQuestMessage(input.pi, renderQuestStatus({
      ...status,
      activeLoadoutName: loaded.config.activeLoadout,
      activeLoadoutId: loaded.config.activeLoadoutId,
      defaultLoadoutId: loaded.defaultLoadoutId ?? null,
      ...(loaded.defaultLoadoutWarning ? { defaultLoadoutWarning: loaded.defaultLoadoutWarning } : {}),
      questDefaultLoadoutId: loaded.questDefaultLoadoutId ?? null,
      ...(loaded.questDefaultLoadoutWarning ? { questDefaultLoadoutWarning: loaded.questDefaultLoadoutWarning } : {}),
    }), "status");
  } catch (error) {
    notifyQuestError(input.ctx, "status", error);
  }
}

async function showQuestList(input: QuestCommandInput, args: QuestListArgs): Promise<void> {
  try {
    const status = await input.useCases.getStatus(input.ctx);
    sendQuestMessage(input.pi, renderQuestList(status, args), "list");
  } catch (error) {
    notifyQuestError(input.ctx, "list", error);
  }
}

function mapWebUiQuestStart(started: QuestStartResult): Extract<MateriaQuestControlResult, { ok: true }>["started"] {
  return {
    quest: started.quest,
    castId: started.state.castId,
    ...(started.state.currentSocketId ? { currentSocketId: started.state.currentSocketId } : {}),
    ...(started.state.artifactRoot ? { artifactRoot: started.state.artifactRoot } : {}),
    ...(started.state.runDir ? { runDir: started.state.runDir } : {}),
  };
}

function questControlNoStartMessage(reason: MateriaQuestNoStartReason | undefined, questId: string | undefined, totalQuests: number): string {
  if (reason === "active_cast") return "A cast is already active; no quest was started.";
  if (reason === "running_quest") return "A quest is already running; no quest was started.";
  if (reason === "runner_stopped") return "Quest runner is stopped; no quest was started.";
  if (reason === "safety_limit") return "Quest runner hit its safety limit before starting another quest.";
  return questStartNotFoundMessage(totalQuests, questId);
}

function mapWebUiQuestControlError(prefix: string, error: unknown): MateriaQuestControlResult {
  if (error instanceof ActiveCastConflictError) return { ok: false, code: "active_cast_conflict", message: `${prefix}: a cast is already active (${error.castId}).` };
  if (error instanceof ActiveQuestConflictError) return { ok: false, code: "active_quest_conflict", message: `${prefix}: a quest is already running (${error.questId}).` };
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, code: "unavailable", message: `${prefix}: ${message}` };
}

async function settleQuestCastAndMaybeAutoAdvance(input: { pi: ExtensionAPI; ctx: ExtensionContext; state: MateriaCastState; useCases: QuestRunnerUseCases<ExtensionContext, ExtensionAPI>; configuredPath?: string; guard: Set<string>; settlementSource: "agent_end" | "command" }): Promise<void> {
  if (input.guard.has(input.ctx.cwd)) return;
  input.guard.add(input.ctx.cwd);
  try {
    const settled = await input.useCases.handleCastSettled({
      castId: input.state.castId,
      state: input.state,
      message: input.state.runState?.lastMessage,
      error: input.state.failedReason,
    });
    if (!settled.quest) return;
    if (!settled.board.runner.enabled) return;
    // Pi may ignore triggerTurn calls issued from inside agent_end, even when that
    // handler starts a new quest cast. Keep quest/cast state durable now and defer
    // only the first prompt dispatch; do not wake the next cast with dummy input.
    await autoAdvanceQuestBoard({ pi: input.pi, ctx: input.ctx, useCases: input.useCases, configuredPath: input.configuredPath, castOptions: input.settlementSource === "agent_end" ? { initialPromptDispatch: "defer-agent-trigger" } : undefined });
  } catch (error) {
    notifyQuestError(input.ctx, "auto-advance", error);
  } finally {
    input.guard.delete(input.ctx.cwd);
  }
}

async function autoAdvanceQuestBoard(input: { pi: ExtensionAPI; ctx: ExtensionContext; useCases: QuestRunnerUseCases<ExtensionContext, ExtensionAPI>; configuredPath?: string; castOptions?: CastStartOptions }): Promise<void> {
  const result = await input.useCases.drainEnabledRunner({ pi: input.pi, session: input.ctx, cwd: input.ctx.cwd, configuredPath: input.configuredPath, options: input.castOptions });
  sendQuestStartedMessages({ pi: input.pi, ctx: input.ctx, started: result.started, firstMode: "auto-advance" });
}

async function drainQuestBoard(input: { pi: ExtensionAPI; ctx: ExtensionContext; useCases: QuestRunnerUseCases<ExtensionContext, ExtensionAPI>; configuredPath?: string; guard: Set<string> }): Promise<void> {
  if (input.guard.has(input.ctx.cwd)) return;
  input.guard.add(input.ctx.cwd);
  try {
    await autoAdvanceQuestBoard({ pi: input.pi, ctx: input.ctx, useCases: input.useCases, configuredPath: input.configuredPath });
  } catch (error) {
    notifyQuestError(input.ctx, "auto-advance", error);
  } finally {
    input.guard.delete(input.ctx.cwd);
  }
}

function sendQuestStartedMessages(input: { pi: ExtensionAPI; ctx: ExtensionContext; started: QuestStartResult[]; firstMode: "run" | "start" | "auto-advance" }): void {
  input.started.forEach((started, index) => {
    if (!started) return;
    const mode = index === 0 ? input.firstMode : "auto-advance";
    sendQuestMessage(input.pi, renderQuestStarted(started, mode), mode);
    input.ctx.ui.notify(mode === "auto-advance" ? `pi-materia quest ${started.quest.id} auto-launched as cast ${started.state.castId}.` : `pi-materia quest ${started.quest.id} launched as cast ${started.state.castId}.`, "info");
  });
}

function sendQuestMessage(pi: ExtensionAPI, lines: string[], eventType: string): void {
  pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "quest", materiaName: "orchestrator", eventType } });
}

function questStartNotFoundMessage(totalQuests: number, questId?: string): string {
  if (questId) return `No pending pi-materia quest found with id ${questId}.`;
  if (totalQuests === 0) return "The pi-materia quest board is empty. Add a quest with /materia quest add <prompt> first.";
  return "No pending pi-materia quests are available.";
}

function notifyQuestError(ctx: ExtensionContext, action: string, error: unknown): void {
  if (error instanceof ActiveCastConflictError) {
    ctx.ui.notify(`A pi-materia cast is already active (${error.castId}). Use /materia status or /materia abort.`, "error");
    return;
  }
  if (error instanceof ActiveQuestConflictError) {
    ctx.ui.notify(`A pi-materia quest is already running (${error.questId}). Use /materia quest status.`, "error");
    return;
  }
  if (error instanceof QuestBoardPersistenceError) {
    ctx.ui.notify(error.message, "error");
    return;
  }
  ctx.ui.notify(`pi-materia quest ${action} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
}

export function parseQuestListArgs(tokens: string[]): { ok: true; args: QuestListArgs } | { ok: false; error: string } {
  const usage = "Usage: /materia quest list [pending|all|succeeded|failed] [--limit <n>]";
  const filters = new Set<QuestListFilter>(["pending", "all", "succeeded", "failed"]);
  let filter: QuestListFilter = "pending";
  let sawFilter = false;
  let limit = 10;
  let sawLimit = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--limit") {
      if (sawLimit) return { ok: false, error: `${usage}. Specify --limit only once.` };
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, error: usage };
      const parsed = parsePositiveSafeInteger(value);
      if (!parsed.ok) return { ok: false, error: `${usage}. Limit must be a positive safe integer.` };
      limit = parsed.value;
      sawLimit = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--limit=")) {
      if (sawLimit) return { ok: false, error: `${usage}. Specify --limit only once.` };
      const parsed = parsePositiveSafeInteger(token.slice("--limit=".length));
      if (!parsed.ok) return { ok: false, error: `${usage}. Limit must be a positive safe integer.` };
      limit = parsed.value;
      sawLimit = true;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, error: `Unknown /materia quest list option ${token}. ${usage}` };
    if (!filters.has(token as QuestListFilter)) return { ok: false, error: `Unknown /materia quest list filter ${token}. Expected pending, all, succeeded, or failed.` };
    if (sawFilter) return { ok: false, error: `${usage}. Specify at most one filter.` };
    filter = token as QuestListFilter;
    sawFilter = true;
  }

  return { ok: true, args: { filter, limit } };
}

function parsePositiveSafeInteger(value: string): { ok: true; value: number } | { ok: false } {
  if (!/^[1-9]\d*$/.test(value)) return { ok: false };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return { ok: false };
  return { ok: true, value: parsed };
}

export function parseQuestMoveArgs(tokens: string[]): { ok: true; args: { questRef: string; placement: QuestMovePlacement; targetRef?: string } } | { ok: false; error: string } {
  const usage = "Usage: /materia quest move <quest> --first|--before <target>|--onto <target> (--onto means after target). Quest IDs accept unambiguous prefixes.";
  const questRef = tokens[0];
  if (!questRef || questRef.startsWith("--")) return { ok: false, error: usage };
  let placement: QuestMovePlacement | undefined;
  let targetRef: string | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const setPlacement = (next: QuestMovePlacement, target?: string): { ok: true } | { ok: false; error: string } => {
      if (placement !== undefined) return { ok: false, error: `${usage} Specify exactly one placement option.` };
      placement = next;
      targetRef = target;
      return { ok: true };
    };
    if (token === "--first") {
      const set = setPlacement("first");
      if (!set.ok) return set;
      continue;
    }
    if (token === "--before" || token === "--onto") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, error: usage };
      const set = setPlacement(token === "--before" ? "before" : "after", value);
      if (!set.ok) return set;
      index += 1;
      continue;
    }
    if (token.startsWith("--before=")) {
      const value = token.slice("--before=".length).trim();
      if (!value) return { ok: false, error: usage };
      const set = setPlacement("before", value);
      if (!set.ok) return set;
      continue;
    }
    if (token.startsWith("--onto=")) {
      const value = token.slice("--onto=".length).trim();
      if (!value) return { ok: false, error: usage };
      const set = setPlacement("after", value);
      if (!set.ok) return set;
      continue;
    }
    return { ok: false, error: token.startsWith("--") ? `Unknown /materia quest move option ${token}. ${usage}` : usage };
  }

  if (placement === undefined) return { ok: false, error: usage };
  return { ok: true, args: { questRef, placement, ...(targetRef ? { targetRef } : {}) } };
}

function parseQuestAddArgs(tokens: string[]): { ok: true; prompt: string; loadoutOverride?: string } | { ok: false; error: string } {
  let loadoutOverride: string | undefined;
  const promptTokens: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--loadout") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, error: "Usage: /materia quest add [--loadout <name>] <prompt>" };
      loadoutOverride = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--loadout=")) {
      const value = token.slice("--loadout=".length).trim();
      if (!value) return { ok: false, error: "Usage: /materia quest add [--loadout <name>] <prompt>" };
      loadoutOverride = value;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, error: `Unknown /materia quest add option ${token}.` };
    promptTokens.push(token);
  }
  const prompt = promptTokens.join(" ").trim();
  if (!prompt) return { ok: false, error: "Usage: /materia quest add [--loadout <name>] <prompt>" };
  return { ok: true, prompt, ...(loadoutOverride ? { loadoutOverride } : {}) };
}

function tokenizeCommandArgs(args: string): string[] {
  return args.match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\S+/g)?.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return token.slice(1, -1);
    return token;
  }) ?? [];
}

function isNonBlockingQuestCommand(args: string): boolean {
  const action = tokenizeCommandArgs(args)[0] ?? "status";
  return action === "status" || action === "list" || action === "stop" || action === "add" || action === "default-loadout";
}

function isNonBlockingMateriaCommand(subcommand: string | undefined): boolean {
  return subcommand === "continue";
}

function getMateriaArgumentCompletions(prefix: string, ctx: ExtensionContext | undefined, statesRepository: Pick<CastStateRepository<ExtensionContext>, "listResumable" | "listRevivable">, getConfigPath?: () => string | undefined): Array<{ value: string; label: string; description?: string }> | null | Promise<Array<{ value: string; label: string; description?: string }> | null> {
  const trimmedStart = prefix.trimStart();
  const tokens = trimmedStart.split(/\s+/).filter(Boolean);
  const endsWithWhitespace = /\s$/.test(prefix);

  // Loadout subcommand completions — loads config asynchronously to build the full candidate list.
  // Handled before the generic subcommand filter so typing the exact "loadout" token shows
  // loadout candidates instead of repeating the subcommand name.
  if (tokens.length >= 1 && tokens[0] === "loadout") {
    if (!ctx || !getConfigPath) return null;
    const query = prefix.replace(/^loadout\s*/, "").trim();
    const configuredPath = getConfigPath();
    return loadConfig(ctx.cwd, configuredPath).then((loaded) => {
      const candidates = loadoutPickerCandidates({
        config: loaded.config,
        loadoutSources: loaded.loadoutSources,
      }, query);
      if (candidates.length === 0) return null;
      return candidates.map((c) => ({
        value: `loadout ${c.value}`,
        label: c.label,
        description: c.description,
      }));
    });
  }

  if (tokens.length === 0 && !endsWithWhitespace) {
    const subcommands = materiaSubcommands();
    return subcommands.map((value) => ({ value, label: value }));
  }

  if (tokens.length === 1 && !endsWithWhitespace) {
    const subcommands = materiaSubcommands();
    const matching = subcommands.filter((value) => value.startsWith(tokens[0]));
    return matching.length ? matching.map((value) => ({ value, label: value })) : null;
  }

  if (tokens[0] === "quest") {
    const questSubcommands = ["status", "add", "run", "runonce", "start", "stop", "list", "move", "requeue", "unblock", "unfail", "default-loadout"];
    if (tokens.length === 1 && endsWithWhitespace) return questSubcommands.map((value) => ({ value: `quest ${value}`, label: value }));
    if (tokens.length === 2 && !endsWithWhitespace) {
      const matching = questSubcommands.filter((value) => value.startsWith(tokens[1] ?? ""));
      return matching.length ? matching.map((value) => ({ value: `quest ${value}`, label: value })) : null;
    }
    if (tokens[1] === "list") return questListCompletions(tokens, endsWithWhitespace);
    if (tokens[1] === "default-loadout") return questDefaultLoadoutCompletions(tokens, endsWithWhitespace);
    return null;
  }

  if ((tokens[0] !== "recast" && tokens[0] !== "revive") || !ctx) return null;
  const command = tokens[0];
  const castIdPrefix = endsWithWhitespace ? "" : (tokens[1] ?? "");
  const states = command === "revive" ? statesRepository.listRevivable(ctx) : statesRepository.listResumable(ctx);
  const completions = states
    .filter((state) => state.castId.startsWith(castIdPrefix))
    .map((state) => ({
      value: `${command} ${state.castId}`,
      label: `${state.castId}  ${command === "revive" ? revivableStatusLabel(state) : recastStatusLabel(state)}  socket:${command === "revive" ? (revivableStatusSocketId(state) ?? currentCastSocketId(state) ?? "-") : (currentCastSocketId(state) ?? "-")}`,
      description: truncateLine(state.request ?? state.failedReason ?? state.runState?.lastMessage ?? "", 72),
    }));
  return completions.length ? completions : null;
}

function questListCompletions(tokens: string[], endsWithWhitespace: boolean): Array<{ value: string; label: string; description?: string }> | null {
  const filters = ["pending", "all", "succeeded", "failed"];
  if (tokens.length === 2 && endsWithWhitespace) return filters.map((filter) => ({ value: `quest list ${filter}`, label: filter }));
  if (tokens.length === 3 && !endsWithWhitespace) {
    const matching = filters.filter((filter) => filter.startsWith(tokens[2] ?? ""));
    return matching.length ? matching.map((filter) => ({ value: `quest list ${filter}`, label: filter })) : null;
  }
  if (tokens.length === 3 && endsWithWhitespace) return [{ value: `quest list ${tokens[2]} --limit `, label: "--limit", description: "Limit number of quests shown" }];
  return null;
}

function questDefaultLoadoutCompletions(tokens: string[], endsWithWhitespace: boolean): Array<{ value: string; label: string; description?: string }> | null {
  if (tokens.length === 2 && endsWithWhitespace) return [{ value: "quest default-loadout --clear", label: "--clear", description: "Clear the quest default loadout preference" }];
  if (tokens.length === 3 && !endsWithWhitespace && "--clear".startsWith(tokens[2] ?? "")) return [{ value: "quest default-loadout --clear", label: "--clear", description: "Clear the quest default loadout preference" }];
  return null;
}

function materiaSubcommands(): string[] {
  return ["cast", "autocast", "link", "recast", "revive", "casts", "quest", "grid", "loadout", "ui", "status", "continue", "abort"];
}

function shouldAutoStartWebUi(subcommand: string | undefined): boolean {
  return subcommand === "cast" || subcommand === "link" || subcommand === "recast" || subcommand === "revive";
}

function autoStartMateriaWebUi(input: { ctx: ExtensionContext; pi: ExtensionAPI; configuredPath?: string; questControls?: MateriaWebUiQuestControlCallbacks }): void {
  void ensureMateriaWebUi({
    ctx: input.ctx,
    mode: "automatic",
    configuredPath: input.configuredPath,
    pi: input.pi,
    notify: (message, type) => input.ctx.ui.notify(message, type),
    questControls: input.questControls,
  }).then((result) => {
    if (!result.ok) return;
    updateMateriaWebUiStatusWidget(input.ctx, { url: result.url, status: result.status });
    input.ctx.ui.notify(`Materia WebUI ${result.status === "reused" ? "ready" : "started"}: ${result.url}`, "info");
  }).catch((error) => {
    input.ctx.ui.notify(`pi-materia WebUI failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
  });
}

function recastStatusLabel(state: MateriaCastState): string {
  return state.failedReason?.toLowerCase().includes("abort") ? "aborted" : "failed";
}

function revivableStatusLabel(state: MateriaCastState): string {
  if (state.recoveryExhaustion?.kind === "edge_traversal_exhausted") return "edge-exhausted";
  if (state.recoveryExhaustion?.kind === "same_socket_recovery_exhausted") return "recovery-exhausted";
  return "revivable";
}

function revivableStatusSocketId(state: MateriaCastState): string | undefined {
  const exhaustion = state.recoveryExhaustion;
  if (exhaustion?.kind === "edge_traversal_exhausted") return exhaustion.to;
  if (exhaustion?.kind === "same_socket_recovery_exhausted") return exhaustion.socket;
  return undefined;
}

function truncateLine(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, Math.max(0, max - 1))}…` : singleLine;
}


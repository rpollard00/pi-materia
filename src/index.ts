import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ActiveCastConflictError, CastCatalogUseCases, CastExecutionUseCases, LoadoutUseCases, configuredConfigPath, type CastStateRepository } from "./application/index.js";
import type { MateriaCastState } from "./types.js";
import { currentCastSocketId } from "./runtime/castStateAccessors.js";
import { publishActiveLoadoutChange } from "./presentation/activeLoadoutEvents.js";
import { registerMateriaRenderer } from "./presentation/renderer.js";
import { closeMateriaWebUiForSession, initializeDefaultLoadoutPreference } from "./webui/launcher.js";
import { ensureMateriaWebUi } from "./webui/service.js";
import { clearMateriaAuxiliaryWidgets, clearWidgetTicker, renderMateriaCastStatusWidget, updateWidget } from "./presentation/ui.js";
import { createMateriaPluginAdapters } from "./runtime/pluginAdapters.js";
export { renderCastList } from "./infrastructure/index.js";

export default function piMateria(pi: ExtensionAPI) {
  registerMateriaRenderer(pi);
  let activeContext: ExtensionContext | undefined;
  const adapters = createMateriaPluginAdapters();
  const getConfiguredConfigPath = () => configuredConfigPath(pi, adapters.environment);
  const loadoutUseCases = new LoadoutUseCases({ configs: adapters.configs, pipeline: adapters.pipeline, logger: adapters.logger });
  const castCatalogUseCases = new CastCatalogUseCases({ configs: adapters.configs, states: adapters.states, artifacts: adapters.artifacts });
  const castExecutionUseCases = new CastExecutionUseCases({ states: adapters.states, context: adapters.context, agentTurns: adapters.agentTurns, lifecycle: adapters.lifecycle, statusPresenter: adapters.statusPresenter, loadouts: loadoutUseCases, configs: adapters.configs, pipeline: adapters.pipeline });

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
    await castExecutionUseCases.handleAgentEnd(pi, event, ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    await initializeDefaultLoadoutPreference(ctx, getConfiguredConfigPath(), pi);
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
    description: "Run pi-materia commands: cast, link, recast, revive, casts, grid, loadout, ui, status, continue, abort.",
    getArgumentCompletions: (prefix) => getMateriaArgumentCompletions(prefix, activeContext, adapters.states),
    handler: async (args, ctx) => {
      activeContext = ctx;
      const trimmedArgs = args.trimStart();
      const [subcommand, ...rest] = trimmedArgs.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "ui") {
        try {
          const result = await ensureMateriaWebUi({ ctx, mode: "explicit", configuredPath: getConfiguredConfigPath(), pi });
          if (!result.ok) return;
          const reused = result.status === "reused";
          const lines = [`WebUI ${reused ? "ready" : "started"}: ${truncateLine(result.url, 110)}`];
          clearMateriaAuxiliaryWidgets(ctx);
          ctx.ui.notify(`Materia WebUI ${reused ? "ready" : "started"}: ${result.url}`, "info");
          pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "ui", materiaName: "orchestrator", eventType: "ui", url: result.url, sessionKey: result.sessionKey } });
          pi.appendEntry("pi-materia-webui", { url: result.url, sessionKey: result.sessionKey, reused, startedAt: Date.now() });
        } catch (error) {
          ctx.ui.notify(`pi-materia ui failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (shouldAutoStartWebUi(subcommand)) {
        autoStartMateriaWebUi({ ctx, pi, configuredPath: getConfiguredConfigPath() });
      }

      await ctx.waitForIdle();

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
        const lines = renderMateriaCastStatusWidget(state);
        clearMateriaAuxiliaryWidgets(ctx);
        ctx.ui.setWidget("materia", lines, { placement: "belowEditor" });
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
            ctx.ui.notify("No failed pi-materia casts exhausted by same-socket recovery are available to revive. Use /materia recast [cast-id] for general failed or aborted casts.", "info");
            return;
          }
        } catch (error) {
          ctx.ui.notify(`pi-materia revive failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand !== "cast") {
        ctx.ui.notify("Usage: /materia cast <task>, /materia link [--from <castId>] <target> [<target> ...] -- <prompt>, /materia recast [cast-id], /materia revive [cast-id] (only after same-socket recovery attempts are exhausted; adds the original attempt allowance then recasts), /materia casts, /materia grid, /materia loadout [name], /materia ui, /materia status, /materia continue, or /materia abort", "error");
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

function getMateriaArgumentCompletions(prefix: string, ctx: ExtensionContext | undefined, statesRepository: Pick<CastStateRepository<ExtensionContext>, "listResumable" | "listRevivable">): Array<{ value: string; label: string; description?: string }> | null {
  const trimmedStart = prefix.trimStart();
  const tokens = trimmedStart.split(/\s+/).filter(Boolean);
  const endsWithWhitespace = /\s$/.test(prefix);

  if (tokens.length === 0 && !endsWithWhitespace) {
    const subcommands = materiaSubcommands();
    return subcommands.map((value) => ({ value, label: value }));
  }

  if (tokens.length === 1 && !endsWithWhitespace) {
    const subcommands = materiaSubcommands();
    const matching = subcommands.filter((value) => value.startsWith(tokens[0]));
    return matching.length ? matching.map((value) => ({ value, label: value })) : null;
  }

  if ((tokens[0] !== "recast" && tokens[0] !== "revive") || !ctx) return null;
  const command = tokens[0];
  const castIdPrefix = endsWithWhitespace ? "" : (tokens[1] ?? "");
  const states = command === "revive" ? statesRepository.listRevivable(ctx) : statesRepository.listResumable(ctx);
  const completions = states
    .filter((state) => state.castId.startsWith(castIdPrefix))
    .map((state) => ({
      value: `${command} ${state.castId}`,
      label: `${state.castId}  ${command === "revive" ? "revivable" : recastStatusLabel(state)}  socket:${currentCastSocketId(state) ?? "-"}`,
      description: truncateLine(state.request ?? state.failedReason ?? state.runState?.lastMessage ?? "", 72),
    }));
  return completions.length ? completions : null;
}

function materiaSubcommands(): string[] {
  return ["cast", "link", "recast", "revive", "casts", "grid", "loadout", "ui", "status", "continue", "abort"];
}

function shouldAutoStartWebUi(subcommand: string | undefined): boolean {
  return subcommand === "cast" || subcommand === "link" || subcommand === "recast" || subcommand === "revive";
}

function autoStartMateriaWebUi(input: { ctx: ExtensionContext; pi: ExtensionAPI; configuredPath?: string }): void {
  void ensureMateriaWebUi({
    ctx: input.ctx,
    mode: "automatic",
    configuredPath: input.configuredPath,
    pi: input.pi,
    notify: (message, type) => input.ctx.ui.notify(message, type),
  }).then((result) => {
    if (!result.ok) return;
    input.ctx.ui.notify(`Materia WebUI ${result.status === "reused" ? "ready" : "started"}: ${result.url}`, "info");
  }).catch((error) => {
    input.ctx.ui.notify(`pi-materia WebUI failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
  });
}

function recastStatusLabel(state: MateriaCastState): string {
  return state.failedReason?.toLowerCase().includes("abort") ? "aborted" : "failed";
}

function truncateLine(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, Math.max(0, max - 1))}…` : singleLine;
}


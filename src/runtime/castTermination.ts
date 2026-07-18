import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "./eventBus.js";
import type {
  MateriaCastState,
  MateriaManifestEntry,
  MateriaRunState,
  UsageCostKind,
  UsageTotals,
} from "../types.js";

export interface CastTerminationLifecycleEvent {
  severity?: "debug" | "info" | "warning" | "error";
  message?: string;
  payload?: Record<string, unknown>;
}

interface ResultAccumulatorView {
  deriveOutcome(): unknown;
  getResultEvents(): ReadonlyArray<{ type: string }>;
}

export interface CastTerminationDependencies {
  eventing: {
    stopHeartbeat(castId: string): void;
    emitLifecycleEvent(
      state: MateriaCastState,
      type: string,
      overrides?: CastTerminationLifecycleEvent,
    ): Promise<void>;
    getEventBus(state: MateriaCastState): EventBus | undefined;
    getResultAccumulator(state: MateriaCastState): ResultAccumulatorView | undefined;
    flushBusOutcomes(bus: EventBus, runDir: string): Promise<void>;
    removeEventBus(castId: string): void;
  };
  artifacts: {
    appendEvent(state: MateriaRunState, type: string, data: unknown): Promise<void>;
    appendManifest(
      state: MateriaCastState,
      entry: Omit<MateriaManifestEntry, "timestamp">,
    ): Promise<void>;
    writeUsage(state: MateriaRunState): Promise<void>;
  };
  state: {
    clearCastState(
      pi: ExtensionAPI,
      state: MateriaCastState,
      reason?: string,
    ): MateriaCastState;
    saveCastState(pi: ExtensionAPI, state: MateriaCastState): void;
    currentSocketId(state: MateriaCastState): string | undefined;
    setCurrentSocketState(
      state: MateriaCastState,
      socketState: MateriaCastState["socketState"],
    ): void;
  };
  finalization?: {
    deactivate(pi: ExtensionAPI): void;
  };
  ui: {
    updateWidget(ctx: ExtensionContext, state: MateriaCastState): unknown;
    showUsageSummary(ctx: ExtensionContext, state: MateriaRunState): void;
    formatUsage(usage: UsageTotals, costKind?: UsageCostKind): string;
  };
}

export interface FailCastOptions {
  preserveRecoveryExhaustion?: boolean;
}

export interface CastStartFailure {
  errorMessage: string | undefined;
  entryId: string;
  entryMateria?: string;
  lifecyclePayload: Record<string, unknown>;
}

/**
 * Creates the terminal-transition coordinator used by the native runtime.
 * Dependencies are supplied by the lifecycle composition root so this module
 * owns transition ordering without depending on the lifecycle orchestrator.
 */
export function createCastTermination(deps: CastTerminationDependencies) {
  async function flushTerminalEventBus(
    state: MateriaCastState,
    bus: EventBus,
    removeAfterFlush: boolean,
  ): Promise<void> {
    try { await bus.flush(); } catch { /* best-effort */ }
    try { await deps.eventing.flushBusOutcomes(bus, state.runDir); } catch { /* best-effort */ }
    if (removeAfterFlush) deps.eventing.removeEventBus(state.castId);
  }

  function markRunEnded(state: MateriaCastState): void {
    state.runState.endedAt ??= Date.now();
  }

  /** Cancel a cast after delivering its terminal lifecycle event. */
  async function cancelNativeCast(
    pi: ExtensionAPI,
    state: MateriaCastState,
    reason = "aborted by user",
  ): Promise<MateriaCastState> {
    deps.finalization?.deactivate(pi);
    // Stop heartbeat before emitting the terminal event so no heartbeat fires
    // after cancellation (docs/runtime-eventing.md §7.4).
    deps.eventing.stopHeartbeat(state.castId);

    await deps.eventing.emitLifecycleEvent(state, "lifecycle.cast.cancelled", {
      severity: "warning",
      message: reason,
      payload: { reason },
    });

    const bus = deps.eventing.getEventBus(state);
    if (bus) await flushTerminalEventBus(state, bus, false);

    // clearCastState also guards this timestamp; set it here to retain the
    // terminal event/artifact/state ordering of native cancellation.
    markRunEnded(state);
    const cleared = deps.state.clearCastState(pi, state, reason);
    deps.eventing.removeEventBus(state.castId);
    return cleared;
  }

  /** Persist the special fail-fast transition used while starting a cast. */
  async function failCastAtStart(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    eventBus: EventBus | undefined,
    failure: CastStartFailure,
  ): Promise<void> {
    await deps.eventing.emitLifecycleEvent(state, "lifecycle.cast.failed", {
      severity: "error",
      message: failure.errorMessage,
      payload: failure.lifecyclePayload,
    });

    // This path starts its heartbeat before validation. Preserve its existing
    // ordering by removing the bus (and heartbeat) only after the flush.
    if (eventBus) await flushTerminalEventBus(state, eventBus, true);

    await deps.artifacts.appendEvent(state.runState, "cast_end", {
      ok: false,
      error: failure.errorMessage,
      socket: failure.entryId,
    });
    await deps.artifacts.writeUsage(state.runState);
    await deps.artifacts.appendManifest(state, {
      phase: "failed",
      socket: failure.entryId,
      materia: failure.entryMateria,
    });
    state.active = false;
    state.phase = "failed";
    state.failedReason = failure.errorMessage;
    state.runState.endedAt = Date.now();
    deps.state.saveCastState(pi, state);
    ctx.ui.setStatus("materia", "failed");
    deps.ui.updateWidget(ctx, state);
    ctx.ui.notify(`pi-materia cast failed: ${failure.errorMessage}`, "error");
  }

  /** Transition an active cast to its failed terminal state. */
  async function failCast(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    error: unknown,
    entryId?: string,
    options: FailCastOptions = {},
  ): Promise<void> {
    deps.finalization?.deactivate(pi);
    if (!options.preserveRecoveryExhaustion) state.recoveryExhaustion = undefined;
    state.active = false;
    state.awaitingResponse = false;
    state.multiTurnFinalizing = false;
    deps.state.setCurrentSocketState(state, "failed");
    state.phase = "failed";
    state.failedReason = error instanceof Error ? error.message : String(error);
    state.runState.lastMessage = state.failedReason;
    markRunEnded(state);

    deps.eventing.stopHeartbeat(state.castId);

    await deps.eventing.emitLifecycleEvent(state, "lifecycle.cast.failed", {
      severity: "error",
      message: state.failedReason,
      payload: {
        error: state.failedReason,
        socketId: deps.state.currentSocketId(state),
        materia: state.currentMateria,
        ...(state.currentItemKey !== undefined ? { itemKey: state.currentItemKey } : {}),
      },
    });

    const bus = deps.eventing.getEventBus(state);
    if (bus) await flushTerminalEventBus(state, bus, true);

    await deps.artifacts.appendEvent(state.runState, "cast_end", {
      ok: false,
      error: state.failedReason,
      entryId,
      socket: deps.state.currentSocketId(state),
    });
    await deps.artifacts.writeUsage(state.runState);
    await deps.artifacts.appendManifest(state, {
      phase: "failed",
      socket: deps.state.currentSocketId(state),
      materia: state.currentMateria,
      itemKey: state.currentItemKey,
      entryId,
    });
    deps.state.saveCastState(pi, state);
    ctx.ui.setStatus("materia", "failed");
    deps.ui.updateWidget(ctx, state);
    ctx.ui.notify(`pi-materia cast failed: ${state.failedReason}`, "error");
  }

  /** Transition an active cast to successful completion. */
  async function finishCast(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: MateriaCastState,
    entryId: string,
    message: string,
  ): Promise<void> {
    deps.finalization?.deactivate(pi);
    state.active = false;
    state.phase = "complete";
    state.awaitingResponse = false;
    state.multiTurnFinalizing = false;
    deps.state.setCurrentSocketState(state, "complete");
    state.recoveryExhaustion = undefined;
    state.failedReason = undefined;
    state.updatedAt = Date.now();
    state.runState.lastMessage = message;
    markRunEnded(state);

    deps.eventing.stopHeartbeat(state.castId);

    const accumulator = deps.eventing.getResultAccumulator(state);
    const outcome = accumulator?.deriveOutcome() ?? "patch_created";
    const resultEvents = accumulator?.getResultEvents() ?? [];
    await deps.eventing.emitLifecycleEvent(state, "lifecycle.cast.completed", {
      severity: "info",
      message,
      payload: {
        outcome,
        resultCount: resultEvents.length,
        resultTypes: resultEvents.map((event) => event.type),
      },
    });

    const bus = deps.eventing.getEventBus(state);
    if (bus) await flushTerminalEventBus(state, bus, true);

    await deps.artifacts.writeUsage(state.runState);
    await deps.artifacts.appendEvent(state.runState, "cast_end", {
      ok: true,
      usage: state.runState.usage,
      entryId,
    });
    await deps.artifacts.appendManifest(state, { phase: "complete", entryId });
    deps.state.saveCastState(pi, state);
    ctx.ui.setStatus("materia", "done");
    deps.ui.updateWidget(ctx, state);
    deps.ui.showUsageSummary(ctx, state.runState);
    ctx.ui.notify(
      `pi-materia cast complete. ${deps.ui.formatUsage(state.runState.usage, state.runState.usage.costKind)}`,
      "info",
    );
  }

  return {
    cancelNativeCast,
    failCastAtStart,
    failCast,
    finishCast,
  };
}

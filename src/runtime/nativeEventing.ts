import { randomUUID } from "node:crypto";
import {
  ResultAccumulator,
  createSequenceCounter,
  enrichEvents,
  type EnrichmentContext,
  type EventSeverity,
  type MateriaEventObject,
} from "../domain/eventing.js";
import { evaluateAgentControllerWebhookStatus } from "../eventing/diagnostics.js";
import { detectControllerLaunch, expandPresets, resolveControllerRunId } from "../eventing/presets.js";
import { appendEvent } from "../infrastructure/castArtifacts.js";
import type {
  EventingConfig,
  EventingWebhookSinkConfig,
  EventSinkConfig,
  MateriaCastState,
  PiMateriaConfig,
} from "../types.js";
import { createEventBus, type EventBus } from "./eventBus.js";
import { WebhookSink } from "./webhookSink.js";

export interface CentralTelemetryDiagnostic {
  readonly severity: "info" | "warning";
  readonly reason: "active" | "telemetry_credential_missing" | "configuration_unavailable" | "sink_invalid";
  readonly message: string;
}

export interface CentralTelemetrySinkResolution {
  readonly sink?: EventingWebhookSinkConfig;
  readonly diagnostic?: CentralTelemetryDiagnostic;
}

/** Adapter boundary that turns opt-in central configuration into a webhook sink. */
export interface CentralTelemetrySinkResolver {
  resolve(state: MateriaCastState): Promise<CentralTelemetrySinkResolution | undefined>;
}

const localOnlyCentralTelemetryResolver: CentralTelemetrySinkResolver = {
  resolve: async () => undefined,
};

export interface LifecycleEventOverrides {
  severity?: EventSeverity;
  message?: string;
  payload?: Record<string, unknown>;
  socketId?: string;
  materia?: string;
  materiaLabel?: string;
  visit?: number;
  itemKey?: string;
  itemLabel?: string;
}

/**
 * Owns the mutable eventing resources shared by native cast lifecycle flows.
 * A single instance is exported so starts, resumes, socket events, and terminal
 * transitions all observe the same per-cast registries.
 */
export class NativeEventingRuntime {
  private readonly eventBuses = new Map<string, EventBus>();
  private readonly sequenceCounters = new Map<string, ReturnType<typeof createSequenceCounter>>();
  private readonly resultAccumulators = new Map<string, ResultAccumulator>();
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  private centralTelemetryResolver: CentralTelemetrySinkResolver;

  constructor(centralTelemetryResolver: CentralTelemetrySinkResolver = localOnlyCentralTelemetryResolver) {
    this.centralTelemetryResolver = centralTelemetryResolver;
  }

  setCentralTelemetrySinkResolver(resolver: CentralTelemetrySinkResolver): void {
    this.centralTelemetryResolver = resolver;
  }

  /** Compatibility access for nativeTestInternals; returns the shared registry. */
  get castEventBuses(): Map<string, EventBus> {
    return this.eventBuses;
  }

  /** Compatibility access for nativeTestInternals; returns the shared registry. */
  get castHeartbeats(): Map<string, ReturnType<typeof setInterval>> {
    return this.heartbeats;
  }

  getEventBus(state: MateriaCastState): EventBus | undefined {
    return this.eventBuses.get(state.castId);
  }

  /** Get the result accumulator for a cast, if eventing is enabled. */
  getResultAccumulator(state: MateriaCastState): ResultAccumulator | undefined {
    return this.resultAccumulators.get(state.castId);
  }

  /**
   * Enrich, accumulate, and dispatch validated materia events using the cast's
   * shared sequence counter. Result events are recorded before any dispatch.
   */
  async dispatchMateriaEvents(
    state: MateriaCastState,
    events: MateriaEventObject[],
    buildEnrichmentContext: () => EnrichmentContext,
  ): Promise<void> {
    const bus = this.getEventBus(state);
    const sequence = this.sequenceCounters.get(state.castId);
    if (!bus || !sequence) return;

    const enrichedEvents = enrichEvents(events, buildEnrichmentContext(), sequence, () => randomUUID());
    const accumulator = this.getResultAccumulator(state);
    if (accumulator) {
      for (const event of enrichedEvents) {
        accumulator.record(event);
      }
    }

    for (const event of enrichedEvents) {
      await bus.dispatch(event);
    }
  }

  /**
   * Emit a runtime-owned lifecycle event through the same eventing path used by
   * materia output. Missing eventing state is a silent no-op.
   */
  async emitLifecycleEvent(
    state: MateriaCastState,
    type: string,
    overrides: LifecycleEventOverrides = {},
  ): Promise<void> {
    const bus = this.getEventBus(state);
    if (!bus) return;

    const sequence = this.sequenceCounters.get(state.castId);
    if (!sequence) return;

    const materiaEvent: MateriaEventObject = {
      type,
      severity: overrides.severity ?? "info",
      ...(overrides.message !== undefined ? { message: overrides.message } : {}),
      ...(overrides.payload !== undefined ? { payload: overrides.payload } : {}),
    };
    const enrichmentContext: EnrichmentContext = {
      castId: state.castId,
      socketId: overrides.socketId ?? "lifecycle",
      materia: overrides.materia ?? "pi-materia",
      ...(overrides.materiaLabel !== undefined ? { materiaLabel: overrides.materiaLabel } : {}),
      visit: overrides.visit ?? 0,
      ...(overrides.itemKey !== undefined ? { itemKey: overrides.itemKey } : {}),
      ...(overrides.itemLabel !== undefined ? { itemLabel: overrides.itemLabel } : {}),
    };

    const enrichedEvents = enrichEvents([materiaEvent], enrichmentContext, sequence, () => randomUUID());
    for (const event of enrichedEvents) {
      await bus.dispatch(event);
    }
  }

  /** Start the configured, opt-in heartbeat interval for a cast. */
  startHeartbeat(state: MateriaCastState, config: PiMateriaConfig): void {
    if (!config.eventing?.enabled) return;
    const intervalMs = config.eventing?.heartbeatIntervalMs;
    if (!intervalMs || intervalMs <= 0) return;
    if (!this.eventBuses.has(state.castId)) return;

    this.stopHeartbeat(state.castId);

    const startedAt = state.startedAt;
    const castId = state.castId;
    const interval = setInterval(() => {
      if (!this.eventBuses.has(castId)) {
        this.stopHeartbeat(castId);
        return;
      }

      void this.emitLifecycleEvent(state, "lifecycle.heartbeat", {
        severity: "debug",
        payload: {
          phase: state.phase,
          elapsedMs: Date.now() - startedAt,
          socketId: state.currentSocketId,
        },
      });
    }, intervalMs);

    interval.unref();
    this.heartbeats.set(castId, interval);
  }

  /** Stop and forget a cast heartbeat. Safe to call repeatedly. */
  stopHeartbeat(castId: string): void {
    const interval = this.heartbeats.get(castId);
    if (interval !== undefined) {
      clearInterval(interval);
      this.heartbeats.delete(castId);
    }
  }

  /** Remove all eventing state for a cast, including its heartbeat timer. */
  removeEventBus(castId: string): void {
    this.stopHeartbeat(castId);
    this.eventBuses.delete(castId);
    this.sequenceCounters.delete(castId);
    this.resultAccumulators.delete(castId);
  }

  /** Create and register the event bus and configured/central sinks for a cast. */
  async initializeCastEventBus(config: PiMateriaConfig, state: MateriaCastState): Promise<EventBus | undefined> {
    const eventing = config.eventing;
    const controllerContextDir = process.env["CONTROLLER_CONTEXT_DIR"]?.trim();
    const controller = detectControllerLaunch();
    const runIdResolved = Boolean(resolveControllerRunId(controllerContextDir));
    let centralResolution: CentralTelemetrySinkResolution | undefined;

    try {
      centralResolution = await this.centralTelemetryResolver.resolve(state);
    } catch {
      centralResolution = {
        diagnostic: {
          severity: "warning",
          reason: "configuration_unavailable",
          message: "Central telemetry configuration could not be resolved; the local cast will continue without central delivery.",
        },
      };
    }
    this.surfaceCentralTelemetryDiagnostic(state, centralResolution?.diagnostic);

    if (!eventing?.enabled && !centralResolution?.sink) {
      this.surfaceAgentControllerDiagnostics(state, {
        eventing,
        agentControllerSink: this.pickAgentControllerSink(eventing?.sinks),
        controller,
        runIdResolved,
      });
      return undefined;
    }

    const bus = createEventBus(state.runDir);
    const sequence = createSequenceCounter();
    const accumulator = new ResultAccumulator();
    const resolvedSinks: Record<string, EventSinkConfig> = {};

    // Explicit eventing remains independently opt-in. A central connection can
    // create the shared bus without accidentally activating configured controller
    // sinks or heartbeat behavior.
    if (eventing?.enabled) {
      Object.assign(resolvedSinks, eventing.sinks);
      if (eventing.presets && eventing.presets.length > 0) {
        const expanded = expandPresets(
          eventing.presets,
          eventing.sinks,
          controllerContextDir,
        );
        for (const [sinkId, sinkConfig] of Object.entries(expanded.sinks)) {
          if (!(sinkId in resolvedSinks)) {
            resolvedSinks[sinkId] = sinkConfig;
          }
        }
        for (const warning of expanded.warnings) {
          appendEvent(state.runState, "eventing_preset_warning", { warning }).catch(() => {});
        }
      }
    }

    this.surfaceAgentControllerDiagnostics(state, {
      eventing,
      agentControllerSink: this.pickAgentControllerSink(resolvedSinks),
      controller,
      runIdResolved,
    });

    for (const sinkConfig of Object.values(resolvedSinks)) {
      if (sinkConfig.id === centralResolution?.sink?.id) continue;
      if (!this.isEnabledWebhookSinkConfig(sinkConfig)) continue;
      try {
        bus.register(new WebhookSink(sinkConfig));
      } catch {
        // Sink creation is non-fatal; the cast continues without this sink.
      }
    }

    if (centralResolution?.sink) {
      try {
        bus.register(new WebhookSink(centralResolution.sink));
      } catch {
        this.surfaceCentralTelemetryDiagnostic(state, {
          severity: "warning",
          reason: "sink_invalid",
          message: "Central telemetry sink configuration is invalid; the local cast will continue without central delivery.",
        });
      }
    }

    this.eventBuses.set(state.castId, bus);
    this.sequenceCounters.set(state.castId, sequence);
    this.resultAccumulators.set(state.castId, accumulator);
    return bus;
  }

  private isEnabledWebhookSinkConfig(config: unknown): config is EventingWebhookSinkConfig {
    if (typeof config !== "object" || config === null) return false;
    const candidate = config as Record<string, unknown>;
    if (candidate.enabled === false) return false;
    return typeof candidate.url === "string" && candidate.url.trim().length > 0;
  }

  private pickAgentControllerSink(
    sinks: Record<string, EventSinkConfig> | undefined,
  ): EventSinkConfig | undefined {
    return sinks?.["agent-controller-webhook"];
  }

  private surfaceCentralTelemetryDiagnostic(
    state: MateriaCastState,
    diagnostic: CentralTelemetryDiagnostic | undefined,
  ): void {
    if (!diagnostic) return;
    if (diagnostic.severity === "warning") {
      console.warn(`[pi-materia] central telemetry: ${diagnostic.message}`);
    }
    appendEvent(state.runState, "central_telemetry_diagnostic", {
      severity: diagnostic.severity,
      reason: diagnostic.reason,
      message: diagnostic.message,
      active: diagnostic.reason === "active",
    }).catch(() => {});
  }

  /** Surface webhook activation diagnostics without affecting cast progress. */
  private surfaceAgentControllerDiagnostics(
    state: MateriaCastState,
    input: {
      eventing?: EventingConfig;
      agentControllerSink?: EventSinkConfig;
      controller?: ReturnType<typeof detectControllerLaunch>;
      runIdResolved?: boolean;
    },
  ): void {
    const status = evaluateAgentControllerWebhookStatus(input);
    if (!status.expected) return;

    for (const diagnostic of status.diagnostics) {
      console.warn(`[pi-materia] agent-controller webhook: ${diagnostic.message}`);
      appendEvent(state.runState, "eventing_webhook_diagnostic", {
        severity: diagnostic.severity,
        reason: diagnostic.reason,
        message: diagnostic.message,
        active: status.active,
        ...(status.targetUrl ? { targetUrl: status.targetUrl } : {}),
      }).catch(() => {});
    }
  }
}

export const nativeEventing = new NativeEventingRuntime();

/** Register the connected-runtime adapter during plugin composition. */
export function setCentralTelemetrySinkResolver(resolver: CentralTelemetrySinkResolver): void {
  nativeEventing.setCentralTelemetrySinkResolver(resolver);
}

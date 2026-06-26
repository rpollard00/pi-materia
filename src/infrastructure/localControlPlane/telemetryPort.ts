import {
  type ControlPlaneStatusSnapshot,
  type TelemetryEventFilter,
  type TelemetryIngestInput,
  type TelemetryIngestResult,
  type TelemetryStatusPort,
} from "../../application/controlPlane.js";
import type { EnrichedEvent } from "../../domain/eventing.js";
import { type LocalControlPlaneAdapterOptions, localAdapterModeMetadata, nowIso } from "./shared.js";

/**
 * Local telemetry/status port.
 *
 * Exposes existing local monitoring data (runtime events, runtime identity,
 * health) read-only through control-plane status/query DTOs. Local artifact
 * monitoring is unchanged; this port is not a replacement for it
 * (docs/enterprise-control-plane.md §15). Ingestion has no central target in
 * local-only mode, so {@link TelemetryStatusPort.ingest} is a best-effort
 * acknowledgement that does not persist.
 */
export function createLocalTelemetryStatusPort(options: LocalControlPlaneAdapterOptions): TelemetryStatusPort {
  const mode = () => localAdapterModeMetadata(options);

  async function readEvents(): Promise<readonly EnrichedEvent[]> {
    const source = options.monitoringSource?.getRuntimeEvents;
    if (typeof source !== "function") return [];
    try {
      return (await source()) ?? [];
    } catch {
      // Monitoring is best-effort; degrade to empty reads rather than failing.
      return [];
    }
  }

  async function readHealthy(): Promise<boolean> {
    if (!options.monitoringSource?.isHealthy) return true;
    try {
      return (await options.monitoringSource.isHealthy()) ?? true;
    } catch {
      return false;
    }
  }

  return {
    mode,
    async ingest(input: TelemetryIngestInput): Promise<TelemetryIngestResult> {
      // No central ingestion target exists in local-only mode. The same events
      // are already captured by local session monitoring and surfaced read-only
      // via queryEvents/status. Acknowledge receipt best-effort without persisting.
      return { accepted: input.events.length, ingestedAt: nowIso() };
    },
    async status(): Promise<ControlPlaneStatusSnapshot> {
      const events = await readEvents();
      const snapshot: ControlPlaneStatusSnapshot = {
        mode: "local-only",
        capturedAt: nowIso(),
        runtimeCount: 1,
        eventCount: events.length,
        healthy: await readHealthy(),
        ...(options.label !== undefined ? { label: options.label } : {}),
      };
      return snapshot;
    },
    async queryEvents(filter?: TelemetryEventFilter): Promise<EnrichedEvent[]> {
      const events = await readEvents();
      const filtered = events.filter((event) => matchesEventFilter(event, filter));
      if (filter?.limit !== undefined && filter.limit >= 0) return filtered.slice(0, filter.limit);
      return filtered;
    },
  };
}

function matchesEventFilter(event: EnrichedEvent, filter: TelemetryEventFilter | undefined): boolean {
  if (!filter) return true;
  // In local-only mode the runtime identity resolves to the cast id, so both the
  // runtimeId and castId filters match against the event's cast id.
  if (filter.runtimeId !== undefined && event.castId !== filter.runtimeId) return false;
  if (filter.castId !== undefined && event.castId !== filter.castId) return false;
  if (filter.sinceSequence !== undefined && (typeof event.sequence !== "number" || event.sequence < filter.sinceSequence)) return false;
  return true;
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "../types.js";
import { renderLoadoutList } from "../loadout/loadouts.js";
import { syncConfiguredLoadoutWidget } from "./ui.js";

export const ACTIVE_LOADOUT_CHANGED_EVENT = "active-loadout-changed";
export const ACTIVE_LOADOUT_CHANGED_ENTRY = "pi-materia-active-loadout-changed";

export type ActiveLoadoutChangeSource = "command" | "webui";

export interface ActiveLoadoutChangeEvent {
  eventType: typeof ACTIVE_LOADOUT_CHANGED_EVENT;
  source: ActiveLoadoutChangeSource;
  activeLoadout: string;
  activeLoadoutId?: string;
  configSource?: string;
  configPath?: string;
  loadouts: string[];
  timestamp: number;
}

export interface PublishActiveLoadoutChangeOptions {
  source: ActiveLoadoutChangeSource;
  loaded: LoadedConfig;
  writtenPath?: string;
  notifyMessage?: string;
  setLoadoutWidget?: boolean;
}

export interface PublishActiveLoadoutChangeResult {
  event: ActiveLoadoutChangeEvent;
  lines: string[];
}

export function publishActiveLoadoutChange(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: PublishActiveLoadoutChangeOptions,
): PublishActiveLoadoutChangeResult {
  const activeLoadout = options.loaded.config.activeLoadout ?? "";
  const activeLoadoutId = options.loaded.config.activeLoadoutId;
  const lines = renderLoadoutList(options.loaded.config, options.loaded.source);
  const event: ActiveLoadoutChangeEvent = {
    eventType: ACTIVE_LOADOUT_CHANGED_EVENT,
    source: options.source,
    activeLoadout,
    ...(activeLoadoutId ? { activeLoadoutId } : {}),
    ...(options.loaded.source ? { configSource: options.loaded.source } : {}),
    ...(options.writtenPath ? { configPath: options.writtenPath } : {}),
    loadouts: Object.keys(options.loaded.config.loadouts ?? {}),
    timestamp: Date.now(),
  };

  if (options.setLoadoutWidget ?? true) {
    ctx.ui.setWidget("materia-loadouts", lines, { placement: "belowEditor" });
  }
  syncConfiguredLoadoutWidget(ctx, activeLoadout);
  if (options.notifyMessage) ctx.ui.notify(options.notifyMessage, "info");

  pi.sendMessage({
    customType: "pi-materia",
    content: lines.join("\n"),
    display: true,
    details: {
      prefix: "loadout",
      materiaName: "orchestrator",
      // Keep existing loadout message details compatible while attaching the canonical event payload.
      eventType: "loadout",
      source: event.source,
      name: event.activeLoadout,
      activeLoadout: event.activeLoadout,
      activeLoadoutId: event.activeLoadoutId,
      configSource: event.configSource,
      configPath: event.configPath,
      timestamp: event.timestamp,
      loadoutEvent: event,
    },
  });
  pi.appendEntry(ACTIVE_LOADOUT_CHANGED_ENTRY, { ...event, lines });
  return { event, lines };
}

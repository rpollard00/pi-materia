import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { launchMateriaWebUi, type MateriaWebUiQuestControlCallbacks } from "./launcher.js";

export type MateriaWebUiEnsureMode = "explicit" | "automatic";
export type MateriaWebUiEnsureStatus = "started" | "reused";

export interface MateriaWebUiEnsureSuccess {
  ok: true;
  url: string;
  status: MateriaWebUiEnsureStatus;
  sessionKey: string;
  autoOpenBrowser: boolean;
}

export interface MateriaWebUiEnsureFailure {
  ok: false;
  status: "failed";
  error: unknown;
}

export type MateriaWebUiEnsureResult = MateriaWebUiEnsureSuccess | MateriaWebUiEnsureFailure;

export interface MateriaWebUiEnsureOptions {
  ctx: ExtensionContext;
  mode: MateriaWebUiEnsureMode;
  configuredPath?: string;
  pi?: ExtensionAPI;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  questControls?: MateriaWebUiQuestControlCallbacks;
}

/**
 * Ensure the session-scoped Materia WebUI exists without coupling callers to the
 * launcher internals. Automatic mode is intentionally TUI-only: this helper does
 * not send transcript messages, append custom entries, or wait for the agent to
 * become idle.
 */
export async function ensureMateriaWebUi(options: MateriaWebUiEnsureOptions): Promise<MateriaWebUiEnsureResult> {
  try {
    const launched = await launchMateriaWebUi(options.ctx, options.configuredPath, options.pi, {
      questControls: options.questControls,
    });
    return {
      ok: true,
      url: launched.url,
      status: launched.reused ? "reused" : "started",
      sessionKey: launched.sessionKey,
      autoOpenBrowser: launched.autoOpenBrowser,
    };
  } catch (error) {
    const message = `pi-materia WebUI failed to start: ${error instanceof Error ? error.message : String(error)}`;
    options.notify?.(message, "error");
    if (options.mode === "explicit") throw error;
    return { ok: false, status: "failed", error };
  }
}

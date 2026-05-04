import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { platform } from "node:os";
import { createMateriaWebUiServer, type MateriaWebUiSessionSnapshot } from "./server/index.js";
import { loadActiveCastState } from "../native.js";
import { loadConfig, loadProfileConfig, saveMateriaConfigPatch } from "../config.js";

export interface MateriaWebUiLaunchResult {
  url: string;
  reused: boolean;
  autoOpenBrowser: boolean;
  sessionKey: string;
}

interface RunningWebUiServer {
  url: string;
  host: string;
  port: number;
  sessionKey: string;
  autoOpenBrowser: boolean;
  server: ReturnType<typeof createMateriaWebUiServer>["server"];
}

const servers = new Map<string, RunningWebUiServer>();
const pending = new Map<string, Promise<MateriaWebUiLaunchResult>>();

export async function launchMateriaWebUi(ctx: ExtensionContext, configuredPath?: string): Promise<MateriaWebUiLaunchResult> {
  const sessionKey = webUiSessionKey(ctx);
  const existing = servers.get(sessionKey);
  if (existing?.server.listening) {
    return { url: existing.url, reused: true, autoOpenBrowser: existing.autoOpenBrowser, sessionKey };
  }

  const inFlight = pending.get(sessionKey);
  if (inFlight) return inFlight;

  const launch = startServer(ctx, sessionKey, configuredPath).finally(() => pending.delete(sessionKey));
  pending.set(sessionKey, launch);
  return launch;
}

export function closeMateriaWebUiForSession(ctx: ExtensionContext): void {
  const sessionKey = webUiSessionKey(ctx);
  const running = servers.get(sessionKey);
  if (!running) return;
  servers.delete(sessionKey);
  running.server.close();
}

export function webUiSessionKey(ctx: ExtensionContext): string {
  const raw = [ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId(), ctx.cwd].join("\0");
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

async function startServer(ctx: ExtensionContext, sessionKey: string, configuredPath?: string): Promise<MateriaWebUiLaunchResult> {
  const profile = await loadProfileConfig();
  const host = profile.webui?.host?.trim() || "127.0.0.1";
  const port = profile.webui?.preferredPort ?? profile.webui?.port ?? 0;
  const autoOpenBrowser = profile.webui?.autoOpenBrowser ?? profile.webui?.openBrowser ?? false;
  const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
  const sessionId = ctx.sessionManager.getSessionId() ?? "";
  const cwd = ctx.cwd;
  const startedAt = Date.now();

  const { server } = createMateriaWebUiServer({
    host,
    port,
    session: {
      key: sessionKey,
      cwd,
      sessionFile,
      sessionId,
      startedAt,
      getSnapshot: () => currentSessionSnapshot(ctx, sessionKey, startedAt),
      getConfig: () => loadConfig(cwd, configuredPath),
      saveConfig: (patch, target) => saveMateriaConfigPatch(cwd, patch, { target, configuredPath }),
    },
  });

  const actualPort = await listen(server, host, port);
  const url = `http://${host}:${actualPort}/?session=${encodeURIComponent(sessionKey)}`;
  const running: RunningWebUiServer = { url, host, port: actualPort, sessionKey, autoOpenBrowser, server };
  servers.set(sessionKey, running);
  server.once("close", () => {
    if (servers.get(sessionKey) === running) servers.delete(sessionKey);
  });

  if (autoOpenBrowser) openBrowser(url);
  return { url, reused: false, autoOpenBrowser, sessionKey };
}

function listen(server: RunningWebUiServer["server"], host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

function currentSessionSnapshot(ctx: ExtensionContext, sessionKey: string, uiStartedAt: number): MateriaWebUiSessionSnapshot {
  const state = loadActiveCastState(ctx);
  return {
    ok: true,
    scope: "session",
    service: "pi-materia-webui",
    sessionKey,
    cwd: ctx.cwd,
    sessionFile: ctx.sessionManager.getSessionFile() ?? "",
    sessionId: ctx.sessionManager.getSessionId() ?? "",
    uiStartedAt,
    now: Date.now(),
    activeCast: state ? {
      castId: state.castId,
      active: state.active,
      phase: state.phase,
      currentNode: state.currentNode,
      currentRole: state.currentRole,
      nodeState: state.nodeState,
      awaitingResponse: state.awaitingResponse,
      runDir: state.runDir,
      artifactRoot: state.artifactRoot,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
    } : undefined,
  };
}

function openBrowser(url: string): void {
  const os = platform();
  const command = os === "darwin" ? "open" : os === "win32" ? "cmd" : process.env.TERMUX_VERSION ? "termux-open-url" : "xdg-open";
  const args = os === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export const webUiLauncherTestInternals = {
  loadMateriaWebUiProfileConfig: loadProfileConfig,
  webUiSessionKey,
};

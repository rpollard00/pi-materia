import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMateriaWebUiServer, type MateriaMonitorArtifactEntry, type MateriaMonitorEventEntry, type MateriaWebUiSessionSnapshot } from "./server/index.js";
import { loadActiveCastState } from "../native.js";
import { loadConfig, loadProfileConfig, saveMateriaConfigPatch } from "../config.js";
import { generateMateriaRolePrompt } from "../roleGeneration.js";

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

interface MateriaWebUiArtifactOptions {
  clientEntrypoint?: string;
  projectRoot?: string;
}

interface MateriaWebUiBuildOptions extends MateriaWebUiArtifactOptions {
  runBuild?: () => Promise<void>;
}

let materiaWebUiBuildPromise: Promise<void> | undefined;

export async function assertMateriaWebUiArtifactAvailable(options: MateriaWebUiArtifactOptions = {}): Promise<void> {
  const projectRoot = options.projectRoot ?? materiaPackageRoot();
  const clientEntrypoint = options.clientEntrypoint ?? join(projectRoot, "dist", "webui", "client", "index.html");
  if (await fileExists(clientEntrypoint)) return;

  throw new Error(
    `Materia WebUI build artifact is missing: expected ${clientEntrypoint}. `
    + "Build the WebUI before starting it (for example, run `npm run build:webui`) "
    + "or include the committed dist/webui artifacts in the installed package.",
  );
}

async function ensureMateriaWebUiBuilt(options: MateriaWebUiBuildOptions = {}): Promise<void> {
  const projectRoot = options.projectRoot ?? materiaPackageRoot();
  const clientEntrypoint = options.clientEntrypoint ?? join(projectRoot, "dist", "webui", "client", "index.html");
  if (await fileExists(clientEntrypoint)) return;

  if (!materiaWebUiBuildPromise) {
    materiaWebUiBuildPromise = (async () => {
      try {
        await (options.runBuild?.() ?? Promise.reject(new Error("runBuild is required")));
        if (!(await fileExists(clientEntrypoint))) {
          throw new Error(`npm run build:webui completed but ${clientEntrypoint} was not created.`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`npm run build:webui failed: ${message}`);
      }
    })();
  }

  return materiaWebUiBuildPromise;
}

function resetMateriaWebUiBuildPromise(): void {
  materiaWebUiBuildPromise = undefined;
}

export async function launchMateriaWebUi(ctx: ExtensionContext, configuredPath?: string, pi?: ExtensionAPI): Promise<MateriaWebUiLaunchResult> {
  const sessionKey = webUiSessionKey(ctx);
  const existing = servers.get(sessionKey);
  if (existing?.server.listening) {
    return { url: existing.url, reused: true, autoOpenBrowser: existing.autoOpenBrowser, sessionKey };
  }

  const inFlight = pending.get(sessionKey);
  if (inFlight) return inFlight;

  const launch = startServer(ctx, sessionKey, configuredPath, pi).finally(() => pending.delete(sessionKey));
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

async function startServer(ctx: ExtensionContext, sessionKey: string, configuredPath?: string, pi?: ExtensionAPI): Promise<MateriaWebUiLaunchResult> {
  await assertMateriaWebUiArtifactAvailable();

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
      generateMateriaRole: pi ? (request) => generateMateriaRolePrompt(pi, ctx, request) : undefined,
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

async function currentSessionSnapshot(ctx: ExtensionContext, sessionKey: string, uiStartedAt: number): Promise<MateriaWebUiSessionSnapshot> {
  const state = loadActiveCastState(ctx);
  const artifactSummary = state?.runDir ? await readArtifactSummary(state.runDir) : undefined;
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
    emittedOutputs: readSessionEmittedOutputs(ctx, uiStartedAt),
    artifactSummary,
    activeCast: state ? {
      castId: state.castId,
      active: state.active,
      phase: state.phase,
      currentNode: state.currentNode,
      currentMateria: state.currentMateria,
      nodeState: state.nodeState,
      awaitingResponse: state.awaitingResponse,
      runDir: state.runDir,
      artifactRoot: state.artifactRoot,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
    } : undefined,
  };
}

function readSessionEmittedOutputs(ctx: ExtensionContext, since: number): Array<{ id: string; type: string; text: string; timestamp?: number; node?: string }> {
  return ctx.sessionManager.getBranch().slice(-80).flatMap((entry) => {
    const rawTimestamp = (entry as { timestamp?: unknown }).timestamp;
    const timestamp = typeof rawTimestamp === "number" ? rawTimestamp : typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : undefined;
    if (timestamp && Number.isFinite(timestamp) && timestamp < since) return [];
    if (entry.type === "custom" && typeof entry.customType === "string" && entry.customType.startsWith("pi-materia")) {
      const data = (entry as { data?: Record<string, unknown> }).data ?? {};
      return [{ id: entry.id, type: entry.customType, text: summarizeUnknown(data), timestamp, node: typeof data.nodeId === "string" ? data.nodeId : undefined }];
    }
    if (entry.type === "message") {
      const message = (entry as { message?: unknown }).message as { role?: unknown; content?: unknown } | undefined;
      const text = messageContentText(message?.content).trim();
      if (message?.role === "assistant" && text) return [{ id: entry.id, type: "assistant", text: truncate(text, 1200), timestamp }];
    }
    return [];
  });
}

async function readArtifactSummary(runDir: string): Promise<MateriaWebUiSessionSnapshot["artifactSummary"]> {
  const [manifest, events] = await Promise.all([
    readJsonFile<{ request?: string; entries?: MateriaMonitorArtifactEntry[] }>(`${runDir}/manifest.json`),
    readEventsFile(`${runDir}/events.jsonl`),
  ]);
  const outputs = await Promise.all((manifest?.entries ?? [])
    .filter((entry) => entry.artifact && (entry.kind === "node_output" || entry.kind === "node_refinement" || entry.kind === "context" || entry.kind === undefined))
    .slice(-12)
    .map(async (entry) => ({ ...entry, content: await readArtifactText(runDir, entry.artifact) })));
  const completed = outputs.filter((entry) => entry.kind === "node_output").map((entry) => entry.node).filter(Boolean).join(" → ");
  const lastEvent = events.at(-1);
  return {
    runDir,
    request: manifest?.request,
    events: events.slice(-40),
    outputs,
    summary: [
      manifest?.request ? `Request: ${manifest.request}` : undefined,
      completed ? `Completed nodes: ${completed}` : undefined,
      lastEvent?.type ? `Latest event: ${lastEvent.type}` : undefined,
      outputs.length ? `${outputs.length} recent artifact entries loaded.` : "No artifact outputs recorded yet.",
    ].filter(Boolean).join("\n"),
  };
}

async function readArtifactText(runDir: string, artifact?: string): Promise<string | undefined> {
  if (!artifact || artifact.includes("..")) return undefined;
  try {
    return truncate(await readFile(`${runDir}/${artifact}`, "utf8"), 2000);
  } catch {
    return undefined;
  }
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readEventsFile(file: string): Promise<MateriaMonitorEventEntry[]> {
  try {
    return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as MateriaMonitorEventEntry);
  } catch {
    return [];
  }
}

function summarizeUnknown(value: unknown): string {
  if (!value || typeof value !== "object") return truncate(String(value ?? ""), 1200);
  const object = value as Record<string, unknown>;
  const label = [object.phase, object.nodeId, object.materiaName, object.eventType].filter((part) => typeof part === "string").join(" · ");
  return label || truncate(JSON.stringify(object), 1200);
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const value = part as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function materiaPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
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
  assertMateriaWebUiArtifactAvailable,
  ensureMateriaWebUiBuilt,
  resetMateriaWebUiBuildPromise,
  loadMateriaWebUiProfileConfig: loadProfileConfig,
  webUiSessionKey,
};

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMateriaWebUiServer, readRuntimeEvents, type MateriaAddQuestInput, type MateriaAddQuestResult, type MateriaDeleteQuestInput, type MateriaDeleteQuestResult, type MateriaModelCatalogSource, type MateriaMonitorArtifactEntry, type MateriaMonitorEventEntry, type MateriaQuestBoardSource, type MateriaQuestControlInput, type MateriaQuestControlResult, type MateriaReorderQuestInput, type MateriaReorderQuestResult, type MateriaRequeueQuestInput, type MateriaRequeueQuestResult, type MateriaSetActiveLoadoutCallback, type MateriaSetActiveLoadoutResult, type MateriaSetDefaultLoadoutCallback, type MateriaSetDefaultLoadoutResult, type MateriaSetQuestDefaultLoadoutCallback, type MateriaSetQuestDefaultLoadoutResult, type MateriaToolRegistrySnapshot, type MateriaUpdateQuestInput, type MateriaUpdateQuestResult, type MateriaWebUiSessionSnapshot } from "./server/index.js";
import { loadActiveCastState } from "../infrastructure/castStateRepository.js";
import { clearStaleDefaultLoadoutPreference, getRoleGenerationPreference, loadConfig, loadProfileConfig, saveActiveLoadout, saveDefaultLoadoutPreference, saveMateriaConfigPatch, saveQuestDefaultLoadoutPreference, saveRoleGenerationPreference } from "../config/config.js";
import { resolveLoadoutReference } from "../loadout/defaultLoadoutResolver.js";
import { publishActiveLoadoutChange } from "../presentation/activeLoadoutEvents.js";
import { generateMateriaRolePrompt } from "../handoff/roleGeneration.js";
import { addQuest as addQuestToBoard, deleteQuest as deleteQuestFromBoard, generateUniqueQuestId, movePendingQuest, requeueQuest, updatePendingQuest } from "../domain/questBoard.js";
import { FileQuestBoardRepository } from "../infrastructure/questBoardRepository.js";
import { issuesToMessage } from "../domain/result.js";

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

export interface MateriaWebUiQuestControlCallbacks {
  runQuest?: (input: MateriaQuestControlInput) => Promise<MateriaQuestControlResult>;
  runQuestOnce?: (input: MateriaQuestControlInput) => Promise<MateriaQuestControlResult>;
  stopQuestRunner?: () => Promise<MateriaQuestControlResult>;
}

export interface MateriaWebUiLaunchOptions {
  /**
   * Internal opt-in for session lifecycle initialization only. The pending
   * launch map is keyed by session, so avoid mixing in-flight launches with
   * different initialization semantics.
   */
  initializeDefaultLoadout?: boolean;
  questControls?: MateriaWebUiQuestControlCallbacks;
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

export async function launchMateriaWebUi(ctx: ExtensionContext, configuredPath?: string, pi?: ExtensionAPI, options: MateriaWebUiLaunchOptions = {}): Promise<MateriaWebUiLaunchResult> {
  const sessionKey = webUiSessionKey(ctx);
  const existing = servers.get(sessionKey);
  if (existing?.server.listening) {
    return { url: existing.url, reused: true, autoOpenBrowser: existing.autoOpenBrowser, sessionKey };
  }

  const inFlight = pending.get(sessionKey);
  if (inFlight) return inFlight;

  const launch = startServer(ctx, sessionKey, configuredPath, pi, options).finally(() => pending.delete(sessionKey));
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

async function startServer(ctx: ExtensionContext, sessionKey: string, configuredPath?: string, pi?: ExtensionAPI, options: MateriaWebUiLaunchOptions = {}): Promise<MateriaWebUiLaunchResult> {
  await assertMateriaWebUiArtifactAvailable();

  const profile = await loadProfileConfig();
  const host = profile.webui?.host?.trim() || "127.0.0.1";
  const port = profile.webui?.preferredPort ?? profile.webui?.port ?? 0;
  const autoOpenBrowser = profile.webui?.autoOpenBrowser ?? profile.webui?.openBrowser ?? false;
  const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
  const sessionId = ctx.sessionManager.getSessionId() ?? "";
  const cwd = ctx.cwd;
  const startedAt = Date.now();
  if (options.initializeDefaultLoadout === true) await initializeDefaultLoadoutPreference(ctx, configuredPath, pi);

  const { server } = createMateriaWebUiServer({
    host,
    port,
    session: {
      key: sessionKey,
      cwd,
      sessionFile,
      sessionId,
      startedAt,
      getSnapshot: () => currentSessionSnapshot(ctx, sessionKey, startedAt, configuredPath, pi),
      getConfig: () => loadConfig(cwd, configuredPath),
      saveConfig: (patch, target) => saveMateriaConfigPatch(cwd, patch, { target, configuredPath }),
      setActiveLoadout: createActiveLoadoutSetter(ctx, configuredPath, pi),
      setDefaultLoadout: createDefaultLoadoutSetter(ctx, configuredPath),
      setQuestDefaultLoadout: createQuestDefaultLoadoutSetter(ctx, configuredPath),
      getRoleGenerationPreference,
      setRoleGenerationPreference: saveRoleGenerationPreference,
      getQuestBoard: () => readQuestBoardSnapshot(cwd),
      runQuest: options.questControls?.runQuest,
      runQuestOnce: options.questControls?.runQuestOnce,
      stopQuestRunner: options.questControls?.stopQuestRunner,
      addQuest: (input) => addWebUiQuest(cwd, configuredPath, input),
      updateQuest: (input) => updateWebUiQuest(cwd, configuredPath, input),
      reorderQuest: (input) => reorderWebUiQuest(cwd, input),
      requeueQuest: (input) => requeueWebUiQuest(cwd, input),
      deleteQuest: (input) => deleteWebUiQuest(cwd, input),
      generateMateriaRole: pi ? (request) => generateMateriaRolePrompt(pi, ctx, request) : undefined,
      modelCatalog: createPiModelCatalogSource(ctx, pi),
    },
  });

  const actualPort = await listen(server, host, port);
  const url = `http://${host}:${actualPort}/`;
  const running: RunningWebUiServer = { url, host, port: actualPort, sessionKey, autoOpenBrowser, server };
  servers.set(sessionKey, running);
  server.once("close", () => {
    if (servers.get(sessionKey) === running) servers.delete(sessionKey);
  });

  if (autoOpenBrowser) openBrowser(url);
  return { url, reused: false, autoOpenBrowser, sessionKey };
}

export async function initializeDefaultLoadoutPreference(ctx: ExtensionContext, configuredPath?: string, pi?: ExtensionAPI): Promise<void> {
  try {
    const loaded = await loadConfig(ctx.cwd, configuredPath);
    const defaultLoadoutId = loaded.defaultLoadoutId;
    if (!defaultLoadoutId) {
      if (loaded.defaultLoadoutWarning) ctx.ui.notify(loaded.defaultLoadoutWarning, "warning");
      await clearStaleDefaultLoadoutPreference(ctx.cwd, configuredPath);
      return;
    }
    if (loaded.config.activeLoadoutId === defaultLoadoutId) return;
    const written = await saveActiveLoadout(ctx.cwd, defaultLoadoutId, configuredPath);
    const reloaded = await loadConfig(ctx.cwd, configuredPath);
    if (pi) {
      publishActiveLoadoutChange(pi, ctx, {
        source: "webui",
        loaded: reloaded,
        writtenPath: written,
        notifyMessage: `pi-materia initialized active loadout from default preference: ${defaultLoadoutId} (${written})`,
      });
    }
  } catch (error) {
    const message = `Could not initialize default Materia loadout preference: ${error instanceof Error ? error.message : String(error)}`;
    ctx.ui.notify(message, "warning");
  }
}

function createDefaultLoadoutSetter(ctx: ExtensionContext, configuredPath?: string): MateriaSetDefaultLoadoutCallback {
  return async (rawName: string | null): Promise<MateriaSetDefaultLoadoutResult> => {
    try {
      const defaultLoadoutId = await saveDefaultLoadoutPreference(ctx.cwd, rawName, configuredPath);
      return {
        ok: true,
        defaultLoadoutId,
        message: defaultLoadoutId ? `Default loadout set to ${defaultLoadoutId}.` : "Default loadout cleared.",
      };
    } catch (error) {
      return {
        ok: false,
        code: "unavailable",
        message: `Could not update default loadout: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

function createQuestDefaultLoadoutSetter(ctx: ExtensionContext, configuredPath?: string): MateriaSetQuestDefaultLoadoutCallback {
  return async (rawName: string | null): Promise<MateriaSetQuestDefaultLoadoutResult> => {
    try {
      const questDefaultLoadoutId = await saveQuestDefaultLoadoutPreference(ctx.cwd, rawName, configuredPath);
      return {
        ok: true,
        questDefaultLoadoutId,
        message: questDefaultLoadoutId ? `Quest default loadout set to ${questDefaultLoadoutId}.` : "Quest default loadout cleared.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: message.includes("Unknown quest default Materia loadout") || message.includes("does not define any loadouts") ? "unknown_loadout" : "unavailable",
        message: `Could not update quest default loadout: ${message}`,
      };
    }
  };
}

function createActiveLoadoutSetter(ctx: ExtensionContext, configuredPath?: string, pi?: ExtensionAPI): MateriaSetActiveLoadoutCallback | undefined {
  if (!pi) return undefined;

  return async (rawName: string): Promise<MateriaSetActiveLoadoutResult> => {
    const name = rawName.trim();
    if (!name) {
      return { ok: false, code: "invalid_name", message: "Active loadout name is required." };
    }

    const activeCast = loadActiveCastState(ctx);
    if (activeCast?.active) {
      const message = `Cannot change active loadout during active cast ${activeCast.castId}.`;
      ctx.ui.notify(message, "error");
      pi.sendMessage({ customType: "pi-materia", content: message, display: true, details: { prefix: "loadout", materiaName: "orchestrator", eventType: "loadout", source: "webui", error: "active_cast_conflict", castId: activeCast.castId } });
      pi.appendEntry("pi-materia-active-loadout-change-blocked", { eventType: "active-loadout-change-blocked", source: "webui", reason: "active_cast_conflict", castId: activeCast.castId, timestamp: Date.now() });
      return {
        ok: false,
        code: "active_cast_conflict",
        message,
      };
    }

    try {
      let loaded = await loadConfig(ctx.cwd, configuredPath);
      const loadoutNames = Object.keys(loaded.config.loadouts ?? {});
      const loadoutKnown = resolveLoadoutReference(name, loaded.config.loadouts, loaded.loadoutSources);
      if (!loadoutKnown) {
        return {
          ok: false,
          code: "unknown_loadout",
          message: loadoutNames.length
            ? `Unknown Materia loadout "${name}". Available loadouts: ${loadoutNames.join(", ")}.`
            : "Cannot change Materia loadout because this config does not define any loadouts.",
          activeLoadout: loaded.config.activeLoadout,
          config: loaded,
        };
      }

      const written = await saveActiveLoadout(ctx.cwd, name, configuredPath);
      loaded = await loadConfig(ctx.cwd, configuredPath);
      const activeLoadout = loaded.config.activeLoadout ?? name;
      publishActiveLoadoutChange(pi, ctx, {
        source: "webui",
        loaded,
        writtenPath: written,
        notifyMessage: `pi-materia active loadout changed from WebUI to ${activeLoadout} (${written})`,
      });
      return { ok: true, activeLoadout, activeLoadoutId: loaded.config.activeLoadoutId, config: loaded, message: `Active loadout changed to ${activeLoadout}.` };
    } catch (error) {
      return {
        ok: false,
        code: "unavailable",
        message: `Could not change active loadout: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

async function readQuestBoardSnapshot(cwd: string): Promise<MateriaQuestBoardSource> {
  const boards = new FileQuestBoardRepository(cwd);
  return { boardPath: boards.boardPath, board: await boards.loadOrCreate() };
}

async function addWebUiQuest(cwd: string, configuredPath: string | undefined, input: MateriaAddQuestInput): Promise<MateriaAddQuestResult> {
  try {
    const prompt = input.prompt.trim();
    if (!prompt) return { ok: false, code: "validation_failed", message: "Quest prompt is required." };

    const loadoutOverride = input.loadoutOverride?.trim();
    if (loadoutOverride) {
      const loaded = await loadConfig(cwd, configuredPath);
      const resolved = resolveLoadoutReference(loadoutOverride, loaded.config.loadouts, loaded.loadoutSources);
      if (!resolved) {
        const names = Object.keys(loaded.config.loadouts ?? {});
        return {
          ok: false,
          code: "invalid_loadout",
          message: names.length
            ? `Unknown Materia loadout "${loadoutOverride}". Available loadouts: ${names.join(", ")}.`
            : "Cannot add quest with a loadout override because this config does not define any loadouts.",
        };
      }
    }

    const boards = new FileQuestBoardRepository(cwd);
    const board = await boards.loadOrCreate();
    const now = new Date().toISOString();
    const id = generateUniqueQuestId(board);
    if (!id.ok) return { ok: false, code: "validation_failed", message: id.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ") };
    const result = addQuestToBoard(board, {
      id: id.value,
      title: deriveWebUiQuestTitle(prompt),
      prompt,
      now,
      ...(loadoutOverride ? { loadoutOverride } : {}),
    });
    if (!result.ok) return { ok: false, code: "validation_failed", message: result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ") };
    await boards.save(result.value);
    return { ok: true, boardPath: boards.boardPath, board: result.value, quest: result.value.quests[result.value.quests.length - 1]! };
  } catch (error) {
    return { ok: false, code: "unavailable", message: `Could not add quest: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function updateWebUiQuest(cwd: string, configuredPath: string | undefined, input: MateriaUpdateQuestInput): Promise<MateriaUpdateQuestResult> {
  try {
    const prompt = input.prompt.trim();
    if (!prompt) return { ok: false, code: "validation_failed", message: "Quest prompt is required." };

    const loadoutOverride = input.loadoutOverride?.trim();
    if (loadoutOverride) {
      const loaded = await loadConfig(cwd, configuredPath);
      const resolved = resolveLoadoutReference(loadoutOverride, loaded.config.loadouts, loaded.loadoutSources);
      if (!resolved) {
        const names = Object.keys(loaded.config.loadouts ?? {});
        return {
          ok: false,
          code: "invalid_loadout",
          message: names.length
            ? `Unknown Materia loadout "${loadoutOverride}". Available loadouts: ${names.join(", ")}.`
            : "Cannot update quest with a loadout override because this config does not define any loadouts.",
        };
      }
    }

    const boards = new FileQuestBoardRepository(cwd);
    const board = await boards.loadOrCreate();
    const now = new Date().toISOString();
    const result = updatePendingQuest(board, {
      questId: input.questId,
      title: deriveWebUiQuestTitle(prompt),
      prompt,
      now,
      ...(loadoutOverride ? { loadoutOverride } : {}),
    });
    if (!result.ok) return { ok: false, code: "validation_failed", message: result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ") };
    await boards.save(result.value);
    const quest = result.value.quests.find((candidate) => candidate.id === input.questId);
    if (!quest) return { ok: false, code: "validation_failed", message: `questId: quest '${input.questId}' does not exist` };
    return { ok: true, boardPath: boards.boardPath, board: result.value, quest };
  } catch (error) {
    return { ok: false, code: "unavailable", message: `Could not update quest: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function reorderWebUiQuest(cwd: string, input: MateriaReorderQuestInput): Promise<MateriaReorderQuestResult> {
  try {
    const boards = new FileQuestBoardRepository(cwd);
    const board = await boards.loadOrCreate();
    const result = movePendingQuest(board, { questId: input.questId, placement: input.placement, ...(input.targetId ? { targetId: input.targetId } : {}), now: new Date().toISOString() });
    if (!result.ok) return { ok: false, code: "validation_failed", message: issuesToMessage(result.issues) };
    await boards.save(result.value);
    const quest = result.value.quests.find((candidate) => candidate.id === input.questId);
    const target = input.targetId ? result.value.quests.find((candidate) => candidate.id === input.targetId) : undefined;
    if (!quest) return { ok: false, code: "validation_failed", message: `questId: quest '${input.questId}' does not exist` };
    return { ok: true, boardPath: boards.boardPath, board: result.value, quest, ...(target ? { target } : {}) };
  } catch (error) {
    return { ok: false, code: "unavailable", message: `Could not reorder quest: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function requeueWebUiQuest(cwd: string, input: MateriaRequeueQuestInput): Promise<MateriaRequeueQuestResult> {
  try {
    const boards = new FileQuestBoardRepository(cwd);
    const board = await boards.loadOrCreate();
    const result = requeueQuest(board, { questId: input.questId, now: new Date().toISOString() });
    if (!result.ok) return { ok: false, code: "validation_failed", message: issuesToMessage(result.issues) };
    await boards.save(result.value);
    const quest = result.value.quests.find((candidate) => candidate.id === input.questId);
    if (!quest) return { ok: false, code: "validation_failed", message: `questId: quest '${input.questId}' does not exist` };
    return { ok: true, boardPath: boards.boardPath, board: result.value, quest };
  } catch (error) {
    return { ok: false, code: "unavailable", message: `Could not requeue quest: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function deleteWebUiQuest(cwd: string, input: MateriaDeleteQuestInput): Promise<MateriaDeleteQuestResult> {
  try {
    const boards = new FileQuestBoardRepository(cwd);
    const board = await boards.loadOrCreate();
    const questToDelete = board.quests.find((candidate) => candidate.id === input.questId);
    const result = deleteQuestFromBoard(board, { questId: input.questId, now: new Date().toISOString() });
    if (!result.ok) return { ok: false, code: "validation_failed", message: issuesToMessage(result.issues) };
    await boards.save(result.value);
    return { ok: true, boardPath: boards.boardPath, board: result.value, quest: questToDelete! };
  } catch (error) {
    return { ok: false, code: "unavailable", message: `Could not delete quest: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function deriveWebUiQuestTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "WebUI quest";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

function createPiModelCatalogSource(ctx: ExtensionContext, pi?: ExtensionAPI): MateriaModelCatalogSource {
  return {
    modelRegistry: ctx.modelRegistry,
    getActiveModel: () => ctx.model,
    getActiveThinking: () => maybeGetThinkingLevel(pi)?.call(pi),
  };
}

function maybeGetThinkingLevel(pi?: ExtensionAPI): (() => unknown) | undefined {
  return (pi as unknown as { getThinkingLevel?: () => unknown } | undefined)?.getThinkingLevel;
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

async function currentSessionSnapshot(ctx: ExtensionContext, sessionKey: string, uiStartedAt: number, configuredPath?: string, pi?: ExtensionAPI): Promise<MateriaWebUiSessionSnapshot> {
  const state = loadActiveCastState(ctx);
  const runDir = state?.runDir;
  // Runtime events live at {runDir}/events/events.jsonl and are read newest-first
  // alongside (but separate from) the legacy artifact summary so neither stream
  // can break the other.
  const [artifactSummary, runtimeEvents] = await Promise.all([
    runDir ? readArtifactSummary(runDir) : Promise.resolve(undefined),
    runDir ? readRuntimeEvents(runDir) : Promise.resolve([]),
  ]);
  const activeLoadoutSnapshot = await readActiveLoadoutSnapshot(ctx.cwd, configuredPath);
  const activeCastLoadoutIdentity = state ? resolveActiveCastLoadoutIdentity(state) : undefined;
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
    ...activeLoadoutSnapshot,
    toolRegistry: readPiToolRegistry(pi),
    artifactSummary,
    runtimeEvents,
    activeCast: state ? {
      castId: state.castId,
      active: state.active,
      phase: state.phase,
      ...(activeCastLoadoutIdentity?.loadoutId ? { loadoutId: activeCastLoadoutIdentity.loadoutId } : {}),
      ...(activeCastLoadoutIdentity?.loadoutName ? { loadoutName: activeCastLoadoutIdentity.loadoutName } : {}),
      currentSocketId: state.currentSocketId,
      currentMateria: state.currentMateria,
      socketState: state.socketState,
      awaitingResponse: state.awaitingResponse,
      runDir: state.runDir,
      artifactRoot: state.artifactRoot,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
    } : undefined,
  };
}

function resolveActiveCastLoadoutIdentity(state: NonNullable<ReturnType<typeof loadActiveCastState>>): { loadoutId?: string; loadoutName?: string } | undefined {
  const runState = state.runState;
  const quest = isRecord(state.data?.quest) ? state.data.quest : undefined;
  const loadoutId = nonEmptyString(runState.loadoutId) ?? nonEmptyString(quest?.effectiveLoadoutId);
  const loadoutName = nonEmptyString(runState.loadoutName) ?? nonEmptyString(quest?.effectiveLoadoutName);
  return loadoutId || loadoutName ? { ...(loadoutId ? { loadoutId } : {}), ...(loadoutName ? { loadoutName } : {}) } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPiToolRegistry(pi?: ExtensionAPI): MateriaToolRegistrySnapshot {
  if (!pi) {
    return { ok: false, available: false, tools: [], warnings: ["Pi tool registry is unavailable for this WebUI session."] };
  }
  try {
    const names = pi.getAllTools().map((tool) => tool.name).filter((name): name is string => typeof name === "string" && name.trim().length > 0);
    return { ok: true, available: true, tools: Array.from(new Set(names)) };
  } catch (error) {
    return {
      ok: false,
      available: false,
      tools: [],
      warnings: [`Pi tool registry is unavailable: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function readActiveLoadoutSnapshot(cwd: string, configuredPath?: string): Promise<Pick<MateriaWebUiSessionSnapshot, "activeLoadoutId" | "activeLoadout">> {
  try {
    const loaded = await loadConfig(cwd, configuredPath);
    return {
      activeLoadout: loaded.config.activeLoadout,
      activeLoadoutId: loaded.config.activeLoadoutId,
    };
  } catch {
    return {};
  }
}

function readSessionEmittedOutputs(ctx: ExtensionContext, since: number): Array<{ id: string; type: string; text: string; timestamp?: number; socket?: string }> {
  return ctx.sessionManager.getBranch().slice(-80).flatMap((entry) => {
    const rawTimestamp = (entry as { timestamp?: unknown }).timestamp;
    const timestamp = typeof rawTimestamp === "number" ? rawTimestamp : typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : undefined;
    if (timestamp && Number.isFinite(timestamp) && timestamp < since) return [];
    if (entry.type === "custom" && typeof entry.customType === "string" && entry.customType.startsWith("pi-materia")) {
      const data = (entry as { data?: Record<string, unknown> }).data ?? {};
      return [{ id: entry.id, type: entry.customType, text: summarizeUnknown(data), timestamp, socket: typeof data.socketId === "string" ? data.socketId : undefined }];
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
    .filter((entry) => entry.artifact && (entry.kind === "socket_output" || entry.kind === "socket_refinement" || entry.kind === "context" || entry.kind === undefined))
    .slice(-12)
    .map(async (entry) => ({ ...entry, content: await readArtifactText(runDir, entry.artifact) })));
  const completed = outputs.filter((entry) => entry.kind === "socket_output").map((entry) => entry.socket).filter(Boolean).join(" → ");
  const lastEvent = events.at(-1);
  return {
    runDir,
    request: manifest?.request,
    events: events.slice(-40),
    outputs,
    summary: [
      manifest?.request ? `Request: ${manifest.request}` : undefined,
      completed ? `Completed sockets: ${completed}` : undefined,
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
  const label = [object.phase, object.socketId, object.materiaName, object.eventType].filter((part) => typeof part === "string").join(" · ");
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
  createActiveLoadoutSetter,
  currentSessionSnapshot,
  readPiToolRegistry,
  loadMateriaWebUiProfileConfig: loadProfileConfig,
  webUiSessionKey,
};

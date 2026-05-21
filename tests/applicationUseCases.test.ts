import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActiveCastConflictError, ActiveQuestConflictError, CastCatalogUseCases, CastExecutionUseCases, LoadoutUseCases, QuestRunnerUseCases, configuredConfigPath, type ArtifactCatalog, type CastAgentTurnPort, type CastContextPort, type CastLifecyclePort, type CastStateRepository, type CastStatusPort, type ConfigRepository, type PipelinePresenter, type QuestBoardRepository } from "../src/application/index.js";
import { createEmptyQuestBoard, type QuestBoard } from "../src/domain/questBoard.js";
import type { LoadedConfig, MateriaCastState, ResolvedMateriaPipeline } from "../src/types.js";

function loaded(activeLoadout = "default"): LoadedConfig {
  return { source: "/repo/materia.json", config: { activeLoadout, materia: {}, loadouts: { [activeLoadout]: { entry: "Socket-1", sockets: {} } } } };
}

function pipeline(): ResolvedMateriaPipeline {
  return { entry: { id: "Socket-1", socket: { utility: "noop" } }, sockets: { "Socket-1": { id: "Socket-1", socket: { utility: "noop" } } } };
}

function state(overrides: Partial<MateriaCastState> = {}): MateriaCastState {
  return {
    version: 1,
    active: true,
    castId: "cast-1",
    request: "build it",
    configSource: "test",
    configHash: "hash",
    cwd: "/repo",
    runDir: "/repo/.pi/cast-1",
    artifactRoot: "/repo/.pi",
    phase: "Socket-1",
    awaitingResponse: false,
    data: {},
    cursors: {},
    visits: {},
    edgeTraversals: {},
    outputs: {},
    errors: [],
    handoffs: [],
    usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byMateria: {}, bySocket: {}, byTask: {}, byAttempt: {} },
    ...overrides,
  };
}

describe("application use cases", () => {
  test("loadout use cases coordinate config repository and pipeline presenter", async () => {
    const calls: string[] = [];
    const configs: ConfigRepository = {
      async load(cwd, configuredPath) { calls.push(`load:${cwd}:${configuredPath}`); return loaded(); },
      async saveActiveLoadout(cwd, name, configuredPath) { calls.push(`save:${cwd}:${name}:${configuredPath}`); return "/repo/materia.json"; },
      resolveArtifactRoot: (cwd, artifactDir) => `${cwd}/${artifactDir ?? ".pi/pi-materia"}`,
    };
    const presenter: PipelinePresenter = {
      resolve(config) { calls.push(`resolve:${config.activeLoadout}`); return pipeline(); },
      renderGrid(_config, resolved, source, cwd) { return [`${source}:${cwd}:${resolved.entry.id}`]; },
      renderLoadoutList(config, source) { return [`${source}:${config.activeLoadout}`]; },
    };
    const useCases = new LoadoutUseCases({ configs, pipeline: presenter });

    await expect(useCases.prepareGrid("/repo", "custom.json")).resolves.toMatchObject({ lines: ["/repo/materia.json:/repo:Socket-1"] });
    await expect(useCases.listLoadouts("/repo", "custom.json")).resolves.toMatchObject({ lines: ["/repo/materia.json:default"] });
    await expect(useCases.selectActiveLoadout({ cwd: "/repo", requestedLoadout: "default", configuredPath: "custom.json" })).resolves.toMatchObject({ writtenPath: "/repo/materia.json" });
    expect(calls).toContain("save:/repo:default:custom.json");
  });

  test("loadForCast applies loadout override in memory without saving", async () => {
    let saves = 0;
    const configLoaded: LoadedConfig = {
      source: "/repo/materia.json",
      loadoutSources: { Alpha: "project", Beta: "user" },
      config: {
        activeLoadout: "Alpha",
        activeLoadoutId: "project:alpha",
        materia: {},
        loadouts: {
          Alpha: { id: "project:alpha", entry: "Socket-1", sockets: {} },
          Beta: { id: "user:beta", entry: "Socket-2", sockets: {} },
        },
      },
    };
    const presenter: PipelinePresenter = {
      resolve(config) { return { entry: { id: config.activeLoadout === "Beta" ? "Socket-2" : "Socket-1", socket: { utility: "noop" } }, sockets: {} }; },
      renderGrid: () => [],
      renderLoadoutList: () => [],
    };
    const useCases = new LoadoutUseCases({
      configs: { async load() { return configLoaded; }, async saveActiveLoadout() { saves += 1; return "written"; }, resolveArtifactRoot: () => "artifacts" },
      pipeline: presenter,
    });

    const result = await useCases.loadForCast("/repo", undefined, "user:beta");

    expect(result.loaded).not.toBe(configLoaded);
    expect(result.loaded.config).not.toBe(configLoaded.config);
    expect(result.loaded.config.activeLoadout).toBe("Beta");
    expect(result.loaded.config.activeLoadoutId).toBe("user:beta");
    expect(result.effectiveLoadout).toEqual({ requestedLoadoutOverride: "user:beta", effectiveLoadoutName: "Beta", effectiveLoadoutId: "user:beta" });
    expect(result.pipeline.entry.id).toBe("Socket-2");
    expect(configLoaded.config.activeLoadout).toBe("Alpha");
    expect(configLoaded.config.activeLoadoutId).toBe("project:alpha");
    expect(saves).toBe(0);
  });

  test("loadForCast rejects unknown loadout overrides before cast start", async () => {
    const useCases = new LoadoutUseCases({
      configs: { async load() { return loaded("Alpha"); }, async saveActiveLoadout() { throw new Error("must not save"); }, resolveArtifactRoot: () => "artifacts" },
      pipeline: { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] },
    });

    await expect(useCases.loadForCast("/repo", undefined, "Missing")).rejects.toThrow('Unknown Materia loadout override "Missing"');
  });

  test("autocast starts a temporary loadout without saving or switching active loadout", async () => {
    let saves = 0;
    let started: { loaded: LoadedConfig; request: string; options?: { initialData?: Record<string, unknown>; startEventDetails?: Record<string, unknown> } } | undefined;
    const configLoaded: LoadedConfig = {
      source: "/repo/materia.json",
      config: {
        activeLoadout: "Review",
        materia: { Build: { prompt: "build" }, Review: { prompt: "review" } },
        loadouts: {
          Review: { id: "review-id", entry: "Socket-1", sockets: { "Socket-1": { materia: "Review" } } },
          "Full-Auto": { id: "full-auto-id", entry: "Socket-2", sockets: { "Socket-2": { materia: "Build" } } },
        },
      },
    };
    const configs: ConfigRepository = { async load() { return configLoaded; }, async saveActiveLoadout() { saves += 1; return "written"; }, resolveArtifactRoot: () => "" };
    const presenter: PipelinePresenter = {
      resolve(config) { return { entry: { id: config.activeLoadout === "Full-Auto" ? "Socket-2" : "Socket-1", socket: { utility: "noop" } }, sockets: {} }; },
      renderGrid: () => [],
      renderLoadoutList: () => [],
    };
    const useCases = new CastExecutionUseCases({
      states: { loadActive: () => undefined, listLatest: () => [], listResumable: () => [], listRevivable: () => [] },
      context: { buildIsolatedContext: (messages) => messages },
      agentTurns: { prepareAgentStartSystemPrompt: async () => undefined, handleAgentEnd: async () => undefined },
      lifecycle: { start: async (_pi, _session, loadedArg, _pipeline, request, options) => { started = { loaded: loadedArg, request, options }; }, continue: async () => undefined, resume: async () => undefined, revive: async () => undefined, clear: () => undefined },
      statusPresenter: { statusLabel: () => "" },
      loadouts: new LoadoutUseCases({ configs, pipeline: presenter }),
      configs,
      pipeline: presenter,
    });

    const result = await (useCases as unknown as { startAutoCast(input: { pi: string; session: string; cwd: string; argumentsText: string; rawCommand?: string }): Promise<{ effectiveLoadout?: unknown; autocast: unknown }> }).startAutoCast({ pi: "pi", session: "session", cwd: "/repo", argumentsText: "Full-Auto implement it", rawCommand: "/materia autocast Full-Auto implement it" });

    expect(started?.request).toBe("implement it");
    expect(started?.loaded.config.activeLoadout).toBe("Full-Auto");
    expect(started?.loaded.config.activeLoadoutId).toBe("full-auto-id");
    expect(result.effectiveLoadout).toEqual({ requestedLoadoutOverride: "Full-Auto", effectiveLoadoutName: "Full-Auto", effectiveLoadoutId: "full-auto-id" });
    expect(started?.options?.initialData?.autocast).toMatchObject({ mode: "loadout", requestedTarget: "Full-Auto", activeLoadoutChanged: false, effectiveLoadout: { name: "Full-Auto", id: "full-auto-id" } });
    expect(started?.options?.startEventDetails?.autocast).toMatchObject({ mode: "loadout", requestedTarget: "Full-Auto", activeLoadoutChanged: false });
    expect(started?.options?.initialData?.link).toBeUndefined();
    expect(started?.options?.startEventDetails?.link).toBeUndefined();
    expect(configLoaded.config.activeLoadout).toBe("Review");
    expect(configLoaded.config.activeLoadoutId).toBeUndefined();
    expect(saves).toBe(0);
  });

  test("autocast creates a single-materia virtual loadout without link metadata", async () => {
    let started: { loaded: LoadedConfig; request: string; options?: { initialData?: Record<string, unknown>; startEventDetails?: Record<string, unknown> } } | undefined;
    const configLoaded: LoadedConfig = {
      source: "/repo/materia.json",
      config: {
        activeLoadout: "Review",
        materia: { Maintain: { prompt: "maintain", tools: "coding" }, Review: { prompt: "review" } },
        loadouts: { Review: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Review" } } } },
      },
    };
    const configs: ConfigRepository = { async load() { return configLoaded; }, async saveActiveLoadout() { throw new Error("must not save"); }, resolveArtifactRoot: () => "" };
    const presenter: PipelinePresenter = { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] };
    const useCases = new CastExecutionUseCases({
      states: { loadActive: () => undefined, listLatest: () => [], listResumable: () => [], listRevivable: () => [] },
      context: { buildIsolatedContext: (messages) => messages },
      agentTurns: { prepareAgentStartSystemPrompt: async () => undefined, handleAgentEnd: async () => undefined },
      lifecycle: { start: async (_pi, _session, loadedArg, _pipeline, request, options) => { started = { loaded: loadedArg, request, options }; }, continue: async () => undefined, resume: async () => undefined, revive: async () => undefined, clear: () => undefined },
      statusPresenter: { statusLabel: () => "" },
      loadouts: new LoadoutUseCases({ configs, pipeline: presenter }),
      configs,
      pipeline: presenter,
    });

    await (useCases as unknown as { startAutoCast(input: { pi: string; session: string; cwd: string; argumentsText: string; rawCommand?: string }): Promise<unknown> }).startAutoCast({ pi: "pi", session: "session", cwd: "/repo", argumentsText: "materia:Maintain fix drift", rawCommand: "/materia autocast materia:Maintain fix drift" });

    expect(started?.request).toBe("fix drift");
    expect(started?.loaded.config.activeLoadout).toStartWith("virtual-autocast-");
    const activeLoadout = started?.loaded.config.loadouts?.[started.loaded.config.activeLoadout!];
    expect(activeLoadout?.entry).toBe("Socket-1");
    expect(activeLoadout?.sockets?.["Socket-1"]?.materia).toBe("Maintain");
    expect(started?.options?.initialData?.autocast).toMatchObject({
      mode: "materia",
      requestedTarget: "materia:Maintain",
      activeLoadoutChanged: false,
      resolvedMateria: { id: "Maintain" },
      virtualLoadout: {
        name: "Autocast virtual loadout: Maintain",
        targets: [{ kind: "materia", id: "Maintain" }],
        remappings: [{ targetOrder: 0, fromSocketId: "Socket-1", toSocketId: "Socket-1" }],
        stitching: [],
      },
    });
    expect(started?.options?.startEventDetails?.autocast).toMatchObject({ mode: "materia", requestedTarget: "materia:Maintain", activeLoadoutChanged: false, resolvedMateria: { id: "Maintain" } });
    expect(started?.options?.initialData?.link).toBeUndefined();
    expect(started?.options?.startEventDetails?.link).toBeUndefined();
    expect(configLoaded.config.activeLoadout).toBe("Review");
    expect(configLoaded.config.loadouts).toEqual({ Review: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Review" } } } });
  });

  test("autocast rejects invalid targets and active-cast conflicts before lifecycle start", async () => {
    let started = false;
    const configLoaded: LoadedConfig = {
      source: "/repo/materia.json",
      config: { activeLoadout: "Review", materia: { Maintain: { prompt: "maintain" } }, loadouts: { Review: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Maintain" } } } } },
    };
    const configs: ConfigRepository = { async load() { return configLoaded; }, async saveActiveLoadout() { throw new Error("must not save"); }, resolveArtifactRoot: () => "" };
    const presenter: PipelinePresenter = { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] };
    const makeUseCases = (active?: MateriaCastState) => new CastExecutionUseCases({
      states: { loadActive: () => active, listLatest: () => [], listResumable: () => [], listRevivable: () => [] },
      context: { buildIsolatedContext: (messages) => messages },
      agentTurns: { prepareAgentStartSystemPrompt: async () => undefined, handleAgentEnd: async () => undefined },
      lifecycle: { start: async () => { started = true; }, continue: async () => undefined, resume: async () => undefined, revive: async () => undefined, clear: () => undefined },
      statusPresenter: { statusLabel: () => "" },
      loadouts: new LoadoutUseCases({ configs, pipeline: presenter }),
      configs,
      pipeline: presenter,
    });
    const startAutoCast = (useCases: CastExecutionUseCases<string, string>, argumentsText: string) => (useCases as unknown as { startAutoCast(input: { pi: string; session: string; cwd: string; argumentsText: string }): Promise<unknown> }).startAutoCast({ pi: "pi", session: "session", cwd: "/repo", argumentsText });

    await expect(startAutoCast(makeUseCases(), "Missing do it")).rejects.toThrow("Unknown Materia loadout");
    await expect(startAutoCast(makeUseCases(), "materia:Missing do it")).rejects.toThrow("Unknown Materia");
    await expect(startAutoCast(makeUseCases(state({ castId: "active-cast" })), "Review do it")).rejects.toBeInstanceOf(ActiveCastConflictError);
    expect(started).toBe(false);
  });

  test("startCast records effective loadout override in cast start details", async () => {
    let started: { loaded: LoadedConfig; options?: { startEventDetails?: Record<string, unknown> } } | undefined;
    const configLoaded: LoadedConfig = {
      source: "/repo/materia.json",
      config: {
        activeLoadout: "Alpha",
        materia: {},
        loadouts: {
          Alpha: { id: "alpha-id", entry: "Socket-1", sockets: {} },
          Beta: { id: "beta-id", entry: "Socket-1", sockets: {} },
        },
      },
    };
    const configs: ConfigRepository = { async load() { return configLoaded; }, async saveActiveLoadout() { throw new Error("must not save"); }, resolveArtifactRoot: () => "" };
    const presenter: PipelinePresenter = { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] };
    const useCases = new CastExecutionUseCases({
      states: { loadActive: () => undefined, listLatest: () => [], listResumable: () => [], listRevivable: () => [] },
      context: { buildIsolatedContext: (messages) => messages },
      agentTurns: { prepareAgentStartSystemPrompt: async () => undefined, handleAgentEnd: async () => undefined },
      lifecycle: { start: async (_pi, _session, loadedArg, _pipeline, _request, options) => { started = { loaded: loadedArg, options }; }, continue: async () => undefined, resume: async () => undefined, revive: async () => undefined, clear: () => undefined },
      statusPresenter: { statusLabel: () => "" },
      loadouts: new LoadoutUseCases({ configs, pipeline: presenter }),
      configs,
      pipeline: presenter,
    });

    const result = await useCases.startCast({ pi: "pi", session: "session", cwd: "/repo", request: "ship", loadoutOverride: "Beta" });

    expect(result.effectiveLoadout).toEqual({ requestedLoadoutOverride: "Beta", effectiveLoadoutName: "Beta", effectiveLoadoutId: "beta-id" });
    expect(started?.loaded.config.activeLoadout).toBe("Beta");
    expect(started?.options?.startEventDetails?.loadoutOverride).toEqual(result.effectiveLoadout);
    expect(configLoaded.config.activeLoadout).toBe("Alpha");
  });

  test("selectActiveLoadout rejects active casts before writing", async () => {
    let wrote = false;
    const useCases = new LoadoutUseCases({
      configs: { async load() { return loaded(); }, async saveActiveLoadout() { wrote = true; return "written"; }, resolveArtifactRoot: () => "artifacts" },
      pipeline: { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] },
    });

    await expect(useCases.selectActiveLoadout({ cwd: "/repo", requestedLoadout: "other", activeCast: state({ castId: "active-cast" }) })).rejects.toBeInstanceOf(ActiveCastConflictError);
    expect(wrote).toBe(false);
  });

  test("cast catalog use case resolves artifact root and delegates listing", async () => {
    const artifacts: ArtifactCatalog = { async renderCastList(root, states) { return [`${root}:${states?.[0]?.castId}`]; } };
    const states: Pick<CastStateRepository<string>, "listLatest"> = { listLatest: () => [state({ castId: "latest" })] };
    const useCases = new CastCatalogUseCases({ configs: { async load() { return { ...loaded(), config: { ...loaded().config, artifactDir: "artifacts" } }; }, async saveActiveLoadout() { return ""; }, resolveArtifactRoot: (cwd, dir) => `${cwd}/${dir}` }, states, artifacts });

    await expect(useCases.listCasts({ cwd: "/repo", session: "session" })).resolves.toMatchObject({ artifactRoot: "/repo/artifacts", lines: ["/repo/artifacts:latest"] });
  });

  test("cast execution use case prepares prompts and delegates lifecycle actions", async () => {
    const active = state({ awaitingResponse: true, socketState: "awaiting_agent_response", currentSocketId: "Socket-1" });
    const events: string[] = [];
    const states: CastStateRepository<string> = { loadActive: () => active, listLatest: () => [], listResumable: () => [state({ castId: "resume-me" })], listRevivable: () => [state({ castId: "revive-me" })] };
    const context: CastContextPort = { buildIsolatedContext: (messages) => ({ messages }) };
    const agentTurns: CastAgentTurnPort<string, string, string> = {
      prepareAgentStartSystemPrompt: async ({ systemPrompt }) => `${systemPrompt}\n\ndomain prompt`,
      handleAgentEnd: async () => { events.push("end"); },
    };
    const lifecycle: CastLifecyclePort<string, string> = {
      start: async (_pi, _session, _loaded, _pipeline, request) => { events.push(`start:${request}`); },
      continue: async () => { events.push("continue"); },
      resume: async (_pi, _session, castId) => { events.push(`resume:${castId}`); },
      revive: async (_pi, _session, castId) => { events.push(`revive:${castId}`); },
      clear: () => { events.push("clear"); },
    };
    const statusPresenter: CastStatusPort = { statusLabel: () => "running" };
    const configs: ConfigRepository = { async load() { return loaded(); }, async saveActiveLoadout() { return ""; }, resolveArtifactRoot: () => "" };
    const presenter: PipelinePresenter = { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] };
    const loadouts = new LoadoutUseCases({ configs, pipeline: presenter });
    const useCases = new CastExecutionUseCases({ states, context, agentTurns, lifecycle, statusPresenter, loadouts, configs, pipeline: presenter });

    expect(useCases.buildIsolatedContext(["hello"], "session")).toEqual({ messages: ["hello"] });
    await expect(useCases.prepareAgentStart({ pi: "pi", session: "session", systemPrompt: "base" })).resolves.toContain("domain prompt");
    await useCases.startCast({ pi: "pi", session: "session", cwd: "/repo", request: "ship" }).catch((error) => expect(error).toBeInstanceOf(ActiveCastConflictError));
    await expect(useCases.resumeLatestOrRequested("pi", "session")).resolves.toBe("resume-me");
    await expect(useCases.reviveLatestOrRequested("pi", "session", "explicit")).resolves.toBe("explicit");
    expect(useCases.abortActive("pi", "session")?.castId).toBe("cast-1");
    expect(events).toEqual(["resume:resume-me", "revive:explicit", "clear"]);
  });

  test("linked cast use case composes a virtual loadout and starts normal lifecycle with metadata", async () => {
    const events: string[] = [];
    let started: { loaded: LoadedConfig; request: string; options?: { initialData?: Record<string, unknown>; startEventDetails?: Record<string, unknown> } } | undefined;
    const configLoaded: LoadedConfig = {
      source: "/repo/materia.json",
      config: {
        activeLoadout: "Review",
        materia: {
          Build: { prompt: "build" },
          Review: { prompt: "review" },
        },
        loadouts: {
          Review: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Review" } } },
        },
      },
    };
    const configs: ConfigRepository = { async load() { return configLoaded; }, async saveActiveLoadout() { return ""; }, resolveArtifactRoot: (cwd) => `${cwd}/.pi/pi-materia` };
    const presenter: PipelinePresenter = {
      resolve(config) { events.push(`resolve:${config.activeLoadout}`); return pipeline(); },
      renderGrid: () => [],
      renderLoadoutList: () => [],
    };
    const lifecycle: CastLifecyclePort<string, string> = {
      start: async (_pi, _session, loadedArg, _pipeline, request, options) => { started = { loaded: loadedArg, request, options }; },
      continue: async () => undefined,
      resume: async () => undefined,
      revive: async () => undefined,
      clear: () => undefined,
    };
    const useCases = new CastExecutionUseCases({
      states: { loadActive: () => undefined, listLatest: () => [], listResumable: () => [], listRevivable: () => [] },
      context: { buildIsolatedContext: (messages) => messages },
      agentTurns: { prepareAgentStartSystemPrompt: async () => undefined, handleAgentEnd: async () => undefined },
      lifecycle,
      statusPresenter: { statusLabel: () => "" },
      loadouts: new LoadoutUseCases({ configs, pipeline: presenter }),
      configs,
      pipeline: presenter,
    });

    const result = await useCases.startLinkedCast({ pi: "pi", session: "session", cwd: "/repo", argumentsText: "materia:Build loadout:Review -- implement it", rawCommand: "/materia link materia:Build loadout:Review -- implement it" });

    expect(started?.request).toBe("implement it");
    expect(started?.loaded.config.activeLoadout).toStartWith("virtual-link-");
    expect(started?.loaded.config.loadouts?.[started.loaded.config.activeLoadout!]?.entry).toBe("Socket-1");
    expect(started?.options?.initialData?.link).toMatchObject({ plan: { invocation: { command: "/materia link" }, targets: [{ kind: "materia", id: "Build" }, { kind: "loadout", id: "Review" }] } });
    expect(started?.options?.startEventDetails?.link).toMatchObject({ invocation: { command: "/materia link" }, virtualLoadout: { id: result.link.virtualLoadout.id } });
    expect(events).toEqual([`resolve:${started?.loaded.config.activeLoadout}`]);
  });

  test("linked cast use case starts reported Chain-Context to UI-authored Hojo-Consult loadout past linked-loadout validation", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "pi-materia-reported-link-"));
    const previousCastId = "2026-05-12T19-40-40-605Z";
    const runDir = path.join(artifactRoot, previousCastId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ castId: previousCastId, request: "prior Chain-Context request", entries: [] }));

    const hojoConsult = {
      id: "Hojo-Consult",
      entry: "Socket-7",
      sockets: {
        "Socket-7": { socketKind: "entry", materia: "Build", edges: [{ when: "always", to: "Socket-8" }] },
        "Socket-8": { socketKind: "normal", materia: "Review", advance: { cursor: "items", items: "$.items", done: "end" }, edges: [{ when: "satisfied", to: "Socket-9" }] },
        "Socket-9": { socketKind: "normal", materia: "Build" },
      },
      loops: {
        consult: {
          sockets: ["Socket-7", "Socket-8"],
          consumes: { from: "Socket-7", done: "Socket-8" },
          iterator: { items: "$.items", done: "Socket-9" },
          exit: { from: "Socket-8", when: "satisfied", to: "Socket-9" },
          exits: [{ id: "route", from: "Socket-8", condition: "not_satisfied", targetSocketId: "Socket-9" }],
        },
      },
      layout: { sockets: { "Socket-7": { x: 0, y: 0 }, "Socket-8": { x: 1, y: 0 } } },
    };
    const before = JSON.stringify(hojoConsult);
    const configLoaded: LoadedConfig = {
      source: "/repo/materia.json",
      config: {
        activeLoadout: "Hojo-Consult",
        artifactDir: artifactRoot,
        materia: { "Chain-Context": { prompt: "context" }, Build: { prompt: "build" }, Review: { prompt: "review" } },
        loadouts: { "Hojo-Consult": hojoConsult },
      },
    };
    const configs: ConfigRepository = { async load() { return configLoaded; }, async saveActiveLoadout() { return ""; }, resolveArtifactRoot: (_cwd, artifactDir) => artifactDir ?? artifactRoot };
    const presenter: PipelinePresenter = { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] };
    const starts: Array<{ loaded: LoadedConfig; request: string; options?: { initialData?: Record<string, unknown>; startEventDetails?: Record<string, unknown> } }> = [];
    const useCases = new CastExecutionUseCases({
      states: { loadActive: () => undefined, listLatest: () => [], listResumable: () => [], listRevivable: () => [] },
      context: { buildIsolatedContext: (messages) => messages },
      agentTurns: { prepareAgentStartSystemPrompt: async () => undefined, handleAgentEnd: async () => undefined },
      lifecycle: { start: async (_pi, _session, loadedArg, _pipeline, request, options) => { starts.push({ loaded: loadedArg, request, options }); }, continue: async () => undefined, resume: async () => undefined, revive: async () => undefined, clear: () => undefined },
      statusPresenter: { statusLabel: () => "" },
      loadouts: new LoadoutUseCases({ configs, pipeline: presenter }),
      configs,
      pipeline: presenter,
    });

    const reported = await useCases.startLinkedCast({ pi: "pi", session: "session", cwd: "/repo", argumentsText: `--from ${previousCastId} Chain-Context loadout:Hojo-Consult -- This is a test cast`, rawCommand: `/materia link --from ${previousCastId} Chain-Context loadout:Hojo-Consult -- This is a test cast` });
    const prefixed = await useCases.startLinkedCast({ pi: "pi", session: "session", cwd: "/repo", argumentsText: `--from ${previousCastId} materia:Chain-Context loadout:Hojo-Consult -- This is a test cast` });

    expect(starts).toHaveLength(2);
    expect(starts[0]?.request).toBe("This is a test cast");
    expect(reported.link.fromCastId).toBe(previousCastId);
    expect(reported.link.plan.targets.map((target) => ({ kind: target.kind, id: target.id, raw: target.requested.raw }))).toEqual([
      { kind: "materia", id: "Chain-Context", raw: "Chain-Context" },
      { kind: "loadout", id: "Hojo-Consult", raw: "loadout:Hojo-Consult" },
    ]);
    expect(prefixed.link.plan.targets[0]).toMatchObject({ kind: "materia", id: "Chain-Context", requested: { raw: "materia:Chain-Context", prefix: "materia" } });
    expect(JSON.stringify(hojoConsult)).toBe(before);

    const linkedLoadout = starts[0]?.loaded.config.loadouts?.[starts[0].loaded.config.activeLoadout!];
    expect(linkedLoadout?.sockets?.["Socket-3"]?.advance?.done).toBe("end");
    expect(linkedLoadout?.loops?.["t1-consult"]).toMatchObject({
      sockets: ["Socket-2", "Socket-3"],
      consumes: { from: "Socket-2", done: "Socket-3" },
      iterator: { done: "Socket-4" },
      exit: { from: "Socket-3", when: "satisfied", to: "Socket-4" },
      exits: [{ id: "route", from: "Socket-3", condition: "not_satisfied", targetSocketId: "Socket-4" }],
    });
    expect(starts[0]?.options?.initialData?.previousCastContext).toMatchObject({ castId: previousCastId, request: "prior Chain-Context request" });
  });

  test("linked cast use case loads previous cast context and records lineage metadata", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "pi-materia-link-usecase-"));
    const runDir = path.join(artifactRoot, "cast-prev");
    await mkdir(path.join(runDir, "sockets", "Socket-1"), { recursive: true });
    await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ castId: "cast-prev", request: "prior request", entries: [{ artifact: "sockets/Socket-1/output.json", kind: "socket_output" }] }));
    await writeFile(path.join(runDir, "sockets", "Socket-1", "output.json"), JSON.stringify({ summary: "prior summary", satisfied: true, feedback: "ready", missing: [] }));
    let started: { options?: { initialData?: Record<string, unknown>; startEventDetails?: Record<string, unknown> } } | undefined;
    const configLoaded: LoadedConfig = {
      source: "/repo/materia.json",
      config: {
        activeLoadout: "Review",
        artifactDir: artifactRoot,
        materia: { Build: { prompt: "build" }, Review: { prompt: "review" } },
        loadouts: { Review: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Review" } } } },
      },
    };
    const configs: ConfigRepository = { async load() { return configLoaded; }, async saveActiveLoadout() { return ""; }, resolveArtifactRoot: (_cwd, artifactDir) => artifactDir ?? artifactRoot };
    const presenter: PipelinePresenter = { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] };
    const useCases = new CastExecutionUseCases({
      states: { loadActive: () => undefined, listLatest: () => [], listResumable: () => [], listRevivable: () => [] },
      context: { buildIsolatedContext: (messages) => messages },
      agentTurns: { prepareAgentStartSystemPrompt: async () => undefined, handleAgentEnd: async () => undefined },
      lifecycle: { start: async (_pi, _session, _loaded, _pipeline, _request, options) => { started = { options }; }, continue: async () => undefined, resume: async () => undefined, revive: async () => undefined, clear: () => undefined },
      statusPresenter: { statusLabel: () => "" },
      loadouts: new LoadoutUseCases({ configs, pipeline: presenter }),
      configs,
      pipeline: presenter,
    });

    const result = await useCases.startLinkedCast({ pi: "pi", session: "session", cwd: "/repo", argumentsText: "--from cast-prev materia:Build loadout:Review -- continue" });

    expect(result.link.fromCastId).toBe("cast-prev");
    expect(result.link.plan.lineage.fromCastId).toBe("cast-prev");
    expect(started?.options?.initialData?.previousCastContext).toMatchObject({ castId: "cast-prev", request: "prior request", handoff: { summary: "prior summary", satisfied: true } });
    expect(started?.options?.startEventDetails?.link).toMatchObject({ fromCastId: "cast-prev", virtualLoadout: { id: result.link.virtualLoadout.id } });
  });

  test("linked cast use case rejects missing previous casts before lifecycle start", async () => {
    let started = false;
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "pi-materia-link-missing-"));
    const configs: ConfigRepository = {
      async load() { return { source: "/repo/materia.json", config: { activeLoadout: "Review", artifactDir: artifactRoot, materia: { Build: { prompt: "build" } }, loadouts: { Review: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } } } } }; },
      async saveActiveLoadout() { return ""; },
      resolveArtifactRoot: (_cwd, artifactDir) => artifactDir ?? artifactRoot,
    };
    const presenter: PipelinePresenter = { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] };
    const useCases = new CastExecutionUseCases({
      states: { loadActive: () => undefined, listLatest: () => [], listResumable: () => [], listRevivable: () => [] },
      context: { buildIsolatedContext: (messages) => messages },
      agentTurns: { prepareAgentStartSystemPrompt: async () => undefined, handleAgentEnd: async () => undefined },
      lifecycle: { start: async () => { started = true; }, continue: async () => undefined, resume: async () => undefined, revive: async () => undefined, clear: () => undefined },
      statusPresenter: { statusLabel: () => "" },
      loadouts: new LoadoutUseCases({ configs, pipeline: presenter }),
      configs,
      pipeline: presenter,
    });

    await expect(useCases.startLinkedCast({ pi: "pi", session: "session", cwd: "/repo", argumentsText: "--from absent materia:Build -- continue" })).rejects.toThrow("unknown previous cast id");
    expect(started).toBe(false);
  });

  test("linked cast use case rejects invalid commands before lifecycle start", async () => {
    let started = false;
    const configs: ConfigRepository = { async load() { return loaded(); }, async saveActiveLoadout() { return ""; }, resolveArtifactRoot: () => "" };
    const presenter: PipelinePresenter = { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] };
    const useCases = new CastExecutionUseCases({
      states: { loadActive: () => undefined, listLatest: () => [], listResumable: () => [], listRevivable: () => [] },
      context: { buildIsolatedContext: (messages) => messages },
      agentTurns: { prepareAgentStartSystemPrompt: async () => undefined, handleAgentEnd: async () => undefined },
      lifecycle: { start: async () => { started = true; }, continue: async () => undefined, resume: async () => undefined, revive: async () => undefined, clear: () => undefined },
      statusPresenter: { statusLabel: () => "" },
      loadouts: new LoadoutUseCases({ configs, pipeline: presenter }),
      configs,
      pipeline: presenter,
    });

    await expect(useCases.startLinkedCast({ pi: "pi", session: "session", cwd: "/repo", argumentsText: "Build without delimiter" })).rejects.toThrow("missing prompt delimiter");
    expect(started).toBe(false);
  });

  test("quest runner adds and starts a pending quest with metadata", async () => {
    let board: QuestBoard = createEmptyQuestBoard({ now: "2026-01-01T00:00:00.000Z" });
    const boards: QuestBoardRepository = { boardPath: "/repo/.pi/pi-materia/quest-board.json", loadOrCreate: async () => board, save: async (next) => { board = next; } };
    let active: MateriaCastState | undefined;
    let startOptions: unknown;
    const casts = {
      startCast: async (input: Parameters<CastExecutionUseCases<string, string>["startCast"]>[0]) => {
        startOptions = input.options;
        active = state({ castId: "cast-quest", request: input.request });
        return { loaded: loaded(), pipeline: pipeline(), state: active };
      },
    };
    const runner = new QuestRunnerUseCases({ boards, casts, loadouts: { loadForCast: async () => ({ loaded: loaded(), pipeline: pipeline() }) }, states: { loadActive: () => active }, clock: { now: () => "2026-01-01T00:00:01.000Z" }, ids: { nextId: () => "quest-1" } });

    await runner.addQuest({ prompt: "Build the quest runner", loadoutOverride: "Auto" });
    const result = await runner.runNext({ pi: "pi", session: "session", cwd: "/repo" });

    expect(result?.quest.status).toBe("running");
    expect(result?.quest.currentCastId).toBe("cast-quest");
    expect(startOptions).toMatchObject({ initialData: { quest: { questId: "quest-1", title: "Build the quest runner", loadoutOverride: "Auto" } }, startEventDetails: { quest: { questId: "quest-1" } } });
  });

  test("quest runner uses quest default loadout for no-override quests and preserves override precedence", async () => {
    let board: QuestBoard = createEmptyQuestBoard({ now: "2026-01-01T00:00:00.000Z" });
    const boards: QuestBoardRepository = { boardPath: "/repo/.pi/pi-materia/quest-board.json", loadOrCreate: async () => board, save: async (next) => { board = next; } };
    const sourceConfig: LoadedConfig = {
      source: "/repo/materia.json",
      questDefaultLoadoutId: "quest-default-id",
      config: {
        activeLoadout: "Interactive",
        activeLoadoutId: "interactive-id",
        materia: {},
        loadouts: {
          Interactive: { id: "interactive-id", entry: "Socket-1", sockets: {} },
          "Quest Default": { id: "quest-default-id", entry: "Socket-2", sockets: {} },
          Override: { id: "override-id", entry: "Socket-3", sockets: {} },
        },
      },
    };
    let loadCount = 0;
    const loadouts = new LoadoutUseCases({
      configs: { async load() { loadCount += 1; return sourceConfig; }, async saveActiveLoadout() { throw new Error("must not save"); }, resolveArtifactRoot: () => "artifacts" },
      pipeline: { resolve: (config) => ({ entry: { id: config.activeLoadout === "Quest Default" ? "Socket-2" : config.activeLoadout === "Override" ? "Socket-3" : "Socket-1", socket: { utility: "noop" } }, sockets: {} }), renderGrid: () => [], renderLoadoutList: () => [] },
    });
    const starts: Parameters<CastExecutionUseCases<string, string>["startCast"]>[0][] = [];
    const casts = { startCast: async (input: Parameters<CastExecutionUseCases<string, string>["startCast"]>[0]) => { starts.push(input); return { loaded: input.prepared!.loaded, pipeline: input.prepared!.pipeline, effectiveLoadout: input.prepared!.effectiveLoadout, state: state({ castId: `cast-${starts.length}`, data: input.options?.initialData ?? {} }) }; } };
    const runner = new QuestRunnerUseCases({ boards, casts, loadouts, states: { loadActive: () => undefined }, clock: { now: () => "2026-01-01T00:00:01.000Z" }, ids: { nextId: () => `quest-${board.quests.length + 1}` } });

    await runner.addQuest({ prompt: "use quest default" });
    const defaultResult = await runner.runNext({ pi: "pi", session: "session", cwd: "/repo" });
    expect(defaultResult?.effectiveLoadout).toEqual({ requestedLoadoutOverride: "quest-default-id", effectiveLoadoutName: "Quest Default", effectiveLoadoutId: "quest-default-id" });
    expect(defaultResult?.loadoutSource).toBe("quest_default");
    expect(starts[0]?.prepared?.loaded.config.activeLoadout).toBe("Quest Default");
    expect(starts[0]?.options?.initialData?.quest).toMatchObject({ loadoutSource: "quest_default", effectiveLoadoutName: "Quest Default", effectiveLoadoutId: "quest-default-id" });

    await runner.handleCastSettled({ castId: "cast-1", status: "succeeded" });
    await runner.addQuest({ prompt: "use override", loadoutOverride: "Override" });
    const overrideResult = await runner.runNext({ pi: "pi", session: "session", cwd: "/repo" });
    expect(overrideResult?.effectiveLoadout).toEqual({ requestedLoadoutOverride: "Override", effectiveLoadoutName: "Override", effectiveLoadoutId: "override-id" });
    expect(overrideResult?.loadoutSource).toBe("override");
    expect(starts[1]?.prepared?.loaded.config.activeLoadout).toBe("Override");
    expect(sourceConfig.config.activeLoadout).toBe("Interactive");
    expect(sourceConfig.config.activeLoadoutId).toBe("interactive-id");
    expect(sourceConfig.questDefaultLoadoutId).toBe("quest-default-id");
    expect(loadCount).toBe(2);
  });

  test("quest runner falls back to active loadout for cleared or stale quest defaults", async () => {
    let board: QuestBoard = createEmptyQuestBoard({ now: "2026-01-01T00:00:00.000Z" });
    const boards: QuestBoardRepository = { boardPath: "/repo/.pi/pi-materia/quest-board.json", loadOrCreate: async () => board, save: async (next) => { board = next; } };
    const loadedConfigs: LoadedConfig[] = [
      { source: "/repo/materia.json", questDefaultLoadoutId: null, config: { activeLoadout: "Interactive", activeLoadoutId: "interactive-id", materia: {}, loadouts: { Interactive: { id: "interactive-id", entry: "Socket-1", sockets: {} } } } },
      { source: "/repo/materia.json", questDefaultLoadoutId: null, questDefaultLoadoutWarning: 'Configured quest default loadout "missing-id" could not be resolved.', config: { activeLoadout: "Interactive", activeLoadoutId: "interactive-id", materia: {}, loadouts: { Interactive: { id: "interactive-id", entry: "Socket-1", sockets: {} } } } },
    ];
    let loadIndex = 0;
    const loadouts = new LoadoutUseCases({
      configs: { async load() { return loadedConfigs[loadIndex++]!; }, async saveActiveLoadout() { throw new Error("must not save"); }, resolveArtifactRoot: () => "artifacts" },
      pipeline: { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] },
    });
    const starts: Parameters<CastExecutionUseCases<string, string>["startCast"]>[0][] = [];
    const casts = { startCast: async (input: Parameters<CastExecutionUseCases<string, string>["startCast"]>[0]) => { starts.push(input); return { loaded: input.prepared!.loaded, pipeline: input.prepared!.pipeline, state: state({ castId: `cast-${starts.length}`, data: input.options?.initialData ?? {} }) }; } };
    const runner = new QuestRunnerUseCases({ boards, casts, loadouts, states: { loadActive: () => undefined }, clock: { now: () => "2026-01-01T00:00:01.000Z" }, ids: { nextId: () => `quest-${board.quests.length + 1}` } });

    await runner.addQuest({ prompt: "cleared default falls back" });
    const cleared = await runner.runNext({ pi: "pi", session: "session", cwd: "/repo" });
    expect(cleared?.loadoutSource).toBe("fallback");
    expect(cleared?.loadoutWarning).toBeUndefined();
    expect(starts[0]?.prepared?.effectiveLoadout).toBeUndefined();
    expect(starts[0]?.prepared?.loaded.config.activeLoadout).toBe("Interactive");

    await runner.handleCastSettled({ castId: "cast-1", status: "succeeded" });
    await runner.addQuest({ prompt: "stale default warns and falls back" });
    const stale = await runner.runNext({ pi: "pi", session: "session", cwd: "/repo" });
    expect(stale?.loadoutSource).toBe("fallback");
    expect(stale?.loadoutWarning).toContain("missing-id");
    expect(starts[1]?.options?.initialData?.quest).toMatchObject({ loadoutSource: "fallback", questDefaultLoadoutWarning: 'Configured quest default loadout "missing-id" could not be resolved.' });
    expect(loadedConfigs[1]?.questDefaultLoadoutId).toBeNull();
  });

  test("quest runner blocks starts when a cast or quest is already active", async () => {
    let board: QuestBoard = createEmptyQuestBoard({ now: "2026-01-01T00:00:00.000Z" });
    const boards: QuestBoardRepository = { boardPath: "/repo/.pi/pi-materia/quest-board.json", loadOrCreate: async () => board, save: async (next) => { board = next; } };
    const runner = new QuestRunnerUseCases({ boards, casts: { startCast: async () => { throw new Error("must not start"); } }, loadouts: { loadForCast: async () => ({ loaded: loaded(), pipeline: pipeline() }) }, states: { loadActive: () => state({ castId: "active-cast" }) }, clock: { now: () => "2026-01-01T00:00:01.000Z" }, ids: { nextId: () => "quest-1" } });
    await runner.addQuest({ prompt: "blocked by active cast" });

    await expect(runner.runNext({ pi: "pi", session: "session", cwd: "/repo" })).rejects.toBeInstanceOf(ActiveCastConflictError);

    board = { ...board, runner: { enabled: false }, quests: [{ ...board.quests[0]!, status: "running", currentCastId: "cast-running", lastCastId: "cast-running" }, { ...board.quests[0]!, id: "quest-2", status: "pending", currentCastId: undefined, lastCastId: undefined }] };
    const runnerWithRunningQuest = new QuestRunnerUseCases({ boards, casts: { startCast: async () => { throw new Error("must not start"); } }, loadouts: { loadForCast: async () => ({ loaded: loaded(), pipeline: pipeline() }) }, states: { loadActive: () => undefined }, clock: { now: () => "2026-01-01T00:00:02.000Z" }, ids: { nextId: () => "quest-2" } });
    await expect(runnerWithRunningQuest.runOnce({ pi: "pi", session: "session", cwd: "/repo", questId: "quest-2" })).rejects.toBeInstanceOf(ActiveQuestConflictError);
  });

  test("quest runner records immediate terminal casts and startup failures", async () => {
    let board: QuestBoard = createEmptyQuestBoard({ now: "2026-01-01T00:00:00.000Z" });
    const boards: QuestBoardRepository = { boardPath: "/repo/.pi/pi-materia/quest-board.json", loadOrCreate: async () => board, save: async (next) => { board = next; } };
    const terminal = state({ castId: "cast-done", active: false, phase: "complete", socketState: "complete", data: { quest: { questId: "quest-1", effectiveLoadoutName: "Auto", effectiveLoadoutId: "auto-id" } } });
    const runner = new QuestRunnerUseCases({ boards, casts: { startCast: async () => ({ loaded: loaded(), pipeline: pipeline(), state: terminal, effectiveLoadout: { requestedLoadoutOverride: "Auto", effectiveLoadoutName: "Auto", effectiveLoadoutId: "auto-id" } }) }, loadouts: { loadForCast: async () => ({ loaded: loaded(), pipeline: pipeline() }) }, states: { loadActive: () => undefined }, clock: { now: () => "2026-01-01T00:00:01.000Z" }, ids: { nextId: () => "quest-1" } });

    await runner.addQuest({ prompt: "finish immediately", loadoutOverride: "Auto" });
    const result = await runner.runNext({ pi: "pi", session: "session", cwd: "/repo" });
    expect(result?.quest.status).toBe("succeeded");
    expect(result?.quest.lastResult).toMatchObject({ status: "succeeded", castId: "cast-done", effectiveLoadoutName: "Auto", effectiveLoadoutId: "auto-id" });

    board = createEmptyQuestBoard({ now: "2026-01-01T00:00:00.000Z" });
    const failingRunner = new QuestRunnerUseCases({ boards, casts: { startCast: async () => { throw new Error("boom"); } }, loadouts: { loadForCast: async () => ({ loaded: loaded(), pipeline: pipeline() }) }, states: { loadActive: () => undefined }, clock: { now: () => "2026-01-01T00:00:02.000Z" }, ids: { nextId: () => "quest-fail" } });
    await failingRunner.addQuest({ prompt: "fail to start" });
    await expect(failingRunner.runNext({ pi: "pi", session: "session", cwd: "/repo" })).rejects.toThrow("boom");
    expect(board.quests[0]).toMatchObject({ status: "blocked", lastError: { message: "boom", code: "cast_start_failed" } });
  });

  test("quest runner settles completed casts with result metadata and auto-advances when enabled", async () => {
    let board: QuestBoard = createEmptyQuestBoard({ now: "2026-01-01T00:00:00.000Z" });
    const boards: QuestBoardRepository = { boardPath: "/repo/.pi/pi-materia/quest-board.json", loadOrCreate: async () => board, save: async (next) => { board = next; } };
    let active: MateriaCastState | undefined;
    const starts: string[] = [];
    const runner = new QuestRunnerUseCases({
      boards,
      casts: {
        startCast: async (input: Parameters<CastExecutionUseCases<string, string>["startCast"]>[0]) => {
          starts.push(input.request);
          active = state({ castId: `cast-${starts.length}`, request: input.request, runDir: `/repo/.pi/pi-materia/cast-${starts.length}`, artifactRoot: "/repo/.pi/pi-materia" });
          return { loaded: loaded(), pipeline: pipeline(), state: active };
        },
      },
      loadouts: { loadForCast: async () => ({ loaded: loaded(), pipeline: pipeline() }) },
      states: { loadActive: () => active },
      clock: { now: () => "2026-01-01T00:00:01.000Z" },
      ids: { nextId: () => `quest-${board.quests.length + 1}` },
    });

    await runner.addQuest({ prompt: "first quest" });
    await runner.addQuest({ prompt: "second quest" });
    const first = await runner.enableRunner({ pi: "pi", session: "session", cwd: "/repo" });
    active = state({ castId: first!.state.castId, active: false, phase: "complete", socketState: "complete", runDir: "/repo/.pi/pi-materia/cast-1", artifactRoot: "/repo/.pi/pi-materia", runState: { ...first!.state.runState, lastMessage: "Cast complete." } });

    const settled = await runner.handleCastSettled({ castId: first!.state.castId, state: active });
    const advanced = await runner.autoAdvanceNext({ pi: "pi", session: "session", cwd: "/repo", board: settled.board });

    expect(settled.quest).toMatchObject({ status: "succeeded", lastResult: { status: "succeeded", castId: "cast-1", message: "Cast complete.", runDirectory: "/repo/.pi/pi-materia/cast-1", artifactDirectory: "/repo/.pi/pi-materia" } });
    expect(advanced?.quest).toMatchObject({ id: "quest-2", status: "running", currentCastId: "cast-2" });
    expect(starts).toEqual(["first quest", "second quest"]);
  });

  test("quest runner does not auto-advance after stop disables the runner", async () => {
    let board: QuestBoard = createEmptyQuestBoard({ now: "2026-01-01T00:00:00.000Z" });
    const boards: QuestBoardRepository = { boardPath: "/repo/.pi/pi-materia/quest-board.json", loadOrCreate: async () => board, save: async (next) => { board = next; } };
    let active: MateriaCastState | undefined;
    let starts = 0;
    const runner = new QuestRunnerUseCases({
      boards,
      casts: { startCast: async () => { starts += 1; active = state({ castId: `cast-${starts}` }); return { loaded: loaded(), pipeline: pipeline(), state: active }; } },
      loadouts: { loadForCast: async () => ({ loaded: loaded(), pipeline: pipeline() }) },
      states: { loadActive: () => active },
      clock: { now: () => "2026-01-01T00:00:01.000Z" },
      ids: { nextId: () => `quest-${board.quests.length + 1}` },
    });

    await runner.addQuest({ prompt: "first" });
    await runner.addQuest({ prompt: "second" });
    const first = await runner.enableRunner({ pi: "pi", session: "session", cwd: "/repo" });
    await runner.stopRunner();
    active = state({ castId: first!.state.castId, active: false, phase: "complete", socketState: "complete" });
    const settled = await runner.handleCastSettled({ castId: first!.state.castId, state: active });

    await expect(runner.autoAdvanceNext({ pi: "pi", session: "session", cwd: "/repo", board: settled.board })).resolves.toBeUndefined();
    expect(starts).toBe(1);
    expect(board.quests[1]).toMatchObject({ status: "pending" });
  });

  test("quest runner status and no-pending starts are explicit", async () => {
    let board: QuestBoard = createEmptyQuestBoard({ now: "2026-01-01T00:00:00.000Z" });
    const boards: QuestBoardRepository = { boardPath: "/repo/.pi/pi-materia/quest-board.json", loadOrCreate: async () => board, save: async (next) => { board = next; } };
    const runner = new QuestRunnerUseCases({
      boards,
      casts: { startCast: async () => { throw new Error("must not start without pending quests"); } },
      loadouts: { loadForCast: async () => ({ loaded: loaded(), pipeline: pipeline() }) },
      states: { loadActive: () => state({ castId: "active-cast" }) },
      clock: { now: () => "2026-01-01T00:00:01.000Z" },
      ids: { nextId: () => "quest-1" },
    });

    await expect(runner.runNext({ pi: "pi", session: "session", cwd: "/repo" })).resolves.toBeUndefined();
    const status = await runner.getStatus("session");

    expect(status.boardPath).toBe("/repo/.pi/pi-materia/quest-board.json");
    expect(status.pendingCount).toBe(0);
    expect(status.activeCast?.castId).toBe("active-cast");
  });

  test("quest runner maps failed terminal casts and reconciles stale running quests as blocked", async () => {
    let board: QuestBoard = createEmptyQuestBoard({ now: "2026-01-01T00:00:00.000Z" });
    const boards: QuestBoardRepository = { boardPath: "/repo/.pi/pi-materia/quest-board.json", loadOrCreate: async () => board, save: async (next) => { board = next; } };
    let active: MateriaCastState | undefined;
    const runner = new QuestRunnerUseCases({
      boards,
      casts: { startCast: async () => { active = state({ castId: "cast-failed" }); return { loaded: loaded(), pipeline: pipeline(), state: active }; } },
      loadouts: { loadForCast: async () => ({ loaded: loaded(), pipeline: pipeline() }) },
      states: { loadActive: () => active },
      clock: { now: () => "2026-01-01T00:00:01.000Z" },
      ids: { nextId: () => `quest-${board.quests.length + 1}` },
    });

    await runner.addQuest({ prompt: "will fail" });
    const started = await runner.runNext({ pi: "pi", session: "session", cwd: "/repo" });
    active = state({ castId: started!.state.castId, active: false, phase: "failed", socketState: "failed", failedReason: "agent failed" });
    const settled = await runner.handleCastSettled({ castId: started!.state.castId, state: active });
    expect(settled.quest).toMatchObject({ status: "failed", lastResult: { status: "failed", error: "agent failed" }, lastError: { message: "agent failed" } });

    await runner.addQuest({ prompt: "stale after restart" });
    active = undefined;
    await runner.runNext({ pi: "pi", session: "session", cwd: "/repo" });
    const reconciled = await runner.reconcileOnSessionStart();

    expect(reconciled.reconciled).toHaveLength(1);
    expect(reconciled.reconciled[0]).toMatchObject({ status: "blocked", lastError: { code: "stale_running_quest" } });
  });

  test("configuredConfigPath prefers flag over environment", () => {
    expect(configuredConfigPath({ getFlag: () => " flag.json " }, { get: () => "env.json" })).toBe("flag.json");
    expect(configuredConfigPath({ getFlag: () => undefined }, { get: () => " env.json " })).toBe("env.json");
  });
});

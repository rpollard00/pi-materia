import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActiveCastConflictError, CastCatalogUseCases, CastExecutionUseCases, LoadoutUseCases, configuredConfigPath, type ArtifactCatalog, type CastAgentTurnPort, type CastContextPort, type CastLifecyclePort, type CastStateRepository, type CastStatusPort, type ConfigRepository, type PipelinePresenter } from "../src/application/index.js";
import type { LoadedConfig, MateriaCastState, ResolvedMateriaPipeline } from "../src/types.js";

function loaded(activeLoadout = "default"): LoadedConfig {
  return { source: "/repo/materia.json", config: { activeLoadout, materia: {}, loadouts: { [activeLoadout]: { entry: "Socket-1", sockets: {} } } } };
}

function pipeline(): ResolvedMateriaPipeline {
  return { entry: { id: "Socket-1", socket: { type: "utility", utility: "noop" } }, sockets: { "Socket-1": { id: "Socket-1", socket: { type: "utility", utility: "noop" } } } };
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
          Review: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Review" } } },
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
        "Socket-7": { socketKind: "entry", type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-8" }] },
        "Socket-8": { socketKind: "normal", type: "agent", materia: "Review", advance: { cursor: "items", items: "$.items", done: "end" }, edges: [{ when: "satisfied", to: "Socket-9" }] },
        "Socket-9": { socketKind: "normal", type: "agent", materia: "Build" },
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
        loadouts: { Review: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Review" } } } },
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
      async load() { return { source: "/repo/materia.json", config: { activeLoadout: "Review", artifactDir: artifactRoot, materia: { Build: { prompt: "build" } }, loadouts: { Review: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Build" } } } } } }; },
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

  test("configuredConfigPath prefers flag over environment", () => {
    expect(configuredConfigPath({ getFlag: () => " flag.json " }, { get: () => "env.json" })).toBe("flag.json");
    expect(configuredConfigPath({ getFlag: () => undefined }, { get: () => " env.json " })).toBe("env.json");
  });
});

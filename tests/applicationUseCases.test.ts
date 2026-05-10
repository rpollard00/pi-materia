import { describe, expect, test } from "bun:test";
import { ActiveCastConflictError, CastCatalogUseCases, CastExecutionUseCases, LoadoutUseCases, configuredConfigPath, type ArtifactCatalog, type CastRuntime, type CastStateRepository, type ConfigRepository, type PipelinePresenter } from "../src/application/index.js";
import type { LoadedConfig, MateriaCastState, ResolvedMateriaPipeline } from "../src/types.js";

function loaded(activeLoadout = "default"): LoadedConfig {
  return { source: "/repo/materia.json", config: { activeLoadout, materia: {}, loadouts: { [activeLoadout]: { entry: "Socket-1", nodes: {} } } } };
}

function pipeline(): ResolvedMateriaPipeline {
  return { entry: { id: "Socket-1", node: { type: "utility", utility: "noop" } }, nodes: { "Socket-1": { id: "Socket-1", node: { type: "utility", utility: "noop" } } } };
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
    usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byMateria: {}, byNode: {}, byTask: {}, byAttempt: {} },
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
    const active = state({ awaitingResponse: true, nodeState: "awaiting_agent_response", currentNode: "Socket-1" });
    const events: string[] = [];
    const states: CastStateRepository<string> = { loadActive: () => active, listLatest: () => [], listResumable: () => [state({ castId: "resume-me" })], listRevivable: () => [state({ castId: "revive-me" })] };
    const runtime: CastRuntime<string, string, string> = {
      buildIsolatedContext: (messages) => ({ messages }),
      currentMateria: () => ({ id: "builder" }),
      activeSystemPrompt: () => "domain prompt",
      prepareMultiTurnRefinementTurn: async () => { events.push("refine"); },
      handleAgentEnd: async () => { events.push("end"); },
      start: async (_pi, _session, _loaded, _pipeline, request) => { events.push(`start:${request}`); },
      continue: async () => { events.push("continue"); },
      resume: async (_pi, _session, castId) => { events.push(`resume:${castId}`); },
      revive: async (_pi, _session, castId) => { events.push(`revive:${castId}`); },
      clear: () => { events.push("clear"); },
      statusLabel: () => "running",
    };
    const loadouts = new LoadoutUseCases({ configs: { async load() { return loaded(); }, async saveActiveLoadout() { return ""; }, resolveArtifactRoot: () => "" }, pipeline: { resolve: pipeline, renderGrid: () => [], renderLoadoutList: () => [] } });
    const useCases = new CastExecutionUseCases({ states, runtime, loadouts });

    expect(useCases.buildIsolatedContext(["hello"], "session")).toEqual({ messages: ["hello"] });
    await expect(useCases.prepareAgentStart({ pi: "pi", session: "session", systemPrompt: "base" })).resolves.toContain("domain prompt");
    await useCases.startCast({ pi: "pi", session: "session", cwd: "/repo", request: "ship" }).catch((error) => expect(error).toBeInstanceOf(ActiveCastConflictError));
    await expect(useCases.resumeLatestOrRequested("pi", "session")).resolves.toBe("resume-me");
    await expect(useCases.reviveLatestOrRequested("pi", "session", "explicit")).resolves.toBe("explicit");
    expect(useCases.abortActive("pi", "session")?.castId).toBe("cast-1");
    expect(events).toEqual(["resume:resume-me", "revive:explicit", "clear"]);
  });

  test("configuredConfigPath prefers flag over environment", () => {
    expect(configuredConfigPath({ getFlag: () => " flag.json " }, { get: () => "env.json" })).toBe("flag.json");
    expect(configuredConfigPath({ getFlag: () => undefined }, { get: () => " env.json " })).toBe("env.json");
  });
});

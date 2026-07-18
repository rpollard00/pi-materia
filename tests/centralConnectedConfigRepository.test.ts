import { describe, expect, test } from "bun:test";
import type { CatalogAccessPort, CatalogItemSummary } from "../src/application/controlPlane.js";
import { centralConnectedModeMetadata } from "../src/application/controlPlane.js";
import type { LoadConfigOptions } from "../src/config/config.js";
import { createCentralConnectedConfigRepository } from "../src/infrastructure/centralConnectedConfigRepository.js";
import { resolvePipeline } from "../src/runtime/pipeline.js";
import type { LoadedConfig } from "../src/types.js";

function loaded(source = "local"): LoadedConfig {
  return {
    config: { materia: {} },
    source,
    layers: [],
    loadoutSources: {},
    materiaSources: {},
  };
}

function emptyCatalog(): CatalogAccessPort {
  return {
    mode: () => centralConnectedModeMetadata(),
    list: async () => [],
    get: async () => undefined,
    head: async () => undefined,
  };
}

describe("central-connected config repository", () => {
  test("keeps local-only loads free of central client and catalog I/O", async () => {
    let clientCreations = 0;
    const optionsSeen: Array<LoadConfigOptions | undefined> = [];
    const repository = createCentralConnectedConfigRepository({
      resolveRuntimeConfig: async () => undefined,
      createCatalogPort: () => {
        clientCreations++;
        return emptyCatalog();
      },
      local: {
        async load(_cwd, _configuredPath, options) {
          optionsSeen.push(options);
          return loaded();
        },
        async saveActiveLoadout() {
          return "/tmp/local.json";
        },
        resolveArtifactRoot: (cwd) => cwd,
      },
    });

    expect(await repository.load("/project")).toEqual(loaded());
    expect(clientCreations).toBe(0);
    expect(optionsSeen).toEqual([undefined]);
  });

  test("constructs the central source through the configured catalog adapter", async () => {
    const centralSummary: CatalogItemSummary = {
      id: "Build",
      kind: "materia",
      version: "4",
      contentHash: "sha256:build",
      updatedAt: "2026-07-18T00:00:00.000Z",
    };
    let clientOptions: Record<string, unknown> | undefined;
    let received: LoadConfigOptions | undefined;
    const repository = createCentralConnectedConfigRepository({
      resolveRuntimeConfig: async () => ({
        apiUrl: "https://central.example.test",
        requestTimeoutMs: 2_500,
        credentials: { readToken: "reader" },
      }),
      createCatalogPort: (options) => {
        clientOptions = options as unknown as Record<string, unknown>;
        return {
          mode: () => centralConnectedModeMetadata(),
          list: async () => [centralSummary],
          get: async () => ({
            ...centralSummary,
            content: { definition: { type: "agent", tools: "coding", prompt: "remote build" } },
          }),
          head: async () => centralSummary,
        };
      },
      local: {
        async load(_cwd, _configuredPath, options) {
          received = options;
          return loaded(options?.centralSource ? "default < central" : "local");
        },
        async saveActiveLoadout() {
          return "/tmp/local.json";
        },
        resolveArtifactRoot: (cwd) => cwd,
      },
      clock: () => "2026-07-18T01:00:00.000Z",
    });

    expect((await repository.load("/project")).source).toBe("default < central");
    expect(clientOptions).toMatchObject({
      apiUrl: "https://central.example.test",
      requestTimeoutMs: 2_500,
      credentials: { readToken: "reader" },
      mode: "central-connected",
    });
    expect(received?.centralSource?.materia?.Build).toMatchObject({ prompt: "remote build" });
    expect(received?.centralSource?.snapshot?.status).toBe("fresh");
  });

  test("keeps a selected central loadout process-local instead of persisting its remote identity", async () => {
    const centralSummary: CatalogItemSummary = {
      id: "flow",
      kind: "loadout",
      name: "Central Flow",
      version: "1",
      contentHash: "sha256:flow",
      updatedAt: "2026-07-18T00:00:00.000Z",
    };
    let localSaveCalls = 0;
    let receivedSource: LoadConfigOptions | undefined;
    const repository = createCentralConnectedConfigRepository({
      resolveRuntimeConfig: async () => ({
        apiUrl: "https://central.example.test",
        requestTimeoutMs: 1_000,
        credentials: { readToken: "reader" },
      }),
      createCatalogPort: () => ({
        mode: () => centralConnectedModeMetadata(),
        list: async () => [centralSummary],
        get: async () => ({
          ...centralSummary,
          content: { definition: { entry: "Socket-1", sockets: {} } },
        }),
        head: async () => centralSummary,
      }),
      local: {
        async load(_cwd, _configuredPath, options) {
          receivedSource = options;
          if (!options?.centralSource?.loadouts?.["Central Flow"]) return loaded();
          return {
            config: {
              activeLoadout: "Local Flow",
              materia: {},
              loadouts: {
                "Local Flow": { id: "project:local-flow", entry: "Socket-1", sockets: {} },
                "Central Flow": options.centralSource.loadouts["Central Flow"],
              },
            },
            source: "default < central < project",
            layers: [],
            loadoutSources: { "Local Flow": "project", "Central Flow": "central" },
            materiaSources: {},
          };
        },
        async saveActiveLoadout() {
          localSaveCalls++;
          return "/tmp/user.json";
        },
        resolveArtifactRoot: (cwd) => cwd,
      },
    });

    expect(await repository.saveActiveLoadout("/project", "Central Flow")).toContain("process-local");
    expect(localSaveCalls).toBe(0);
    expect(receivedSource?.centralSource?.loadouts?.["Central Flow"]).toBeDefined();
    const selected = await repository.load("/project");
    expect(selected.config.activeLoadout).toBe("Central Flow");
    expect(selected.config.activeLoadoutId).toBe("central:central flow");
  });

  test("falls back in memory when a persisted central-only active loadout is unavailable on startup", async () => {
    const localLoaded = {
      config: {
        activeLoadout: "Central Flow",
        activeLoadoutId: "central:central-flow",
        materia: { Build: { type: "agent", tools: "coding", prompt: "local build" } },
        loadouts: {
          "Local Flow": {
            id: "project:local-flow",
            entry: "Socket-1",
            sockets: { "Socket-1": { materia: "Build" } },
          },
        },
      },
      source: "default < project",
      layers: [],
      loadoutSources: { "Local Flow": "project" },
      materiaSources: { Build: "default" },
    } satisfies LoadedConfig;
    const repository = createCentralConnectedConfigRepository({
      resolveRuntimeConfig: async () => ({
        apiUrl: "https://central.example.test",
        requestTimeoutMs: 1_000,
        credentials: { readToken: "reader" },
      }),
      createCatalogPort: () => ({
        mode: () => centralConnectedModeMetadata(),
        list: async () => { throw new Error("central unavailable"); },
        get: async () => undefined,
        head: async () => undefined,
      }),
      local: {
        async load() {
          return localLoaded;
        },
        async saveActiveLoadout() {
          return "/tmp/project.json";
        },
        resolveArtifactRoot: (cwd) => cwd,
      },
    });

    const recovered = await repository.load("/project");

    expect(recovered.config.activeLoadout).toBe("Local Flow");
    expect(recovered.config.activeLoadoutId).toBe("project:local-flow");
    expect(resolvePipeline(recovered.config).entry.id).toBe("Socket-1");
    expect(localLoaded.config.activeLoadout).toBe("Central Flow");
    expect(recovered.centralCatalogSnapshot).toBeUndefined();
  });
});

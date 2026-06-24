import { describe, expect, test } from "bun:test";
import {
  createLocalAdminMetadataPort,
  createLocalCatalogAccessPort,
  createLocalControlPlanePorts,
  createLocalModelPolicyPort,
  createLocalTelemetryStatusPort,
  LOCAL_DEFINITION_UPDATED_AT,
  LOCAL_DEFINITION_VERSION,
  LOCAL_LOADOUT_ID_PREFIX,
  LOCAL_MATERIA_ID_PREFIX,
  hashLocalDefinition,
  localLoadoutItemId,
  localMateriaItemId,
  type LocalControlPlaneAdapterOptions,
} from "../src/infrastructure/localControlPlane/index.js";
import { defaultCapabilities } from "../src/application/controlPlane.js";
import type { EnrichedEvent } from "../src/domain/eventing.js";
import type { LoadedConfig } from "../src/types.js";

// ── Fixtures ────────────────────────────────────────────────────────────

function loadedConfigFixture(): LoadedConfig {
  return {
    source: "< merged layers",
    materiaSources: { builder: "user", reviewer: "default" },
    loadoutSources: { "full-auto": "default", custom: "project" },
    config: {
      materia: {
        builder: { type: "agent", tools: "coding", prompt: "Build it" },
        reviewer: { type: "agent", tools: "readOnly", prompt: "Review it" },
      },
      loadouts: {
        "full-auto": { id: "default:full-auto", entry: "Socket-1", sockets: {} },
        custom: { id: "project:custom", entry: "Socket-2", sockets: {} },
      },
    },
  };
}

function event(overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    type: "status.progress",
    eventId: "evt-1",
    occurredAt: "2026-06-24T00:00:00.000Z",
    sequence: 1,
    castId: "cast-1",
    socketId: "Socket-1",
    materia: "builder",
    ...overrides,
  };
}

function withSources(options: LocalControlPlaneAdapterOptions = {}): LocalControlPlaneAdapterOptions {
  return {
    ...options,
    configSource: options.configSource ?? { getLoadedConfig: () => loadedConfigFixture() },
    monitoringSource:
      options.monitoringSource ??
      {
        getRuntimeEvents: () => [event({ sequence: 1 }), event({ sequence: 2, castId: "cast-1" }), event({ sequence: 3, castId: "cast-2" })],
        getRuntimeId: () => "cast-1",
        isHealthy: () => true,
      },
  };
}

// ── Mode metadata ───────────────────────────────────────────────────────

describe("local control-plane adapter mode metadata", () => {
  test("every port reports local-only with local session and no central", () => {
    const options = withSources({ label: "local-dev" });
    const ports = createLocalControlPlanePorts(options);
    for (const port of [ports.catalog, ports.modelPolicy, ports.telemetry, ports.admin]) {
      const meta = port.mode();
      expect(meta.mode).toBe("local-only");
      expect(meta.hasLocalSession).toBe(true);
      expect(meta.hasCentral).toBe(false);
      expect(meta.capabilities).toEqual(defaultCapabilities(false));
      expect(meta.label).toBe("local-dev");
    }
  });

  test("omits label when none configured", () => {
    const ports = createLocalControlPlanePorts(withSources());
    expect(ports.catalog.mode().label).toBeUndefined();
  });
});

// ── Catalog ─────────────────────────────────────────────────────────────

describe("local catalog access port", () => {
  test("exposes local materia and loadout definitions as catalog DTOs", async () => {
    const catalog = createLocalCatalogAccessPort(withSources());

    const all = await catalog.list();
    expect(all).toHaveLength(4);
    expect(all.map((s) => s.id).sort()).toEqual(
      [localMateriaItemId("builder"), localMateriaItemId("reviewer"), localLoadoutItemId("custom"), localLoadoutItemId("full-auto")].sort(),
    );

    const materia = await catalog.list({ kind: "materia" });
    expect(materia).toHaveLength(2);
    expect(materia.every((s) => s.kind === "materia")).toBe(true);

    const loadouts = await catalog.list({ kind: "loadout" });
    expect(loadouts).toHaveLength(2);
    expect(loadouts.every((s) => s.kind === "loadout")).toBe(true);
  });

  test("summaries carry local sentinel version/updatedAt, content hash, and local-scope provenance", async () => {
    const catalog = createLocalCatalogAccessPort(withSources());
    const [builder] = (await catalog.list({ kind: "materia", search: "builder" }));
    expect(builder).toBeDefined();
    expect(builder!.name).toBe("builder");
    expect(builder!.version).toBe(LOCAL_DEFINITION_VERSION);
    expect(builder!.updatedAt).toBe(LOCAL_DEFINITION_UPDATED_AT);
    expect(builder!.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
    expect(builder!.provenance?.source).toBe("user");

    const [fullAuto] = (await catalog.list({ kind: "loadout", search: "full-auto" }));
    expect(fullAuto!.provenance?.source).toBe("default");
  });

  test("get returns the full item with definition content; head returns a summary without content", async () => {
    const catalog = createLocalCatalogAccessPort(withSources());
    const id = localMateriaItemId("builder");

    const item = await catalog.get(id, "materia");
    expect(item).toBeDefined();
    expect(item!.content.definition).toEqual({ type: "agent", tools: "coding", prompt: "Build it" });

    const head = await catalog.head(id);
    expect(head).toBeDefined();
    expect(head!.contentHash).toBe(item!.contentHash);
    expect((head as unknown as { content?: unknown }).content).toBeUndefined();
  });

  test("get/head return undefined for unknown ids or mismatched kind", async () => {
    const catalog = createLocalCatalogAccessPort(withSources());
    expect(await catalog.get("local:materia:nope")).toBeUndefined();
    expect(await catalog.get(localLoadoutItemId("custom"), "materia")).toBeUndefined();
    expect(await catalog.head(localLoadoutItemId("custom"), "materia")).toBeUndefined();
  });

  test("content hash is deterministic and order-independent", () => {
    const a = { type: "agent", tools: "coding", prompt: "Build it" };
    const b = { prompt: "Build it", tools: "coding", type: "agent" };
    expect(hashLocalDefinition(a)).toBe(hashLocalDefinition(b));
    expect(hashLocalDefinition({ ...a, prompt: "Ship it" })).not.toBe(hashLocalDefinition(a));
  });

  test("list returns empty when no config source is configured", async () => {
    const catalog = createLocalCatalogAccessPort({});
    expect(await catalog.list()).toEqual([]);
    expect(await catalog.get(localMateriaItemId("builder"))).toBeUndefined();
  });

  test("catalog ids are prefixed by kind to avoid materia/loadout name collisions", () => {
    expect(localMateriaItemId("shared")).toBe(`${LOCAL_MATERIA_ID_PREFIX}shared`);
    expect(localLoadoutItemId("shared")).toBe(`${LOCAL_LOADOUT_ID_PREFIX}shared`);
    expect(localMateriaItemId("shared")).not.toBe(localLoadoutItemId("shared"));
  });
});

// ── Model policy ────────────────────────────────────────────────────────

describe("local model policy port", () => {
  test("reports no active policy and no policies, preserving local selection behavior", async () => {
    const modelPolicy = createLocalModelPolicyPort(withSources());
    expect(await modelPolicy.getActivePolicy()).toBeUndefined();
    expect(await modelPolicy.listPolicies()).toEqual([]);
  });
});

// ── Telemetry / status ──────────────────────────────────────────────────

describe("local telemetry/status port", () => {
  test("status reports local-only mode with runtime/event counts from local monitoring", async () => {
    const telemetry = createLocalTelemetryStatusPort(withSources({ label: "local-dev" }));
    const status = await telemetry.status();
    expect(status.mode).toBe("local-only");
    expect(status.runtimeCount).toBe(1);
    expect(status.eventCount).toBe(3);
    expect(status.healthy).toBe(true);
    expect(status.label).toBe("local-dev");
    expect(status.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("queryEvents returns local runtime events and honors filters", async () => {
    const telemetry = createLocalTelemetryStatusPort(withSources());

    const cast1 = await telemetry.queryEvents({ castId: "cast-1" });
    expect(cast1).toHaveLength(2);
    expect(cast1.every((e) => e.castId === "cast-1")).toBe(true);

    const since = await telemetry.queryEvents({ sinceSequence: 2 });
    expect(since.map((e) => e.sequence)).toEqual([2, 3]);

    const limited = await telemetry.queryEvents({ limit: 1 });
    expect(limited).toHaveLength(1);

    // In local mode the runtime identity resolves to the cast id.
    expect(await telemetry.queryEvents({ runtimeId: "cast-2" })).toHaveLength(1);
  });

  test("ingest is a best-effort acknowledgement and does not persist", async () => {
    const telemetry = createLocalTelemetryStatusPort(withSources());
    const result = await telemetry.ingest({ events: [event({ sequence: 9 }), event({ sequence: 10 })] });
    expect(result.accepted).toBe(2);
    expect(result.ingestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Ingested events are not added to the local read surface (local-only has no central store).
    expect((await telemetry.queryEvents()).length).toBe(3);
  });

  test("degrades gracefully when no monitoring source is configured", async () => {
    const telemetry = createLocalTelemetryStatusPort({});
    const status = await telemetry.status();
    expect(status.eventCount).toBe(0);
    expect(status.healthy).toBe(true);
    expect(await telemetry.queryEvents()).toEqual([]);
    expect((await telemetry.ingest({ events: [] })).accepted).toBe(0);
  });

  test("degrades gracefully when the monitoring source throws", async () => {
    const telemetry = createLocalTelemetryStatusPort({
      monitoringSource: {
        getRuntimeEvents: () => {
          throw new Error("boom");
        },
        isHealthy: () => {
          throw new Error("boom");
        },
      },
    });
    expect((await telemetry.status()).eventCount).toBe(0);
    expect((await telemetry.status()).healthy).toBe(false);
    expect(await telemetry.queryEvents()).toEqual([]);
  });
});

// ── Admin ───────────────────────────────────────────────────────────────

describe("local admin metadata port", () => {
  test("reports local-only server info with no auth surface and central-disabled capabilities", async () => {
    const admin = createLocalAdminMetadataPort(withSources({ label: "local-dev", startedAt: "2026-06-24T00:00:00.000Z" }));
    const meta = await admin.getMetadata();
    expect(meta.server.mode).toBe("local-only");
    expect(meta.server.authMethods).toEqual([]);
    expect(meta.server.capabilities).toEqual(defaultCapabilities(false));
    expect(meta.server.label).toBe("local-dev");
    expect(meta.server.startedAt).toBe("2026-06-24T00:00:00.000Z");
    expect(meta.principals).toBeUndefined();
    expect(meta.roles).toBeUndefined();
  });

  test("central catalog admin writes are unsupported in local-only mode", async () => {
    const admin = createLocalAdminMetadataPort(withSources());
    await expect(admin.createCatalogItem({ id: "x", kind: "loadout", content: { definition: {} } })).rejects.toThrow(/not available in local-only mode/);
    await expect(admin.updateCatalogItem({ id: "x" })).rejects.toThrow(/not available in local-only mode/);
    await expect(admin.deleteCatalogItem({ id: "x" })).rejects.toThrow(/not available in local-only mode/);
  });
});

// ── Composition & boundaries ────────────────────────────────────────────

describe("local control-plane adapter composition and boundaries", () => {
  test("createLocalControlPlanePorts composes all four ports", () => {
    const ports = createLocalControlPlanePorts(withSources());
    expect(ports.catalog.mode().mode).toBe("local-only");
    expect(ports.modelPolicy.mode().mode).toBe("local-only");
    expect(ports.telemetry.mode().mode).toBe("local-only");
    expect(ports.admin.mode().mode).toBe("local-only");
  });

  test("no control-plane port exposes quest-board APIs", () => {
    const questish = (name: string) => /quest/i.test(name);
    const portMethodNames = (port: object): string[] =>
      Object.getOwnPropertyNames(port).filter((name) => typeof (port as unknown as Record<string, unknown>)[name] === "function");

    const ports = createLocalControlPlanePorts(withSources());
    for (const port of [ports.catalog, ports.modelPolicy, ports.telemetry, ports.admin]) {
      expect(portMethodNames(port).some(questish)).toBe(false);
    }
  });
});

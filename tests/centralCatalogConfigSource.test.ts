import { describe, expect, test } from "bun:test";
import type {
  CatalogAccessPort,
  CatalogItem,
  CatalogItemSummary,
} from "../src/application/controlPlane.js";
import { centralConnectedModeMetadata } from "../src/application/controlPlane.js";
import { createCentralCatalogConfigSourceLoader } from "../src/central/client/catalogConfigSource.js";
import { centralCatalogSummaryKey } from "../src/config/centralCatalogSource.js";

const UPDATED_AT = "2026-07-18T00:00:00.000Z";

function summary(overrides: Partial<CatalogItemSummary> & Pick<CatalogItemSummary, "id" | "kind">): CatalogItemSummary {
  return {
    version: "1",
    contentHash: `sha256:${overrides.id}`,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function item(entry: CatalogItemSummary, definition: Record<string, unknown>): CatalogItem {
  return { ...entry, content: { definition } };
}

function catalogPort(input: {
  list: () => Promise<CatalogItemSummary[]>;
  get: (id: string, kind?: "loadout" | "materia") => Promise<CatalogItem | undefined>;
}): CatalogAccessPort {
  return {
    mode: () => centralConnectedModeMetadata(),
    list: input.list,
    get: input.get,
    async head(id, kind) {
      return (await input.list()).find((entry) => entry.id === id && (kind === undefined || entry.kind === kind));
    },
  };
}

describe("central catalog config source loader", () => {
  test("fetches summaries and definitions into the read-only central config shape", async () => {
    const loadoutSummary = summary({ id: "flow-1", kind: "loadout", name: "Team Flow" });
    const materiaSummary = summary({ id: "Team-Build", kind: "materia", name: "Build display label" });
    const loadoutDefinition = {
      id: "central:flow-1",
      source: "user",
      catalogOrigin: { catalogItemId: "old" },
      entry: "Socket-1",
      sockets: { "Socket-1": { materia: "Team-Build" } },
    };
    const materiaDefinition = {
      type: "agent",
      tools: "coding",
      prompt: "Build centrally",
      catalogOrigin: { catalogItemId: "old" },
    };
    const items = new Map([
      [`loadout:${loadoutSummary.id}`, item(loadoutSummary, loadoutDefinition)],
      [`materia:${materiaSummary.id}`, item(materiaSummary, materiaDefinition)],
    ]);
    const gets: string[] = [];
    const loader = createCentralCatalogConfigSourceLoader(catalogPort({
      list: async () => [materiaSummary, loadoutSummary],
      get: async (id, kind) => {
        gets.push(`${kind}:${id}`);
        return items.get(`${kind}:${id}`);
      },
    }), { clock: () => UPDATED_AT });

    const source = await loader.load();

    expect(gets).toEqual(["loadout:flow-1", "materia:Team-Build"]);
    expect(source?.loadouts?.["Team Flow"]).toMatchObject({ id: "central:flow-1", entry: "Socket-1" });
    expect((source?.loadouts?.["Team Flow"] as { source?: string }).source).toBeUndefined();
    expect((source?.loadouts?.["Team Flow"] as { catalogOrigin?: unknown }).catalogOrigin).toBeUndefined();
    // Materia map identity is the stable catalog id; summary.name is presentation metadata.
    expect(source?.materia?.["Team-Build"]).toMatchObject({ prompt: "Build centrally" });
    expect((source?.materia?.["Team-Build"] as { catalogOrigin?: unknown }).catalogOrigin).toBeUndefined();
    expect(source?.summaries?.[centralCatalogSummaryKey("loadout", "flow-1")]).toEqual({
      version: "1",
      contentHash: "sha256:flow-1",
      updatedAt: UPDATED_AT,
    });
    expect(source?.snapshot).toEqual({ status: "fresh", fetchedAt: UPDATED_AT, attemptedAt: UPDATED_AT });
    // Projection never mutates the transport DTOs.
    expect(loadoutDefinition.source).toBe("user");
    expect(loadoutDefinition.catalogOrigin).toEqual({ catalogItemId: "old" });
  });

  test("uses a clearly marked process-local last-known snapshot after an outage", async () => {
    const centralSummary = summary({ id: "Build", kind: "materia" });
    let unavailable = false;
    const failures: boolean[] = [];
    const times = [
      "2026-07-18T01:00:00.000Z",
      "2026-07-18T02:00:00.000Z",
    ];
    const loader = createCentralCatalogConfigSourceLoader(catalogPort({
      list: async () => {
        if (unavailable) throw new Error("offline");
        return [centralSummary];
      },
      get: async () => item(centralSummary, { type: "agent", tools: "coding", prompt: "cached" }),
    }), {
      clock: () => times.shift()!,
      onRefreshFailure: (_error, usingLastKnown) => failures.push(usingLastKnown),
    });

    const fresh = await loader.load();
    unavailable = true;
    const stale = await loader.load();

    expect(fresh?.snapshot?.status).toBe("fresh");
    expect(stale?.materia?.Build).toMatchObject({ prompt: "cached" });
    expect(stale?.snapshot).toEqual({
      status: "last-known",
      fetchedAt: "2026-07-18T01:00:00.000Z",
      attemptedAt: "2026-07-18T02:00:00.000Z",
      reason: "Central catalog refresh failed; using the last-known in-memory snapshot.",
    });
    expect(failures).toEqual([true]);
  });

  test("omits the central source when the first refresh is unavailable", async () => {
    let failures = 0;
    const loader = createCentralCatalogConfigSourceLoader(catalogPort({
      list: async () => { throw new Error("offline"); },
      get: async () => undefined,
    }), {
      clock: () => UPDATED_AT,
      onRefreshFailure: (_error, usingLastKnown) => {
        expect(usingLastKnown).toBe(false);
        failures++;
      },
    });

    expect(await loader.load()).toBeUndefined();
    expect(failures).toBe(1);
  });

  test("coalesces concurrent refreshes into one catalog snapshot", async () => {
    let lists = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const loader = createCentralCatalogConfigSourceLoader(catalogPort({
      list: async () => {
        lists++;
        await pending;
        return [];
      },
      get: async () => undefined,
    }), { clock: () => UPDATED_AT });

    const first = loader.load();
    const second = loader.load();
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(lists).toBe(1);
    expect(left).toEqual(right);
    expect(left?.summaries).toEqual({});
  });
});

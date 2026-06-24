import { describe, expect, test } from "bun:test";
import {
  CatalogConflictError,
  CatalogNotFoundError,
  CatalogVersionMismatchError,
  CentralCatalogWriteError,
  createInMemoryCentralCatalogRepository,
  hashCentralContent,
  type CentralCatalogRepository,
} from "../src/central/index.js";

/** Deterministic clock so versions/timestamps are stable across assertions. */
function fixedClock(times: string[]): () => string {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)];
}

describe("central catalog repository — create + read", () => {
  test("create stores a versioned item with hash, timestamp, and default central provenance", async () => {
    const repo = createInMemoryCentralCatalogRepository({ clock: fixedClock(["2026-01-01T00:00:00.000Z"]) });
    const result = await repo.create({
      id: "buildga",
      kind: "materia",
      name: "Buildga",
      description: "builder materia",
      content: { definition: { type: "agent", model: { value: "zai/glm-4.6" } } },
      principalId: "principal-1",
    });

    expect(result.action).toBe("created");
    expect(result.summary).toEqual({
      id: "buildga",
      kind: "materia",
      name: "Buildga",
      description: "builder materia",
      version: "1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      contentHash: hashCentralContent({ definition: { type: "agent", model: { value: "zai/glm-4.6" } } }),
      provenance: { source: "central" },
    });
    expect(result.summary.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.audit).toBeDefined();
    expect(result.audit?.action).toBe("catalog-item.created");
    expect(result.audit?.resourceType).toBe("catalog-item");
    expect(result.audit?.resourceId).toBe("materia:buildga");
    expect(result.audit?.outcome).toBe("success");
    expect(result.audit?.source).toBe("catalog-admin");
    expect(result.audit?.principalId).toBe("principal-1");

    // Read APIs surface the stored item.
    expect(repo.size()).toBe(1);
    const item = await repo.get("buildga", "materia");
    expect(item?.content.definition).toEqual({ type: "agent", model: { value: "zai/glm-4.6" } });
    const head = await repo.head("buildga", "materia");
    expect(head?.version).toBe("1");
  });

  test("create rejects duplicate id+kind and is per-kind (materia and loadout may share an id)", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    await repo.create({ id: "shared", kind: "materia", content: { definition: { a: 1 } } });

    // Same id + same kind conflicts.
    await expect(repo.create({ id: "shared", kind: "materia", content: { definition: {} } })).rejects.toBeInstanceOf(CatalogConflictError);
    await expect(repo.create({ id: "shared", kind: "materia", content: { definition: {} } })).rejects.toThrow(/already exists/);

    // Same id under a different kind is allowed.
    await repo.create({ id: "shared", kind: "loadout", content: { definition: { sockets: [] } } });
    expect(repo.size()).toBe(2);
    expect((await repo.get("shared", "materia"))?.kind).toBe("materia");
    expect((await repo.get("shared", "loadout"))?.kind).toBe("loadout");
  });

  test("create validates input structure", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    await expect(repo.create({ id: "", kind: "materia", content: { definition: {} } })).rejects.toThrow(/id/);
    await expect(repo.create({ id: "x", kind: "bogus", content: { definition: {} } } as never)).rejects.toThrow(/kind/);
    await expect(repo.create({ id: "x", kind: "materia", content: {} as never })).rejects.toThrow(/definition/);
    await expect(repo.create({ id: "x", kind: "materia", content: { definition: "not-an-object" } })).rejects.toThrow(/definition/);
    await expect(repo.create({ id: "x", kind: "materia", name: 5, content: { definition: {} } } as never)).rejects.toThrow(/name/);
  });
});

describe("central catalog repository — update", () => {
  test("update bumps version, recomputes hash, and updates timestamp", async () => {
    const repo = createInMemoryCentralCatalogRepository({ clock: fixedClock(["t1", "t2", "t3"]) });
    await repo.create({ id: "loadout-a", kind: "loadout", content: { definition: { sockets: [1] } } });

    const updated = await repo.update({ id: "loadout-a", name: "Loadout A", content: { definition: { sockets: [1, 2] } } });
    expect(updated.action).toBe("updated");
    expect(updated.summary.version).toBe("2");
    expect(updated.summary.updatedAt).toBe("t2");
    expect(updated.summary.contentHash).toBe(hashCentralContent({ definition: { sockets: [1, 2] } }));
    expect(updated.summary.name).toBe("Loadout A");

    // Partial update leaves prior content/name intact where fields are omitted.
    const partial = await repo.update({ id: "loadout-a", description: "desc" });
    expect(partial.summary.version).toBe("3");
    expect(partial.summary.name).toBe("Loadout A");
    expect(partial.summary.description).toBe("desc");
    const item = await repo.get("loadout-a", "loadout");
    expect(item?.content.definition).toEqual({ sockets: [1, 2] });
  });

  test("update honors expectedVersion for optimistic concurrency", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    await repo.create({ id: "m1", kind: "materia", content: { definition: {} } });

    // Correct expected version succeeds.
    const updated = await repo.update({ id: "m1", content: { definition: { v: 2 } }, expectedVersion: "1" });
    expect(updated.summary.version).toBe("2");

    // Stale expected version fails with current version surfaced.
    await expect(repo.update({ id: "m1", expectedVersion: "1" })).rejects.toBeInstanceOf(CatalogVersionMismatchError);
    await expect(repo.update({ id: "m1", expectedVersion: "1" })).rejects.toThrow(/version mismatch/);
    const error = await repo.update({ id: "m1", expectedVersion: "1" }).catch((err: CatalogVersionMismatchError) => err);
    expect(error.currentVersion).toBe("2");
  });

  test("update on unknown item surfaces not-found", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    await expect(repo.update({ id: "missing", content: { definition: {} } })).rejects.toBeInstanceOf(CatalogNotFoundError);
    await expect(repo.update({ id: "missing" })).rejects.toThrow(/not found/);
  });

  test("update validates inputs", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    await repo.create({ id: "m1", kind: "materia", content: { definition: {} } });
    await expect(repo.update({ id: "m1", kind: "bogus" } as never)).rejects.toThrow(/kind/);
    await expect(repo.update({ id: "m1", content: { definition: 7 } })).rejects.toThrow(/definition/);
    await expect(repo.update({ id: "m1", expectedVersion: "" })).rejects.toThrow(/expectedVersion/);
  });
});

describe("central catalog repository — delete", () => {
  test("delete removes the item and returns its final summary", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    await repo.create({ id: "d1", kind: "materia", content: { definition: {} } });
    expect(repo.size()).toBe(1);

    const deleted = await repo.delete({ id: "d1" });
    expect(deleted.action).toBe("deleted");
    expect(deleted.summary.id).toBe("d1");
    expect(repo.size()).toBe(0);
    expect(await repo.get("d1", "materia")).toBeUndefined();
  });

  test("delete honors expectedVersion and surfaces not-found", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    await repo.create({ id: "d1", kind: "materia", content: { definition: {} } });
    await repo.update({ id: "d1", content: { definition: { v: 2 } } });

    await expect(repo.delete({ id: "d1", expectedVersion: "1" })).rejects.toBeInstanceOf(CatalogVersionMismatchError);
    await repo.delete({ id: "d1", expectedVersion: "2" });
    expect(repo.size()).toBe(0);

    await expect(repo.delete({ id: "d1" })).rejects.toBeInstanceOf(CatalogNotFoundError);
    await expect(repo.delete({ id: "never" })).rejects.toThrow(/not found/);
  });
});

describe("central catalog repository — read queries and ordering", () => {
  test("list filters by kind and search, and returns deterministic kind+id ordering", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    await repo.create({ id: "zeta", kind: "materia", name: "Zeta Mater", content: { definition: {} } });
    await repo.create({ id: "alpha", kind: "materia", name: "Alpha", content: { definition: {} } });
    await repo.create({ id: "beta", kind: "loadout", content: { definition: {} } });

    const all = await repo.list();
    expect(all.map((s) => `${s.kind}:${s.id}`)).toEqual(["loadout:beta", "materia:alpha", "materia:zeta"]);

    const materia = await repo.list({ kind: "materia" });
    expect(materia.map((s) => s.id)).toEqual(["alpha", "zeta"]);

    const search = await repo.list({ search: "alph" });
    expect(search.map((s) => s.id)).toEqual(["alpha"]);
  });

  test("get/head without kind resolve the first id deterministically when ids collide across kinds", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    await repo.create({ id: "shared", kind: "loadout", content: { definition: { l: 1 } } });
    await repo.create({ id: "shared", kind: "materia", content: { definition: { m: 1 } } });

    // Deterministic: loadout sorts before materia.
    const loose = await repo.get("shared");
    expect(loose?.kind).toBe("loadout");
    const looseHead = await repo.head("shared");
    expect(looseHead?.kind).toBe("loadout");

    // Kind-qualified lookup is exact.
    expect((await repo.get("shared", "materia"))?.kind).toBe("materia");
    expect((await repo.head("shared", "loadout"))?.kind).toBe("loadout");
  });

  test("reads return undefined for unknown ids", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    expect(await repo.get("nope")).toBeUndefined();
    expect(await repo.get("nope", "materia")).toBeUndefined();
    expect(await repo.head("nope")).toBeUndefined();
  });
});

describe("central catalog repository — hashing and immutability", () => {
  test("content hash is key-order independent", () => {
    const a = hashCentralContent({ definition: { one: 1, two: { nested: true } } });
    const b = hashCentralContent({ definition: { two: { nested: true }, one: 1 } });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("stored content is frozen so accidental in-place mutation is resisted", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    await repo.create({ id: "f1", kind: "materia", content: { definition: { nested: { value: 1 } } } });
    const item = await repo.get("f1", "materia");
    expect(item).toBeDefined();
    expect(Object.isFrozen(item?.content)).toBe(true);
    expect(Object.isFrozen(item?.content.definition)).toBe(true);
  });
});

describe("central catalog repository — seed", () => {
  test("seed items are applied through create and validated identically", async () => {
    const repo = createInMemoryCentralCatalogRepository({
      clock: fixedClock(["seed-t"]),
      seed: [
        { id: "seeded-materia", kind: "materia", name: "Seeded", content: { definition: { x: 1 } } },
        { id: "seeded-loadout", kind: "loadout", content: { definition: { sockets: [] } } },
      ],
    });
    expect(repo.size()).toBe(2);
    const summaries = await repo.list();
    expect(summaries.map((s) => s.id).sort()).toEqual(["seeded-loadout", "seeded-materia"]);
    const item = await repo.get("seeded-materia", "materia");
    expect(item?.version).toBe("1");
    expect(item?.updatedAt).toBe("seed-t");
  });

  test("a conflicting seed surfaces a conflict error eagerly at construction", () => {
    expect(() =>
      createInMemoryCentralCatalogRepository({
        seed: [
          { id: "dup", kind: "materia", content: { definition: {} } },
          { id: "dup", kind: "materia", content: { definition: {} } },
        ],
      }),
    ).toThrow(CatalogConflictError);
  });
});

describe("central catalog repository — provenance", () => {
  test("create records supplied provenance and update can replace it", async () => {
    const repo = createInMemoryCentralCatalogRepository();
    const created = await repo.create({
      id: "p1",
      kind: "materia",
      content: { definition: {} },
      provenance: { source: "upstream", author: "team-a", repositoryId: "repo-1" },
    });
    expect(created.summary.provenance).toEqual({ source: "upstream", author: "team-a", repositoryId: "repo-1" });

    const updated = await repo.update({ id: "p1", provenance: { source: "central" } });
    expect(updated.summary.provenance).toEqual({ source: "central" });
  });
});

describe("central catalog repository — error class hierarchy", () => {
  test("write errors extend a shared base with status codes", () => {
    expect(new CatalogConflictError("c")).toBeInstanceOf(CentralCatalogWriteError);
    expect(new CatalogNotFoundError("n")).toBeInstanceOf(CentralCatalogWriteError);
    expect(new CatalogVersionMismatchError("v", "3")).toBeInstanceOf(CentralCatalogWriteError);
    expect(new CatalogConflictError("c").statusCode).toBe(409);
    expect(new CatalogNotFoundError("n").statusCode).toBe(404);
    expect(new CatalogVersionMismatchError("v", "3").statusCode).toBe(409);
    expect(new CatalogVersionMismatchError("v", "3").currentVersion).toBe("3");
  });
});

describe("central catalog repository — injection into in-memory ports", () => {
  test("the same repository instance backs catalog reads and admin writes", async () => {
    const { createInMemoryCentralCatalogRepository: createRepo, createInMemoryCentralPorts } = await import("../src/central/index.js");
    const repository: CentralCatalogRepository = createRepo();
    const ports = createInMemoryCentralPorts({ catalogRepository: repository });

    await ports.admin.createCatalogItem({ id: "wired", kind: "loadout", content: { definition: { sockets: [] } } });
    expect((await ports.catalog.list()).map((s) => s.id)).toEqual(["wired"]);
    expect((await ports.catalog.get("wired", "loadout"))?.version).toBe("1");
    expect(repository.size()).toBe(1);
  });
});

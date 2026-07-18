import { describe, expect, test } from "bun:test";
import {
  applyCatalogToLocalAction,
  validateCatalogLocalActionRequest,
  type CatalogActionDeps,
  type LocalCatalogStore,
} from "../src/application/catalogActions.js";
import type { CatalogAccessPort, CatalogItem, CatalogItemKind } from "../src/application/controlPlane.js";
import type { CatalogDefinitionKind, CatalogLocalActionRequest, CatalogLocalTargetScope } from "../src/domain/catalogActions.js";
import type { CatalogOriginProvenance } from "../src/domain/catalogProvenance.js";

function agentMateria(prompt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "agent", tools: "coding", prompt, ...extra };
}
function origin(catalogItemId: string, contentHash: string, version = "2", source: "user" | "project" | "explicit" = "user"): CatalogOriginProvenance {
  return { catalogItemId, catalogVersion: version, catalogContentHash: contentHash, source };
}

/** Fake CatalogAccessPort holding catalog items keyed by `${kind}:${id}`. */
function fakeCatalog(items: Array<{ id: string; kind: CatalogItemKind; version: string; contentHash: string; definition: Record<string, unknown> }>): CatalogAccessPort {
  const map = new Map<string, CatalogItem>();
  for (const item of items) {
    map.set(`${item.kind}:${item.id}`, {
      id: item.id,
      kind: item.kind,
      version: item.version,
      updatedAt: "1970-01-01T00:00:00.000Z",
      contentHash: item.contentHash,
      content: { definition: item.definition },
    });
  }
  return {
    mode: () => ({
      mode: "central-connected",
      hasLocalSession: true,
      hasCentral: true,
      capabilities: { catalog: true, modelPolicy: true, telemetry: true, admin: true },
    }),
    async list() {
      return [...map.values()].map(({ content: _c, ...summary }) => summary as never);
    },
    async get(id, kind) {
      if (kind !== undefined) return map.get(`${kind}:${id}`);
      for (const [key, item] of map) if (key.endsWith(`:${id}`)) return item;
      return undefined;
    },
    async head(id, kind) {
      const item = await this.get(id, kind);
      return item ? ({ ...item } as never) : undefined;
    },
  };
}

/** Recording fake LocalCatalogStore. */
function fakeStore(existing: Record<string, Record<string, unknown> | undefined> = {}): LocalCatalogStore & { writes: Array<{ kind: CatalogDefinitionKind; localKey: string; definition: Record<string, unknown>; target: CatalogLocalTargetScope }>; reads: number } {
  const writes: Array<{ kind: CatalogDefinitionKind; localKey: string; definition: Record<string, unknown>; target: CatalogLocalTargetScope }> = [];
  let reads = 0;
  return {
    writes,
    get reads() {
      return reads;
    },
    async readLocalDefinition(kind, localKey) {
      reads += 1;
      return existing[`${kind}:${localKey}`];
    },
    async writeLocalDefinition(kind, localKey, definition, target) {
      writes.push({ kind, localKey, definition: definition as Record<string, unknown>, target });
      return { path: `<local>/${target}/${kind}/${localKey}.json` };
    },
  };
}

function req(partial: Partial<CatalogLocalActionRequest> & Pick<CatalogLocalActionRequest, "action">): CatalogLocalActionRequest {
  return { kind: "materia", catalogItemId: "team-build", localKey: "Team-Build", target: "user", ...partial };
}

describe("catalog action use case — validation", () => {
  test("rejects malformed requests", () => {
    expect(() => validateCatalogLocalActionRequest({} as CatalogLocalActionRequest)).toThrow(TypeError);
    expect(() => validateCatalogLocalActionRequest({ action: "sync", kind: "materia", catalogItemId: "x", localKey: "Y", target: "user" } as CatalogLocalActionRequest)).toThrow();
    expect(() => validateCatalogLocalActionRequest({ action: "copy", kind: "role", catalogItemId: "x", localKey: "Y", target: "user" } as CatalogLocalActionRequest)).toThrow();
    expect(() => validateCatalogLocalActionRequest({ action: "copy", kind: "materia", catalogItemId: "", localKey: "Y", target: "user" } as CatalogLocalActionRequest)).toThrow();
    expect(() => validateCatalogLocalActionRequest({ action: "copy", kind: "materia", catalogItemId: "x", localKey: "Y", target: "central" } as CatalogLocalActionRequest)).toThrow();
  });

  test("accepts a well-formed request", () => {
    expect(() => validateCatalogLocalActionRequest(req({ action: "copy" }))).not.toThrow();
  });
});

describe("catalog action use case — copy", () => {
  test("copy writes a new local definition with provenance and returns the path", async () => {
    const catalog = fakeCatalog([{ id: "team-build", kind: "materia", version: "3", contentHash: "sha256:central", definition: agentMateria("central build") }]);
    const store = fakeStore();
    const deps: CatalogActionDeps = { catalog, localStore: store };

    const result = await applyCatalogToLocalAction(req({ action: "copy" }), deps);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.path).toBe("<local>/user/materia/Team-Build.json");
    expect(result.overwrite).toBe(false);
    expect(result.origin).toEqual(origin("team-build", "sha256:central", "3", "user"));
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toEqual({
      kind: "materia",
      localKey: "Team-Build",
      target: "user",
      definition: { ...agentMateria("central build"), catalogOrigin: origin("team-build", "sha256:central", "3", "user") },
    });
  });

  test("copy does not write when the local key already exists", async () => {
    const catalog = fakeCatalog([{ id: "team-build", kind: "materia", version: "3", contentHash: "sha256:central", definition: agentMateria("central build") }]);
    const store = fakeStore({ "materia:Team-Build": agentMateria("local") });
    const deps: CatalogActionDeps = { catalog, localStore: store };

    const result = await applyCatalogToLocalAction(req({ action: "copy" }), deps);

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.code).toBe("target_exists");
    expect(store.writes).toHaveLength(0);
  });
});

describe("catalog action use case — update", () => {
  test("update requires confirmation and does not write when content differs", async () => {
    const catalog = fakeCatalog([{ id: "team-build", kind: "materia", version: "3", contentHash: "sha256:central", definition: agentMateria("central build") }]);
    const store = fakeStore({
      "materia:Team-Build": { ...agentMateria("local edits"), catalogOrigin: origin("team-build", "sha256:older", "2") },
    });
    const deps: CatalogActionDeps = { catalog, localStore: store };

    const result = await applyCatalogToLocalAction(req({ action: "update" }), deps);

    expect(result.status).toBe("needs_confirmation");
    if (result.status !== "needs_confirmation") return;
    expect(result.origin).toEqual(origin("team-build", "sha256:central", "3", "user"));
    expect(result.previousOrigin).toEqual(origin("team-build", "sha256:older", "2"));
    expect(store.writes).toHaveLength(0);
  });

  test("update applies with confirmation, records previousOrigin, and refreshes provenance", async () => {
    const catalog = fakeCatalog([{ id: "team-build", kind: "materia", version: "5", contentHash: "sha256:new", definition: agentMateria("central v5") }]);
    const previousOrigin = origin("team-build", "sha256:older", "2");
    const store = fakeStore({
      "materia:Team-Build": { ...agentMateria("local edits"), catalogOrigin: previousOrigin },
    });
    const deps: CatalogActionDeps = { catalog, localStore: store };

    const result = await applyCatalogToLocalAction(req({ action: "update", confirmOverwrite: true }), deps);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.overwrite).toBe(true);
    expect(result.contentChanged).toBe(true);
    expect(result.previousOrigin).toEqual(previousOrigin);
    expect(result.origin).toEqual(origin("team-build", "sha256:new", "5", "user"));
    expect(store.writes[0].definition.catalogOrigin).toEqual(origin("team-build", "sha256:new", "5", "user"));
  });

  test("update is rejected with origin_mismatch and does not write when origin differs", async () => {
    const catalog = fakeCatalog([{ id: "team-build", kind: "materia", version: "3", contentHash: "sha256:central", definition: agentMateria("central") }]);
    const store = fakeStore({
      "materia:Team-Build": { ...agentMateria("local"), catalogOrigin: origin("other-item", "h") },
    });
    const deps: CatalogActionDeps = { catalog, localStore: store };

    const result = await applyCatalogToLocalAction(req({ action: "update", confirmOverwrite: true }), deps);

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.code).toBe("origin_mismatch");
    expect(result.previousOrigin).toEqual(origin("other-item", "h"));
    expect(store.writes).toHaveLength(0);
  });
});

describe("catalog action use case — replace", () => {
  test("replace requires confirmation when a local definition exists", async () => {
    const catalog = fakeCatalog([{ id: "team-build", kind: "materia", version: "3", contentHash: "sha256:central", definition: agentMateria("central") }]);
    const store = fakeStore({ "materia:Team-Build": agentMateria("local") });
    const deps: CatalogActionDeps = { catalog, localStore: store };

    const result = await applyCatalogToLocalAction(req({ action: "replace" }), deps);

    expect(result.status).toBe("needs_confirmation");
    expect(store.writes).toHaveLength(0);
  });

  test("replace applies with confirmation regardless of origin", async () => {
    const catalog = fakeCatalog([{ id: "team-build", kind: "materia", version: "3", contentHash: "sha256:central", definition: agentMateria("central build") }]);
    const store = fakeStore({ "materia:Team-Build": { ...agentMateria("local"), catalogOrigin: origin("other", "h") } });
    const deps: CatalogActionDeps = { catalog, localStore: store };

    const result = await applyCatalogToLocalAction(req({ action: "replace", confirmOverwrite: true }), deps);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.overwrite).toBe(true);
    expect(result.origin.catalogItemId).toBe("team-build");
  });
});

describe("catalog action use case — central resolution", () => {
  test("returns rejected not_found when the central item is absent and does not read/write local", async () => {
    const catalog = fakeCatalog([]);
    const store = fakeStore();
    const deps: CatalogActionDeps = { catalog, localStore: store };

    const result = await applyCatalogToLocalAction(req({ action: "copy" }), deps);

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.code).toBe("not_found");
    expect(store.reads).toBe(0);
    expect(store.writes).toHaveLength(0);
  });
});

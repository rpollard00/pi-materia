import { describe, expect, test } from "bun:test";
import {
  buildCatalogOrigin,
  catalogDefinitionsEqual,
  catalogDefinitionsSemanticallyEqual,
  CATALOG_LOCAL_ACTIONS,
  CATALOG_LOCAL_TARGET_SCOPES,
  evaluateCatalogLocalAction,
  isCatalogDefinitionKind,
  isCatalogLocalAction,
  isCatalogLocalTargetScope,
  preparePromotedDefinition,
  stampCatalogOrigin,
  stripDefinitionOwnershipMetadata,
  type CatalogDefinitionKind,
  type CatalogLocalActionRequest,
} from "../src/domain/catalogActions.js";
import type { CatalogOriginProvenance } from "../src/domain/catalogProvenance.js";

/** Minimal valid central definition shapes. */
function agentMateria(prompt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "agent", tools: "coding", prompt, ...extra };
}
function singleSocketLoadout(materiaId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { entry: "Socket-1", sockets: { "Socket-1": { materia: materiaId } }, ...extra };
}
function origin(catalogItemId: string, contentHash: string, version = "2", source: "user" | "project" | "explicit" = "user"): CatalogOriginProvenance {
  return { catalogItemId, catalogVersion: version, catalogContentHash: contentHash, source };
}

function request(partial: Partial<CatalogLocalActionRequest> & Pick<CatalogLocalActionRequest, "action">): CatalogLocalActionRequest {
  return {
    kind: "materia",
    catalogItemId: "team-build",
    localKey: "Team-Build",
    target: "user",
    ...partial,
  };
}

function evaluate(opts: {
  request: CatalogLocalActionRequest;
  existing?: Record<string, unknown>;
  centralDefinition?: Record<string, unknown>;
  centralVersion?: string;
  centralContentHash?: string;
}) {
  return evaluateCatalogLocalAction({
    request: opts.request,
    existingDefinition: opts.existing,
    centralVersion: opts.centralVersion ?? "3",
    centralContentHash: opts.centralContentHash ?? "sha256:central",
    centralDefinition: opts.centralDefinition ?? agentMateria("central build"),
  });
}

describe("catalog action domain — guards", () => {
  test("action/kind/scope unions and guards", () => {
    expect(CATALOG_LOCAL_ACTIONS).toEqual(["copy", "update", "replace"]);
    expect(CATALOG_LOCAL_TARGET_SCOPES).toEqual(["user", "project", "explicit"]);
    expect(isCatalogLocalAction("copy")).toBe(true);
    expect(isCatalogLocalAction("sync")).toBe(false);
    expect(isCatalogDefinitionKind("loadout")).toBe(true);
    expect(isCatalogDefinitionKind("role")).toBe(false);
    expect(isCatalogLocalTargetScope("project")).toBe(true);
    expect(isCatalogLocalTargetScope("central")).toBe(false);
  });
});

describe("catalog action domain — transformation", () => {
  test("stripDefinitionOwnershipMetadata removes loadout identity/source/lock/provenance", () => {
    const loadout = singleSocketLoadout("Build", {
      id: "central:flow",
      source: "central",
      lockState: "locked",
      originDefaultId: "default:flow",
      catalogOrigin: origin("flow", "h"),
    });
    const stripped = stripDefinitionOwnershipMetadata(loadout, "loadout");
    expect(stripped).toEqual(singleSocketLoadout("Build"));
    // Original is not mutated.
    expect(loadout.id).toBe("central:flow");
  });

  test("stripDefinitionOwnershipMetadata removes materia lock/provenance but keeps behavior", () => {
    const materia = agentMateria("build", { lockState: "locked", catalogOrigin: origin("x", "h") });
    expect(stripDefinitionOwnershipMetadata(materia, "materia")).toEqual(agentMateria("build"));
  });

  test("stampCatalogOrigin sets provenance without mutating input", () => {
    const def = agentMateria("build");
    const stamped = stampCatalogOrigin(def, origin("x", "h"));
    expect(stamped.catalogOrigin).toEqual(origin("x", "h"));
    expect(def.catalogOrigin).toBeUndefined();
  });

  test("preparePromotedDefinition strips ownership and stamps a fresh origin", () => {
    const central = agentMateria("central", { lockState: "locked", catalogOrigin: origin("old", "old-hash") });
    const promoted = preparePromotedDefinition({
      centralDefinition: central,
      kind: "materia",
      origin: origin("team-build", "sha256:central", "3", "user"),
    });
    expect(promoted).toEqual({
      ...agentMateria("central"),
      catalogOrigin: origin("team-build", "sha256:central", "3", "user"),
    });
  });

  test("catalogDefinitionsEqual is key-order independent and type-tolerant", () => {
    expect(catalogDefinitionsEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(catalogDefinitionsEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(catalogDefinitionsEqual({ a: { x: 1 } }, { a: { x: 2 } })).toBe(false);
  });

  test("catalogDefinitionsSemanticallyEqual ignores ownership metadata differences", () => {
    const existing = agentMateria("build", { lockState: "locked", catalogOrigin: origin("x", "h") });
    const central = agentMateria("build");
    expect(catalogDefinitionsSemanticallyEqual("materia", existing, central)).toBe(true);
    expect(catalogDefinitionsSemanticallyEqual("materia", existing, agentMateria("other"))).toBe(false);
  });
});

describe("catalog action domain — copy", () => {
  test("copy applies when the local key is absent (new definition, no overwrite)", () => {
    const decision = evaluate({ request: request({ action: "copy" }) });
    expect(decision.status).toBe("apply");
    if (decision.status !== "apply") return;
    expect(decision.overwrite).toBe(false);
    expect(decision.contentChanged).toBe(false);
    expect(decision.origin).toEqual(origin("team-build", "sha256:central", "3", "user"));
    expect(decision.definition.catalogOrigin).toEqual(origin("team-build", "sha256:central", "3", "user"));
  });

  test("copy is rejected with target_exists when any definition already exists at the key", () => {
    const decision = evaluate({
      request: request({ action: "copy" }),
      existing: agentMateria("local"),
    });
    expect(decision.status).toBe("rejected");
    if (decision.status !== "rejected") return;
    expect(decision.code).toBe("target_exists");
  });

  test("copy honors the requested target scope in provenance", () => {
    const decision = evaluate({ request: request({ action: "copy", target: "project" }) });
    expect(decision.status).toBe("apply");
    if (decision.status !== "apply") return;
    expect(decision.origin.source).toBe("project");
  });
});

describe("catalog action domain — update", () => {
  test("update is rejected with missing_origin_target when no local definition exists", () => {
    const decision = evaluate({ request: request({ action: "update" }) });
    expect(decision.status).toBe("rejected");
    if (decision.status !== "rejected") return;
    expect(decision.code).toBe("missing_origin_target");
  });

  test("update is rejected with origin_mismatch when the local definition has no catalog origin", () => {
    const decision = evaluate({
      request: request({ action: "update" }),
      existing: agentMateria("local"),
    });
    expect(decision.status).toBe("rejected");
    if (decision.status !== "rejected") return;
    expect(decision.code).toBe("origin_mismatch");
  });

  test("update is rejected with origin_mismatch when the origin catalog item id differs", () => {
    const decision = evaluate({
      request: request({ action: "update", catalogItemId: "team-build" }),
      existing: { ...agentMateria("local"), catalogOrigin: origin("different-item", "sha256:central") },
    });
    expect(decision.status).toBe("rejected");
    if (decision.status !== "rejected") return;
    expect(decision.code).toBe("origin_mismatch");
  });

  test("update applies without confirmation when content is unchanged (origin matches, same content)", () => {
    const decision = evaluate({
      request: request({ action: "update", catalogItemId: "team-build" }),
      existing: { ...agentMateria("central build"), catalogOrigin: origin("team-build", "sha256:older", "2") },
      centralDefinition: agentMateria("central build"),
    });
    expect(decision.status).toBe("apply");
    if (decision.status !== "apply") return;
    expect(decision.overwrite).toBe(true);
    expect(decision.contentChanged).toBe(false);
    // Provenance refreshed to the current central version/hash.
    expect(decision.origin).toEqual(origin("team-build", "sha256:central", "3", "user"));
  });

  test("update requires confirmation when central content differs and confirmOverwrite is absent", () => {
    const decision = evaluate({
      request: request({ action: "update", catalogItemId: "team-build" }),
      existing: { ...agentMateria("local edits"), catalogOrigin: origin("team-build", "sha256:older", "2") },
      centralDefinition: agentMateria("central build"),
    });
    expect(decision.status).toBe("needs_confirmation");
    if (decision.status !== "needs_confirmation") return;
    expect(decision.reason).toContain("changes its local content");
    expect(decision.definition.catalogOrigin).toEqual(origin("team-build", "sha256:central", "3", "user"));
  });

  test("update applies with confirmOverwrite when central content differs", () => {
    const decision = evaluate({
      request: request({ action: "update", catalogItemId: "team-build", confirmOverwrite: true }),
      existing: { ...agentMateria("local edits"), catalogOrigin: origin("team-build", "sha256:older", "2") },
      centralDefinition: agentMateria("central build"),
    });
    expect(decision.status).toBe("apply");
    if (decision.status !== "apply") return;
    expect(decision.overwrite).toBe(true);
    expect(decision.contentChanged).toBe(true);
  });
});

describe("catalog action domain — replace", () => {
  test("replace applies without confirmation when no local definition exists", () => {
    const decision = evaluate({ request: request({ action: "replace" }) });
    expect(decision.status).toBe("apply");
    if (decision.status !== "apply") return;
    expect(decision.overwrite).toBe(false);
    expect(decision.contentChanged).toBe(false);
  });

  test("replace requires confirmation when a local definition exists", () => {
    const decision = evaluate({
      request: request({ action: "replace" }),
      existing: { ...agentMateria("local"), catalogOrigin: origin("other", "h") },
    });
    expect(decision.status).toBe("needs_confirmation");
    if (decision.status !== "needs_confirmation") return;
    expect(decision.reason).toContain("overwrites the existing local definition");
  });

  test("replace applies with confirmOverwrite even when origin differs (origin-agnostic)", () => {
    const decision = evaluate({
      request: request({ action: "replace", confirmOverwrite: true }),
      existing: { ...agentMateria("local"), catalogOrigin: origin("other", "h") },
      centralDefinition: agentMateria("central build"),
    });
    expect(decision.status).toBe("apply");
    if (decision.status !== "apply") return;
    expect(decision.overwrite).toBe(true);
    expect(decision.contentChanged).toBe(true);
  });

  test("replace to an absent key does not flag overwrite/content change", () => {
    const decision = evaluate({
      request: request({ action: "replace" }),
      centralDefinition: agentMateria("central build"),
    });
    expect(decision.status).toBe("apply");
    if (decision.status !== "apply") return;
    expect(decision.overwrite).toBe(false);
    expect(decision.contentChanged).toBe(false);
  });
});

describe("catalog action domain — loadout kind", () => {
  const loadoutRequest = (overrides: Partial<CatalogLocalActionRequest>): CatalogLocalActionRequest => ({
    action: "copy",
    kind: "loadout",
    catalogItemId: "team-flow",
    localKey: "Team-Flow",
    target: "project",
    ...overrides,
  });

  test("copy loadout strips central identity and stamps origin", () => {
    const decision = evaluate({
      request: loadoutRequest({ action: "copy" }),
      centralDefinition: singleSocketLoadout("Build", { id: "central:flow", source: "central", lockState: "locked" }),
    });
    expect(decision.status).toBe("apply");
    if (decision.status !== "apply") return;
    expect(decision.definition).toEqual({
      ...singleSocketLoadout("Build"),
      catalogOrigin: origin("team-flow", "sha256:central", "3", "project"),
    });
  });

  test("update loadout matches origin and refreshes", () => {
    const decision = evaluate({
      request: loadoutRequest({ action: "update", confirmOverwrite: true }),
      existing: { ...singleSocketLoadout("Build"), id: "project:team-flow", source: "project", catalogOrigin: origin("team-flow", "sha256:older", "2", "project") },
      centralDefinition: singleSocketLoadout("Build"),
    });
    expect(decision.status).toBe("apply");
  });
});

describe("catalog action domain — buildCatalogOrigin", () => {
  test("buildCatalogOrigin composes provenance for the target scope", () => {
    expect(buildCatalogOrigin({ catalogItemId: "x", catalogVersion: "4", catalogContentHash: "sha256:h", source: "explicit" })).toEqual({
      catalogItemId: "x",
      catalogVersion: "4",
      catalogContentHash: "sha256:h",
      source: "explicit",
    });
  });
});

// Ensure every kind is exercised without unused-variable complaints.
const _kinds: CatalogDefinitionKind[] = ["loadout", "materia"];
void _kinds;

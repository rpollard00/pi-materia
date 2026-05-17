import { describe, expect, test } from "bun:test";
import { createConfigLinkTargetRegistry, resolveLinkTargets } from "../src/link/resolver.js";
import { parseLinkCommandArguments } from "../src/link/parser.js";
import type { Loadout } from "../src/domain/loadout.js";
import type { MateriaCatalog } from "../src/domain/materia.js";

const materia = {
  Build: { id: "Build", type: "agent", behavior: { id: "Build", label: "Build" }, tools: "coding", prompt: "build" },
  "Chain-Context": { id: "Chain-Context", type: "agent", behavior: { id: "Chain-Context" }, tools: "none", prompt: "context" },
} satisfies MateriaCatalog;

const loadouts = {
  Consult: { id: "Consult", entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } },
  Build: { id: "BuildLoadout", entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } },
  "Hojo Consult": { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } },
  "Hojo-Consult": { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } },
} satisfies Record<string, Loadout>;

describe("/materia link parser", () => {
  test("parses --from, ordered targets, explicit prefixes, and prompt", () => {
    const result = parseLinkCommandArguments("--from cast-1 materia:Chain-Context loadout:Consult -- continue the work", "/materia link --from cast-1 materia:Chain-Context loadout:Consult -- continue the work");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fromCastId).toBe("cast-1");
    expect(result.value.prompt).toBe("continue the work");
    expect(result.value.targets).toEqual([
      { order: 0, raw: "materia:Chain-Context", prefix: "materia", name: "Chain-Context" },
      { order: 1, raw: "loadout:Consult", prefix: "loadout", name: "Consult" },
    ]);
  });

  test("parses reported Chain-Context to loadout command shape before graph compilation", () => {
    const result = parseLinkCommandArguments("--from 2026-05-12T19-40-40-605Z Chain-Context loadout:Hojo-Consult -- This is a test cast", "/materia link --from 2026-05-12T19-40-40-605Z Chain-Context loadout:Hojo-Consult -- This is a test cast");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fromCastId).toBe("2026-05-12T19-40-40-605Z");
    expect(result.value.targets).toEqual([
      { order: 0, raw: "Chain-Context", name: "Chain-Context" },
      { order: 1, raw: "loadout:Hojo-Consult", prefix: "loadout", name: "Hojo-Consult" },
    ]);
  });

  test("parses materia-prefixed Chain-Context as valid target syntax", () => {
    const result = parseLinkCommandArguments("--from cast-1 materia:Chain-Context loadout:Hojo-Consult -- prompt");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targets[0]).toEqual({ order: 0, raw: "materia:Chain-Context", prefix: "materia", name: "Chain-Context" });
  });

  test("supports quoted targets without making Chain-Context special", () => {
    const result = parseLinkCommandArguments('"Chain-Context" "loadout:Hojo Consult" -- prompt with -- inside text');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targets).toEqual([
      { order: 0, raw: '"Chain-Context"', name: "Chain-Context" },
      { order: 1, raw: '"loadout:Hojo Consult"', prefix: "loadout", name: "Hojo Consult" },
    ]);
    expect(result.value.prompt).toBe("prompt with -- inside text");
  });

  test("rejects missing delimiter, missing prompt, empty targets, and malformed --from", () => {
    const missingDelimiter = parseLinkCommandArguments("Build continue");
    expect(missingDelimiter.ok).toBe(false);
    if (!missingDelimiter.ok) expect(missingDelimiter.issues[0]?.message).toContain("missing prompt delimiter");

    const missingPrompt = parseLinkCommandArguments("Build --   ");
    expect(missingPrompt.ok).toBe(false);
    if (!missingPrompt.ok) expect(missingPrompt.issues[0]?.message).toContain("missing prompt text");

    const empty = parseLinkCommandArguments("-- prompt");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.issues[0]?.message).toContain("at least one link target");

    const missingFrom = parseLinkCommandArguments("--from -- prompt");
    expect(missingFrom.ok).toBe(false);
    if (!missingFrom.ok) expect(missingFrom.issues[0]?.message).toContain("missing cast id");
  });
});

describe("/materia link target resolver", () => {
  test("resolves reported command targets before linked-loadout graph validation", () => {
    const parsed = parseLinkCommandArguments("--from 2026-05-12T19-40-40-605Z Chain-Context loadout:Hojo-Consult -- prompt");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = resolveLinkTargets({ targets: parsed.value.targets }, createConfigLinkTargetRegistry({ materia, loadouts }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targets.map((target) => ({ order: target.order, kind: target.kind, id: target.id }))).toEqual([
      { order: 0, kind: "materia", id: "Chain-Context" },
      { order: 1, kind: "loadout", id: "Hojo-Consult" },
    ]);
  });

  test("resolves materia-prefixed Chain-Context through the same target-resolution path", () => {
    const parsed = parseLinkCommandArguments("materia:Chain-Context loadout:Hojo-Consult -- prompt");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = resolveLinkTargets({ targets: parsed.value.targets }, createConfigLinkTargetRegistry({ materia, loadouts }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targets.map((target) => ({ order: target.order, kind: target.kind, id: target.id }))).toEqual([
      { order: 0, kind: "materia", id: "Chain-Context" },
      { order: 1, kind: "loadout", id: "Hojo-Consult" },
    ]);
  });

  test("resolves prefixed and unambiguous unprefixed targets in order", () => {
    const parsed = parseLinkCommandArguments("materia:Build Consult -- prompt");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = resolveLinkTargets({ targets: parsed.value.targets }, createConfigLinkTargetRegistry({ materia, loadouts }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targets.map((target) => ({ order: target.order, kind: target.kind, id: target.id, raw: target.requested.raw }))).toEqual([
      { order: 0, kind: "materia", id: "Build", raw: "materia:Build" },
      { order: 1, kind: "loadout", id: "Consult", raw: "Consult" },
    ]);
  });

  test("rejects ambiguous unprefixed targets with prefix suggestions", () => {
    const parsed = parseLinkCommandArguments("Build -- prompt");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = resolveLinkTargets({ targets: parsed.value.targets }, createConfigLinkTargetRegistry({ materia, loadouts }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain("use materia:Build or loadout:Build");
  });

  test("does not mutate loadout records while resolving", () => {
    const before = JSON.stringify(loadouts);
    const parsed = parseLinkCommandArguments("loadout:Consult -- prompt");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    resolveLinkTargets({ targets: parsed.value.targets }, createConfigLinkTargetRegistry({ materia, loadouts }));

    expect(JSON.stringify(loadouts)).toBe(before);
  });
});

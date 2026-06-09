import { describe, expect, test } from "bun:test";
import { loadoutPickerCandidates, type LoadoutPickerCandidate } from "../src/loadout/loadoutPickerCandidates.js";
import type { PiMateriaConfig } from "../src/types.js";

function makeConfig(overrides: Partial<PiMateriaConfig> = {}): PiMateriaConfig {
  return {
    materia: {},
    ...overrides,
  };
}

function candidateNames(candidates: LoadoutPickerCandidate[]): string[] {
  return candidates.map((c) => c.value);
}

describe("loadoutPickerCandidates", () => {
  test("empty config returns no candidates", () => {
    const config = makeConfig();
    expect(loadoutPickerCandidates({ config })).toEqual([]);
  });

  test("empty query returns all loadouts without truncation", () => {
    const config = makeConfig({
      loadouts: {
        Alpha: { id: "default:alpha", entry: "S1" },
        Beta: { id: "user:beta", entry: "S2" },
        Gamma: { id: "project:gamma", entry: "S3" },
        Delta: { id: "user:delta", entry: "S4" },
        Epsilon: { id: "user:epsilon", entry: "S5" },
      },
      activeLoadout: "Gamma",
      activeLoadoutId: "project:gamma",
    });

    const candidates = loadoutPickerCandidates({ config });

    expect(candidates).toHaveLength(5);
    expect(candidateNames(candidates).sort()).toEqual(
      ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].sort(),
    );
  });

  test("no artificial first-four truncation with many loadouts", () => {
    const loadouts: Record<string, { id: string; entry: string }> = {};
    for (let i = 0; i < 15; i += 1) {
      const name = `Loadout-${i}`;
      loadouts[name] = { id: `user:loadout-${i}`, entry: "S1" };
    }

    const config = makeConfig({
      loadouts,
      activeLoadout: "Loadout-0",
      activeLoadoutId: "user:loadout-0",
    });

    const candidates = loadoutPickerCandidates({ config });

    expect(candidates).toHaveLength(15);
    // Verify the last loadout is included (no truncation)
    expect(candidateNames(candidates)).toContain("Loadout-14");
  });

  test("active marker metadata", () => {
    const config = makeConfig({
      loadouts: {
        Active: { id: "user:active", entry: "S1" },
        Inactive: { id: "user:inactive", entry: "S2" },
      },
      activeLoadout: "Active",
      activeLoadoutId: "user:active",
    });

    const candidates = loadoutPickerCandidates({ config });

    const active = candidates.find((c) => c.value === "Active")!;
    const inactive = candidates.find((c) => c.value === "Inactive")!;

    expect(active).toBeDefined();
    expect(active.label).toContain("*");
    expect(inactive.label).not.toContain("*");
  });

  test("active marker also matches by id when name differs", () => {
    const config = makeConfig({
      loadouts: {
        "Display Name": { id: "user:real-id", entry: "S1" },
        Other: { id: "user:other", entry: "S2" },
      },
      activeLoadout: "Display Name",
      activeLoadoutId: "user:real-id",
    });

    const candidates = loadoutPickerCandidates({ config });

    const active = candidates.find((c) => c.value === "Display Name")!;
    expect(active.label).toContain("*");
  });

  test("description includes id and source metadata", () => {
    const config = makeConfig({
      loadouts: {
        Hojo: { id: "user:hojo", entry: "S1" },
      },
    });

    const candidates = loadoutPickerCandidates({
      config,
      loadoutSources: { Hojo: "user" },
    });

    const hojo = candidates.find((c) => c.value === "Hojo")!;
    expect(hojo.description).toContain("id:user:hojo");
    expect(hojo.description).toContain("source:user");
  });

  test("description excludes missing metadata gracefully", () => {
    const config = makeConfig({
      loadouts: {
        Minimal: { entry: "S1" },
      },
    });

    const candidates = loadoutPickerCandidates({ config });
    const minimal = candidates.find((c) => c.value === "Minimal")!;

    expect(minimal.description).toBeUndefined();
  });

  test("fuzzy case-insensitive narrowing by name", () => {
    const config = makeConfig({
      loadouts: {
        "Full-Auto": { id: "default:full-auto", entry: "S1" },
        "Hojo-Consult": { id: "default:hojo-consult", entry: "S2" },
        Solo: { id: "user:solo", entry: "S3" },
      },
    });

    // Exact substring match (case-insensitive)
    const byHojo = loadoutPickerCandidates({ config }, "hojo");
    expect(candidateNames(byHojo)).toEqual(["Hojo-Consult"]);

    // Prefix match (fuzzy match is character-order, so "full" also
    // matches "default" in descriptions — use a unique prefix)
    const byFullAuto = loadoutPickerCandidates({ config }, "Full-A");
    expect(candidateNames(byFullAuto)).toEqual(["Full-Auto"]);

    // No match
    const byMissing = loadoutPickerCandidates({ config }, "zzz");
    expect(byMissing).toEqual([]);
  });

  test("fuzzy narrowing by id", () => {
    const config = makeConfig({
      loadouts: {
        NameA: { id: "user:special-id", entry: "S1" },
        NameB: { id: "user:other", entry: "S2" },
      },
    });

    const byId = loadoutPickerCandidates({ config }, "special");
    expect(candidateNames(byId)).toEqual(["NameA"]);
  });

  test("fuzzy narrowing by source", () => {
    const config = makeConfig({
      loadouts: {
        Default: { id: "default:def", entry: "S1" },
        Custom: { id: "user:custom", entry: "S2" },
      },
    });

    const bySource = loadoutPickerCandidates(
      { config, loadoutSources: { Default: "default", Custom: "user" } },
      "default",
    );
    expect(candidateNames(bySource)).toEqual(["Default"]);
  });

  test("space-separated tokens narrow with fuzzy filter", () => {
    const config = makeConfig({
      loadouts: {
        "Full-Auto": { id: "default:full-auto", entry: "S1" },
        "Hojo-Consult": { id: "default:hojo-consult", entry: "S2" },
        "Rude": { id: "user:rude", entry: "S3" },
      },
    });

    // "hojo consult" matches "Hojo-Consult"
    const results = loadoutPickerCandidates({ config }, "hojo consult");
    expect(candidateNames(results)).toContain("Hojo-Consult");

    // "full auto default" matches "Full-Auto" (matches name + source)
    const results2 = loadoutPickerCandidates(
      { config, loadoutSources: { "Full-Auto": "default", "Hojo-Consult": "default", Rude: "user" } },
      "full auto default",
    );
    expect(candidateNames(results2)).toContain("Full-Auto");
  });

  test("whitespace-only query returns all candidates", () => {
    const config = makeConfig({
      loadouts: {
        A: { id: "user:a", entry: "S1" },
        B: { id: "user:b", entry: "S2" },
      },
    });

    expect(loadoutPickerCandidates({ config }, "   ")).toHaveLength(2);
  });

  test("null loadout entries are excluded", () => {
    // Simulate a config where a loadout is marked as deleted (null in layered merge)
    const loadouts: Record<string, unknown> = {
      "Keep": { id: "user:keep", entry: "S1" },
      "Deleted": null,
    };
    const config = makeConfig({ loadouts: loadouts as PiMateriaConfig["loadouts"] });

    const candidates = loadoutPickerCandidates({ config });
    expect(candidateNames(candidates)).toEqual(["Keep"]);
  });
});

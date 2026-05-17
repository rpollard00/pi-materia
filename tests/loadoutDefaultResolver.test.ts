import { describe, expect, test } from "bun:test";
import { resolveDefaultLoadout, resolveLoadoutReference } from "../src/loadout/defaultLoadoutResolver.js";
import type { PiMateriaConfig } from "../src/types.js";

const loadout = (id: string) => ({ id, entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } });

describe("default loadout resolution", () => {
  test("selects a configured user default named Hojo instead of similarly named built-in Hojo-Consult", () => {
    const loadouts: PiMateriaConfig["loadouts"] = {
      "Hojo-Consult": loadout("Hojo"),
      Hojo: loadout("user:hojo"),
    };

    const resolved = resolveDefaultLoadout("Hojo", loadouts, { "Hojo-Consult": "default", Hojo: "user" });

    expect(resolved).toEqual({ loadoutName: "Hojo", loadoutId: "user:hojo" });
  });

  test("uses exact id matching with deterministic non-default precedence", () => {
    const loadouts: PiMateriaConfig["loadouts"] = {
      "Hojo-Consult": loadout("shared:hojo"),
      Hojo: loadout("shared:hojo"),
    };

    const resolved = resolveDefaultLoadout("shared:hojo", loadouts, { "Hojo-Consult": "default", Hojo: "user" });

    expect(resolved).toEqual({ loadoutName: "Hojo", loadoutId: "shared:hojo" });
  });

  test("does not use prefix or substring matching for defaults", () => {
    const loadouts: PiMateriaConfig["loadouts"] = {
      "Hojo-Consult": loadout("default:hojo-consult"),
    };

    const resolved = resolveDefaultLoadout("Hojo", loadouts, { "Hojo-Consult": "default" });

    expect(resolved.loadoutName).toBeNull();
    expect(resolved.loadoutId).toBeNull();
    expect(resolved.warning).toContain('Configured default Materia loadout "Hojo" was not found');
  });

  test("active loadout references also prefer exact names over conflicting ids", () => {
    const loadouts: PiMateriaConfig["loadouts"] = {
      "Hojo-Consult": loadout("Hojo"),
      Hojo: loadout("user:hojo"),
    };

    expect(resolveLoadoutReference("Hojo", loadouts, { "Hojo-Consult": "default", Hojo: "user" })).toEqual({ loadoutName: "Hojo", loadoutId: "user:hojo" });
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { migrateConfigLayers, type MigratableConfigLayer } from "./migrations.js";
import type { MateriaProfileConfig } from "../types.js";

const minimalLoadout = () => ({ entry: "Socket-1", sockets: { "Socket-1": { type: "agent" as const, materia: "Build" } } });

const layer = (config: MigratableConfigLayer["config"]): MigratableConfigLayer => ({
  scope: "user",
  path: "/tmp/materia.json",
  loaded: true,
  config,
});

test("config migration stamps stable loadout ids and translates legacy activeLoadout once at the load boundary", () => {
  const configLayer = layer({
    activeLoadout: "Hojo",
    materia: { Build: { tools: "coding", prompt: "build" } },
    loadouts: { Hojo: minimalLoadout() },
  });

  migrateConfigLayers([configLayer]);

  assert.equal(configLayer.config.loadouts?.Hojo?.id, "user:hojo");
  assert.equal(configLayer.config.activeLoadoutId, "user:hojo");
});

test("config migration translates a legacy default display-name preference to the stamped stable id", () => {
  const configLayer = layer({
    materia: { Build: { tools: "coding", prompt: "build" } },
    loadouts: { Hojo: minimalLoadout() },
  });
  const profile: MateriaProfileConfig = { defaultLoadoutId: "Hojo" };

  migrateConfigLayers([configLayer], profile);

  assert.equal(profile.defaultLoadoutId, "user:hojo");
});

test("config migration leaves unknown default ids stale for runtime validation instead of guessing by display name", () => {
  const configLayer = layer({
    materia: { Build: { tools: "coding", prompt: "build" } },
    loadouts: { Hojo: { ...minimalLoadout(), id: "user:hojo" } },
  });
  const profile: MateriaProfileConfig = { defaultLoadoutId: "missing:hojo" };

  migrateConfigLayers([configLayer], profile);

  assert.equal(profile.defaultLoadoutId, "missing:hojo");
});

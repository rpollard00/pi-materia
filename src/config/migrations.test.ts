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
    materia: { Build: { type: "agent", tools: "coding", prompt: "build" } },
    loadouts: { Hojo: minimalLoadout() },
  });

  migrateConfigLayers([configLayer]);

  assert.equal(configLayer.config.loadouts?.Hojo?.id, "user:hojo");
  assert.equal(configLayer.config.activeLoadoutId, "user:hojo");
});

test("config migration translates a legacy default display-name preference to the stamped stable id", () => {
  const configLayer = layer({
    materia: { Build: { type: "agent", tools: "coding", prompt: "build" } },
    loadouts: { Hojo: minimalLoadout() },
  });
  const profile: MateriaProfileConfig = { defaultLoadoutId: "Hojo" };

  migrateConfigLayers([configLayer], profile);

  assert.equal(profile.defaultLoadoutId, "user:hojo");
});

test("config migration canonicalizes known inline utility sockets to utility materia references", () => {
  const configLayer = layer({
    materia: {
      Build: { type: "agent", tools: "coding", prompt: "build" },
      ensureArtifactsIgnored: { type: "utility", utility: "project.ensureIgnored", parse: "json", params: { patterns: [".pi/pi-materia/"] }, assign: { artifactIgnore: "$" } },
    },
    loadouts: {
      Hojo: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { type: "utility", utility: "project.ensureIgnored", parse: "json", params: { patterns: [".pi/pi-materia/"] }, assign: { artifactIgnore: "$" }, edges: [{ when: "always", to: "Socket-2" }] },
          "Socket-2": { type: "agent", materia: "Build" },
        },
      },
    } as never,
  });

  migrateConfigLayers([configLayer]);

  assert.deepEqual(configLayer.config.loadouts?.Hojo?.sockets?.["Socket-1"], { type: "utility", materia: "ensureArtifactsIgnored", edges: [{ when: "always", to: "Socket-2" }] });
});

test("config migration maps default utility aliases across layered configs", () => {
  const defaultLayer: MigratableConfigLayer = {
    scope: "default",
    path: "/tmp/default.json",
    loaded: true,
    config: {
      materia: {
        ensureArtifactsIgnored: { type: "utility", utility: "project.ensureIgnored", parse: "json", params: { patterns: [".pi/pi-materia/"] }, assign: { artifactIgnore: "$" } },
        detectVcs: { type: "utility", utility: "vcs.detect", parse: "json", assign: { vcs: "$" } },
      },
    },
  };
  const userLayer = layer({
    materia: { Build: { type: "agent", tools: "coding", prompt: "build" } },
    loadouts: {
      Hojo: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { type: "utility", utility: "project.ensureIgnored", parse: "json", params: { patterns: [".pi/pi-materia/"] }, assign: { artifactIgnore: "$" }, edges: [{ when: "always", to: "Socket-2" }] },
          "Socket-2": { type: "utility", utility: "vcs.detect", parse: "json", assign: { vcs: "$" } },
        },
      },
    } as never,
  });

  migrateConfigLayers([defaultLayer, userLayer]);

  assert.equal((userLayer.config.loadouts?.Hojo?.sockets?.["Socket-1"] as { materia?: string }).materia, "ensureArtifactsIgnored");
  assert.equal((userLayer.config.loadouts?.Hojo?.sockets?.["Socket-2"] as { materia?: string }).materia, "detectVcs");
  assert.equal(userLayer.config.materia?.legacyUtilityProjectEnsureIgnored, undefined);
  assert.equal(userLayer.config.materia?.legacyUtilityVcsDetect, undefined);
});

test("config migration hoists distinct legacy inline utility signatures without clobbering ids", () => {
  const configLayer = layer({
    materia: {
      Build: { type: "agent", tools: "coding", prompt: "build" },
      legacyUtilityCustomCommandzzzzzz: { type: "utility", command: ["occupied"] },
    },
    loadouts: {
      Hojo: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": { type: "utility", command: ["node", "one.mjs"], parse: "json", assign: { one: "$" } },
          "Socket-2": { type: "utility", command: ["node", "two.mjs"], parse: "json", assign: { two: "$" } },
          "Socket-3": { type: "utility", command: ["node", "one.mjs"], parse: "json", assign: { one: "$" } },
        },
      },
    } as never,
  });

  migrateConfigLayers([configLayer]);

  const first = configLayer.config.loadouts?.Hojo?.sockets?.["Socket-1"] as { materia?: string } | undefined;
  const second = configLayer.config.loadouts?.Hojo?.sockets?.["Socket-2"] as { materia?: string } | undefined;
  const third = configLayer.config.loadouts?.Hojo?.sockets?.["Socket-3"] as { materia?: string } | undefined;
  assert.ok(first?.materia);
  assert.ok(second?.materia);
  assert.equal(third?.materia, first?.materia);
  assert.notEqual(second?.materia, first?.materia);
  assert.equal((configLayer.config.materia?.[first.materia!] as { command?: string[] }).command?.[1], "one.mjs");
  assert.equal((configLayer.config.materia?.[second.materia!] as { command?: string[] }).command?.[1], "two.mjs");
});

test("config migration leaves unknown default ids stale for runtime validation instead of guessing by display name", () => {
  const configLayer = layer({
    materia: { Build: { type: "agent", tools: "coding", prompt: "build" } },
    loadouts: { Hojo: { ...minimalLoadout(), id: "user:hojo" } },
  });
  const profile: MateriaProfileConfig = { defaultLoadoutId: "missing:hojo" };

  migrateConfigLayers([configLayer], profile);

  assert.equal(profile.defaultLoadoutId, "missing:hojo");
});

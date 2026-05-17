import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig, loadProfileConfig, saveMateriaConfigPatch } from "../src/config/config.js";
import {
  domainLoadoutToPipelineConfig,
  normalizePersistedLoadoutForApplication,
  parsePersistedLoadout,
  pipelineConfigToDomainLoadout,
  serializePersistedLoadout,
  validatePersistedHandoffPayload,
} from "../src/schema/persistence.js";

const materia = { Build: { type: "agent", tools: "coding", prompt: "build" }, Check: { type: "agent", tools: "none", prompt: "check" } };

describe("schema/persistence adapters", () => {
  test("requires canonical sockets payloads", () => {
    const parsed = parsePersistedLoadout({
      entry: "Socket-1",
      loops: {
        review: { consumes: { from: "Socket-1", output: "workItems" } },
      },
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(["loadout.sockets", "loadout.loops.review.sockets"]));
    expect(parsed.issues.map((issue) => issue.message).join("\n")).toContain("sockets");
  });

  test("rejects persisted socket type fields", () => {
    const parsed = parsePersistedLoadout({
      entry: "Socket-1",
      sockets: { "Socket-1": { type: "agent", materia: "Build" } },
    }, "loadout", { Build: { type: "agent" } });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toContainEqual({ path: "loadout.sockets.Socket-1.type", message: "persisted sockets must not configure type; define behavior on referenced materia" });
  });

  test("reads and serializes current sockets payloads", () => {
    const parsed = parsePersistedLoadout({
      entry: "Socket-1",
      sockets: {
        "Socket-1": { materia: "Build", edges: [{ when: "satisfied", to: "Socket-2" }], parse: "json" },
        "Socket-2": { materia: "Noop", utility: "noop", parse: "json", assign: { noop: "$" } },
      },
      loops: {
        main: { sockets: ["Socket-1", "Socket-2"] },
      },
    }, "loadout", { Build: { type: "agent" }, Noop: { type: "utility" } });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const serialized = serializePersistedLoadout(parsed.value);
    expect(serialized.sockets).toBeDefined();
    expect((serialized.loops as Record<string, { sockets: string[] }>).main.sockets).toEqual(["Socket-1", "Socket-2"]);
    expect((serialized.sockets as Record<string, Record<string, unknown>>)["Socket-2"]).toEqual({ materia: "Noop", parse: "json", assign: { noop: "$" } });
  });

  test("reports malformed loadout data and missing optional fields remain optional", () => {
    const malformed = parsePersistedLoadout({ entry: "Socket-1", sockets: [] });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.issues.map((issue) => issue.path)).toContain("loadout.sockets");

    const minimal = parsePersistedLoadout({ entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } }, "loadout", { Build: { type: "agent" } });
    expect(minimal.ok).toBe(true);
    if (minimal.ok) {
      expect(minimal.value.loops).toBeUndefined();
      expect(minimal.value.sockets["Socket-1"].edges).toBeUndefined();
    }
  });

  test("validates persisted handoff payload reserved fields and canonical workItems", () => {
    const valid = validatePersistedHandoffPayload({
      summary: "ok",
      workItems: [],
      satisfied: false,
      feedback: "needs follow-up",
      missing: ["tests"],
    });
    expect(valid.ok).toBe(true);

    const invalid = validatePersistedHandoffPayload({ tasks: [], satisfied: "yes", feedback: [], missing: "tests" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(["handoff.tasks", "handoff.satisfied", "handoff.feedback", "handoff.missing"]));
    }
  });

  test("bridges domain sockets to the canonical pipeline DTO", () => {
    const pipeline = domainLoadoutToPipelineConfig({
      entry: "Socket-1",
      sockets: { "Socket-1": { materia: "Build" }, "Socket-2": { materia: "Noop", utility: "noop", parse: "json", assign: { noop: "$" } } },
      loops: { one: { sockets: ["Socket-1"] } },
    });
    expect(pipeline.sockets["Socket-1"].type).toBeUndefined();
    expect(pipeline.loops?.one.sockets).toEqual(["Socket-1"]);
    expect(pipeline.sockets["Socket-2"]).toEqual({ materia: "Noop", parse: "json", assign: { noop: "$" } });

    const domain = pipelineConfigToDomainLoadout(pipeline, undefined, { Build: { type: "agent" }, Noop: { type: "utility" } });
    expect(domain.sockets["Socket-1"]).toEqual(expect.objectContaining({ materia: "Build" }));
    expect(domain.loops?.one.sockets).toEqual(["Socket-1"]);
  });

  test("config loading accepts sockets-format loadouts while preserving current application DTOs", async () => {
    const profile = await Bun.$`mktemp -d`.text().then((value) => value.trim());
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      const dir = await Bun.$`mktemp -d`.text().then((value) => value.trim());
      const file = path.join(dir, "materia.json");
      await writeFile(file, JSON.stringify({
        activeLoadout: "SocketConfig",
        materia,
        loadouts: {
          SocketConfig: {
            entry: "Socket-1",
            sockets: { "Socket-1": { materia: "Build" } },
            loops: { only: { sockets: ["Socket-1"] } },
          },
        },
      }), "utf8");

      const loaded = await loadConfig(dir, file);
      expect(loaded.config.loadouts?.SocketConfig.sockets["Socket-1"].materia).toBe("Build");
      expect(loaded.config.loadouts?.SocketConfig.loops?.only.sockets).toEqual(["Socket-1"]);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("config loading rejects socket types and loop labels in persisted loadouts", async () => {
    const profile = await Bun.$`mktemp -d`.text().then((value) => value.trim());
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      const dir = await Bun.$`mktemp -d`.text().then((value) => value.trim());
      const socketTypeFile = path.join(dir, "socket-type.json");
      await writeFile(socketTypeFile, JSON.stringify({
        activeLoadout: "PersistedDetails",
        materia,
        loadouts: {
          PersistedDetails: {
            entry: "Socket-1",
            sockets: { "Socket-1": { type: "agent", materia: "Build" } },
          },
        },
      }), "utf8");

      await expect(loadConfig(dir, socketTypeFile)).rejects.toThrow(/configures socket type/);

      const loopLabelFile = path.join(dir, "loop-label.json");
      await writeFile(loopLabelFile, JSON.stringify({
        activeLoadout: "PersistedDetails",
        materia,
        loadouts: {
          PersistedDetails: {
            entry: "Socket-1",
            sockets: { "Socket-1": { materia: "Build" } },
            loops: { only: { label: "Only", sockets: ["Socket-1"] } },
          },
        },
      }), "utf8");

      await expect(loadConfig(dir, loopLabelFile)).rejects.toThrow(/configures persisted label/);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("saving writes the current metadata-free config model", async () => {
    const profile = await Bun.$`mktemp -d`.text().then((value) => value.trim());
    const cwd = await Bun.$`mktemp -d`.text().then((value) => value.trim());
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      const file = await saveMateriaConfigPatch(cwd, {
        materia,
        loadouts: { Custom: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } }, loops: { only: { sockets: ["Socket-1"] } } } },
        activeLoadout: "Custom",
      });
      const saved = JSON.parse(await readFile(file, "utf8"));
      expect(saved.piMateria).toBeUndefined();
      expect(saved.schemaVersion).toBeUndefined();
      expect(saved.loadouts.Custom.sockets["Socket-1"].type).toBeUndefined();
      expect(saved.loadouts.Custom.loops.only).toEqual({ sockets: ["Socket-1"] });
      expect(saved.loadouts.Custom.loops.only.label).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("config loading fails malformed socket payloads through canonical graph validation", async () => {
    const profile = await Bun.$`mktemp -d`.text().then((value) => value.trim());
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      const dir = await Bun.$`mktemp -d`.text().then((value) => value.trim());
      const file = path.join(dir, "materia.json");
      await writeFile(file, JSON.stringify({
        activeLoadout: "BadConfig",
        materia,
        loadouts: {
          BadConfig: {
            entry: "Socket-1",
            sockets: {},
            loops: { only: { sockets: ["Socket-1"] } },
          },
        },
      }), "utf8");

      await expect(loadConfig(dir, file)).rejects.toThrow(/Unknown graph endpoint|must include at least one socket id/);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

  test("application adapter preserves socket-shaped loadouts", () => {
    const normalized = normalizePersistedLoadoutForApplication({
      entry: "Socket-1",
      sockets: { "Socket-1": { materia: "Build" } },
    }, { Build: { type: "agent" } }) as { sockets: Record<string, { materia: string }> };

    expect(normalized.sockets["Socket-1"].materia).toBe("Build");
  });

  test("saved malformed socket patches fail through canonical graph validation", async () => {
    const profile = await Bun.$`mktemp -d`.text().then((value) => value.trim());
    const cwd = await Bun.$`mktemp -d`.text().then((value) => value.trim());
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      await expect(saveMateriaConfigPatch(cwd, {
        materia,
        loadouts: { Custom: { entry: "Socket-1", sockets: {} } },
        activeLoadout: "Custom",
      })).rejects.toThrow(/Unknown graph endpoint/);
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });
});

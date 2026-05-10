import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig, saveMateriaConfigPatch } from "../src/config.js";
import {
  domainLoadoutToPipelineConfig,
  normalizePersistedLoadoutForApplication,
  parsePersistedLoadout,
  pipelineConfigToDomainLoadout,
  serializePersistedLoadout,
  validatePersistedHandoffPayload,
} from "../src/schema/persistence.js";

const materia = { Build: { tools: "coding", prompt: "build" }, Check: { tools: "none", prompt: "check" } };

describe("schema/persistence adapters", () => {
  test("normalizes legacy nodes payloads into canonical domain sockets", () => {
    const parsed = parsePersistedLoadout({
      entry: "Socket-1",
      nodes: {
        "Socket-1": { type: "agent", materia: "Build", edges: [{ when: "always", to: "Socket-2" }] },
        "Socket-2": { type: "agent", materia: "Check" },
      },
      loops: {
        review: { nodes: ["Socket-2"], consumes: { from: "Socket-1", output: "workItems" } },
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.sockets["Socket-1"].type).toBe("agent");
    expect(parsed.value.loops?.review.sockets).toEqual(["Socket-2"]);
    expect("nodes" in parsed.value).toBe(false);
  });

  test("reads current sockets payloads and serializes new data with sockets, not nodes", () => {
    const parsed = parsePersistedLoadout({
      schemaVersion: 2,
      entry: "Socket-1",
      sockets: {
        "Socket-1": { type: "agent", materia: "Build", edges: [{ when: "satisfied", to: "Socket-2" }], parse: "json" },
        "Socket-2": { type: "utility", utility: "noop" },
      },
      loops: {
        main: { sockets: ["Socket-1", "Socket-2"] },
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const serialized = serializePersistedLoadout(parsed.value);
    expect(serialized.schemaVersion).toBe(2);
    expect(serialized.sockets).toBeDefined();
    expect(serialized.nodes).toBeUndefined();
    expect((serialized.loops as Record<string, { sockets: string[] }>).main.sockets).toEqual(["Socket-1", "Socket-2"]);
    expect((serialized.loops as Record<string, { nodes?: string[] }>).main.nodes).toBeUndefined();
  });

  test("reports malformed loadout data and missing optional fields remain optional", () => {
    const malformed = parsePersistedLoadout({ entry: "Socket-1", sockets: [] });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.issues.map((issue) => issue.path)).toContain("loadout.sockets");

    const minimal = parsePersistedLoadout({ entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Build" } } });
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

  test("bridges domain sockets to the current pipeline nodes DTO without leaking nodes into the domain", () => {
    const pipeline = domainLoadoutToPipelineConfig({
      entry: "Socket-1",
      sockets: { "Socket-1": { type: "agent", materia: "Build" } },
      loops: { one: { sockets: ["Socket-1"] } },
    });
    expect(pipeline.nodes["Socket-1"].type).toBe("agent");
    expect(pipeline.loops?.one.nodes).toEqual(["Socket-1"]);

    const domain = pipelineConfigToDomainLoadout(pipeline);
    expect(domain.sockets["Socket-1"].type).toBe("agent");
    expect(domain.loops?.one.sockets).toEqual(["Socket-1"]);
    expect("nodes" in domain).toBe(false);
  });

  test("config loading accepts sockets-format loadouts while preserving current application DTOs", async () => {
    const dir = await Bun.$`mktemp -d`.text().then((value) => value.trim());
    const file = path.join(dir, "materia.json");
    await writeFile(file, JSON.stringify({
      activeLoadout: "SocketConfig",
      materia,
      loadouts: {
        SocketConfig: {
          entry: "Socket-1",
          sockets: { "Socket-1": { type: "agent", materia: "Build" } },
          loops: { only: { sockets: ["Socket-1"] } },
        },
      },
    }), "utf8");

    const loaded = await loadConfig(dir, file);
    expect(loaded.config.loadouts?.SocketConfig.nodes["Socket-1"].materia).toBe("Build");
    expect(loaded.config.loadouts?.SocketConfig.loops?.only.nodes).toEqual(["Socket-1"]);
  });

  test("application compatibility adapter prefers sockets when both sockets and legacy nodes are present", () => {
    const normalized = normalizePersistedLoadoutForApplication({
      entry: "Socket-1",
      sockets: { "Socket-1": { type: "agent", materia: "Build" } },
      nodes: { "Socket-1": { type: "agent", materia: "Check" } },
    }) as { nodes: Record<string, { materia: string }> };

    expect(normalized.nodes["Socket-1"].materia).toBe("Build");
  });

  test("round-trips saved legacy node patches through the compatibility loader", async () => {
    const profile = await Bun.$`mktemp -d`.text().then((value) => value.trim());
    const cwd = await Bun.$`mktemp -d`.text().then((value) => value.trim());
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    try {
      const file = await saveMateriaConfigPatch(cwd, {
        materia,
        loadouts: { Custom: { entry: "Socket-1", nodes: { "Socket-1": { type: "agent", materia: "Build" } } } },
        activeLoadout: "Custom",
      });
      const raw = JSON.parse(await readFile(file, "utf8"));
      expect(raw.loadouts.Custom.nodes["Socket-1"].materia).toBe("Build");
      const loaded = await loadConfig(cwd);
      expect(loaded.config.loadouts?.Custom.nodes["Socket-1"].materia).toBe("Build");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });
});

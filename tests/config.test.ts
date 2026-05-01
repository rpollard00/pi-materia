import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { resolvePipeline } from "../src/pipeline.js";

async function writeConfig(config: unknown): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-config-"));
  const file = path.join(dir, "loadout.json");
  await writeFile(file, JSON.stringify(config), "utf8");
  return { dir, file };
}

describe("config loadouts", () => {
  test("project config can define loadouts and activeLoadout without duplicating roles", async () => {
    const { dir, file } = await writeConfig({
      activeLoadout: "Planning-Consult",
      loadouts: {
        "Full-Auto": {
          entry: "planner",
          nodes: { planner: { type: "agent", role: "planner" } },
        },
        "Planning-Consult": {
          entry: "interactivePlan",
          nodes: { interactivePlan: { type: "agent", role: "interactivePlan", multiTurn: true } },
        },
      },
    });

    const loaded = await loadConfig(dir, file);
    const pipeline = resolvePipeline(loaded.config);

    expect(loaded.config.activeLoadout).toBe("Planning-Consult");
    expect(Object.keys(loaded.config.loadouts ?? {})).toContain("Full-Auto");
    expect(loaded.config.roles.planner.systemPrompt).toContain("planning role");
    expect(loaded.config.roles.interactivePlan.systemPrompt).toContain("interactive");
    expect(pipeline.entry.id).toBe("interactivePlan");
  });
});

describe("config role model settings", () => {
  test("bundled default roles remain model-free", async () => {
    const loaded = await loadConfig(process.cwd());

    for (const role of Object.values(loaded.config.roles)) {
      expect(role.model).toBeUndefined();
      expect(role.thinking).toBeUndefined();
    }
  });

  test("project config can set model and thinking for one existing role only", async () => {
    const { dir, file } = await writeConfig({
      roles: {
        Build: {
          model: "anthropic/claude-3-7-sonnet-latest",
          thinking: "high",
        },
      },
    });

    const loaded = await loadConfig(dir, file);

    expect(loaded.config.roles.Build.model).toBe("anthropic/claude-3-7-sonnet-latest");
    expect(loaded.config.roles.Build.thinking).toBe("high");
    expect(loaded.config.roles.Build.tools).toBe("coding");
    expect(loaded.config.roles.Build.systemPrompt).toContain("pi-materia Build Materia role");
    expect(loaded.config.roles.planner.model).toBeUndefined();
    expect(loaded.config.roles.planner.thinking).toBeUndefined();
  });

  test("rejects non-string role model with a friendly error", async () => {
    const { dir, file } = await writeConfig({ roles: { Build: { model: 123 } } });

    await expect(loadConfig(dir, file)).rejects.toThrow(/Materia role "Build" has invalid model\. Expected a string/);
  });

  test("rejects non-string role thinking with a friendly error", async () => {
    const { dir, file } = await writeConfig({ roles: { Build: { thinking: true } } });

    await expect(loadConfig(dir, file)).rejects.toThrow(/Materia role "Build" has invalid thinking\. Expected a string/);
  });
});

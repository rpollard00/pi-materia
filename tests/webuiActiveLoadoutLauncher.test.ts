import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { webUiLauncherTestInternals } from "../src/webui/launcher.js";
import { FakePiHarness } from "./fakePi.js";

const previousProfileDir = process.env.PI_MATERIA_PROFILE_DIR;

afterEach(() => {
  if (previousProfileDir === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
  else process.env.PI_MATERIA_PROFILE_DIR = previousProfileDir;
});

async function harnessWithConfig(prefix: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), prefix));
  const profile = await mkdtemp(path.join(tmpdir(), `${prefix}profile-`));
  process.env.PI_MATERIA_PROFILE_DIR = profile;
  const configuredPath = path.join(cwd, "materia.json");
  await writeFile(configuredPath, JSON.stringify({
    activeLoadout: "Web-Test-A",
    loadouts: {
      "Web-Test-A": { entry: "Socket-1", nodes: { "Socket-1": { type: "agent", materia: "Build" } } },
      "Web-Test-B": { entry: "Socket-1", nodes: { "Socket-1": { type: "agent", materia: "Auto-Eval" } } },
    },
  }), "utf8");
  const harness = new FakePiHarness(cwd);
  return { harness, configuredPath };
}

describe("WebUI active loadout launcher callback", () => {
  test("rejects active-cast changes before persistence", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-active-cast-"));
    const profile = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-active-cast-profile-"));
    process.env.PI_MATERIA_PROFILE_DIR = profile;
    const configuredPath = path.join(cwd, "missing-if-persisted.json");
    const harness = new FakePiHarness(cwd);
    harness.sessionManager.appendCustom("pi-materia-cast-state", { castId: "cast-123", active: true });
    const setActiveLoadout = webUiLauncherTestInternals.createActiveLoadoutSetter(harness.ctx, configuredPath, harness.pi);

    const result = await setActiveLoadout?.("Web-Test-B");

    expect(result).toEqual({ ok: false, code: "active_cast_conflict", message: "Cannot change active loadout during active cast cast-123." });
    await expect(readFile(configuredPath, "utf8")).rejects.toThrow();
    expect(harness.widgets.has("materia-loadouts")).toBe(false);
    expect(harness.notifications).toHaveLength(0);
    expect(harness.sentMessages).toHaveLength(0);
  });

  test("persists, reloads the loadout widget, notifies the TUI, and emits a pi-materia WebUI loadout event", async () => {
    const { harness, configuredPath } = await harnessWithConfig("pi-materia-webui-active-success-");
    const setActiveLoadout = webUiLauncherTestInternals.createActiveLoadoutSetter(harness.ctx, configuredPath, harness.pi);

    const result = await setActiveLoadout?.("Web-Test-B");

    expect(result).toMatchObject({ ok: true, activeLoadout: "Web-Test-B", message: "Active loadout changed to Web-Test-B." });
    const persisted = JSON.parse(await readFile(configuredPath, "utf8")) as { activeLoadout?: string };
    expect(persisted.activeLoadout).toBe("Web-Test-B");

    const widget = harness.widgets.get("materia-loadouts");
    expect(widget?.options).toEqual({ placement: "belowEditor" });
    expect(widget?.content?.join("\n")).toContain("Web-Test-B");
    expect(harness.notifications.at(-1)).toEqual({
      message: expect.stringContaining("pi-materia active loadout changed from WebUI to Web-Test-B"),
      type: "info",
    });

    const sent = harness.sentMessages.at(-1)?.message as { customType?: string; details?: Record<string, unknown>; content?: string; display?: boolean };
    expect(sent.customType).toBe("pi-materia");
    expect(sent.display).toBe(true);
    expect(sent.content).toContain("Web-Test-B");
    expect(sent.details).toMatchObject({
      eventType: "loadout",
      prefix: "loadout",
      source: "webui",
      name: "Web-Test-B",
    });
  });

  test("returns undefined without a Pi API so the HTTP layer can report unavailable", () => {
    const harness = new FakePiHarness();

    expect(webUiLauncherTestInternals.createActiveLoadoutSetter(harness.ctx, undefined, undefined)).toBeUndefined();
  });
});

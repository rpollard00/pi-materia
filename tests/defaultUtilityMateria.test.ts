import { describe, expect, test } from "bun:test";
import { access, readFile, readdir, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PiMateriaConfig } from "../src/types.js";
import { paletteColors } from "../src/webui/client/src/loadoutModel.js";

const executableSocketFields = ["utility", "command", "params", "timeoutMs", "parse", "assign"] as const;

async function loadDefaultConfig(): Promise<PiMateriaConfig> {
  return JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8"));
}

describe("bundled utility materia defaults", () => {
  test("default software loadouts start with canonical utility materia references", async () => {
    const config = await loadDefaultConfig();

    for (const loadoutName of ["Full-Auto", "Planning-Consult", "Hojo-Consult"] as const) {
      const loadout = config.loadouts?.[loadoutName];
      expect(loadout, loadoutName).toBeTruthy();
      expect(loadout?.entry).toBe("Socket-1");
      expect(loadout?.sockets?.["Socket-1"]).toMatchObject({
        socketKind: "entry",
        materia: "Ignore-Artifacts",
        edges: [{ when: "always", to: "Socket-2" }],
      });
      expect(loadout?.sockets?.["Socket-2"]).toMatchObject({
        socketKind: "normal",
        materia: "Detect-VCS",
        edges: [{ when: "always", to: "Socket-3" }],
      });

      for (const socketId of ["Socket-1", "Socket-2"] as const) {
        const socket = loadout?.sockets?.[socketId] as Record<string, unknown> | undefined;
        expect(socket, `${loadoutName}.${socketId}`).toBeTruthy();
        for (const field of executableSocketFields) {
          expect(socket?.[field], `${loadoutName}.${socketId}.${field}`).toBeUndefined();
        }
      }
    }
  });

  test("default utility materia are shipped-script backed and package-listed", async () => {
    const [config, packageJson] = await Promise.all([
      loadDefaultConfig(),
      readFile(path.resolve("package.json"), "utf8").then((text) => JSON.parse(text) as { files?: string[] }),
    ]);

    expect(config.materia?.["Ignore-Artifacts"]).toMatchObject({
      type: "utility",
      script: { kind: "shippedUtility", name: "ensure-ignored.mjs", runtime: "node" },
      parse: "json",
    });
    expect(config.materia?.["Detect-VCS"]).toMatchObject({
      type: "utility",
      script: { kind: "shippedUtility", name: "detect-vcs.mjs", runtime: "node" },
      parse: "json",
    });
    expect(config.materia?.["Blackbelt-Bootstrap"]).toMatchObject({
      type: "utility",
      script: { kind: "shippedUtility", name: "blackbelt-bootstrap.mjs", runtime: "node" },
      parse: "json",
    });
    expect(config.materia?.["Blackbelt-Maintain"]).toMatchObject({
      type: "utility",
      script: { kind: "shippedUtility", name: "blackbelt-maintain.mjs", runtime: "node" },
      parse: "json",
    });
    expect((config.materia?.["Ignore-Artifacts"] as { assign?: unknown }).assign).toBeUndefined();
    expect((config.materia?.["Detect-VCS"] as { assign?: unknown }).assign).toBeUndefined();
    expect((config.materia?.["Blackbelt-Bootstrap"] as { assign?: unknown }).assign).toBeUndefined();
    expect((config.materia?.["Blackbelt-Maintain"] as { assign?: unknown }).assign).toBeUndefined();
    expect((config.materia?.["Ignore-Artifacts"] as { command?: unknown }).command).toBeUndefined();
    expect((config.materia?.["Detect-VCS"] as { command?: unknown }).command).toBeUndefined();
    expect((config.materia?.["Blackbelt-Bootstrap"] as { command?: unknown }).command).toBeUndefined();
    expect((config.materia?.["Blackbelt-Maintain"] as { command?: unknown }).command).toBeUndefined();
    expect(packageJson.files).toContain("config/default.json");
    expect(config.materia?.ensureArtifactsIgnored).toBeUndefined();
    expect(config.materia?.detectVcs).toBeUndefined();
    expect(packageJson.files).toContain("config/utilities/*.mjs");
    expect(packageJson.files).not.toContain(".pi/pi-materia");
    expect(packageJson.files).not.toContain(".pi/pi-materia/**");
  });

  test("package manifest and shipped utility sources support dry-run packaging checks", async () => {
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { files?: string[]; scripts?: Record<string, string> };

    expect(packageJson.files).toEqual(expect.arrayContaining(["config/default.json", "config/utilities/*.mjs", "docs/*.md"]));
    expect(packageJson.scripts?.["pack:dry-run"]).toBe("npm pack --dry-run");
    await expect(access(path.resolve("config", "utilities", "detect-vcs.mjs"))).resolves.toBeNull();
    await expect(access(path.resolve("config", "utilities", "ensure-ignored.mjs"))).resolves.toBeNull();
    await expect(access(path.resolve("config", "utilities", "blackbelt-bootstrap.mjs"))).resolves.toBeNull();
    await expect(access(path.resolve("config", "utilities", "blackbelt-maintain.mjs"))).resolves.toBeNull();
    await expect(access(path.resolve("config", "utilities", "commit-sigil.mjs"))).resolves.toBeNull();
  });

  test("Blackbelt-Maintain has correct shipped-utility config shape, parse, color, and metadata", async () => {
    const config = await loadDefaultConfig();
    const materia = config.materia?.["Blackbelt-Maintain"];

    expect(materia).toBeDefined();
    expect(materia?.type).toBe("utility");
    expect(materia?.label).toBe("Blackbelt-Maintain");
    expect(materia?.group).toBe("Utility");
    expect(materia?.parse).toBe("json");
    expect(materia?.script).toEqual({ kind: "shippedUtility", name: "blackbelt-maintain.mjs", runtime: "node" });
    expect(typeof materia?.description).toBe("string");
    expect((materia?.description as string).includes("checkpoint")).toBe(true);
    expect((materia?.description as string).includes("jj")).toBe(true);
    expect(typeof materia?.color).toBe("string");
    const allowedColors = new Set(paletteColors);
    expect(allowedColors.has(materia?.color as string)).toBe(true);
    expect((materia as { assign?: unknown }).assign).toBeUndefined();
    expect((materia as { command?: unknown }).command).toBeUndefined();
  });

  test("no bundled loadout socket references Blackbelt utilities", async () => {
    const config = await loadDefaultConfig();

    for (const [loadoutName, loadout] of Object.entries(config.loadouts ?? {})) {
      for (const [socketId, socket] of Object.entries((loadout as { sockets?: Record<string, { materia?: string }> }).sockets ?? {})) {
        expect(socket.materia, `${loadoutName}.${socketId} should not reference Blackbelt-Bootstrap`).not.toBe("Blackbelt-Bootstrap");
        expect(socket.materia, `${loadoutName}.${socketId} should not reference Blackbelt-Maintain`).not.toBe("Blackbelt-Maintain");
      }
    }

    // Ensure Maintain and GitMaintain entries still exist in config
    expect(config.materia?.Maintain).toBeDefined();
    expect(config.materia?.GitMaintain).toBeDefined();
  });

  test("profile sync copies and resolves blackbelt-maintain.mjs through shipped utility resolution", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-shipped-"));
    const profileDir = path.join(temp, "profile");
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      // Dynamically import loadConfig to trigger profile sync
      const { loadConfig } = await import("../src/config/config.js");
      await loadConfig(temp);

      const utilitiesDir = path.join(profileDir, "utilities");
      const entries = await readdir(utilitiesDir);
      expect(entries).toContain("blackbelt-maintain.mjs");

      const scriptContent = await readFile(path.join(utilitiesDir, "blackbelt-maintain.mjs"), "utf8");
      expect(scriptContent).toContain("handleJj");
      expect(scriptContent).toContain("handleGit");
      expect(scriptContent).toContain("execFile");

      const manifest = JSON.parse(await readFile(path.join(utilitiesDir, ".pi-materia-shipped-utilities.json"), "utf8"));
      expect(manifest.utilities["blackbelt-maintain.mjs"]).toBeDefined();
      expect(manifest.utilities["blackbelt-maintain.mjs"].profileFile).toBe("blackbelt-maintain.mjs");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });
});

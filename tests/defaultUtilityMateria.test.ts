import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PiMateriaConfig } from "../src/types.js";

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
        type: "utility",
        socketKind: "entry",
        materia: "Ignore-Artifacts",
        edges: [{ when: "always", to: "Socket-2" }],
      });
      expect(loadout?.sockets?.["Socket-2"]).toMatchObject({
        type: "utility",
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
      assign: { artifactIgnore: "$" },
    });
    expect(config.materia?.["Detect-VCS"]).toMatchObject({
      type: "utility",
      script: { kind: "shippedUtility", name: "detect-vcs.mjs", runtime: "node" },
      parse: "json",
      assign: { vcs: "$" },
    });
    expect((config.materia?.["Ignore-Artifacts"] as { command?: unknown }).command).toBeUndefined();
    expect((config.materia?.["Detect-VCS"] as { command?: unknown }).command).toBeUndefined();
    expect(packageJson.files).toContain("config/default.json");
    expect(config.materia?.ensureArtifactsIgnored).toBeUndefined();
    expect(config.materia?.detectVcs).toBeUndefined();
    expect(packageJson.files).toContain("config/utilities/*.mjs");
    expect(packageJson.files).not.toContain(".pi/pi-materia");
    expect(packageJson.files).not.toContain(".pi/pi-materia/**");
  });
});

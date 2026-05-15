import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { loadConfig } from "../src/config/config.js";
import { FakePiHarness } from "./fakePi.js";

const minimalLoadout = (id?: string) => ({
  ...(id ? { id } : {}),
  entry: "Socket-1",
  sockets: { "Socket-1": { type: "agent" as const, materia: "Build" } },
});

describe("plugin default loadout initialization", () => {
  test("selects configured default named Hojo over built-in Hojo-Consult on session start", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-hojo-default-"));
    const cwd = path.join(temp, "project");
    const profileDir = path.join(temp, "profile");
    const previousProfile = process.env.PI_MATERIA_PROFILE_DIR;
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(profileDir, { recursive: true });
      await writeFile(path.join(profileDir, "config.json"), JSON.stringify({ defaultLoadoutId: "Hojo" }, null, 2));
      await writeFile(path.join(profileDir, "materia.json"), JSON.stringify({
        materia: { Build: { tools: "coding", prompt: "build" } },
        loadouts: { Hojo: minimalLoadout() },
      }, null, 2));

      const harness = new FakePiHarness(cwd);
      piMateria(harness.pi);
      await harness.emit("session_start");

      const loaded = await loadConfig(cwd);
      expect(loaded.config.activeLoadout).toBe("Hojo");
      expect(loaded.config.activeLoadoutId).toBe("user:hojo");
      expect(loaded.config.activeLoadout).not.toBe("Hojo-Consult");
    } finally {
      if (previousProfile === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previousProfile;
      await rm(temp, { recursive: true, force: true });
    }
  });
});

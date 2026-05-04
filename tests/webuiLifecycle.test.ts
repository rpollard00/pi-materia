import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import piMateria from "../src/index.js";
import { launchMateriaWebUi } from "../src/webui/launcher.js";
import { getUserProfileConfigPath } from "../src/config.js";
import { FakePiHarness } from "./fakePi.js";

const previousProfileDir = process.env.PI_MATERIA_PROFILE_DIR;

afterEach(() => {
  if (previousProfileDir === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
  else process.env.PI_MATERIA_PROFILE_DIR = previousProfileDir;
});

async function harnessWithProfile(prefix = "pi-materia-webui-") {
  const cwd = await mkdtemp(path.join(tmpdir(), prefix));
  const profile = await mkdtemp(path.join(tmpdir(), `${prefix}profile-`));
  process.env.PI_MATERIA_PROFILE_DIR = profile;
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return { harness, profile };
}

describe("/materia ui lifecycle", () => {
  test("command launches a session-scoped server in the background without waiting for idle and reuses it", async () => {
    const { harness } = await harnessWithProfile();

    await harness.runCommand("materia", "ui");

    expect(harness.waitForIdleCalls).toBe(0);
    expect(harness.notifications.at(-1)?.message).toContain("Materia WebUI started:");
    expect(harness.appendedEntries.at(-1)?.customType).toBe("pi-materia-webui");
    const first = harness.appendedEntries.at(-1)?.data as { url: string; reused: boolean; sessionKey: string };
    expect(first.reused).toBe(false);
    expect(first.url).toStartWith("http://127.0.0.1:");

    const health = await fetch(new URL('/api/health', first.url));
    expect(health.status).toBe(200);
    const body = await health.json() as { ok?: boolean; scope?: string; sessionKey?: string };
    expect(body).toMatchObject({ ok: true, scope: "session", sessionKey: first.sessionKey });

    await harness.runCommand("materia", "ui");

    const second = harness.appendedEntries.at(-1)?.data as { url: string; reused: boolean; sessionKey: string };
    expect(second.reused).toBe(true);
    expect(second.url).toBe(first.url);
    expect(second.sessionKey).toBe(first.sessionKey);
    expect(harness.waitForIdleCalls).toBe(0);

    await harness.emit("session_shutdown");
    await expect(fetch(new URL('/api/health', first.url))).rejects.toThrow();
  });

  test("launcher respects profile host and preferred port while reporting auto-open configuration", async () => {
    const { harness, profile } = await harnessWithProfile("pi-materia-webui-profile-");
    await writeFile(getUserProfileConfigPath(), JSON.stringify({ webui: { host: "127.0.0.1", preferredPort: 0, autoOpenBrowser: false } }), "utf8");

    const result = await launchMateriaWebUi(harness.ctx);

    expect(result.reused).toBe(false);
    expect(result.autoOpenBrowser).toBe(false);
    expect(result.url).toContain(`session=${encodeURIComponent(result.sessionKey)}`);
    expect(await readFile(path.join(profile, "config.json"), "utf8")).toContain("autoOpenBrowser");

    await harness.emit("session_shutdown");
  });
});

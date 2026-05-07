import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import piMateria from "../src/index.js";
import { launchMateriaWebUi, webUiLauncherTestInternals } from "../src/webui/launcher.js";
import { getUserProfileConfigPath } from "../src/config.js";
import { FakePiHarness } from "./fakePi.js";

const previousProfileDir = process.env.PI_MATERIA_PROFILE_DIR;

afterEach(() => {
  webUiLauncherTestInternals.resetMateriaWebUiBuildPromise();
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
  test("does not build the WebUI when the built client entrypoint already exists", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-built-"));
    const clientEntrypoint = path.join(projectRoot, "dist", "webui", "client", "index.html");
    await mkdir(path.dirname(clientEntrypoint), { recursive: true });
    await writeFile(clientEntrypoint, "<html></html>", "utf8");
    let builds = 0;

    await webUiLauncherTestInternals.ensureMateriaWebUiBuilt({
      projectRoot,
      clientEntrypoint,
      runBuild: async () => {
        builds += 1;
        throw new Error("should not build");
      },
    });

    expect(builds).toBe(0);
  });

  test("builds the WebUI when the built client entrypoint is missing", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-missing-"));
    const clientEntrypoint = path.join(projectRoot, "dist", "webui", "client", "index.html");
    let builds = 0;

    await webUiLauncherTestInternals.ensureMateriaWebUiBuilt({
      projectRoot,
      clientEntrypoint,
      runBuild: async () => {
        builds += 1;
        await mkdir(path.dirname(clientEntrypoint), { recursive: true });
        await writeFile(clientEntrypoint, "<html></html>", "utf8");
      },
    });

    expect(builds).toBe(1);
  });

  test("reports a useful WebUI build failure", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-fails-"));
    const clientEntrypoint = path.join(projectRoot, "dist", "webui", "client", "index.html");

    await expect(webUiLauncherTestInternals.ensureMateriaWebUiBuilt({
      projectRoot,
      clientEntrypoint,
      runBuild: async () => {
        throw new Error("vite exploded on stderr");
      },
    })).rejects.toThrow(/npm run build:webui failed: vite exploded on stderr/);
  });

  test("deduplicates concurrent WebUI builds", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-concurrent-"));
    const clientEntrypoint = path.join(projectRoot, "dist", "webui", "client", "index.html");
    let builds = 0;
    let markBuildStarted!: () => void;
    let releaseBuild!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      markBuildStarted = resolve;
    });
    const buildRelease = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });

    const first = webUiLauncherTestInternals.ensureMateriaWebUiBuilt({
      projectRoot,
      clientEntrypoint,
      runBuild: async () => {
        builds += 1;
        markBuildStarted();
        await buildRelease;
        await mkdir(path.dirname(clientEntrypoint), { recursive: true });
        await writeFile(clientEntrypoint, "<html></html>", "utf8");
      },
    });
    await buildStarted;
    const second = webUiLauncherTestInternals.ensureMateriaWebUiBuilt({
      projectRoot,
      clientEntrypoint,
      runBuild: async () => {
        builds += 1;
      },
    });

    expect(builds).toBe(1);
    releaseBuild();
    await Promise.all([first, second]);
    expect(builds).toBe(1);
  });

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

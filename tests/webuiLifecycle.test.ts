import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import piMateria from "../src/index.js";
import {
  launchMateriaWebUi,
  webUiLauncherTestInternals,
} from "../src/webui/launcher.js";
import { ensureMateriaWebUi } from "../src/webui/service.js";
import { getUserProfileConfigPath } from "../src/config/config.js";
import { FakePiHarness } from "./fakePi.js";

const previousProfileDir = process.env.PI_MATERIA_PROFILE_DIR;

afterEach(() => {
  webUiLauncherTestInternals.resetMateriaWebUiBuildPromise();
  if (previousProfileDir === undefined)
    delete process.env.PI_MATERIA_PROFILE_DIR;
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

async function waitForNotification(
  harness: FakePiHarness,
  includes: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      harness.notifications.some((notification) =>
        notification.message.includes(includes),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for notification including ${includes}`);
}

describe("/materia ui lifecycle", () => {
  test("does not build the WebUI when the built client entrypoint already exists", async () => {
    const projectRoot = await mkdtemp(
      path.join(tmpdir(), "pi-materia-webui-built-"),
    );
    const clientEntrypoint = path.join(
      projectRoot,
      "dist",
      "webui",
      "client",
      "index.html",
    );
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
    const projectRoot = await mkdtemp(
      path.join(tmpdir(), "pi-materia-webui-missing-"),
    );
    const clientEntrypoint = path.join(
      projectRoot,
      "dist",
      "webui",
      "client",
      "index.html",
    );
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
    const projectRoot = await mkdtemp(
      path.join(tmpdir(), "pi-materia-webui-fails-"),
    );
    const clientEntrypoint = path.join(
      projectRoot,
      "dist",
      "webui",
      "client",
      "index.html",
    );

    await expect(
      webUiLauncherTestInternals.ensureMateriaWebUiBuilt({
        projectRoot,
        clientEntrypoint,
        runBuild: async () => {
          throw new Error("vite exploded on stderr");
        },
      }),
    ).rejects.toThrow(/npm run build:webui failed: vite exploded on stderr/);
  });

  test("deduplicates concurrent WebUI builds", async () => {
    const projectRoot = await mkdtemp(
      path.join(tmpdir(), "pi-materia-webui-concurrent-"),
    );
    const clientEntrypoint = path.join(
      projectRoot,
      "dist",
      "webui",
      "client",
      "index.html",
    );
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
    expect(harness.notifications.at(-1)?.message).toContain(
      "Materia WebUI started:",
    );
    expect(harness.appendedEntries.at(-1)?.customType).toBe("pi-materia-webui");
    const first = harness.appendedEntries.at(-1)?.data as {
      url: string;
      reused: boolean;
      sessionKey: string;
    };
    expect(first.reused).toBe(false);
    expect(first.url).toStartWith("http://127.0.0.1:");
    expect(harness.widgets.get("materia-webui")?.content).toEqual([
      "WebUI started",
      first.url,
    ]);

    const health = await fetch(new URL("/api/health", first.url));
    expect(health.status).toBe(200);
    const body = (await health.json()) as {
      ok?: boolean;
      scope?: string;
      sessionKey?: string;
    };
    expect(body).toMatchObject({
      ok: true,
      scope: "session",
      sessionKey: first.sessionKey,
    });

    await harness.runCommand("materia", "ui");

    const second = harness.appendedEntries.at(-1)?.data as {
      url: string;
      reused: boolean;
      sessionKey: string;
    };
    expect(second.reused).toBe(true);
    expect(second.url).toBe(first.url);
    expect(second.sessionKey).toBe(first.sessionKey);
    expect(harness.widgets.get("materia-webui")?.content).toEqual([
      "WebUI ready (reused)",
      first.url,
    ]);
    expect(harness.waitForIdleCalls).toBe(0);

    await harness.emit("session_shutdown");
    await expect(fetch(new URL("/api/health", first.url))).rejects.toThrow();
  });

  test("automatic service startup returns structured status without transcript or idle side effects", async () => {
    const { harness } = await harnessWithProfile(
      "pi-materia-webui-auto-service-",
    );

    const first = ensureMateriaWebUi({
      ctx: harness.ctx,
      mode: "automatic",
      pi: harness.pi,
      notify: harness.ctx.ui.notify,
    });
    const second = ensureMateriaWebUi({
      ctx: harness.ctx,
      mode: "automatic",
      pi: harness.pi,
      notify: harness.ctx.ui.notify,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    try {
      expect(firstResult).toMatchObject({ ok: true, status: "started" });
      expect(secondResult).toMatchObject({ ok: true, status: "started" });
      if (!firstResult.ok || !secondResult.ok)
        throw new Error("WebUI did not start");
      expect(secondResult.url).toBe(firstResult.url);
      expect(secondResult.sessionKey).toBe(firstResult.sessionKey);
      expect(harness.waitForIdleCalls).toBe(0);
      expect(harness.operationLog).not.toContain("waitForIdle");
      expect(harness.sentMessages).toHaveLength(0);
      expect(harness.appendedEntries).toHaveLength(0);
      expect(
        harness.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "custom_message"),
      ).toHaveLength(0);
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("cast and link flows auto-start the WebUI without transcript side effects", async () => {
    const { harness } = await harnessWithProfile(
      "pi-materia-webui-auto-command-",
    );

    await harness.runCommand("materia", "cast");
    await waitForNotification(harness, "Materia WebUI started:");

    try {
      expect(harness.sentMessages).toHaveLength(0);
      expect(harness.appendedEntries).toHaveLength(0);
      expect(harness.waitForIdleCalls).toBe(0);
      expect(harness.operationLog).not.toContain("waitForIdle");
      const started = harness.notifications.find((notification) =>
        notification.message.includes("Materia WebUI started:"),
      );
      expect(started?.message).toContain("http://127.0.0.1:");
      const startedWidget = harness.widgets.get("materia-webui")?.content;
      expect(startedWidget?.[0]).toBe("WebUI started");
      expect(startedWidget?.[1]).toContain("http://127.0.0.1:");

      await harness.runCommand("materia", "link");
      await waitForNotification(harness, "Materia WebUI ready:");

      const ready = harness.notifications.find((notification) =>
        notification.message.includes("Materia WebUI ready:"),
      );
      expect(ready?.message).toContain("http://127.0.0.1:");
      const readyWidget = harness.widgets.get("materia-webui")?.content;
      expect(readyWidget?.[0]).toBe("WebUI ready (reused)");
      expect(readyWidget?.[1]).toContain("http://127.0.0.1:");
      expect(harness.sentMessages).toHaveLength(0);
      expect(harness.appendedEntries).toHaveLength(0);
      expect(harness.waitForIdleCalls).toBe(0);
      expect(harness.operationLog).not.toContain("waitForIdle");
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("recast and revive commands also auto-start or reuse the WebUI", async () => {
    const { harness } = await harnessWithProfile(
      "pi-materia-webui-auto-recast-",
    );

    await harness.runCommand("materia", "recast");
    await waitForNotification(harness, "Materia WebUI started:");

    try {
      await harness.runCommand("materia", "revive");
      await waitForNotification(harness, "Materia WebUI ready:");

      expect(harness.sentMessages).toHaveLength(0);
      expect(harness.appendedEntries).toHaveLength(0);
      expect(harness.waitForIdleCalls).toBe(0);
      expect(harness.operationLog).not.toContain("waitForIdle");
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("unrelated command cleanup does not clear the persistent WebUI status widget", async () => {
    const { harness } = await harnessWithProfile(
      "pi-materia-webui-widget-cleanup-",
    );

    await harness.runCommand("materia", "cast");
    await waitForNotification(harness, "Materia WebUI started:");
    const webuiWidget = harness.widgets.get("materia-webui")?.content;
    expect(webuiWidget?.[0]).toContain("WebUI started");
    expect(webuiWidget?.[0]).toContain("http://127.0.0.1:");

    try {
      await harness.runCommand("materia", "grid");
      expect(harness.widgets.get("materia-webui")?.content).toEqual(
        webuiWidget,
      );

      await harness.runCommand("materia", "loadout");
      expect(harness.widgets.get("materia-webui")?.content).toEqual(
        webuiWidget,
      );

      await harness.runCommand("materia", "status");
      expect(harness.widgets.get("materia-webui")?.content).toEqual(
        webuiWidget,
      );
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("launcher wires Pi model registry and active thinking into the model catalog endpoint", async () => {
    const { harness } = await harnessWithProfile(
      "pi-materia-webui-model-catalog-",
    );
    const activeModel = {
      provider: "openai-codex",
      id: "gpt-5.5",
      name: "GPT 5.5 Codex",
      api: "openai-codex-responses",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
      },
    };
    const otherModel = {
      provider: "anthropic",
      id: "claude-haiku-test",
      name: "Claude Haiku Test",
      api: "anthropic-messages",
      reasoning: false,
    };
    harness.models = [activeModel, otherModel];
    harness.activeModel = activeModel;
    (harness.ctx as unknown as { model: unknown }).model = activeModel;
    harness.thinkingLevel = "xhigh";

    await harness.runCommand("materia", "ui");

    try {
      const launched = harness.appendedEntries.at(-1)?.data as { url: string };
      const response = await fetch(new URL("/api/models", launched.url));
      const body = (await response.json()) as {
        activeModelValue: string | null;
        activeThinking: string | null;
        models: Array<{ value: string; supportedThinkingLevels: string[] }>;
      };

      expect(response.status).toBe(200);
      expect(body.activeModelValue).toBe("openai-codex/gpt-5.5");
      expect(body.activeThinking).toBe("xhigh");
      expect(body.models.map((model) => model.value)).toEqual([
        "openai-codex/gpt-5.5",
        "anthropic/claude-haiku-test",
      ]);
      expect(body.models[0]?.supportedThinkingLevels).toEqual([
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(body.models[1]?.supportedThinkingLevels).toEqual(["off"]);

      harness.activeModel = otherModel;
      (harness.ctx as unknown as { model: unknown }).model = otherModel;
      harness.thinkingLevel = "low";

      const updatedResponse = await fetch(new URL("/api/models", launched.url));
      const updatedBody = (await updatedResponse.json()) as {
        activeModelValue: string | null;
        activeThinking: string | null;
      };
      expect(updatedBody.activeModelValue).toBe("anthropic/claude-haiku-test");
      expect(updatedBody.activeThinking).toBe("low");
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("launcher respects profile host and preferred port while reporting auto-open configuration", async () => {
    const { harness, profile } = await harnessWithProfile(
      "pi-materia-webui-profile-",
    );
    await writeFile(
      getUserProfileConfigPath(),
      JSON.stringify({
        webui: { host: "127.0.0.1", preferredPort: 0, autoOpenBrowser: false },
      }),
      "utf8",
    );

    const result = await launchMateriaWebUi(harness.ctx);

    expect(result.reused).toBe(false);
    expect(result.autoOpenBrowser).toBe(false);
    expect(result.url).toContain(
      `session=${encodeURIComponent(result.sessionKey)}`,
    );
    expect(await readFile(path.join(profile, "config.json"), "utf8")).toContain(
      "autoOpenBrowser",
    );

    await harness.emit("session_shutdown");
  });
});

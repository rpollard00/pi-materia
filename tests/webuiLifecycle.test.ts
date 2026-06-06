import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import piMateria from "../src/index.js";
import {
  launchMateriaWebUi,
  webUiLauncherTestInternals,
} from "../src/webui/launcher.js";
import { ensureMateriaWebUi } from "../src/webui/service.js";
import { getUserProfileConfigPath, loadConfig } from "../src/config/config.js";
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

function minimalLoadout(id: string) {
  return {
    id,
    entry: "Socket-1",
    sockets: { "Socket-1": { materia: "Build" } },
  };
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
      `WebUI started: ${first.url}`,
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
      `WebUI ready (reused): ${first.url}`,
    ]);
    expect(harness.waitForIdleCalls).toBe(0);

    await harness.emit("session_shutdown");
    await expect(fetch(new URL("/api/health", first.url))).rejects.toThrow();
  });

  test("command preserves the active loadout when opening the WebUI before session start", async () => {
    const { harness, profile } = await harnessWithProfile(
      "pi-materia-webui-loadout-preserve-",
    );
    await writeFile(
      path.join(profile, "config.json"),
      JSON.stringify({ defaultLoadoutId: "user:hojo" }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(profile, "materia.json"),
      JSON.stringify(
        {
          materia: { Build: { tools: "coding", prompt: "build" } },
          loadouts: {
            Hojo: minimalLoadout("user:hojo"),
            reno: minimalLoadout("user:reno"),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      await harness.runCommand("materia", "loadout reno");
      let loaded = await loadConfig(harness.cwd);
      expect(loaded.config.activeLoadout).toBe("reno");
      expect(loaded.config.activeLoadoutId).toBe("user:reno");

      await harness.runCommand("materia", "ui");

      loaded = await loadConfig(harness.cwd);
      expect(loaded.config.activeLoadout).toBe("reno");
      expect(loaded.config.activeLoadoutId).toBe("user:reno");
      expect(
        harness.notifications.map((notification) => notification.message),
      ).not.toContain(
        expect.stringContaining("initialized active loadout from default preference"),
      );
      expect(
        harness.appendedEntries.filter(
          (entry) => entry.customType === "pi-materia-active-loadout-changed",
        ),
      ).toHaveLength(1);
    } finally {
      await harness.emit("session_shutdown");
    }
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
      expect(startedWidget?.[0]).toContain("WebUI started: http://127.0.0.1:");

      await harness.runCommand("materia", "link");
      await waitForNotification(harness, "Materia WebUI ready:");

      const ready = harness.notifications.find((notification) =>
        notification.message.includes("Materia WebUI ready:"),
      );
      expect(ready?.message).toContain("http://127.0.0.1:");
      const readyWidget = harness.widgets.get("materia-webui")?.content;
      expect(readyWidget?.[0]).toContain("WebUI ready (reused): http://127.0.0.1:");
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
    expect(new URL(result.url).search).toBe("");
    expect(await readFile(path.join(profile, "config.json"), "utf8")).toContain(
      "autoOpenBrowser",
    );

    await harness.emit("session_shutdown");
  });
});

describe("PATCH /api/quests/:questId through launcher path", () => {
  const QUEST_BOARD_SCHEMA_VERSION = 1;

  test("updates a pending quest through the full launcher path and persists the edit", async () => {
    const { harness } = await harnessWithProfile(
      "pi-materia-webui-quest-patch-",
    );

    try {
      // Seed a quest board with a single pending quest in the harness cwd.
      const boardDir = path.join(harness.cwd, ".pi", "pi-materia");
      const boardPath = path.join(boardDir, "quest-board.json");
      await mkdir(boardDir, { recursive: true });
      const now = new Date().toISOString();
      const pendingQuest = {
        id: "quest-pending-1",
        title: "Gather moon herbs",
        prompt: "Gather moon herbs",
        status: "pending",
        createdAt: now,
        updatedAt: now,
        attempts: 0,
      };
      const board = {
        version: QUEST_BOARD_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
        runner: { enabled: false },
        quests: [pendingQuest],
      };
      await writeFile(boardPath, JSON.stringify(board, null, 2) + "\n", "utf8");

      // Launch the WebUI through the full launcher path.
      await harness.runCommand("materia", "ui");
      const launched = harness.appendedEntries.at(-1)?.data as {
        url: string;
        sessionKey: string;
      };
      expect(launched.url).toBeTruthy();

      // PATCH the pending quest.  Use new URL() so the path replaces the
      // pathname of the launched URL rather than appending after the
      // session query string.
      const patchUrl = new URL(
        `/api/quests/quest-pending-1`,
        launched.url,
      );
      const patchResponse = await fetch(patchUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "  Gather sun herbs instead  " }),
      });
      const patchBody = await patchResponse.json();

      // Regression assertion: the response must no longer be the 503
      // unavailable envelope that the launcher currently returns.
      expect(patchResponse.status).not.toBe(503);
      expect(patchBody).not.toEqual({
        ok: false,
        error: "Quest update API is unavailable for this server.",
      });

      // After the launcher wiring fix the response should be a 200 success.
      expect(patchResponse.status).toBe(200);
      expect(patchBody.ok).toBe(true);
      expect(patchBody.quest).toMatchObject({
        id: "quest-pending-1",
        title: "Gather sun herbs instead",
        prompt: "Gather sun herbs instead",
        status: "pending",
      });
      expect(patchBody.board).toBeDefined();
      expect(patchBody.board.pendingQuests).toHaveLength(1);

      // Verify the on-disk board reflects the edited prompt, title, and
      // a newer updatedAt timestamp.
      const savedRaw = await readFile(boardPath, "utf8");
      const saved = JSON.parse(savedRaw);
      const savedQuest = saved.quests.find(
        (q: { id: string }) => q.id === "quest-pending-1",
      );
      expect(savedQuest.prompt).toBe("Gather sun herbs instead");
      expect(savedQuest.title).toBe("Gather sun herbs instead");
      expect(savedQuest.status).toBe("pending");
      expect(savedQuest.createdAt).toBe(now);
      expect(savedQuest.updatedAt).not.toBe(now);
      expect(new Date(savedQuest.updatedAt).getTime()).toBeGreaterThan(
        new Date(now).getTime(),
      );
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("isolates cwd state so seeded boards do not leak between tests", async () => {
    const { harness: firstHarness } = await harnessWithProfile(
      "pi-materia-webui-patch-isolate-1-",
    );

    try {
      // Seed the first harness cwd with a pending quest.
      const firstBoardDir = path.join(firstHarness.cwd, ".pi", "pi-materia");
      await mkdir(firstBoardDir, { recursive: true });
      const now = new Date().toISOString();
      await writeFile(
        path.join(firstBoardDir, "quest-board.json"),
        JSON.stringify(
          {
            version: QUEST_BOARD_SCHEMA_VERSION,
            createdAt: now,
            updatedAt: now,
            runner: { enabled: false },
            quests: [
              {
                id: "quest-first",
                title: "First",
                prompt: "First quest",
                status: "pending",
                createdAt: now,
                updatedAt: now,
                attempts: 0,
              },
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      // Launch and immediately shut down.
      await firstHarness.runCommand("materia", "ui");
      await firstHarness.emit("session_shutdown");
    } catch {
      // Ignore errors during setup/shutdown.
    }

    // A second harness with a different cwd should start with an empty board,
    // confirming that the first harness state did not leak.
    const { harness: secondHarness } = await harnessWithProfile(
      "pi-materia-webui-patch-isolate-2-",
    );

    try {
      expect(
        existsSync(
          path.join(secondHarness.cwd, ".pi", "pi-materia", "quest-board.json"),
        ),
      ).toBe(false);

      await secondHarness.runCommand("materia", "ui");
      const launched = secondHarness.appendedEntries.at(-1)?.data as {
        url: string;
      };

      // The fresh board should be empty (no quests).
      const response = await fetch(
        new URL("/api/quests", launched.url),
      );
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.quests).toHaveLength(0);
    } finally {
      await secondHarness.emit("session_shutdown");
    }
  });

  test("returns validation_failed for missing quests through the launcher path", async () => {
    const { harness } = await harnessWithProfile(
      "pi-materia-webui-patch-missing-",
    );

    try {
      const boardDir = path.join(harness.cwd, ".pi", "pi-materia");
      const boardPath = path.join(boardDir, "quest-board.json");
      await mkdir(boardDir, { recursive: true });
      const now = new Date().toISOString();
      await writeFile(
        boardPath,
        JSON.stringify({
          version: QUEST_BOARD_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
          runner: { enabled: false },
          quests: [
            {
              id: "quest-pending-1",
              title: "Pending quest",
              prompt: "Do something",
              status: "pending",
              createdAt: now,
              updatedAt: now,
              attempts: 0,
            },
          ],
        }, null, 2) + "\n",
        "utf8",
      );

      await harness.runCommand("materia", "ui");
      const launched = harness.appendedEntries.at(-1)?.data as { url: string };

      const patchUrl = new URL("/api/quests/quest-missing", launched.url);
      const response = await fetch(patchUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Update missing quest" }),
      });
      const body = await response.json();

      // Must not return the 503 unavailable envelope.
      expect(response.status).not.toBe(503);
      expect(response.status).toBe(400);
      expect(body).toEqual({
        ok: false,
        code: "validation_failed",
        error: "questId: quest 'quest-missing' does not exist",
      });
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("returns validation_failed for non-pending quests through the launcher path", async () => {
    const { harness } = await harnessWithProfile(
      "pi-materia-webui-patch-nonpending-",
    );

    try {
      const boardDir = path.join(harness.cwd, ".pi", "pi-materia");
      const boardPath = path.join(boardDir, "quest-board.json");
      await mkdir(boardDir, { recursive: true });
      const now = new Date().toISOString();
      await writeFile(
        boardPath,
        JSON.stringify({
          version: QUEST_BOARD_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
          runner: { enabled: false },
          quests: [
            {
              id: "quest-running",
              title: "Running quest",
              prompt: "Running quest",
              status: "running",
              createdAt: now,
              updatedAt: now,
              attempts: 1,
              currentCastId: "cast-active",
            },
          ],
        }, null, 2) + "\n",
        "utf8",
      );

      await harness.runCommand("materia", "ui");
      const launched = harness.appendedEntries.at(-1)?.data as { url: string };

      const patchUrl = new URL("/api/quests/quest-running", launched.url);
      const response = await fetch(patchUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Change running quest" }),
      });
      const body = await response.json();

      expect(response.status).not.toBe(503);
      expect(response.status).toBe(400);
      expect(body).toEqual({
        ok: false,
        code: "validation_failed",
        error: "quest.status: quest 'quest-running' is running, not pending",
      });
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("returns invalid_loadout for unknown loadout overrides through the launcher path", async () => {
    const { harness } = await harnessWithProfile(
      "pi-materia-webui-patch-loadout-",
    );

    try {
      const boardDir = path.join(harness.cwd, ".pi", "pi-materia");
      const boardPath = path.join(boardDir, "quest-board.json");
      await mkdir(boardDir, { recursive: true });
      const now = new Date().toISOString();
      await writeFile(
        boardPath,
        JSON.stringify({
          version: QUEST_BOARD_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
          runner: { enabled: false },
          quests: [
            {
              id: "quest-pending-1",
              title: "Pending quest",
              prompt: "Do something",
              status: "pending",
              createdAt: now,
              updatedAt: now,
              attempts: 0,
            },
          ],
        }, null, 2) + "\n",
        "utf8",
      );

      await harness.runCommand("materia", "ui");
      const launched = harness.appendedEntries.at(-1)?.data as { url: string };

      const patchUrl = new URL("/api/quests/quest-pending-1", launched.url);
      const response = await fetch(patchUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Update pending", loadoutOverride: "NonExistentLoadout" }),
      });
      const body = await response.json();

      expect(response.status).not.toBe(503);
      expect(response.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.code).toBe("invalid_loadout");
      expect(body.error).toContain("Unknown Materia loadout");
      expect(body.error).toContain("NonExistentLoadout");
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("returns route-level error for blank prompts without reaching the domain layer", async () => {
    const { harness } = await harnessWithProfile(
      "pi-materia-webui-patch-blank-",
    );

    try {
      const boardDir = path.join(harness.cwd, ".pi", "pi-materia");
      const boardPath = path.join(boardDir, "quest-board.json");
      await mkdir(boardDir, { recursive: true });
      const now = new Date().toISOString();
      await writeFile(
        boardPath,
        JSON.stringify({
          version: QUEST_BOARD_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
          runner: { enabled: false },
          quests: [
            {
              id: "quest-pending-1",
              title: "Pending quest",
              prompt: "Do something",
              status: "pending",
              createdAt: now,
              updatedAt: now,
              attempts: 0,
            },
          ],
        }, null, 2) + "\n",
        "utf8",
      );

      await harness.runCommand("materia", "ui");
      const launched = harness.appendedEntries.at(-1)?.data as { url: string };

      const patchUrl = new URL("/api/quests/quest-pending-1", launched.url);
      const response = await fetch(patchUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "   " }),
      });
      const body = await response.json();

      expect(response.status).not.toBe(503);
      expect(response.status).toBe(400);
      // Route-level blank prompt returns error only, no code field.
      expect(body).toEqual({ ok: false, error: "Quest prompt is required." });
    } finally {
      await harness.emit("session_shutdown");
    }
  });

  test("clears an existing loadout override when patched with blank loadoutOverride", async () => {
    const { harness } = await harnessWithProfile(
      "pi-materia-webui-patch-clear-loadout-",
    );

    try {
      const boardDir = path.join(harness.cwd, ".pi", "pi-materia");
      const boardPath = path.join(boardDir, "quest-board.json");
      await mkdir(boardDir, { recursive: true });
      const now = new Date().toISOString();
      await writeFile(
        boardPath,
        JSON.stringify({
          version: QUEST_BOARD_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
          runner: { enabled: false },
          quests: [
            {
              id: "quest-pending-1",
              title: "Pending quest",
              prompt: "Do something",
              status: "pending",
              createdAt: now,
              updatedAt: now,
              attempts: 0,
              loadoutOverride: "Full-Auto",
            },
          ],
        }, null, 2) + "\n",
        "utf8",
      );

      await harness.runCommand("materia", "ui");
      const launched = harness.appendedEntries.at(-1)?.data as { url: string };

      // PATCH with blank loadoutOverride to clear the existing override.
      const patchUrl = new URL("/api/quests/quest-pending-1", launched.url);
      const response = await fetch(patchUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Updated prompt", loadoutOverride: "   " }),
      });
      const body = await response.json();

      expect(response.status).not.toBe(503);
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.quest.loadoutOverride).toBeUndefined();

      // Verify on-disk persistence cleared the override.
      const savedRaw = await readFile(boardPath, "utf8");
      const saved = JSON.parse(savedRaw);
      const savedQuest = saved.quests.find(
        (q: { id: string }) => q.id === "quest-pending-1",
      );
      expect(savedQuest.loadoutOverride).toBeUndefined();
    } finally {
      await harness.emit("session_shutdown");
    }
  });
});

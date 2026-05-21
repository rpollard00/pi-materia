import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMateriaWebUiServer, type MateriaSetQuestDefaultLoadoutCallback } from "../src/webui/server/index.js";

type StartedServer = ReturnType<typeof createMateriaWebUiServer>["server"];

const servers: StartedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startTestServer(setQuestDefaultLoadout?: MateriaSetQuestDefaultLoadoutCallback) {
  const staticDir = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-quest-default-loadout-"));
  const created = createMateriaWebUiServer({
    staticDir,
    session: {
      key: "test-session",
      cwd: staticDir,
      sessionFile: `${staticDir}/session.jsonl`,
      sessionId: "test-session-id",
      startedAt: Date.now(),
      getSnapshot: async () => ({
        ok: true,
        scope: "session",
        service: "pi-materia-webui",
        sessionKey: "test-session",
        cwd: staticDir,
        sessionFile: `${staticDir}/session.jsonl`,
        sessionId: "test-session-id",
        uiStartedAt: Date.now(),
        now: Date.now(),
      }),
      setQuestDefaultLoadout,
    },
  });
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(created.server);
  const address = created.server.address();
  if (!address || typeof address !== "object") throw new Error("test server did not bind to a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

async function postQuestDefaultLoadout(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/api/loadout/quest-default-loadout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/loadout/quest-default-loadout", () => {
  test("delegates a trimmed loadout name and returns the quest default id", async () => {
    const calls: Array<string | null> = [];
    const baseUrl = await startTestServer(async (name) => {
      calls.push(name);
      return { ok: true, questDefaultLoadoutId: "default:full-auto", message: "Quest default loadout set to default:full-auto." };
    });

    const response = await postQuestDefaultLoadout(baseUrl, { name: "  Full-Auto  " });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, questDefaultLoadoutId: "default:full-auto", message: "Quest default loadout set to default:full-auto." });
    expect(calls).toEqual(["Full-Auto"]);
  });

  test("delegates null to clear only the quest default loadout", async () => {
    const calls: Array<string | null> = [];
    const baseUrl = await startTestServer(async (name) => {
      calls.push(name);
      return { ok: true, questDefaultLoadoutId: null, message: "Quest default loadout cleared." };
    });

    const response = await postQuestDefaultLoadout(baseUrl, { name: null });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, questDefaultLoadoutId: null, message: "Quest default loadout cleared." });
    expect(calls).toEqual([null]);
  });

  test("maps unknown quest default loadout failures to 404", async () => {
    const baseUrl = await startTestServer(async () => ({
      ok: false,
      code: "unknown_loadout",
      message: "Unknown quest default Materia loadout \"Missing\".",
      questDefaultLoadoutId: "default:full-auto",
    }));

    const response = await postQuestDefaultLoadout(baseUrl, { name: "Missing" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "unknown_loadout", message: "Unknown quest default Materia loadout \"Missing\"." },
      questDefaultLoadoutId: "default:full-auto",
    });
  });

  test("rejects empty names before invoking the callback", async () => {
    let calls = 0;
    const baseUrl = await startTestServer(async () => {
      calls += 1;
      return { ok: true, questDefaultLoadoutId: null };
    });

    const response = await postQuestDefaultLoadout(baseUrl, { name: "   " });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: { code: "invalid_name", message: "Quest default loadout name cannot be empty." } });
    expect(calls).toBe(0);
  });
});

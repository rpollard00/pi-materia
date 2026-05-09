import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMateriaWebUiServer, type MateriaSetActiveLoadoutCallback } from "../src/webui/server/index.js";

type StartedServer = ReturnType<typeof createMateriaWebUiServer>["server"];

const servers: StartedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startTestServer(setActiveLoadout?: MateriaSetActiveLoadoutCallback) {
  const staticDir = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-active-loadout-"));
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
      setActiveLoadout,
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

async function postActiveLoadout(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/api/loadout/active`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/loadout/active", () => {
  test("delegates a trimmed loadout name and returns the canonical active config", async () => {
    const calls: string[] = [];
    const config = { config: { activeLoadout: "Planning-Consult", loadouts: { "Planning-Consult": {} } } };
    const baseUrl = await startTestServer(async (name) => {
      calls.push(name);
      return { ok: true, activeLoadout: "Planning-Consult", config, message: "Active loadout changed to Planning-Consult." };
    });

    const response = await postActiveLoadout(baseUrl, { name: "  Planning-Consult  " });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, activeLoadout: "Planning-Consult", config, message: "Active loadout changed to Planning-Consult." });
    expect(calls).toEqual(["Planning-Consult"]);
  });

  test("rejects invalid request shapes before invoking the session callback", async () => {
    let calls = 0;
    const baseUrl = await startTestServer(async () => {
      calls += 1;
      return { ok: true, activeLoadout: "unused" };
    });

    const response = await postActiveLoadout(baseUrl, { name: "   " });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: { code: "invalid_name", message: "Expected JSON body with non-empty string field \"name\"." } });
    expect(calls).toBe(0);
  });

  test("returns unavailable when the backend/session callback is missing", async () => {
    const baseUrl = await startTestServer(undefined);

    const response = await postActiveLoadout(baseUrl, { name: "Full-Auto" });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: { code: "unavailable", message: "Active loadout API is unavailable for this server." } });
  });

  test("maps unknown loadout failures to 404 with current active state", async () => {
    const baseUrl = await startTestServer(async () => ({
      ok: false,
      code: "unknown_loadout",
      message: "Unknown Materia loadout \"Missing\".",
      activeLoadout: "Full-Auto",
      config: { config: { activeLoadout: "Full-Auto" } },
    }));

    const response = await postActiveLoadout(baseUrl, { name: "Missing" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "unknown_loadout", message: "Unknown Materia loadout \"Missing\"." },
      activeLoadout: "Full-Auto",
      config: { config: { activeLoadout: "Full-Auto" } },
    });
  });

  test("maps active cast conflicts to 409", async () => {
    const baseUrl = await startTestServer(async () => ({
      ok: false,
      code: "active_cast_conflict",
      message: "Cannot change active loadout during active cast cast-123.",
    }));

    const response = await postActiveLoadout(baseUrl, { name: "Planning-Consult" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: { code: "active_cast_conflict", message: "Cannot change active loadout during active cast cast-123." } });
  });
});

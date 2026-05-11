import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMateriaWebUiServer, type MateriaConfigPatch, type MateriaSaveTarget } from "../src/webui/server/index.js";

type StartedServer = ReturnType<typeof createMateriaWebUiServer>["server"];
const servers: StartedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startTestServer(saveConfig?: (patch: MateriaConfigPatch, target: MateriaSaveTarget) => Promise<string>) {
  const staticDir = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-config-"));
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
      saveConfig,
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

async function postConfig(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/config", () => {
  test("accepts socket-first WebUI loadout payloads", async () => {
    const calls: Array<{ patch: MateriaConfigPatch; target: MateriaSaveTarget }> = [];
    const baseUrl = await startTestServer(async (patch, target) => {
      calls.push({ patch, target });
      return "/tmp/materia.json";
    });

    const response = await postConfig(baseUrl, {
      target: "user",
      config: { loadouts: { Active: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Build" } }, loops: { work: { sockets: ["Socket-1"] } } } } },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, target: "user", written: "/tmp/materia.json" });
    expect(calls[0]?.patch).toEqual({ loadouts: { Active: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Build" } }, loops: { work: { sockets: ["Socket-1"] } } } } });
  });

  test("rejects legacy WebUI loadout nodes before saving", async () => {
    let calls = 0;
    const baseUrl = await startTestServer(async () => {
      calls += 1;
      return "/tmp/materia.json";
    });

    const response = await postConfig(baseUrl, {
      config: { loadouts: { Legacy: { entry: "Socket-1", nodes: { "Socket-1": { type: "agent", materia: "Build" } } } } },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "Legacy WebUI loadout nodes are not supported; use sockets instead." });
    expect(calls).toBe(0);
  });

  test("rejects legacy WebUI loop nodes before saving", async () => {
    let calls = 0;
    const baseUrl = await startTestServer(async () => {
      calls += 1;
      return "/tmp/materia.json";
    });

    const response = await postConfig(baseUrl, {
      config: { loadouts: { Legacy: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Build" } }, loops: { work: { nodes: ["Socket-1"] } } } } },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "Legacy WebUI loop nodes are not supported; use sockets instead." });
    expect(calls).toBe(0);
  });
});

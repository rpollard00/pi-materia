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

async function startTestServer(saveConfig?: (patch: MateriaConfigPatch, target: MateriaSaveTarget) => Promise<string>, getConfig?: () => Promise<unknown>) {
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
      getConfig,
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

describe("GET /api/config", () => {
  test("returns materia source and default metadata from loaded config", async () => {
    const baseUrl = await startTestServer(undefined, async () => ({
      source: "test",
      config: { materia: { Build: { tools: "coding", prompt: "build" } } },
      materiaSources: { Build: "user" },
      defaultMateriaIds: ["Build"],
      defaultLoadoutId: "default:planning-consult",
      questDefaultLoadoutId: "default:full-auto",
      questDefaultLoadoutWarning: undefined,
    }));

    const response = await fetch(`${baseUrl}/api/config`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      source: "test",
      config: { materia: { Build: { tools: "coding", prompt: "build" } } },
      materiaSources: { Build: "user" },
      defaultMateriaIds: ["Build"],
      defaultLoadoutId: "default:planning-consult",
      questDefaultLoadoutId: "default:full-auto",
    });
  });
});

describe("POST /api/config", () => {
  test("accepts socket-first WebUI loadout payloads", async () => {
    const calls: Array<{ patch: MateriaConfigPatch; target: MateriaSaveTarget }> = [];
    const baseUrl = await startTestServer(async (patch, target) => {
      calls.push({ patch, target });
      return "/tmp/materia.json";
    });

    const response = await postConfig(baseUrl, {
      target: "user",
      config: { loadouts: { Active: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } }, loops: { work: { sockets: ["Socket-1"] } } } } },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, target: "user", written: "/tmp/materia.json" });
    expect(calls[0]?.patch).toEqual({ loadouts: { Active: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } }, loops: { work: { sockets: ["Socket-1"] } } } } });
  });

  test("passes config patches to save validation", async () => {
    const calls: Array<{ patch: MateriaConfigPatch; target: MateriaSaveTarget }> = [];
    const baseUrl = await startTestServer(async (patch, target) => {
      calls.push({ patch, target });
      return "/tmp/materia.json";
    });

    const patch = { loadouts: { Empty: { entry: "Socket-1", sockets: {} } } };
    const response = await postConfig(baseUrl, { config: patch });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, target: "user", written: "/tmp/materia.json" });
    expect(calls[0]).toEqual({ patch, target: "user" });
  });
});

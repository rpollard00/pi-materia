import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMateriaWebUiServer } from "../src/webui/server/index.js";

type StartedServer = ReturnType<typeof createMateriaWebUiServer>["server"];

const servers: StartedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startTestServer(generateMateriaRole: NonNullable<NonNullable<Parameters<typeof createMateriaWebUiServer>[0]["session"]>["generateMateriaRole"]>) {
  const staticDir = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-static-"));
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
      generateMateriaRole,
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

describe("POST /api/generate/materia-role", () => {
  test("returns generated Materia role prompt text in a stable JSON shape", async () => {
    const calls: Array<{ brief: string; generates?: unknown }> = [];
    const baseUrl = await startTestServer(async (request) => {
      calls.push(request);
      return { ok: true, prompt: "Review code carefully.", isolated: true, model: "test/model", provider: "test", api: "mock", thinking: "low" };
    });

    const response = await fetch(`${baseUrl}/api/generate/materia-role`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "  reviewer role  ", generates: null }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      prompt: "Review code carefully.",
      isolated: true,
      model: "test/model",
      provider: "test",
      api: "mock",
      thinking: "low",
    });
    expect(calls).toEqual([{ brief: "reviewer role", generates: null }]);
  });

  test("pipes generated list output configuration into generation requests", async () => {
    const calls: Array<{ brief: string; generates?: unknown }> = [];
    const baseUrl = await startTestServer(async (request) => {
      calls.push(request);
      return { ok: true, prompt: "Plan tasks carefully.", isolated: true };
    });

    const response = await fetch(`${baseUrl}/api/generate/materia-role`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief: "planner role",
        generates: { output: " tasks ", items: " state.tasks ", listType: "array", itemType: " task ", as: " task ", cursor: " taskIndex ", done: " end " },
      }),
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ brief: "planner role", generates: { output: "tasks", items: "state.tasks", listType: "array", itemType: "task", as: "task", cursor: "taskIndex", done: "end" } }]);
  });

  test("rejects bad request shapes before invoking generation", async () => {
    let calls = 0;
    const baseUrl = await startTestServer(async () => {
      calls += 1;
      return { ok: true, prompt: "should not run", isolated: true };
    });

    const response = await fetch(`${baseUrl}/api/generate/materia-role`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "   " }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: { code: "invalid_brief", message: "Role brief cannot be empty." } });
    expect(calls).toBe(0);
  });

  test("maps role generation service failures to JSON error responses", async () => {
    const baseUrl = await startTestServer(async () => ({ ok: false, code: "generation_failed", error: "model unavailable" }));

    const response = await fetch(`${baseUrl}/api/generate/materia-role`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "writer role" }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: { code: "generation_failed", message: "model unavailable" } });
  });
});

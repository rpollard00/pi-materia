import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMateriaWebUiServer } from "../src/webui/server/index.js";

const servers: Array<ReturnType<typeof createMateriaWebUiServer>["server"]> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startTestServer(snapshot: Record<string, unknown> = {}) {
  const staticDir = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-tools-"));
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
        ...snapshot,
      }),
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

describe("GET /api/session tool registry metadata", () => {
  test("returns additive live tool registry metadata on the existing session surface", async () => {
    const baseUrl = await startTestServer({ toolRegistry: { ok: true, available: true, tools: ["read", "extensionTool"] } });

    const response = await fetch(`${baseUrl}/api/session`);
    const body = await response.json() as { ok: boolean; toolRegistry?: { ok: boolean; available: boolean; tools: string[] } };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.toolRegistry).toEqual({ ok: true, available: true, tools: ["read", "extensionTool"] });
  });

  test("preserves backward-compatible session responses when metadata is absent", async () => {
    const baseUrl = await startTestServer();

    const response = await fetch(`${baseUrl}/api/session`);
    const body = await response.json() as { ok: boolean; toolRegistry?: unknown };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("toolRegistry");
  });

  test("reports registry-unavailable metadata without failing the API", async () => {
    const baseUrl = await startTestServer({ toolRegistry: { ok: false, available: false, tools: [], warnings: ["Pi tool registry is unavailable for this WebUI session."] } });

    const response = await fetch(`${baseUrl}/api/session`);
    const body = await response.json() as { toolRegistry?: { ok: boolean; available: boolean; tools: string[]; warnings?: string[] } };

    expect(response.status).toBe(200);
    expect(body.toolRegistry).toMatchObject({ ok: false, available: false, tools: [] });
    expect(body.toolRegistry?.warnings?.join("\n")).toContain("unavailable");
  });
});

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { getUserProfileConfigPath, getRoleGenerationModelPreference, saveRoleGenerationModelPreference } from "../src/config/config.js";
import { createMateriaWebUiServer } from "../src/webui/server/index.js";

type StartedServer = ReturnType<typeof createMateriaWebUiServer>["server"];
const servers: StartedServer[] = [];
let previousProfileDir: string | undefined;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  if (previousProfileDir === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
  else process.env.PI_MATERIA_PROFILE_DIR = previousProfileDir;
  previousProfileDir = undefined;
});

async function startProfileServer(profileDir?: string) {
  previousProfileDir = process.env.PI_MATERIA_PROFILE_DIR;
  process.env.PI_MATERIA_PROFILE_DIR = profileDir ?? await mkdtemp(path.join(tmpdir(), "pi-materia-profile-api-"));
  const staticDir = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-profile-"));
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
      getRoleGenerationPreference: async () => ({ model: await getRoleGenerationModelPreference() }),
      setRoleGenerationPreference: async (model) => ({ model: await saveRoleGenerationModelPreference(model) }),
    },
  });
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(created.server);
  const address = created.server.address();
  if (!address || typeof address !== "object") throw new Error("test server did not bind to a TCP port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, profileDir: process.env.PI_MATERIA_PROFILE_DIR };
}

function patchPreference(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/api/profile/role-generation`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/profile/role-generation", () => {
  test("reads null when Active Pi Model is the effective default", async () => {
    const { baseUrl } = await startProfileServer();

    const response = await fetch(`${baseUrl}/api/profile/role-generation`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, model: null });
  });

  test("sets trimmed provider-qualified model without checking availability", async () => {
    const { baseUrl } = await startProfileServer();

    const response = await patchPreference(baseUrl, { model: "  obsolete-provider/missing-model  " });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, model: "obsolete-provider/missing-model" });
    expect(JSON.parse(await readFile(getUserProfileConfigPath(), "utf8")).roleGeneration.model).toBe("obsolete-provider/missing-model");
  });

  test("clears null and blank model values while preserving role-generation siblings", async () => {
    const profileDir = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-api-"));
    await mkdir(profileDir, { recursive: true });
    const profileFile = path.join(profileDir, "config.json");
    await writeFile(profileFile, JSON.stringify({
      roleGeneration: {
        enabled: false,
        model: "provider/existing",
        thinking: "medium",
        extraInstructions: "Be direct.",
        useReadOnlyProjectContext: true,
      },
    }), "utf8");
    const { baseUrl } = await startProfileServer(profileDir);

    const blankResponse = await patchPreference(baseUrl, { model: "   " });
    expect(blankResponse.status).toBe(200);
    expect(await blankResponse.json()).toEqual({ ok: true, model: null });

    const savedBlank = JSON.parse(await readFile(profileFile, "utf8"));
    expect(savedBlank.roleGeneration).toEqual({
      enabled: false,
      thinking: "medium",
      extraInstructions: "Be direct.",
      useReadOnlyProjectContext: true,
    });

    await patchPreference(baseUrl, { model: "provider/new" });
    const nullResponse = await patchPreference(baseUrl, { model: null });
    expect(nullResponse.status).toBe(200);
    expect(JSON.parse(await readFile(profileFile, "utf8")).roleGeneration.model).toBeUndefined();
  });

  test("returns 400 for invalid payloads without modifying profile", async () => {
    const profileDir = await mkdtemp(path.join(tmpdir(), "pi-materia-profile-api-"));
    await mkdir(profileDir, { recursive: true });
    const profileFile = path.join(profileDir, "config.json");
    await writeFile(profileFile, JSON.stringify({ roleGeneration: { enabled: false, model: "provider/existing" } }), "utf8");
    const { baseUrl } = await startProfileServer(profileDir);
    const before = await readFile(profileFile, "utf8");

    for (const body of [{}, { model: 42 }, { model: "unqualified" }, { model: "bad provider/model" }]) {
      const response = await patchPreference(baseUrl, body);
      expect(response.status).toBe(400);
      expect((await response.json()).ok).toBe(false);
      expect(await readFile(profileFile, "utf8")).toBe(before);
    }
  });
});

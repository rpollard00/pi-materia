import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMateriaWebUiServer, type MateriaModelCatalogSource } from "../src/webui/server/index.js";

type StartedServer = ReturnType<typeof createMateriaWebUiServer>["server"];

const servers: StartedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startTestServer(modelCatalog?: MateriaModelCatalogSource) {
  const staticDir = await mkdtemp(path.join(tmpdir(), "pi-materia-webui-models-"));
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
      modelCatalog,
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

describe("GET /api/models", () => {
  test("returns active Pi model, active thinking, and only registry-available models", async () => {
    const reasoningModel = {
      provider: "openai-codex",
      id: "gpt-5.5",
      name: "GPT 5.5 Codex",
      api: "openai-codex-responses",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
      thinkingLevelMap: {
        off: null,
        minimal: "minimal",
        low: "low",
        medium: null,
        high: "high",
        xhigh: "xhigh",
      },
    };
    const nonReasoningModel = {
      provider: "anthropic",
      id: "claude-haiku-test",
      name: "Claude Haiku Test",
      api: "anthropic-messages",
      reasoning: false,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 8_192,
    };
    let getAvailableCalls = 0;
    const baseUrl = await startTestServer({
      getActiveModel: () => reasoningModel,
      getActiveThinking: () => "high",
      modelRegistry: {
        getAvailable: () => {
          getAvailableCalls += 1;
          return [reasoningModel, nonReasoningModel];
        },
      },
    });

    const response = await fetch(`${baseUrl}/api/models`);

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      activeModelValue: string | null;
      activeThinking: string | null;
      activeModel: { value: string; label: string } | null;
      models: Array<{ value: string; label: string; provider: string; id: string; api?: string; reasoning: boolean; input?: string[]; contextWindow?: number; maxTokens?: number; supportedThinkingLevels: string[] }>;
    };
    expect(body.ok).toBe(true);
    expect(body.activeModelValue).toBe("openai-codex/gpt-5.5");
    expect(body.activeThinking).toBe("high");
    expect(body.activeModel).toMatchObject({ value: "openai-codex/gpt-5.5", label: "GPT 5.5 Codex (openai-codex/gpt-5.5)" });
    expect(body.models).toHaveLength(2);
    expect(body.models[0]).toMatchObject({
      value: "openai-codex/gpt-5.5",
      provider: "openai-codex",
      id: "gpt-5.5",
      api: "openai-codex-responses",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
      supportedThinkingLevels: ["minimal", "low", "high", "xhigh"],
    });
    expect(body.models[1]).toMatchObject({
      value: "anthropic/claude-haiku-test",
      supportedThinkingLevels: ["off"],
      reasoning: false,
    });
    expect(getAvailableCalls).toBe(1);
  });

  test("derives default reasoning thinking levels from model metadata when no map is present", async () => {
    const xhighModel = {
      provider: "anthropic",
      id: "claude-opus-4-6-test",
      name: "Claude Opus 4.6 Test",
      api: "anthropic-messages",
      reasoning: true,
    };
    const baseUrl = await startTestServer({
      modelRegistry: { getAvailable: () => [xhighModel] },
    });

    const response = await fetch(`${baseUrl}/api/models`);
    const body = await response.json() as { models: Array<{ supportedThinkingLevels: string[] }> };

    expect(response.status).toBe(200);
    expect(body.models[0]?.supportedThinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
  });

  test("skips malformed registry entries without dropping valid models", async () => {
    const validModel = {
      provider: "openai-codex",
      id: "gpt-5.5",
      name: "GPT 5.5 Codex",
      reasoning: true,
    };
    const throwingModel = {
      provider: "anthropic",
      id: "broken-thinking-map",
      reasoning: true,
      get thinkingLevelMap() {
        throw new Error("bad thinking map");
      },
    };
    const baseUrl = await startTestServer({
      modelRegistry: { getAvailable: () => [validModel, throwingModel, { provider: "missing-id" }] },
    });

    const response = await fetch(`${baseUrl}/api/models`);
    const body = await response.json() as { models: Array<{ value: string }>; warnings?: string[] };

    expect(response.status).toBe(200);
    expect(body.models).toEqual([expect.objectContaining({ value: "openai-codex/gpt-5.5" })]);
    expect(body.warnings?.join("\n")).toContain("Skipped invalid model registry entry at index 1 (anthropic/broken-thinking-map): bad thinking map");
    expect(body.warnings?.join("\n")).toContain("Skipped invalid model registry entry at index 2 (provider: missing-id).");
  });

  test("handles missing or failing model registry data gracefully", async () => {
    const missingBaseUrl = await startTestServer();
    const missingResponse = await fetch(`${missingBaseUrl}/api/models`);
    expect(missingResponse.status).toBe(200);
    expect(await missingResponse.json()).toMatchObject({ ok: true, activeModel: null, activeModelValue: null, activeThinking: null, models: [] });

    const failingBaseUrl = await startTestServer({
      getActiveModel: () => { throw new Error("active unavailable"); },
      getActiveThinking: () => { throw new Error("thinking unavailable"); },
      modelRegistry: { getAvailable: () => { throw new Error("registry unavailable"); } },
    });
    const failingResponse = await fetch(`${failingBaseUrl}/api/models`);
    const failingBody = await failingResponse.json() as { ok: boolean; activeModel: unknown; activeThinking: unknown; models: unknown[]; warnings?: string[] };

    expect(failingResponse.status).toBe(200);
    expect(failingBody).toMatchObject({ ok: true, activeModel: null, activeThinking: null, models: [] });
    expect(failingBody.warnings?.join("\n")).toContain("registry unavailable");
  });
});

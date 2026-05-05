import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderCastList } from "../src/index.js";

describe("/materia casts listing", () => {
  test("renders newest first and marks failed casts as recast targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-casts-"));
    await writeCast(root, "2026-05-05T17-26-59-323Z", [
      { type: "cast_start", data: { request: "older failed recast implementation" } },
      { type: "node_start", data: { node: "Auto-Eval", role: "Auto-Eval", itemKey: "recast-003", itemLabel: "Implement /materia recast", visit: 3 } },
      { type: "cast_end", data: { ok: false, error: "WebSocket closed 1006", node: "Auto-Eval" } },
    ]);
    await writeCast(root, "2026-05-05T20-12-49-507Z", [
      { type: "cast_start", data: { request: "new active follow-up" } },
      { type: "node_start", data: { node: "Build", role: "Build", itemKey: "recast-004", itemLabel: "Improve discoverability", visit: 1 } },
    ]);

    const lines = await renderCastList(root);
    const text = lines.join("\n");
    expect(text.indexOf("2026-05-05T20-12-49-507Z")).toBeLessThan(text.indexOf("2026-05-05T17-26-59-323Z"));
    expect(text).toContain("↻ RECAST TARGET  failed  2026-05-05T17-26-59-323Z");
    expect(text).toContain("recast: /materia recast 2026-05-05T17-26-59-323Z");
    expect(text).toContain("request: older failed recast implementation");
    expect(text).toContain("progress: node Auto-Eval; role Auto-Eval; item recast-003 - Implement /materia recast; visit 3");
  });

  test("does not mark completed casts as recast targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-casts-"));
    const id = "2026-05-05T19-30-00-000Z";
    await writeCast(root, id, [
      { type: "cast_start", data: { request: "completed request" } },
      { type: "node_start", data: { node: "Build", role: "Build", itemKey: "done-001" } },
      { type: "cast_end", data: { ok: true, node: "Build" } },
    ]);

    const lines = await renderCastList(root);
    const text = lines.join("\n");
    expect(text).toContain(`complete  ${id}`);
    expect(text).not.toContain(`↻ RECAST TARGET  complete  ${id}`);
    expect(text).not.toContain(`recast: /materia recast ${id}`);
  });

  test("uses session state to identify aborted recast targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-materia-casts-"));
    const id = "2026-05-05T18-55-00-685Z";
    const dir = await writeCast(root, id, [
      { type: "cast_start", data: { request: "aborted request" } },
      { type: "node_start", data: { node: "Build", role: "Build" } },
    ]);

    const lines = await renderCastList(root, [{
      version: 1,
      active: false,
      castId: id,
      request: "aborted request",
      configSource: "test",
      configHash: "hash",
      cwd: root,
      runDir: dir,
      artifactRoot: root,
      phase: "Build",
      currentNode: "Build",
      currentRole: "Build",
      currentItemKey: "recast-004",
      currentItemLabel: "Improve discoverability",
      awaitingResponse: false,
      nodeState: "failed",
      failedReason: "aborted by user",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      data: {},
      cursors: {},
      visits: {},
      multiTurnRefinements: {},
      taskAttempts: {},
      edgeTraversals: {},
      runState: { castId: id, runDir: dir, usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byRole: {}, byNode: {}, byTask: {}, byAttempt: {} }, attempt: 1 },
      pipeline: { entry: { id: "Build", node: { type: "agent", role: "Build" }, role: { tools: "coding", systemPrompt: "" } }, nodes: new Map(), edges: new Map() },
    }]);

    const text = lines.join("\n");
    expect(text).toContain(`↻ RECAST TARGET  aborted  ${id}`);
    expect(text).toContain(`recast: /materia recast ${id}`);
  });
});

async function writeCast(root: string, id: string, events: Array<{ type: string; data: unknown }>): Promise<string> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ castId: id, request: (events[0].data as { request?: string }).request }, null, 2));
  await writeFile(path.join(dir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
  return dir;
}

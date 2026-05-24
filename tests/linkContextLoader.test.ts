import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPreviousCastContext } from "../src/link/contextLoader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempArtifactRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-materia-link-context-"));
  tempDirs.push(dir);
  return dir;
}

describe("previous-cast context loader", () => {
  test("loads deterministic fixture for reported timestamp-style --from cast id", async () => {
    const root = await tempArtifactRoot();
    const castId = "2026-05-12T19-40-40-605Z";
    const runDir = path.join(root, castId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
      castId,
      request: "linked context source",
      configSource: "fixture",
      entries: [],
    }, null, 2));

    const result = await loadPreviousCastContext({ fromCastId: castId, artifactRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.castId).toBe(castId);
    expect(result.value.request).toBe("linked context source");
  });

  test("validates missing previous cast ids with a helpful link error", async () => {
    const root = await tempArtifactRoot();

    const result = await loadPreviousCastContext({ fromCastId: "missing-cast", artifactRoot: root, maxArtifactBytes: 200 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("link.fromCastId");
      expect(result.issues[0]?.message).toContain("unknown previous cast id");
      expect(result.issues[0]?.message).toContain("missing-cast");
    }
  });

  test("loads bounded JSON handoff and text artifact previews without prompt injection", async () => {
    const root = await tempArtifactRoot();
    const runDir = path.join(root, "cast-1");
    await mkdir(path.join(runDir, "sockets", "Socket-1"), { recursive: true });
    await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
      castId: "cast-1",
      request: "original request",
      configSource: "fixture",
      entries: [
        { phase: "Socket-1", socket: "Socket-1", artifact: "sockets/Socket-1/1.md", kind: "socket_output", timestamp: 1 },
      ],
    }, null, 2));
    await writeFile(path.join(runDir, "sockets", "Socket-1", "1.md"), "abcdefghijklmnopqrstuvwxyz".repeat(20));
    await writeFile(path.join(runDir, "sockets", "Socket-1", "1.json"), JSON.stringify({
      workItems: [{ title: "Next", context: "Do the next thing." }],
      satisfied: true,
      context: "done",
      extra: "preserved only in artifact preview",
    }, null, 2));

    const result = await loadPreviousCastContext({ fromCastId: "cast-1", artifactRoot: root, maxArtifactBytes: 400, maxArtifacts: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.castId).toBe("cast-1");
    expect(result.value.request).toBe("original request");
    expect(result.value.handoff).toMatchObject({
      satisfied: true,
      context: "done",
      workItems: [{ title: "Next", context: "Do the next thing." }],
    });
    expect(result.value.handoff).not.toHaveProperty("summary");
    expect(result.value.handoff).not.toHaveProperty("feedback");
    expect(result.value.handoff).not.toHaveProperty("missing");
    expect(result.value.artifacts.find((artifact) => artifact.path === "sockets/Socket-1/1.md")).toMatchObject({ truncated: true, maxBytes: 400, content: "abcdefghijklmnopqrstuvwxyz".repeat(15) + "abcdefghij" });
    expect(JSON.stringify(result.value)).not.toContain("Original request:");
  });

  test("rejects cast ids that would escape the artifact root", async () => {
    const root = await tempArtifactRoot();

    const result = await loadPreviousCastContext({ fromCastId: "../outside", artifactRoot: root });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain("invalid previous cast id");
  });
});

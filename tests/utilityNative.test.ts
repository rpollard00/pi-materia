import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-utility-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function utilityConfig(node: Record<string, unknown>, extraNodes: Record<string, unknown> = {}) {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "hello", nodes: { hello: { type: "utility", ...node }, ...extraNodes } } },
    roles: {},
  };
}

describe("native utility node execution", () => {
  test("project.ensureIgnored adds configured patterns without duplicates", async () => {
    const harness = await makeHarness(utilityConfig({ utility: "project.ensureIgnored", parse: "json", params: { patterns: [".pi/pi-materia/", "dist/"] }, assign: { ignored: "$.patterns" } }));

    await harness.runCommand("materia", "cast ignore once");
    await harness.runCommand("materia", "cast ignore twice");

    const ignore = await readFile(path.join(harness.cwd, ".gitignore"), "utf8");
    expect(ignore.split("\n").filter((line) => line === ".pi/pi-materia/")).toHaveLength(1);
    expect(ignore.split("\n").filter((line) => line === "dist/")).toHaveLength(1);
    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; lastJson?: { added?: string[]; unchanged?: string[]; file?: string }; data?: Record<string, unknown>; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.lastJson?.added).toEqual([]);
    expect(state.lastJson?.unchanged).toEqual([".pi/pi-materia/", "dist/"]);
    expect(state.lastJson?.file).toBe(path.join(harness.cwd, ".gitignore"));
    expect(state.data?.ignored).toEqual([".pi/pi-materia/", "dist/"]);
    await expect(readFile(path.join(state.runDir!, "nodes", "hello", "1.json"), "utf8")).resolves.toContain('"ok": true');
  });

  test("vcs.detect returns JSON with kind, root, and tool availability", async () => {
    const harness = await makeHarness(utilityConfig({ utility: "vcs.detect", parse: "json", assign: { vcs: "$" } }));
    await mkdir(path.join(harness.cwd, ".jj"), { recursive: true });

    await harness.runCommand("materia", "cast detect vcs");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; lastJson?: { kind?: string; root?: string; available?: { jj?: unknown; git?: unknown } }; data?: { vcs?: unknown } };
    expect(state.phase).toBe("complete");
    expect(state.lastJson?.kind).toBe("jj");
    expect(state.lastJson?.root).toBe(harness.cwd);
    expect(typeof state.lastJson?.available?.jj).toBe("boolean");
    expect(typeof state.lastJson?.available?.git).toBe("boolean");
    expect(state.data?.vcs).toEqual(state.lastJson);
  });

  test("runs a single utility node to completion without an agent turn", async () => {
    const harness = await makeHarness(utilityConfig({ utility: "echo", params: { text: "HELLO WORLD" } }));

    await harness.runCommand("materia", "cast say hi");

    expect(harness.sentMessages.some(({ options }) => (options as { triggerTurn?: boolean } | undefined)?.triggerTurn)).toBe(false);
    expect(harness.statuses.get("materia")).toBe("done");
    const state = harness.appendedEntries.at(-1)?.data as { active?: boolean; phase?: string; runDir?: string; lastOutput?: string };
    expect(state.active).toBe(false);
    expect(state.phase).toBe("complete");
    expect(state.lastOutput).toBe("HELLO WORLD");

    const manifest = JSON.parse(await readFile(path.join(state.runDir!, "manifest.json"), "utf8"));
    const outputEntry = manifest.entries.find((entry: { artifact?: string }) => entry.artifact?.endsWith("1.md"));
    expect(outputEntry.artifact).toBe(path.join("nodes", "hello", "1.md"));
    await expect(readFile(path.join(state.runDir!, outputEntry.artifact), "utf8")).resolves.toBe("HELLO WORLD");
    const events = await readFile(path.join(state.runDir!, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"node_complete"');
    expect(events).toContain('"artifact":"nodes/hello/1.md"');
  });

  test("parses JSON output, assigns state, and routes edges", async () => {
    const harness = await makeHarness(utilityConfig(
      { utility: "echo", parse: "json", params: { output: { route: "done", value: 7 } }, assign: { answer: "$.value" }, edges: [{ when: "$.route == 'done'", to: "second" }] },
      { second: { type: "utility", utility: "echo", params: { text: "second" } } },
    ));

    await harness.runCommand("materia", "cast json");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; lastJson?: unknown; runDir?: string; visits?: Record<string, number> };
    expect(state.phase).toBe("complete");
    expect(state.data?.answer).toBe(7);
    expect(state.lastJson).toEqual({ route: "done", value: 7 });
    expect(state.visits?.second).toBe(1);
    const parsed = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "hello", "1.json"), "utf8"));
    expect(parsed.value).toBe(7);
    await expect(readFile(path.join(state.runDir!, "nodes", "second", "1.md"), "utf8")).resolves.toBe("second");
  });

  test("foreach utility nodes expose item and cursor metadata in input artifacts", async () => {
    const harness = await makeHarness(utilityConfig({
      utility: "echo",
      params: { text: "item" },
      foreach: { items: "state.items", as: "work", cursor: "itemCursor", done: "end" },
      advance: { cursor: "itemCursor", items: "state.items", done: "end" },
    }));
    // Seed state through a first JSON utility then loop over it.
    await mkdir(path.join(harness.cwd, ".pi"), { recursive: true });
    await writeFile(path.join(harness.cwd, ".pi", "pi-materia.json"), JSON.stringify(utilityConfig(
      { utility: "echo", parse: "json", params: { output: { items: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }] } }, assign: { items: "$.items" }, next: "loop" },
      { loop: { type: "utility", utility: "echo", params: { text: "item" }, foreach: { items: "state.items", as: "work", cursor: "itemCursor", done: "end" }, advance: { cursor: "itemCursor", items: "state.items", done: "end" }, next: "loop" } },
    ), null, 2));

    await harness.runCommand("materia", "cast loop");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; runDir?: string };
    expect(state.phase).toBe("complete");
    const firstInput = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "loop", "1-a.input.json"), "utf8"));
    expect(firstInput.item).toEqual({ id: "a", title: "Alpha" });
    expect(firstInput.itemKey).toBe("a");
    expect(firstInput.itemLabel).toBe("Alpha");
    expect(firstInput.cursor).toEqual({ name: "itemCursor", index: 0 });
    const secondInput = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "loop", "2-b.input.json"), "utf8"));
    expect(secondInput.itemKey).toBe("b");
    expect(secondInput.itemLabel).toBe("Beta");
    expect(secondInput.cursor).toEqual({ name: "itemCursor", index: 1 });
  });

  test("command utility receives JSON stdin, captures stdout result, and writes stderr artifact", async () => {
    const script = `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const i=JSON.parse(s);console.error("diagnostic stderr");process.stdout.write(JSON.stringify({cwd:i.cwd===process.cwd(),runDir:!!i.runDir,request:i.request,castId:!!i.castId,nodeId:i.nodeId,params:i.params,state:i.state,item:i.item,itemKey:i.itemKey,itemLabel:i.itemLabel}));});`;
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", script], parse: "json", params: { greeting: "hi" }, assign: { seenRequest: "$.request" } }));

    await harness.runCommand("materia", "cast command request");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; lastJson?: Record<string, unknown>; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.data?.seenRequest).toBe("command request");
    expect(state.lastJson).toMatchObject({ cwd: true, runDir: true, request: "command request", castId: true, nodeId: "hello", params: { greeting: "hi" }, state: {}, item: null, itemKey: null, itemLabel: null });
    await expect(readFile(path.join(state.runDir!, "nodes", "hello", "1.command.stderr.txt"), "utf8")).resolves.toBe("diagnostic stderr\n");
    const events = await readFile(path.join(state.runDir!, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"utility_command"');
  });

  test("command utility succeeds with text stdout", async () => {
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", "process.stdout.write('plain text result')"], parse: "text" }));

    await harness.runCommand("materia", "cast text command");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; lastOutput?: string; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.lastOutput).toBe("plain text result");
    await expect(readFile(path.join(state.runDir!, "nodes", "hello", "1.md"), "utf8")).resolves.toBe("plain text result");
  });

  test("command utility failure includes exit diagnostics and artifact paths", async () => {
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", "console.log('partial'); console.error('bad things happened'); process.exit(7)"] }));

    await harness.runCommand("materia", "cast command fail");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string; runDir?: string };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain("exited with code 7");
    expect(state.failedReason).toContain("bad things happened");
    expect(state.failedReason).toContain("nodes/hello/1.command.stdout.txt");
    await expect(readFile(path.join(state.runDir!, "nodes", "hello", "1.command.stderr.txt"), "utf8")).resolves.toBe("bad things happened\n");
  });

  test("command utility parse json fails clearly on invalid JSON", async () => {
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", "process.stdout.write('not json')"], parse: "json" }));

    await harness.runCommand("materia", "cast invalid json");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain('Invalid JSON output for node "hello"');
  });

  test("command utility timeout terminates the process and fails the cast", async () => {
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", "setTimeout(()=>{}, 5000)"], timeoutMs: 50 }));

    await harness.runCommand("materia", "cast timeout");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain("timed out");
    expect(state.failedReason).toContain("50ms");
  });

  test("command utility bounds captured stdout and records truncation", async () => {
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", "process.stdout.write('x'.repeat(1024*1024+100))"] }));

    await harness.runCommand("materia", "cast truncate");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; lastOutput?: string; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.lastOutput?.length).toBe(1024 * 1024);
    const meta = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "hello", "1.command.json"), "utf8"));
    expect(meta.stdoutTruncated).toBe(true);
    expect(meta.stderrTruncated).toBe(false);
  });

  test("utility failure marks the cast failed and stops routing", async () => {
    const harness = await makeHarness(utilityConfig(
      { utility: "missing.alias", next: "second" },
      { second: { type: "utility", utility: "echo", params: { text: "should not run" } } },
    ));

    await harness.runCommand("materia", "cast fail");

    expect(harness.statuses.get("materia")).toBe("failed");
    const state = harness.appendedEntries.at(-1)?.data as { active?: boolean; phase?: string; failedReason?: string; visits?: Record<string, number> };
    expect(state.active).toBe(false);
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain('Unknown utility alias "missing.alias"');
    expect(state.visits?.second).toBeUndefined();
  });
});

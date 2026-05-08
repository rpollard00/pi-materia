import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { stringifyDeterministicHandoffOutput } from "../src/handoffContract.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-utility-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

const socketAliases: Record<string, string> = { second: "Socket-2", retry: "Socket-2", loop: "Socket-2", seed: "Socket-1", Build: "Socket-1", "Auto-Eval": "Socket-2", Maintain: "Socket-3" };

function canonicalizeFixtureSockets<T>(value: T, parentKey = ""): T {
  if (typeof value === "string") return (["to", "next", "from", "done"].includes(parentKey) ? (socketAliases[value] ?? value) : value) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalizeFixtureSockets(item, parentKey)) as T;
  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) mapped[socketAliases[key] ?? key] = canonicalizeFixtureSockets(child, key);
  return mapped as T;
}

function utilityConfig(node: Record<string, unknown>, extraNodes: Record<string, unknown> = {}) {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "Socket-1", nodes: { "Socket-1": canonicalizeFixtureSockets({ type: "utility", ...node }), ...canonicalizeFixtureSockets(extraNodes) } } },
    materia: {},
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
    await expect(readFile(path.join(state.runDir!, "nodes", "Socket-1", "1.json"), "utf8")).resolves.toContain('"ok": true');
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
    expect(outputEntry.artifact).toBe(path.join("nodes", "Socket-1", "1.md"));
    await expect(readFile(path.join(state.runDir!, outputEntry.artifact), "utf8")).resolves.toBe("HELLO WORLD");
    const events = await readFile(path.join(state.runDir!, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"node_complete"');
    expect(events).toContain('"artifact":"nodes/Socket-1/1.md"');
  });

  test("config-driven JSON params.output uses the shared deterministic handoff serializer", async () => {
    const output = { satisfied: true, feedback: "ok", value: 7 };
    const harness = await makeHarness(utilityConfig({ utility: "echo", parse: "json", params: { output }, assign: { answer: "$.value" } }));

    await harness.runCommand("materia", "cast shared serializer");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; lastJson?: unknown; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.data?.answer).toBe(7);
    expect(state.lastJson).toEqual(JSON.parse(stringifyDeterministicHandoffOutput(output)));
    await expect(readFile(path.join(state.runDir!, "nodes", "Socket-1", "1.md"), "utf8")).resolves.toBe(stringifyDeterministicHandoffOutput(output));

    const nativeSource = await readFile(path.resolve("src", "native.ts"), "utf8");
    expect(nativeSource).toContain("stringifyDeterministicHandoffOutput(value)");
    expect(nativeSource).not.toContain("JSON.stringify(value)");
  });

  test("parses JSON output, assigns state, and routes edges", async () => {
    const harness = await makeHarness(utilityConfig(
      { utility: "echo", parse: "json", params: { output: { satisfied: true, value: 7 } }, assign: { answer: "$.value" }, edges: [{ when: "satisfied", to: "second" }] },
      { second: { type: "utility", utility: "echo", params: { text: "second" } } },
    ));

    await harness.runCommand("materia", "cast json");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; lastJson?: unknown; runDir?: string; visits?: Record<string, number> };
    expect(state.phase).toBe("complete");
    expect(state.data?.answer).toBe(7);
    expect(state.lastJson).toEqual({ satisfied: true, value: 7 });
    expect(state.visits?.["Socket-2"]).toBe(1);
    const parsed = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "Socket-1", "1.json"), "utf8"));
    expect(parsed.value).toBe(7);
    await expect(readFile(path.join(state.runDir!, "nodes", "Socket-2", "1.md"), "utf8")).resolves.toBe("second");
  });

  test("canonical not_satisfied routes only when satisfied is false", async () => {
    const harness = await makeHarness(utilityConfig(
      { utility: "echo", parse: "json", params: { output: { satisfied: false, feedback: "retry" } }, edges: [{ when: "not_satisfied", to: "retry" }] },
      { retry: { type: "utility", utility: "echo", params: { text: "retry" } } },
    ));

    await harness.runCommand("materia", "cast canonical retry");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; visits?: Record<string, number>; lastJson?: unknown };
    expect(state.phase).toBe("complete");
    expect(state.lastJson).toEqual({ satisfied: false, feedback: "retry" });
    expect(state.visits?.["Socket-2"]).toBe(1);
  });

  test("satisfied edge conditions reject legacy passed JSON without canonical satisfied", async () => {
    const harness = await makeHarness(utilityConfig(
      { utility: "echo", parse: "json", params: { output: { passed: true, feedback: "ok" } }, edges: [{ when: "satisfied", to: "second" }] },
      { second: { type: "utility", utility: "echo", params: { text: "second" } } },
    ));

    await harness.runCommand("materia", "cast legacy eval");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string; visits?: Record<string, number> };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain('must include reserved boolean field "satisfied"');
    expect(state.failedReason).toContain('Legacy field "passed" is not canonical');
    expect(state.visits?.["Socket-2"]).toBeUndefined();
  });

  test("parse json utility rejects non-object handoff output", async () => {
    const harness = await makeHarness(utilityConfig({ utility: "echo", parse: "json", params: { output: ["not", "an", "object"] } }));

    await harness.runCommand("materia", "cast array json");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain('Invalid handoff JSON output for node "Socket-1"');
    expect(state.failedReason).toContain("expected a JSON object at the top level");
  });

  test("parse json utility rejects wrong satisfied field type", async () => {
    const harness = await makeHarness(utilityConfig({ utility: "echo", parse: "json", params: { output: { satisfied: "true" } }, edges: [{ when: "satisfied", to: "second" }] }, { second: { type: "utility", utility: "echo", params: { text: "second" } } }));

    await harness.runCommand("materia", "cast bad satisfied");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string; visits?: Record<string, number> };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain('reserved control field "satisfied" must be a boolean');
    expect(state.visits?.["Socket-2"]).toBeUndefined();
  });

  test("runtime traverses iterative Build/Eval/Maintain retry loops as ordered guarded transitions", async () => {
    const evalScript = `
      let input = "";
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const state = JSON.parse(input).state ?? {};
        const cycle = Number(state.evalCycle ?? 0) + 1;
        process.stdout.write(JSON.stringify({ cycle, satisfied: cycle === 2 }));
      });
    `;
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Loop",
      loadouts: {
        Loop: {
          entry: "Socket-1",
          nodes: {
            "Socket-1": { type: "utility", utility: "echo", params: { text: "build" }, next: "Socket-2", limits: { maxVisits: 5 } },
            "Socket-2": {
              type: "utility",
              command: ["node", "-e", evalScript],
              parse: "json",
              assign: { evalCycle: "$.cycle" },
              edges: [
                { when: "satisfied", to: "Socket-3" },
                { when: "not_satisfied", to: "Socket-1", maxTraversals: 3 },
              ],
              limits: { maxVisits: 5 },
            },
            "Socket-3": { type: "utility", utility: "echo", params: { text: "maintain" }, next: "end", limits: { maxVisits: 3 } },
          },
        },
      },
      materia: {},
    });

    await harness.runCommand("materia", "cast iterative workflow");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; visits?: Record<string, number>; edgeTraversals?: Record<string, number>; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.data?.evalCycle).toBe(2);
    expect(state.visits).toMatchObject({ "Socket-1": 2, "Socket-2": 2, "Socket-3": 1 });
    expect(state.edgeTraversals).toMatchObject({ "Socket-2->Socket-1": 1, "Socket-2->Socket-3": 1 });
    await expect(readFile(path.join(state.runDir!, "nodes", "Socket-3", "1.md"), "utf8")).resolves.toBe("maintain");
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
    const firstInput = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "Socket-2", "1-a.input.json"), "utf8"));
    expect(firstInput.item).toEqual({ id: "a", title: "Alpha" });
    expect(firstInput.itemKey).toBe("a");
    expect(firstInput.itemLabel).toBe("Alpha");
    expect(firstInput.cursor).toEqual({ name: "itemCursor", index: 0 });
    const secondInput = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "Socket-2", "2-b.input.json"), "utf8"));
    expect(secondInput.itemKey).toBe("b");
    expect(secondInput.itemLabel).toBe("Beta");
    expect(secondInput.cursor).toEqual({ name: "itemCursor", index: 1 });
  });

  test("explicit loop iterator metadata drives runtime item selection for member nodes", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          nodes: {
            "Socket-1": { type: "utility", utility: "echo", parse: "json", params: { output: { items: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }] } }, assign: { items: "$.items" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { type: "utility", utility: "echo", params: { text: "loop item" }, advance: { cursor: "itemCursor", items: "state.items", done: "end" }, edges: [{ when: "always", to: "Socket-2" }] },
          },
          loops: {
            taskIteration: {
              label: "Runtime item loop",
              nodes: ["Socket-2"],
              iterator: { items: "state.items", as: "work", cursor: "itemCursor", done: "end" },
              exit: { from: "Socket-2", when: "satisfied", to: "end" },
            },
          },
        },
      },
      materia: {},
    });

    await harness.runCommand("materia", "cast explicit loop");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; runDir?: string; visits?: Record<string, number>; cursors?: Record<string, number> };
    expect(state.phase).toBe("complete");
    expect(state.visits?.["Socket-2"]).toBe(2);
    expect(state.cursors?.itemCursor).toBe(2);
    const firstInput = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "Socket-2", "1-a.input.json"), "utf8"));
    expect(firstInput.item).toEqual({ id: "a", title: "Alpha" });
    expect(firstInput.state.work).toEqual({ id: "a", title: "Alpha" });
    expect(firstInput.cursor).toEqual({ name: "itemCursor", index: 0 });
    const secondInput = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "Socket-2", "2-b.input.json"), "utf8"));
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
    expect(state.lastJson).toMatchObject({ cwd: true, runDir: true, request: "command request", castId: true, nodeId: "Socket-1", params: { greeting: "hi" }, state: {}, item: null, itemKey: null, itemLabel: null });
    await expect(readFile(path.join(state.runDir!, "nodes", "Socket-1", "1.command.stderr.txt"), "utf8")).resolves.toBe("diagnostic stderr\n");
    const events = await readFile(path.join(state.runDir!, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"utility_command"');
  });

  test("command utility succeeds with text stdout", async () => {
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", "process.stdout.write('plain text result')"], parse: "text" }));

    await harness.runCommand("materia", "cast text command");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; lastOutput?: string; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.lastOutput).toBe("plain text result");
    await expect(readFile(path.join(state.runDir!, "nodes", "Socket-1", "1.md"), "utf8")).resolves.toBe("plain text result");
  });

  test("command utility failure includes exit diagnostics and artifact paths", async () => {
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", "console.log('partial'); console.error('bad things happened'); process.exit(7)"] }));

    await harness.runCommand("materia", "cast command fail");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string; runDir?: string };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain("exited with code 7");
    expect(state.failedReason).toContain("bad things happened");
    expect(state.failedReason).toContain("nodes/Socket-1/1.command.stdout.txt");
    await expect(readFile(path.join(state.runDir!, "nodes", "Socket-1", "1.command.stderr.txt"), "utf8")).resolves.toBe("bad things happened\n");
  });

  test("command utility parse json fails clearly on invalid JSON", async () => {
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", "process.stdout.write('not json')"], parse: "json" }));

    await harness.runCommand("materia", "cast invalid json");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain('Invalid JSON output for node "Socket-1"');
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
    const meta = JSON.parse(await readFile(path.join(state.runDir!, "nodes", "Socket-1", "1.command.json"), "utf8"));
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
    expect(state.visits?.["Socket-2"]).toBeUndefined();
  });
});

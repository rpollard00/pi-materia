import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import {
  HANDOFF_RESERVED_EVALUATOR_FIELDS,
  HANDOFF_SATISFIED_FIELD,
  HANDOFF_WORK_ITEMS_FIELD,
  createHandoffEnvelope,
  stringifyDeterministicHandoffOutput,
} from "../src/handoff/handoffContract.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-utility-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(currentUtilityFixtureConfig(config), null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

const socketAliases: Record<string, string> = { second: "Socket-2", retry: "Socket-2", loop: "Socket-2", seed: "Socket-1", Build: "Socket-1", "Auto-Eval": "Socket-2", Maintain: "Socket-3" };

function currentUtilityFixtureConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const copy = structuredClone(config) as Record<string, any>;
  copy.materia = copy.materia ?? {};
  for (const loadout of Object.values(copy.loadouts ?? {}) as any[]) {
    for (const [socketId, socket] of Object.entries(loadout?.sockets ?? {}) as Array<[string, any]>) {
      if (!socket || typeof socket !== "object" || socket.materia || (!socket.utility && !socket.command && !socket.script)) continue;
      const materiaId = `Utility-${socketId}`;
      const { utility, command, script, parse, params, assign, timeoutMs, ...placement } = socket;
      copy.materia[materiaId] = { type: "utility", ...(utility !== undefined ? { utility } : {}), ...(command !== undefined ? { command } : {}), ...(script !== undefined ? { script } : {}), ...(parse !== undefined ? { parse } : {}), ...(params !== undefined ? { params } : {}), ...(assign !== undefined ? { assign } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
      loadout.sockets[socketId] = { ...placement, materia: materiaId };
    }
  }
  return copy;
}

function canonicalizeFixtureSockets<T>(value: T, parentKey = ""): T {
  if (typeof value === "string") return (["to", "next", "from", "done"].includes(parentKey) ? (socketAliases[value] ?? value) : value) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalizeFixtureSockets(item, parentKey)) as T;
  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) mapped[socketAliases[key] ?? key] = canonicalizeFixtureSockets(child, key);
  return mapped as T;
}

function utilityConfig(socket: Record<string, unknown>, extraSockets: Record<string, unknown> = {}) {
  const materia: Record<string, unknown> = {};
  const sockets: Record<string, unknown> = {};
  const toSocket = (id: string, input: Record<string, unknown>) => {
    const utilityMateriaId = `Utility-${id.replace(/[^A-Za-z0-9]/g, "-")}`;
    const { utility, command, script, parse, params, assign, timeoutMs, ...placement } = canonicalizeFixtureSockets(input) as Record<string, unknown>;
    materia[utilityMateriaId] = { type: "utility", ...(utility !== undefined ? { utility } : {}), ...(command !== undefined ? { command } : {}), ...(script !== undefined ? { script } : {}), ...(parse !== undefined ? { parse } : {}), ...(params !== undefined ? { params } : {}), ...(assign !== undefined ? { assign } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
    sockets[id] = { ...placement, materia: utilityMateriaId };
  };
  toSocket("Socket-1", socket);
  for (const [key, value] of Object.entries(extraSockets)) toSocket(socketAliases[key] ?? key, value as Record<string, unknown>);
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "Socket-1", sockets } },
    materia,
  };
}

describe("native utility socket execution", () => {
  test("canonical shipped utility materia executes through profile-resolved script copies", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pi-materia-utility-profile-"));
    const previous = process.env.PI_MATERIA_PROFILE_DIR;
    const profileDir = path.join(temp, "profile");
    process.env.PI_MATERIA_PROFILE_DIR = profileDir;
    try {
      const harness = await makeHarness({
        artifactDir: ".pi/pi-materia",
        activeLoadout: "Test",
        loadouts: {
          Test: {
            entry: "Socket-1",
            sockets: { "Socket-1": { materia: "Ignore-Artifacts", edges: [{ when: 'always', to: 'end' }] } },
          },
        },
        materia: {
          "Ignore-Artifacts": {
            type: "utility",
            script: { kind: "shippedUtility", name: "ensure-ignored.mjs", runtime: "node" },
            params: { patterns: [".pi/pi-materia/"] },
            parse: "json",
            assign: { artifactIgnore: "$" },
          },
        },
      });

      await harness.runCommand("materia", "cast canonical shipped utility");

      const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: { artifactIgnore?: { ok?: boolean; file?: string } } };
      expect(state.phase).toBe("complete");
      expect(state.data?.artifactIgnore?.ok).toBe(true);
      expect(state.data?.artifactIgnore?.file).toBe(path.join(harness.cwd, ".gitignore"));
      await expect(readFile(path.join(profileDir, "utilities", "ensure-ignored.mjs"), "utf8")).resolves.toContain("JSON.parse");
      await expect(readFile(path.join(profileDir, "utilities", ".pi-materia-shipped-utilities.json"), "utf8")).resolves.toContain("ensure-ignored.mjs");
    } finally {
      if (previous === undefined) delete process.env.PI_MATERIA_PROFILE_DIR;
      else process.env.PI_MATERIA_PROFILE_DIR = previous;
    }
  });

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
    await expect(readFile(path.join(state.runDir!, "sockets", "Socket-1", "1.json"), "utf8")).resolves.toContain('"ok": true');
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

  test("runs a single utility socket to completion without an agent turn", async () => {
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
    expect(outputEntry.artifact).toBe(path.join("sockets", "Socket-1", "1.md"));
    await expect(readFile(path.join(state.runDir!, outputEntry.artifact), "utf8")).resolves.toBe("HELLO WORLD");
    const events = await readFile(path.join(state.runDir!, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"socket_complete"');
    expect(events).toContain('"artifact":"sockets/Socket-1/1.md"');
  });

  test("config-driven JSON params.output uses the shared deterministic handoff serializer", async () => {
    const output = { satisfied: true, feedback: "ok", value: 7 };
    const harness = await makeHarness(utilityConfig({ utility: "echo", parse: "json", params: { output }, assign: { answer: "$.value" } }));

    await harness.runCommand("materia", "cast shared serializer");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; lastJson?: unknown; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.data?.answer).toBe(7);
    expect(state.lastJson).toEqual(JSON.parse(stringifyDeterministicHandoffOutput(output)));
    await expect(readFile(path.join(state.runDir!, "sockets", "Socket-1", "1.md"), "utf8")).resolves.toBe(stringifyDeterministicHandoffOutput(output));

    const utilityExecutionSource = await readFile(path.resolve("src", "application", "utilityExecution.ts"), "utf8");
    expect(utilityExecutionSource).toContain("stringifyDeterministicHandoffOutput(value)");
    expect(utilityExecutionSource).not.toContain("JSON.stringify(value)");
  });

  test("deterministic utility handoff JSON preserves workItems and reserved evaluator fields", async () => {
    const output = createHandoffEnvelope({
      summary: "planned",
      workItems: [{ id: "one", title: "One", description: "Do one", acceptance: ["done"], context: { architecture: "shared contract", constraints: [], dependencies: [], risks: [] } }],
      satisfied: false,
      feedback: "needs build",
      missing: ["implementation"],
    });
    const harness = await makeHarness(utilityConfig({ utility: "echo", parse: "json", params: { output }, assign: { workItems: "$.workItems", feedback: "$.feedback" } }));

    await harness.runCommand("materia", "cast deterministic envelope");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; lastJson?: Record<string, unknown>; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.lastJson?.[HANDOFF_WORK_ITEMS_FIELD]).toEqual(output.workItems);
    expect(state.lastJson?.[HANDOFF_SATISFIED_FIELD]).toBe(false);
    for (const field of HANDOFF_RESERVED_EVALUATOR_FIELDS) expect(state.lastJson).toHaveProperty(field);
    expect(state.lastJson).not.toHaveProperty("tasks");
    expect(state.data?.workItems).toEqual(output.workItems);
    expect(state.data?.feedback).toBe("needs build");
    await expect(readFile(path.join(state.runDir!, "sockets", "Socket-1", "1.md"), "utf8")).resolves.toBe(stringifyDeterministicHandoffOutput(output));
  });

  test("parses JSON output, assigns state, and routes edges", async () => {
    const harness = await makeHarness(utilityConfig(
      { utility: "echo", parse: "json", params: { output: { satisfied: true, value: 7 } }, assign: { answer: "$.value" }, edges: [{ when: "satisfied", to: "second" }] },
      { second: { utility: "echo", params: { text: "second" } } },
    ));

    await harness.runCommand("materia", "cast json");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; lastJson?: unknown; runDir?: string; visits?: Record<string, number> };
    expect(state.phase).toBe("complete");
    expect(state.data?.answer).toBe(7);
    expect(state.lastJson).toEqual({ satisfied: true, value: 7 });
    expect(state.visits?.["Socket-2"]).toBe(1);
    const parsed = JSON.parse(await readFile(path.join(state.runDir!, "sockets", "Socket-1", "1.json"), "utf8"));
    expect(parsed.value).toBe(7);
    await expect(readFile(path.join(state.runDir!, "sockets", "Socket-2", "1.md"), "utf8")).resolves.toBe("second");
  });

  test("canonical not_satisfied routes only when satisfied is false", async () => {
    const harness = await makeHarness(utilityConfig(
      { utility: "echo", parse: "json", params: { output: { satisfied: false, feedback: "retry" } }, edges: [{ when: "not_satisfied", to: "retry" }] },
      { retry: { utility: "echo", params: { text: "retry" } } },
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
      { second: { utility: "echo", params: { text: "second" } } },
    ));

    await harness.runCommand("materia", "cast legacy eval");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string; visits?: Record<string, number> };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain('Missing required reserved field "satisfied" at $.satisfied');
    expect(state.failedReason).toContain('Legacy field "passed" is not canonical');
    expect(state.visits?.["Socket-2"]).toBeUndefined();
  });

  test("parse json utility rejects non-object handoff output", async () => {
    const harness = await makeHarness(utilityConfig({ utility: "echo", parse: "json", params: { output: ["not", "an", "object"] } }));

    await harness.runCommand("materia", "cast array json");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain('Invalid handoff JSON output for socket "Socket-1"');
    expect(state.failedReason).toContain("expected a JSON object at the top level");
  });

  test("parse json utility rejects wrong satisfied field type", async () => {
    const harness = await makeHarness(utilityConfig({ utility: "echo", parse: "json", params: { output: { satisfied: "true" } }, edges: [{ when: "satisfied", to: "second" }] }, { second: { utility: "echo", params: { text: "second" } } }));

    await harness.runCommand("materia", "cast bad satisfied");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string; visits?: Record<string, number> };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain('Reserved field "satisfied" at $.satisfied must be a boolean');
    expect(state.visits?.["Socket-2"]).toBeUndefined();
  });

  test("Hojo-like Auto-Eval retry loop requires parse json; JSON-shaped text alone stops after evaluator", async () => {
    const evalScript = `
      let input = "";
      process.stdin.on("data", (chunk) => input += chunk);
      process.stdin.on("end", () => {
        const ctx = JSON.parse(input);
        const key = ctx.itemKey ?? "singleton";
        const previous = ctx.state.evalAttempts ?? {};
        const attempt = Number(previous[key] ?? 0) + 1;
        const evalAttempts = { ...previous, [key]: attempt };
        process.stdout.write(JSON.stringify({ satisfied: attempt >= 2, feedback: attempt >= 2 ? "ok" : "retry", evalAttempts }));
      });
    `;
    const hojoLikeConfig = (autoEvalParse?: "json") => ({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Hojo-like",
      loadouts: {
        "Hojo-like": {
          entry: "Socket-1",
          sockets: {
            "Socket-1": {
              utility: "echo",
              parse: "json",
              params: { output: { workItems: [{ id: "alpha", title: "Alpha" }] } },
              assign: { workItems: "$.workItems" },
              edges: [{ when: "always", to: "Socket-2" }],
            },
            "Socket-2": { utility: "echo", params: { text: "build" }, edges: [{ when: "always", to: "Socket-3" }], limits: { maxVisits: 5 } },
            "Socket-3": {
              command: ["node", "-e", evalScript],
              // This reproduces the UI-saved Hojo-Consult failure: Socket-3/Auto-Eval
              // emitted a JSON-shaped string with canonical `satisfied`, but without
              // parse:"json" the runtime treats it as text and satisfied/not_satisfied
              // edges cannot inspect the control field.
              ...(autoEvalParse ? { parse: autoEvalParse } : {}),
              assign: { evalAttempts: "$.evalAttempts" },
              edges: [
                { when: "satisfied", to: "Socket-4" },
                { when: "not_satisfied", to: "Socket-2", maxTraversals: 3 },
              ],
              limits: { maxVisits: 5 },
            },
            "Socket-4": {
              utility: "echo",
              parse: "json",
              params: { output: { satisfied: true, commitMessage: "maintain" } },
              advance: { cursor: "workItemIndex", items: "state.workItems", done: "end", when: "satisfied" },
              edges: [{ when: "always", to: "Socket-2" }],
            },
          },
          loops: {
            loopSelection: {
              sockets: ["Socket-2", "Socket-3", "Socket-4"],
              iterator: { items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" },
              exit: { from: "Socket-4", when: "satisfied", to: "end" },
            },
          },
        },
      },
      materia: {},
    });

    const missingParseHarness = await makeHarness(hojoLikeConfig());
    await missingParseHarness.runCommand("materia", "cast hojo missing parse");
    const missingParseState = missingParseHarness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; visits?: Record<string, number>; edgeTraversals?: Record<string, number> };
    expect(missingParseState.phase).toBe("complete");
    expect(missingParseState.data?.evalAttempts).toBeUndefined();
    expect(missingParseState.visits).toMatchObject({ "Socket-2": 1, "Socket-3": 1 });
    expect(missingParseState.visits?.["Socket-4"]).toBeUndefined();
    expect(missingParseState.edgeTraversals?.["Socket-3->Socket-2"]).toBeUndefined();
    expect(missingParseState.edgeTraversals?.["Socket-3->Socket-4"]).toBeUndefined();

    const jsonParseHarness = await makeHarness(hojoLikeConfig("json"));
    await jsonParseHarness.runCommand("materia", "cast hojo parse json");
    const jsonParseState = jsonParseHarness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; visits?: Record<string, number>; edgeTraversals?: Record<string, number>; cursors?: Record<string, number> };
    expect(jsonParseState.phase).toBe("complete");
    expect(jsonParseState.data?.evalAttempts).toEqual({ alpha: 2 });
    expect(jsonParseState.visits).toMatchObject({ "Socket-2": 2, "Socket-3": 2, "Socket-4": 1 });
    expect(jsonParseState.edgeTraversals).toMatchObject({ "Socket-3->Socket-2": 1, "Socket-3->Socket-4": 1 });
    expect(jsonParseState.cursors?.workItemIndex).toBe(1);
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
          sockets: {
            "Socket-1": { utility: "echo", params: { text: "build" }, edges: [{ when: 'always', to: 'Socket-2' }], limits: { maxVisits: 5 } },
            "Socket-2": {
              command: ["node", "-e", evalScript],
              parse: "json",
              assign: { evalCycle: "$.cycle" },
              edges: [
                { when: "satisfied", to: "Socket-3" },
                { when: "not_satisfied", to: "Socket-1", maxTraversals: 3 },
              ],
              limits: { maxVisits: 5 },
            },
            "Socket-3": { utility: "echo", params: { text: "maintain" }, edges: [{ when: 'always', to: 'end' }], limits: { maxVisits: 3 } },
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
    await expect(readFile(path.join(state.runDir!, "sockets", "Socket-3", "1.md"), "utf8")).resolves.toBe("maintain");
  });

  test("foreach utility sockets expose item and cursor metadata in input artifacts", async () => {
    const harness = await makeHarness(utilityConfig({
      utility: "echo",
      params: { text: "item" },
      foreach: { items: "state.items", as: "work", cursor: "itemCursor", done: "end" },
      advance: { cursor: "itemCursor", items: "state.items", done: "end" },
    }));
    // Seed state through a first JSON utility then loop over it.
    await mkdir(path.join(harness.cwd, ".pi"), { recursive: true });
    await writeFile(path.join(harness.cwd, ".pi", "pi-materia.json"), JSON.stringify(utilityConfig(
      { utility: "echo", parse: "json", params: { output: { items: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }] } }, assign: { items: "$.items" }, edges: [{ when: "always", to: "loop" }] },
      { loop: { utility: "echo", params: { text: "item" }, foreach: { items: "state.items", as: "work", cursor: "itemCursor", done: "end" }, advance: { cursor: "itemCursor", items: "state.items", done: "end" }, edges: [{ when: "always", to: "loop" }] } },
    ), null, 2));

    await harness.runCommand("materia", "cast loop");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; runDir?: string };
    expect(state.phase).toBe("complete");
    const firstInput = JSON.parse(await readFile(path.join(state.runDir!, "sockets", "Socket-2", "1-a.input.json"), "utf8"));
    expect(firstInput.item).toEqual({ id: "a", title: "Alpha" });
    expect(firstInput.itemKey).toBe("a");
    expect(firstInput.itemLabel).toBe("Alpha");
    expect(firstInput.cursor).toEqual({ name: "itemCursor", index: 0 });
    const secondInput = JSON.parse(await readFile(path.join(state.runDir!, "sockets", "Socket-2", "2-b.input.json"), "utf8"));
    expect(secondInput.itemKey).toBe("b");
    expect(secondInput.itemLabel).toBe("Beta");
    expect(secondInput.cursor).toEqual({ name: "itemCursor", index: 1 });
  });

  test("explicit loop iterator metadata drives runtime item selection for member sockets", async () => {
    const harness = await makeHarness({
      artifactDir: ".pi/pi-materia",
      activeLoadout: "Test",
      loadouts: {
        Test: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { utility: "echo", parse: "json", params: { output: { items: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }] } }, assign: { items: "$.items" }, edges: [{ when: "always", to: "Socket-2" }] },
            "Socket-2": { utility: "echo", params: { text: "loop item" }, advance: { cursor: "itemCursor", items: "state.items", done: "end" }, edges: [{ when: "always", to: "Socket-2" }] },
          },
          loops: {
            taskIteration: {
              sockets: ["Socket-2"],
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
    const firstInput = JSON.parse(await readFile(path.join(state.runDir!, "sockets", "Socket-2", "1-a.input.json"), "utf8"));
    expect(firstInput.item).toEqual({ id: "a", title: "Alpha" });
    expect(firstInput.state.work).toEqual({ id: "a", title: "Alpha" });
    expect(firstInput.cursor).toEqual({ name: "itemCursor", index: 0 });
    const secondInput = JSON.parse(await readFile(path.join(state.runDir!, "sockets", "Socket-2", "2-b.input.json"), "utf8"));
    expect(secondInput.itemKey).toBe("b");
    expect(secondInput.itemLabel).toBe("Beta");
    expect(secondInput.cursor).toEqual({ name: "itemCursor", index: 1 });
  });

  test("command utility receives JSON stdin, captures stdout result, and writes stderr artifact", async () => {
    const script = `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const i=JSON.parse(s);console.error("diagnostic stderr");process.stdout.write(JSON.stringify({cwd:i.cwd===process.cwd(),runDir:!!i.runDir,request:i.request,castId:!!i.castId,socketId:i.socketId,params:i.params,state:i.state,item:i.item,itemKey:i.itemKey,itemLabel:i.itemLabel}));});`;
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", script], parse: "json", params: { greeting: "hi" }, assign: { seenRequest: "$.request" } }));

    await harness.runCommand("materia", "cast command request");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; data?: Record<string, unknown>; lastJson?: Record<string, unknown>; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.data?.seenRequest).toBe("command request");
    expect(state.lastJson).toMatchObject({ cwd: true, runDir: true, request: "command request", castId: true, socketId: "Socket-1", params: { greeting: "hi" }, state: {}, item: null, itemKey: null, itemLabel: null });
    await expect(readFile(path.join(state.runDir!, "sockets", "Socket-1", "1.command.stderr.txt"), "utf8")).resolves.toBe("diagnostic stderr\n");
    const events = await readFile(path.join(state.runDir!, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"utility_command"');
  });

  test("command utility succeeds with text stdout", async () => {
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", "process.stdout.write('plain text result')"], parse: "text" }));

    await harness.runCommand("materia", "cast text command");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; lastOutput?: string; runDir?: string };
    expect(state.phase).toBe("complete");
    expect(state.lastOutput).toBe("plain text result");
    await expect(readFile(path.join(state.runDir!, "sockets", "Socket-1", "1.md"), "utf8")).resolves.toBe("plain text result");
  });

  test("command utility failure includes exit diagnostics and artifact paths", async () => {
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", "console.log('partial'); console.error('bad things happened'); process.exit(7)"] }));

    await harness.runCommand("materia", "cast command fail");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string; runDir?: string };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain("exited with code 7");
    expect(state.failedReason).toContain("bad things happened");
    expect(state.failedReason).toContain("sockets/Socket-1/1.command.stdout.txt");
    await expect(readFile(path.join(state.runDir!, "sockets", "Socket-1", "1.command.stderr.txt"), "utf8")).resolves.toBe("bad things happened\n");
  });

  test("command utility parse json fails clearly on invalid JSON", async () => {
    const harness = await makeHarness(utilityConfig({ command: ["node", "-e", "process.stdout.write('not json')"], parse: "json" }));

    await harness.runCommand("materia", "cast invalid json");

    const state = harness.appendedEntries.at(-1)?.data as { phase?: string; failedReason?: string };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain('Invalid JSON output for socket "Socket-1"');
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
    const meta = JSON.parse(await readFile(path.join(state.runDir!, "sockets", "Socket-1", "1.command.json"), "utf8"));
    expect(meta.stdoutTruncated).toBe(true);
    expect(meta.stderrTruncated).toBe(false);
  });

  test("utility failure marks the cast failed and stops routing", async () => {
    const harness = await makeHarness(utilityConfig(
      { utility: "missing.alias", edges: [{ when: "always", to: "second" }] },
      { second: { utility: "echo", params: { text: "should not run" } } },
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

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { FakePiHarness } from "./fakePi.js";

const autoEvalScript = `
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    const context = JSON.parse(input);
    const attempt = Number(context.state.evalAttempts ?? 0) + 1;
    const failuresBeforeSuccess = Number(context.params.failuresBeforeSuccess ?? 0);
    process.stdout.write(JSON.stringify({
      satisfied: attempt > failuresBeforeSuccess,
      context: attempt > failuresBeforeSuccess ? "evaluation passed" : "rework requested",
      evalAttempts: attempt,
    }));
  });
`;

interface LoopSafetyFixtureOptions {
  failuresBeforeEvalSuccess?: number;
  maintainOutput: Record<string, unknown>;
  maxNoAdvanceCycles?: number;
}

function buildEvalMaintainFixture(options: LoopSafetyFixtureOptions): unknown {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Build-Eval-Maintain",
    limits: {
      maxNoAdvanceCycles: options.maxNoAdvanceCycles ?? 3,
      maxEdgeTraversals: 20,
      maxSocketVisits: 20,
    },
    loadouts: {
      "Build-Eval-Maintain": {
        entry: "Socket-1",
        sockets: {
          "Socket-1": {
            materia: "Seed-Work",
            edges: [{ when: "always", to: "Socket-2" }],
          },
          "Socket-2": {
            materia: "Synthetic-Builda",
            edges: [{ when: "always", to: "Socket-3" }],
          },
          "Socket-3": {
            materia: "Synthetic-Auto-Evala",
            edges: [
              { when: "satisfied", to: "Socket-4" },
              { when: "not_satisfied", to: "Socket-2" },
            ],
          },
          "Socket-4": {
            materia: "Synthetic-Mime-Maintain",
            advance: {
              cursor: "workItemIndex",
              items: "state.workItems",
              when: "satisfied",
              done: "end",
            },
            edges: [{ when: "not_satisfied", to: "Socket-2" }],
          },
        },
        loops: {
          workItems: {
            sockets: ["Socket-2", "Socket-3", "Socket-4"],
            iterator: {
              items: "state.workItems",
              as: "workItem",
              cursor: "workItemIndex",
              done: "end",
            },
            exit: { from: "Socket-4", when: "satisfied", to: "end" },
          },
        },
      },
    },
    materia: {
      "Seed-Work": {
        type: "utility",
        utility: "echo",
        parse: "json",
        params: {
          output: {
            workItems: [{ title: "Synthetic work item" }],
          },
        },
        assign: { workItems: "$.workItems" },
      },
      "Synthetic-Builda": {
        type: "utility",
        utility: "echo",
        params: { text: "build complete" },
      },
      "Synthetic-Auto-Evala": {
        type: "utility",
        command: ["node", "-e", autoEvalScript],
        parse: "json",
        params: { failuresBeforeSuccess: options.failuresBeforeEvalSuccess ?? 0 },
        assign: { evalAttempts: "$.evalAttempts" },
      },
      "Synthetic-Mime-Maintain": {
        type: "utility",
        utility: "echo",
        parse: "json",
        params: { output: options.maintainOutput },
      },
    },
  };
}

async function makeHarness(options: LoopSafetyFixtureOptions): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-loop-safety-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi", "pi-materia.json"),
    JSON.stringify(buildEvalMaintainFixture(options), null, 2),
  );
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

describe("runtime Builda -> Auto-Evala -> Mime-Maintain loop safety", () => {
  test("fails on a structured utility infrastructure result without traversing the rework edge", async () => {
    const message = "Synthetic maintain dependency unavailable.";
    const maintainOutput = {
      satisfied: false,
      context: message,
      state: { syntheticMaintain: { ok: false, error: message } },
    };
    const harness = await makeHarness({ maintainOutput });

    await harness.runCommand("materia", "cast utility infrastructure failure loop");

    const state = harness.appendedEntries.at(-1)?.data as {
      phase?: string;
      failedReason?: string;
      lastJson?: unknown;
      data?: Record<string, unknown>;
      cursors?: Record<string, number>;
      visits?: Record<string, number>;
      edgeTraversals?: Record<string, number>;
    };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toBe(message);
    expect(state.lastJson).toEqual(maintainOutput);
    expect(state.data?.syntheticMaintain).toEqual({ ok: false, error: message });
    expect(state.cursors?.workItemIndex).toBe(0);
    expect(state.visits).toMatchObject({ "Socket-2": 1, "Socket-3": 1, "Socket-4": 1 });
    expect(state.edgeTraversals?.["Socket-4->Socket-2"]).toBeUndefined();
  });

  test("routes a legitimate not-satisfied evaluation through rework and then advances", async () => {
    const harness = await makeHarness({
      failuresBeforeEvalSuccess: 1,
      maintainOutput: {
        satisfied: true,
        context: "maintain complete",
        state: { syntheticMaintain: { ok: true } },
      },
    });

    await harness.runCommand("materia", "cast legitimate evaluation rework");

    const state = harness.appendedEntries.at(-1)?.data as {
      phase?: string;
      failedReason?: string;
      data?: Record<string, unknown>;
      cursors?: Record<string, number>;
      visits?: Record<string, number>;
      edgeTraversals?: Record<string, number>;
    };
    expect(state.phase).toBe("complete");
    expect(state.failedReason).toBeUndefined();
    expect(state.data?.evalAttempts).toBe(2);
    expect(state.cursors?.workItemIndex).toBe(1);
    expect(state.visits).toMatchObject({ "Socket-2": 2, "Socket-3": 2, "Socket-4": 1 });
    expect(state.edgeTraversals?.["Socket-3->Socket-2"]).toBe(1);
  });

  test("fails after the configured same-item no-advance cycle bound is exceeded", async () => {
    const harness = await makeHarness({
      maxNoAdvanceCycles: 1,
      maintainOutput: {
        satisfied: false,
        context: "retry without advancing",
      },
    });

    await harness.runCommand("materia", "cast bounded no-advance loop");

    const state = harness.appendedEntries.at(-1)?.data as {
      phase?: string;
      failedReason?: string;
      cursors?: Record<string, number>;
      visits?: Record<string, number>;
      edgeTraversals?: Record<string, number>;
    };
    expect(state.phase).toBe("failed");
    expect(state.failedReason).toContain('itemKey "WI-1"');
    expect(state.failedReason).toContain("Socket-2 -> Socket-3 -> Socket-4 -> Socket-2");
    expect(state.cursors?.workItemIndex).toBe(0);
    expect(state.visits).toMatchObject({ "Socket-2": 2, "Socket-3": 2, "Socket-4": 2 });
    expect(state.edgeTraversals?.["Socket-4->Socket-2"]).toBe(2);
  });
});

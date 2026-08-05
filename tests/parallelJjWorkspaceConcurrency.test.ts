import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createExecutionScope } from "../src/domain/executionScope.js";
import {
  createJjWorkspaceBackend,
  type JjRevisionIdentity,
  type JjWorkspaceRecord,
} from "../src/infrastructure/index.js";

const CHECKPOINT_SCRIPT = path.resolve("config", "utilities", "blackbelt-maintain.mjs");
const REVISION_TEMPLATE = 'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ description.first_line() ++ "\\t" ++ empty ++ "\\n"';

type Revision = JjRevisionIdentity & {
  parents: string[];
  description: string;
  empty: boolean;
};

type WorkerResult = {
  index: number;
  editPhaseReached: boolean;
  exposed: Revision;
  checkpoint: { satisfied: boolean; context: string };
  tip: Revision;
  fresh: Revision;
  fileContents: string;
};

describe("parallel jj workspace execution", () => {
  test("overlaps isolated workers before checkpointing their independent changes", async () => {
    if (!(await hasJj())) return;

    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-parallel-jj-repo-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-parallel-jj-workspaces-"));
    const backend = createJjWorkspaceBackend({ repositoryRoot, workspaceRoot });
    let workspaces: JjWorkspaceRecord[] = [];

    try {
      await realJj(["git", "init", repositoryRoot], process.cwd());
      await writeFile(path.join(repositoryRoot, "base.txt"), "base\n");
      await realJj(["describe", "-m", "feat: shared baseline"], repositoryRoot);
      // Keep the cast's pinned baseline as a clean empty workflow boundary;
      // the meaningful baseline remains its direct parent.
      await realJj(["new"], repositoryRoot);
      const baseline = (await backend.pinImmutableBaseline(repositoryRoot)).baseline;
      const baseBeforeWorkers = await revisionAt(repositoryRoot, "@");
      expect(baseBeforeWorkers).toEqual(baseline);

      workspaces = await Promise.all([0, 1].map((index) => backend.createWorkspace({
        cwd: repositoryRoot,
        repositoryRoot,
        workspaceRoot,
        baseline,
        parentCastId: "parallel-parent",
        loopId: "parallel-work",
        laneId: `lane-${index}`,
      })));
      expect(workspaces.map(({ baseline: pinned }) => pinned)).toEqual([baseline, baseline]);
      expect(new Set(workspaces.map(({ workspacePath }) => workspacePath)).size).toBe(2);
      expect(workspaces.every(({ workspacePath }) => !isWithin(repositoryRoot, workspacePath))).toBe(true);

      const barrierRoot = await mkdtemp(path.join(os.tmpdir(), "materia-parallel-jj-barrier-"));
      try {
        const children = workspaces.map((workspace, index) => Bun.spawn([process.execPath, "-e", workerSource()], {
          cwd: workspace.workspacePath,
          env: {
            ...process.env,
            WORKER_INDEX: String(index),
            WORKER_CWD: workspace.workspacePath,
            WORKER_INPUT: JSON.stringify(workerInput(workspace, index)),
            BARRIER_ROOT: barrierRoot,
            CHECKPOINT_SCRIPT,
          },
          stdout: "pipe",
          stderr: "pipe",
        }));
        const workers = await Promise.all(children.map(readWorker));

        // The edit barrier is reached before either worker runs a jj command
        // that can snapshot or advance its working copy. The exposed barrier
        // then proves both dirty working copies were observed before either
        // worker entered describe -> new. No elapsed-time ordering is used.
        expect(workers.every(({ editPhaseReached }) => editPhaseReached)).toBe(true);
        expect(workers.map(({ exposed }) => exposed.empty)).toEqual([false, false]);
        expect(new Set(workers.map(({ exposed }) => exposed.changeId)).size).toBe(2);
        expect(workers.map(({ exposed }) => exposed.parents)).toEqual([
          [baseline.commitId],
          [baseline.commitId],
        ]);

        expect(workers.map(({ checkpoint }) => checkpoint.satisfied)).toEqual([true, true]);
        expect(workers.map(({ checkpoint }) => checkpoint.context)).toEqual([
          "Blackbelt-Maintain: jj checkpoint created and new working commit ready. [bookmark: none]",
          "Blackbelt-Maintain: jj checkpoint created and new working commit ready. [bookmark: none]",
        ]);
        expect(workers.map(({ tip }) => tip.description)).toEqual([
          "feat: parallel lane 0",
          "feat: parallel lane 1",
        ]);
        expect(workers.map(({ tip }) => tip.changeId)).toEqual(workers.map(({ exposed }) => exposed.changeId));
        expect(workers.map(({ tip }) => tip.empty)).toEqual([false, false]);
        expect(workers.map(({ tip }) => tip.parents)).toEqual([
          [baseline.commitId],
          [baseline.commitId],
        ]);

        // Each normal describe-and-new checkpoint leaves a fresh empty
        // workspace commit directly above that worker's described change.
        expect(workers.map(({ fresh }) => fresh.empty)).toEqual([true, true]);
        expect(workers.map(({ fresh }) => fresh.parents[0])).toEqual(workers.map(({ tip }) => tip.commitId));
        expect(workers.map(({ fileContents }) => fileContents)).toEqual(["lane 0\n", "lane 1\n"]);

        // Worker mutations are serialized by jj's repository lock, but remain
        // safe because every mutation targets a distinct external workspace.
        expect(await revisionAt(repositoryRoot, "@")).toEqual(baseBeforeWorkers);
        expect((await realJj(["file", "show", "-r", "@", "base.txt"], repositoryRoot)).stdout).toBe("base\n");
        expect((await realJj(["status"], repositoryRoot)).stdout).toMatch(/no changes|clean/i);

        for (const [index, workspace] of workspaces.entries()) {
          const inspected = await backend.inspect(workspace);
          expect(inspected).toMatchObject({
            tracked: true,
            currentRevision: {
              commitId: workers[index]!.fresh.commitId,
              changeId: workers[index]!.fresh.changeId,
            },
          });
        }
      } finally {
        await rm(barrierRoot, { recursive: true, force: true });
      }
    } finally {
      await Promise.all(workspaces.map((workspace) => backend.cleanup(workspace).catch(() => undefined)));
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

function workerInput(workspace: JjWorkspaceRecord, index: number) {
  const scope = createExecutionScope({
    id: `cast:parallel-parent:base:branch:parallel-work:lane-${index}`,
    cwd: workspace.workspacePath,
    exports: {
      "jj.workspace.integration": {
        producer: "Spawn-JJ-Workspace",
        value: {
          version: 1,
          backend: "jj",
          owner: { ...workspace.owner },
          repositoryRoot: workspace.repositoryRoot,
          workspaceRoot: workspace.workspaceRoot,
          workspacePath: workspace.workspacePath,
          workspaceName: workspace.workspaceName,
          manifestPath: workspace.manifestPath,
          baseline: { ...workspace.baseline },
          revision: { ...workspace.revision },
          operationId: workspace.operationId,
        },
      },
    },
  });
  return {
    cwd: workspace.workspacePath,
    state: {
      parallelRun: { runId: "parallel-run", loopId: "parallel-work" },
      parallelLane: { laneId: `lane-${index}` },
    },
    executionScope: scope,
    item: { title: `feat: parallel lane ${index}` },
  };
}

function workerSource(): string {
  return `
    import { access, readFile, writeFile } from "node:fs/promises";
    import path from "node:path";

    const index = Number(process.env.WORKER_INDEX);
    const cwd = process.env.WORKER_CWD;
    const barrierRoot = process.env.BARRIER_ROOT;
    const checkpointScript = process.env.CHECKPOINT_SCRIPT;
    const input = JSON.parse(process.env.WORKER_INPUT);
    const revisionTemplate = ${JSON.stringify(REVISION_TEMPLATE)};

    async function command(args, commandCwd = cwd) {
      const child = Bun.spawn(["jj", ...args], { cwd: commandCwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error("jj " + args.join(" ") + " failed (" + exitCode + "): " + (stderr || stdout));
      return { stdout, stderr };
    }

    async function exists(file) {
      try { await access(file); return true; } catch { return false; }
    }

    async function signal(phase) {
      await writeFile(path.join(barrierRoot, phase + "-" + index), String(process.pid) + "\\n");
    }

    async function waitFor(phase) {
      while (true) {
        for (const other of [0, 1]) {
          const failure = path.join(barrierRoot, "failure-" + other);
          if (await exists(failure)) throw new Error(await readFile(failure, "utf8"));
        }
        if (await Promise.all([0, 1].map((other) => exists(path.join(barrierRoot, phase + "-" + other)))).then((ready) => ready.every(Boolean))) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }

    function revision(line) {
      const [commitId, changeId, parents = "", description = "", empty = "false"] = line.trim().split("\\t");
      return { commitId, changeId, parents: parents ? parents.split(",") : [], description, empty: empty === "true" };
    }

    async function checkpoint() {
      const child = Bun.spawn([process.execPath, checkpointScript], {
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      child.stdin.write(JSON.stringify(input) + "\\n");
      child.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error("checkpoint failed (" + exitCode + "): " + (stderr || stdout));
      const result = JSON.parse(stdout);
      if (result.satisfied !== true) throw new Error("checkpoint was not satisfied: " + stdout);
      return result;
    }

    try {
      // Both workers must enter this phase before either can write or invoke jj.
      await signal("editing");
      await waitFor("editing");
      await writeFile(path.join(cwd, "lane-" + index + ".txt"), "lane " + index + "\\n");
      await signal("written");
      await waitFor("written");

      // A normal jj read snapshots the dirty filesystem into this workspace's
      // non-empty working-copy commit. Hold the second barrier until both
      // workers have exposed that independent commit.
      const exposed = revision((await command(["log", "-r", "@", "--no-graph", "-T", revisionTemplate])).stdout);
      if (exposed.empty) throw new Error("jj log did not expose a non-empty working-copy commit");
      await signal("exposed");
      await waitFor("exposed");

      const checkpointResult = await checkpoint();
      const fresh = revision((await command(["log", "-r", "@", "--no-graph", "-T", revisionTemplate])).stdout);
      const tip = revision((await command(["log", "-r", "@-", "--no-graph", "-T", revisionTemplate])).stdout);
      const fileContents = (await command(["file", "show", "-r", "@-", "lane-" + index + ".txt"])).stdout;
      console.log(JSON.stringify({ index, editPhaseReached: true, exposed, checkpoint: checkpointResult, tip, fresh, fileContents }));
    } catch (error) {
      await writeFile(path.join(barrierRoot, "failure-" + index), String(error && error.stack || error)).catch(() => undefined);
      console.error(error && error.stack || error);
      process.exitCode = 1;
    }
  `;
}

async function readWorker(child: ReturnType<typeof Bun.spawn>): Promise<WorkerResult> {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`parallel jj worker failed (${exitCode}): ${stderr || stdout}`);
  expect(stderr).toBe("");
  return JSON.parse(stdout.trim()) as WorkerResult;
}

async function revisionAt(cwd: string, revset: string): Promise<JjRevisionIdentity> {
  const result = await realJj(["log", "-r", revset, "--no-graph", "-T", 'commit_id ++ "\\t" ++ change_id'], cwd);
  const [commitId, changeId] = result.stdout.trim().split("\t");
  return { commitId: commitId!, changeId: changeId! };
}

async function realJj(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(["jj", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`jj ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  return { stdout, stderr };
}

async function hasJj(): Promise<boolean> {
  try {
    await realJj(["--version"], process.cwd());
    return true;
  } catch {
    return false;
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

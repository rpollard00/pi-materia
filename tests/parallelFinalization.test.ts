import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createJjWorkspaceBackend, type JjCommandExecutor, type JjCommandInput, type JjWorkspaceBackend } from "../src/infrastructure/index.js";

const parallelFinalizeUtility = path.resolve("config", "utilities", "parallel-finalize.mjs");

function fakeFinalizationJj(repositoryRoot: string) {
  const tracked = new Set<string>();
  const calls: JjCommandInput[] = [];
  let movedToIntegration = false;
  let describedIntegration = false;
  const command: JjCommandExecutor = async (input) => {
    calls.push({ ...input, args: [...input.args] });
    const args = input.args.filter((arg) => arg !== "--ignore-working-copy");
    const revset = args[args.indexOf("-r") + 1];
    const template = args[args.indexOf("-T") + 1] ?? "";
    if (args[0] === "root") return { stdout: `${repositoryRoot}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "status") return { stdout: "The working copy has no changes.\n", stderr: "", exitCode: 0 };
    if (args[0] === "op") return { stdout: "op-finalize\n", stderr: "", exitCode: 0 };
    if (args[0] === "log") {
      if (template === "empty") return { stdout: movedToIntegration ? "true\n" : "false\n", stderr: "", exitCode: 0 };
      if (template.includes("parents.map")) return { stdout: "integration\tintegration-change\tbase\tfalse\t\n", stderr: "", exitCode: 0 };
      if (template.includes("conflict")) return { stdout: `${describedIntegration ? "integration-described" : "integration"}\tintegration-change\tfalse\n`, stderr: "", exitCode: 0 };
      if (revset === "@-") return { stdout: `${describedIntegration ? "integration-described" : "integration"}\tintegration-change\n`, stderr: "", exitCode: 0 };
      if (revset === "base") return { stdout: "base\tbase-change\n", stderr: "", exitCode: 0 };
      if (revset === "integration-change") return { stdout: `${describedIntegration ? "integration-described" : "integration"}\tintegration-change\n`, stderr: "", exitCode: 0 };
      if (revset === "integration" || revset === "blackbelt/test") return { stdout: `${describedIntegration ? "integration-described" : "integration"}\tintegration-change\n`, stderr: "", exitCode: 0 };
      if (path.resolve(input.cwd) === path.resolve(repositoryRoot)) {
        return { stdout: `${movedToIntegration ? "parent" : "base"}\t${movedToIntegration ? "parent-change" : "base-change"}\n`, stderr: "", exitCode: 0 };
      }
      if (revset?.includes("::")) return { stdout: "reachable\n", stderr: "", exitCode: 0 };
      return { stdout: `lane-${path.basename(input.cwd)}\tlane-change\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "workspace" && args[1] === "add") {
      const workspaceName = args[args.indexOf("--name") + 1]!;
      await mkdir(args.at(-1)!, { recursive: true });
      tracked.add(workspaceName);
      return { stdout: "", stderr: "", exitCode: 0, operationId: `op-add-${workspaceName}` };
    }
    if (args[0] === "workspace" && args[1] === "list") {
      return { stdout: [...tracked].map((name) => `${name}: fake\n`).join(""), stderr: "", exitCode: 0 };
    }
    if (args[0] === "workspace" && args[1] === "forget") {
      tracked.delete(args[2]!);
      return { stdout: "", stderr: "", exitCode: 0, operationId: `op-forget-${args[2]}` };
    }
    if (args[0] === "describe") {
      describedIntegration = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "bookmark") return { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "new") {
      if (!input.args.includes("--ignore-working-copy")) movedToIntegration = true;
      return { stdout: "Created new commit parent\n", stderr: "", exitCode: 0, operationId: "op-new-parent" };
    }
    return { stdout: "", stderr: `unsupported fake command: ${args.join(" ")}`, exitCode: 1 };
  };
  return { command, calls };
}

describe("jj parallel finalization boundary", () => {
  test("preserves all shared state when evaluation is rejected", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-finalize-repo-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-finalize-workspaces-"));
    const fake = fakeFinalizationJj(repositoryRoot);
    const backend = createJjWorkspaceBackend({ workspaceRoot, command: fake.command });
    const baseline = { commitId: "base", changeId: "base-change" };
    const result = await backend.finalize({
      parentCastId: "cast",
      loopId: "build",
      runId: "run",
      cwd: repositoryRoot,
      evaluationAccepted: false,
      bookmarkName: "blackbelt/test",
      fanIn: {
        version: 1,
        parentCastId: "cast",
        loopId: "build",
        runId: "run",
        baseline,
        parentRevisionBefore: baseline,
        parentRevisionAfter: baseline,
        orderedHeads: [],
        outcome: "clean",
        conflictedPaths: [],
        conflictDetails: [],
        operationId: "fan-in",
        startedAt: 1,
        completedAt: 2,
        integrationRevision: { commitId: "integration", changeId: "integration-change" },
      },
    });
    expect(result).toMatchObject({ satisfied: false, status: "preserved", cleanedLaneIds: [] });
    expect(fake.calls).toHaveLength(0);
  });

  test("describes, bookmarks, advances to an empty parent, and cleans owned lanes only after acceptance", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-finalize-repo-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-finalize-workspaces-"));
    const fake = fakeFinalizationJj(repositoryRoot);
    const backend = createJjWorkspaceBackend({ workspaceRoot, command: fake.command });
    const baseline = { commitId: "base", changeId: "base-change" };
    const lane = await backend.create({ cwd: repositoryRoot, baseline, parentCastId: "cast", loopId: "build", laneId: "lane-a" });
    const fanIn = await backend.fanIn({
      parentCastId: "cast",
      loopId: "build",
      runId: "run",
      cwd: repositoryRoot,
      baseline,
      queueOrder: ["lane-a"],
      lanes: [{ laneId: "lane-a", streamIndex: 0, queueIndex: 0, workItemIndexes: [0], status: "accepted", acceptedHead: baseline, workspace: lane }],
    });

    const result = await backend.finalize({
      parentCastId: "cast",
      loopId: "build",
      runId: "run",
      cwd: repositoryRoot,
      evaluationAccepted: true,
      bookmarkName: "blackbelt/test",
      fanIn,
    });
    expect(result).toMatchObject({ satisfied: true, status: "completed", bookmarkName: "blackbelt/test", cleanedLaneIds: ["lane-a"], integrationRevision: { commitId: "integration-described", changeId: "integration-change" } });
    expect(fake.calls.findIndex(({ args }) => args.includes("describe"))).toBeLessThan(fake.calls.findIndex(({ args }) => args.includes("bookmark")));
    expect(fake.calls.findIndex(({ args }) => args[0] === "new")).toBeLessThan(fake.calls.findIndex(({ args }) => args.includes("workspace") && args.includes("forget")));
    await expect(readdir(lane.workspacePath)).rejects.toThrow();
  });

  test("uses the post-description commit id with a real jj repository", async () => {
    if (!(await hasJj())) return;
    const fixture = await makeRealFinalizationFixture();
    const result = await fixture.backend.finalize({
      parentCastId: "cast",
      loopId: "build",
      runId: "run",
      cwd: fixture.repositoryRoot,
      evaluationAccepted: true,
      bookmarkName: "blackbelt/test",
      fanIn: fixture.fanIn,
    });

    expect(result.satisfied).toBe(true);
    expect(result.integrationRevision?.changeId).toBe(fixture.fanIn.integrationRevision?.changeId);
    expect(result.integrationRevision?.commitId).not.toBe(fixture.fanIn.integrationRevision?.commitId);
    expect((await realJj(["log", "-r", "blackbelt/test", "--no-graph", "-T", "commit_id"], fixture.repositoryRoot)).stdout.trim()).toBe(result.integrationRevision?.commitId);
    expect((await realJj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], fixture.repositoryRoot)).stdout.trim()).toBe(result.integrationRevision?.commitId);
    await expect(readdir(fixture.lane.workspacePath)).rejects.toThrow();
  });

  test("the shipped finalizer persists the post-description commit id with a real jj repository", async () => {
    if (!(await hasJj())) return;
    const fixture = await makeRealFinalizationFixture();
    const processHandle = Bun.spawn([process.execPath, parallelFinalizeUtility], {
      cwd: fixture.repositoryRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    processHandle.stdin.write(`${JSON.stringify({
      cwd: fixture.repositoryRoot,
      state: {
        envelope: { satisfied: true },
        parallelFanIn: fixture.fanIn,
        blackbeltBootstrap: { bookmarkName: "blackbelt/test" },
      },
    })}\n`);
    processHandle.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const output = JSON.parse(stdout) as { satisfied: boolean; state?: { parallelFinalization?: { integrationRevision?: { commitId: string; changeId: string } } } };
    expect(output.satisfied).toBe(true);
    const finalRevision = output.state?.parallelFinalization?.integrationRevision;
    expect(finalRevision?.changeId).toBe(fixture.fanIn.integrationRevision?.changeId);
    expect(finalRevision?.commitId).not.toBe(fixture.fanIn.integrationRevision?.commitId);
    expect((await realJj(["log", "-r", "blackbelt/test", "--no-graph", "-T", "commit_id"], fixture.repositoryRoot)).stdout.trim()).toBe(finalRevision?.commitId);
    expect((await realJj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], fixture.repositoryRoot)).stdout.trim()).toBe(finalRevision?.commitId);
    await expect(readdir(fixture.lane.workspacePath)).rejects.toThrow();
  });
});

async function makeRealFinalizationFixture(): Promise<{
  repositoryRoot: string;
  lane: { workspacePath: string };
  fanIn: NonNullable<Awaited<ReturnType<JjWorkspaceBackend["fanIn"]>>>;
  backend: JjWorkspaceBackend;
}> {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-real-finalize-repo-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-real-finalize-workspaces-"));
  await realJj(["git", "init", repositoryRoot], process.cwd());
  await writeFile(path.join(repositoryRoot, "base.txt"), "base\n");
  await realJj(["describe", "-m", "base"], repositoryRoot);
  await realJj(["new"], repositoryRoot);
  const backend = createJjWorkspaceBackend({ workspaceRoot });
  const baseline = (await backend.pinBaseline(repositoryRoot)).baseline;
  const lane = await backend.create({
    cwd: repositoryRoot,
    baseline,
    parentCastId: "cast",
    loopId: "build",
    laneId: "lane-a",
  });
  const fanIn = await backend.fanIn({
    parentCastId: "cast",
    loopId: "build",
    runId: "run",
    cwd: repositoryRoot,
    baseline,
    queueOrder: ["lane-a"],
    lanes: [{ laneId: "lane-a", streamIndex: 0, queueIndex: 0, workItemIndexes: [0], status: "accepted", acceptedHead: baseline, workspace: lane }],
  });
  return { repositoryRoot, lane, fanIn, backend };
}

async function hasJj(): Promise<boolean> {
  try {
    await realJj(["--version"], process.cwd());
    return true;
  } catch {
    return false;
  }
}

async function realJj(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const processHandle = Bun.spawn(["jj", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) throw new Error(`jj ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  return { stdout, stderr };
}

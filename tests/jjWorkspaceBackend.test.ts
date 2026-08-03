import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createJjWorkspaceBackend,
  type JjCommandExecutor,
  type JjCommandInput,
} from "../src/infrastructure/index.js";

function fakeJj(repositoryRoot: string) {
  const tracked = new Set<string>();
  const calls: JjCommandInput[] = [];
  let operation = 0;
  const command: JjCommandExecutor = async (input) => {
    calls.push({ ...input, args: [...input.args] });
    const args = input.args.filter((arg) => arg !== "--ignore-working-copy");
    if (args[0] === "root") return { stdout: `${repositoryRoot}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "log") {
      const revision = path.resolve(input.cwd) === path.resolve(repositoryRoot) ? "baseline" : `lane-${path.basename(input.cwd)}`;
      return { stdout: `${revision}\tchange-${revision}\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "op") return { stdout: `operation-${++operation}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "workspace" && args[1] === "add") {
      const name = args[args.indexOf("--name") + 1]!;
      const destination = args.at(-1)!;
      await mkdir(destination, { recursive: true });
      tracked.add(name);
      return { stdout: "", stderr: "", exitCode: 0, operationId: `operation-add-${name}` };
    }
    if (args[0] === "workspace" && args[1] === "list") {
      return { stdout: [...tracked].map((name) => `${name}: fake\n`).join(""), stderr: "", exitCode: 0 };
    }
    if (args[0] === "workspace" && args[1] === "forget") {
      tracked.delete(args[2]!);
      return { stdout: "", stderr: "", exitCode: 0, operationId: `operation-forget-${args[2]}` };
    }
    return { stdout: "", stderr: `unsupported fake command: ${args.join(" ")}`, exitCode: 1 };
  };
  return { command, calls, tracked };
}

function fakeFanInJj(repositoryRoot: string, options: {
  stackOutput?: string;
  laneStatus?: string;
  integrationParent?: string;
  baselineOutput?: string;
} = {}) {
  const tracked = new Set<string>();
  const calls: JjCommandInput[] = [];
  const stackLines = (options.stackOutput ?? "baseline\tbaseline-change\troot\tfalse\tfalse\nlane-working\tchange-lane-working\tbaseline\tfalse\ttrue\n")
    .trim().split(/\r?\n/).map((line) => line.split("\t"));
  const stackByIdentity = new Map(stackLines.flatMap((fields) => [[fields[0]!, fields], [fields[1]!, fields]]));
  if (options.baselineOutput) {
    const fields = options.baselineOutput.trim().split("\t");
    stackByIdentity.set(fields[0]!, fields);
    stackByIdentity.set(fields[1]!, fields);
  }
  const command: JjCommandExecutor = async (input) => {
    calls.push({ ...input, args: [...input.args] });
    const args = input.args.filter((arg) => arg !== "--ignore-working-copy");
    if (args[0] === "root") return { stdout: `${repositoryRoot}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "log") {
      const template = args[args.indexOf("-T") + 1] ?? "";
      const revset = args[args.indexOf("-r") + 1] ?? "";
      const inLane = path.resolve(input.cwd) !== path.resolve(repositoryRoot);
      if (template.includes("parents.map") && template.includes("empty")) {
        if (revset.includes("::")) return { stdout: options.stackOutput ?? "baseline\tbaseline-change\troot\tfalse\tfalse\nlane-working\tchange-lane-working\tbaseline\tfalse\ttrue\n", stderr: "", exitCode: 0 };
        const fields = stackByIdentity.get(revset);
        if (fields) return { stdout: `${fields.join("\t")}\n`, stderr: "", exitCode: 0 };
      }
      if (template.includes("parents.map")) {
        const fields = stackByIdentity.get(revset);
        if (fields) return { stdout: `${fields.slice(0, 4).join("\t")}\t\n`, stderr: "", exitCode: 0 };
        return { stdout: `1234567890abcdef\tintegration-change\t${options.integrationParent ?? "baseline"}\tfalse\t\n`, stderr: "", exitCode: 0 };
      }
      if ((revset === "@" && inLane) || revset === "lane-working") return { stdout: "lane-working\tchange-lane-working\n", stderr: "", exitCode: 0 };
      if (revset === "root") return { stdout: "root\tchange-root\n", stderr: "", exitCode: 0 };
      return { stdout: "baseline\tbaseline-change\n", stderr: "", exitCode: 0 };
    }
    if (args[0] === "status") return { stdout: path.resolve(input.cwd) === path.resolve(repositoryRoot) ? "The working copy has no changes.\n" : (options.laneStatus ?? "The working copy has no changes.\n"), stderr: "", exitCode: 0 };
    if (args[0] === "op") return { stdout: "operation-latest\n", stderr: "", exitCode: 0 };
    if (args[0] === "workspace" && args[1] === "add") {
      const name = args[args.indexOf("--name") + 1]!;
      const destination = args.at(-1)!;
      await mkdir(destination, { recursive: true });
      tracked.add(name);
      return { stdout: "", stderr: "", exitCode: 0, operationId: `operation-add-${name}` };
    }
    if (args[0] === "workspace" && args[1] === "list") {
      return { stdout: [...tracked].map((name) => `${name}: fake\n`).join(""), stderr: "", exitCode: 0 };
    }
    if (args[0] === "workspace" && args[1] === "forget") {
      tracked.delete(args[2]!);
      return { stdout: "", stderr: "", exitCode: 0, operationId: `operation-forget-${args[2]}` };
    }
    if (args[0] === "rebase") {
      const source = args[args.indexOf("-s") + 1]!;
      const destination = args[args.indexOf("-d") + 1]!;
      const fields = stackByIdentity.get(source);
      if (fields) fields[2] = destination;
      return { stdout: "Rebased 1 commits\n", stderr: "", exitCode: 0, operationId: "operation-linearize" };
    }
    return { stdout: "", stderr: `unsupported fake command: ${args.join(" ")}`, exitCode: 1 };
  };
  return { command, calls };
}

describe("jj workspace lifecycle backend", () => {
  test("pins, creates idempotently, inspects, forgets, and removes owned lanes", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-repo-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-workspaces-"));
    const fake = fakeJj(repositoryRoot);
    const backend = createJjWorkspaceBackend({ workspaceRoot, command: fake.command });

    const pinned = await backend.pinImmutableBaseline(repositoryRoot);
    const created = await backend.createWorkspace({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast-1", loopId: "build", laneId: "lane/one" });
    const repeated = await backend.createWorkspace({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast-1", loopId: "build", laneId: "lane/one" });
    const manifest = JSON.parse(await readFile(created.manifestPath, "utf8")) as Record<string, unknown>;
    const inspected = await backend.inspectWorkspace(created.path);

    expect(pinned.baseline.commitId).toBe("baseline");
    expect(repeated.path).toBe(created.path);
    expect(created.workspaceName).toContain("lane-one");
    expect(created.baselineCommitId).toBe("baseline");
    expect(created.operationId).toBe(`operation-add-${created.workspaceName}`);
    expect(manifest.owner).toEqual({ parentCastId: "cast-1", loopId: "build", laneId: "lane/one" });
    expect(created.manifestPath).not.toStartWith(created.path);
    expect(inspected).toMatchObject({ exists: true, tracked: true, workspacePath: created.path });
    expect(fake.calls.filter(({ args }) => args.includes("workspace") && args.includes("add"))).toHaveLength(1);
    expect(fake.calls.filter(({ args }) => args.includes("workspace") && args.includes("add")).every(({ args }) => args.includes("--ignore-working-copy"))).toBe(true);

    const forgotten = await backend.forgetWorkspace(created);
    expect(forgotten.state).toBe("forgotten");
    expect((await backend.inspect(created))?.tracked).toBe(false);
    const removed = await backend.removeOwnedDirectory(created);
    expect(removed.removed).toBe(true);
    expect(await backend.inspect(created)).toBeUndefined();
  });

  test("deduplicates identical accepted heads while retaining every lane in provenance", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-repo-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-workspaces-"));
    const fake = fakeFanInJj(repositoryRoot);
    const backend = createJjWorkspaceBackend({ workspaceRoot, command: fake.command });

    const pinned = await backend.pinBaseline(repositoryRoot);
    const laneA = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane-a" });
    const laneB = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane-b" });
    const result = await backend.fanIn({
      parentCastId: "cast",
      loopId: "build",
      runId: "run",
      cwd: repositoryRoot,
      baseline: pinned.baseline,
      queueOrder: ["lane-a", "lane-b"],
      lanes: [
        { laneId: "lane-a", streamIndex: 0, queueIndex: 0, workItemIndexes: [0], status: "accepted", acceptedHead: laneA.revision, workspace: laneA },
        { laneId: "lane-b", streamIndex: 1, queueIndex: 1, workItemIndexes: [1], status: "accepted", acceptedHead: laneB.revision, workspace: laneB },
      ],
    });

    expect(fake.calls.some(({ args }) => args.includes("new") || args.includes("rebase"))).toBe(false);
    expect(result.orderedHeads.map((entry) => entry.laneId)).toEqual(["lane-a", "lane-b"]);
    expect(result.orderedHeads.map((entry) => entry.head)).toEqual([pinned.baseline, pinned.baseline]);
    expect(result.orderedHeads.map((entry) => entry.commits)).toEqual([[], []]);
    expect(result.orderedHeads.map((entry) => entry.workspaceRevision)).toEqual([laneA.revision, laneB.revision]);
    expect(result.effectiveBase).toEqual(pinned.baseline);
    expect(result.orderedChangeIds).toEqual([]);
    expect(result.rewrittenLaneTips).toEqual([]);
    expect(result.finalTip).toEqual(pinned.baseline);
    expect(result.integrationRevision).toEqual(pinned.baseline);
  });

  test("derives ordered meaningful commits and removes only an empty cast boundary from the effective base", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-repo-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-workspaces-"));
    const stackOutput = [
      "baseline\tbaseline-change\troot\tfalse\ttrue",
      "item-one\tchange-item-one\tbaseline\tfalse\tfalse",
      "item-two\tchange-item-two\titem-one\tfalse\tfalse",
      "lane-working\tchange-lane-working\titem-two\tfalse\ttrue",
    ].join("\n") + "\n";
    const fake = fakeFanInJj(repositoryRoot, {
      stackOutput,
      baselineOutput: "baseline\tbaseline-change\troot\tfalse\ttrue\n",
      integrationParent: "item-two",
    });
    const backend = createJjWorkspaceBackend({ workspaceRoot, command: fake.command });
    const pinned = await backend.pinBaseline(repositoryRoot);
    const lane = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane" });

    const result = await backend.fanIn({
      parentCastId: "cast", loopId: "build", runId: "run", cwd: repositoryRoot,
      baseline: pinned.baseline, queueOrder: ["lane"],
      lanes: [{ laneId: "lane", streamIndex: 0, queueIndex: 0, workItemIndexes: [0, 1], status: "accepted", acceptedHead: lane.revision, workspace: lane }],
    });

    expect(result.orderedHeads[0]?.commits).toEqual([
      { commitId: "item-one", changeId: "change-item-one" },
      { commitId: "item-two", changeId: "change-item-two" },
    ]);
    expect(result.orderedHeads[0]?.head).toEqual({ commitId: "item-two", changeId: "change-item-two" });
    expect(result.effectiveBase).toEqual({ commitId: "root", changeId: "change-root" });
    expect(result.orderedChangeIds).toEqual(["change-item-one", "change-item-two"]);
    expect(result.rewrittenLaneTips).toEqual([{ laneId: "lane", revision: { commitId: "item-two", changeId: "change-item-two" } }]);
    expect(result.finalTip).toEqual({ commitId: "item-two", changeId: "change-item-two" });
    expect(fake.calls.some(({ args }) => args.includes("new"))).toBe(false);
  });

  test("derives a real-jj multi-item stack and excludes its trailing working commit", async () => {
    if (!(await hasRealJj())) return;
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-stack-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-workspaces-"));
    await runRealJj(["git", "init", repositoryRoot], process.cwd());
    const backend = createJjWorkspaceBackend({ repositoryRoot, workspaceRoot });
    const pinned = await backend.pinBaseline(repositoryRoot);
    const effectiveBase = await realRevision(repositoryRoot, `${pinned.baseline.commitId}-`);
    const lane = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane" });

    await writeFile(path.join(lane.workspacePath, "one.txt"), "one\n");
    await runRealJj(["describe", "-m", "feat: item one"], lane.workspacePath);
    const itemOne = await realRevision(lane.workspacePath, "@");
    await runRealJj(["new"], lane.workspacePath);
    await writeFile(path.join(lane.workspacePath, "two.txt"), "two\n");
    await runRealJj(["describe", "-m", "feat: item two"], lane.workspacePath);
    const itemTwo = await realRevision(lane.workspacePath, "@");
    await runRealJj(["new"], lane.workspacePath);
    const working = await realRevision(lane.workspacePath, "@");

    const result = await backend.fanIn({
      parentCastId: "cast", loopId: "build", runId: "run", cwd: repositoryRoot,
      baseline: pinned.baseline, queueOrder: ["lane"],
      lanes: [{ laneId: "lane", streamIndex: 0, queueIndex: 0, workItemIndexes: [0, 1], status: "accepted", acceptedHead: working, workspace: lane }],
    });

    expect(result.orderedHeads[0]?.commits).toEqual([itemOne, itemTwo]);
    expect(result.orderedHeads[0]?.workspaceRevision).toEqual(working);
    expect(result.orderedHeads[0]?.commits).not.toContainEqual(working);
    expect(result.effectiveBase).toEqual(effectiveBase);
  });

  test("linearly stacks real-jj lanes in schedule order without merge or transient empty commits", async () => {
    if (!(await hasRealJj())) return;
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-linear-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-workspaces-"));
    await runRealJj(["git", "init", repositoryRoot], process.cwd());
    const backend = createJjWorkspaceBackend({ repositoryRoot, workspaceRoot });
    const pinned = await backend.pinBaseline(repositoryRoot);
    const laneA = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane-a" });
    const noOp = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane-noop" });
    const laneB = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane-b" });

    await writeFile(path.join(laneA.workspacePath, "a-one.txt"), "a one\n");
    await runRealJj(["describe", "-m", "feat: lane a one"], laneA.workspacePath);
    const aOne = await realRevision(laneA.workspacePath, "@");
    await runRealJj(["new"], laneA.workspacePath);
    await writeFile(path.join(laneA.workspacePath, "a-two.txt"), "a two\n");
    await runRealJj(["describe", "-m", "feat: lane a two"], laneA.workspacePath);
    const aTwo = await realRevision(laneA.workspacePath, "@");
    await runRealJj(["new"], laneA.workspacePath);
    const aWorking = await realRevision(laneA.workspacePath, "@");

    await writeFile(path.join(laneB.workspacePath, "b.txt"), "b\n");
    await runRealJj(["describe", "-m", "feat: lane b"], laneB.workspacePath);
    const b = await realRevision(laneB.workspacePath, "@");
    await runRealJj(["new"], laneB.workspacePath);
    const bWorking = await realRevision(laneB.workspacePath, "@");

    const result = await backend.fanIn({
      parentCastId: "cast", loopId: "build", runId: "run", cwd: repositoryRoot,
      baseline: pinned.baseline, queueOrder: ["lane-a", "lane-noop", "lane-b"],
      lanes: [
        { laneId: "lane-b", streamIndex: 2, queueIndex: 2, workItemIndexes: [2], status: "accepted", acceptedHead: bWorking, workspace: laneB },
        { laneId: "lane-a", streamIndex: 0, queueIndex: 0, workItemIndexes: [0, 1], status: "accepted", acceptedHead: aWorking, workspace: laneA },
        { laneId: "lane-noop", streamIndex: 1, queueIndex: 1, workItemIndexes: [], status: "accepted", acceptedHead: noOp.revision, workspace: noOp },
      ],
    });

    expect(result.orderedChangeIds).toEqual([aOne.changeId, aTwo.changeId, b.changeId]);
    expect(result.rewrittenLaneTips.map(({ laneId }) => laneId)).toEqual(["lane-a", "lane-b"]);
    expect(result.finalTip.changeId).toBe(b.changeId);
    expect(result.integrationRevision).toEqual(result.finalTip);
    expect(result.outcome).toBe("clean");
    const { stdout } = await runRealJj(["log", "-r", `${result.effectiveBase.commitId}::${result.finalTip.commitId}`, "--reversed", "--no-graph", "-T", 'change_id ++ "\\t" ++ parents.len() ++ "\\t" ++ empty ++ "\\t" ++ description.first_line() ++ "\\n"'], repositoryRoot);
    const history = stdout.trim().split(/\r?\n/).map((line) => line.split("\t"));
    expect(history.slice(1).map(([changeId]) => changeId)).toEqual(result.orderedChangeIds);
    expect(history.slice(1).map(([, parents]) => parents)).toEqual(["1", "1", "1"]);
    expect(history.slice(1).map(([, , empty]) => empty)).toEqual(["false", "false", "false"]);
    expect(history.slice(1).map(([, , , description]) => description)).toEqual(["feat: lane a one", "feat: lane a two", "feat: lane b"]);
  });

  test("reports conflicts across the real-jj linear range with bounded paths", async () => {
    if (!(await hasRealJj())) return;
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-linear-conflict-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-workspaces-"));
    await runRealJj(["git", "init", repositoryRoot], process.cwd());
    const backend = createJjWorkspaceBackend({ repositoryRoot, workspaceRoot });
    const pinned = await backend.pinBaseline(repositoryRoot);
    const lanes = await Promise.all(["lane-a", "lane-b"].map((laneId) => backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId })));
    const working: Array<{ commitId: string; changeId: string }> = [];
    for (const [laneIndex, lane] of lanes.entries()) {
      for (let index = 0; index < 70; index += 1) await writeFile(path.join(lane.workspacePath, `shared-${index}.txt`), `lane ${laneIndex}\n`);
      await runRealJj(["describe", "-m", `feat: conflicting lane ${laneIndex}`], lane.workspacePath);
      await runRealJj(["new"], lane.workspacePath);
      working.push(await realRevision(lane.workspacePath, "@"));
    }

    const result = await backend.fanIn({
      parentCastId: "cast", loopId: "build", runId: "run", cwd: repositoryRoot,
      baseline: pinned.baseline, queueOrder: ["lane-a", "lane-b"],
      lanes: lanes.map((lane, index) => ({ laneId: `lane-${index === 0 ? "a" : "b"}`, streamIndex: index, queueIndex: index, workItemIndexes: [index], status: "accepted" as const, acceptedHead: working[index]!, workspace: lane })),
    });

    expect(result.outcome).toBe("conflict");
    expect(result.satisfied).toBe(false);
    expect(result.conflictedPaths).toHaveLength(64);
    expect(result.conflictDetails).toHaveLength(64);
    expect(result.finalTip.changeId).toBe(result.orderedChangeIds.at(-1));
  });

  test("represents a real-jj no-op lane as an empty stack", async () => {
    if (!(await hasRealJj())) return;
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-noop-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-workspaces-"));
    await runRealJj(["git", "init", repositoryRoot], process.cwd());
    const backend = createJjWorkspaceBackend({ repositoryRoot, workspaceRoot });
    const pinned = await backend.pinBaseline(repositoryRoot);
    const lane = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane" });

    const result = await backend.fanIn({
      parentCastId: "cast", loopId: "build", runId: "run", cwd: repositoryRoot,
      baseline: pinned.baseline, queueOrder: ["lane"],
      lanes: [{ laneId: "lane", streamIndex: 0, queueIndex: 0, workItemIndexes: [0], status: "accepted", acceptedHead: lane.revision, workspace: lane }],
    });

    expect(result.orderedHeads[0]?.commits).toEqual([]);
    expect(result.orderedHeads[0]?.head).toEqual(pinned.baseline);
    expect(result.effectiveBase).toEqual(pinned.baseline);
  });

  test("rejects a real-jj dirty lane and a real non-empty accepted working tip", async () => {
    if (!(await hasRealJj())) return;

    for (const cleanStatusOverride of [false, true]) {
      const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-nonempty-"));
      const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-workspaces-"));
      await runRealJj(["git", "init", repositoryRoot], process.cwd());
      const backend = createJjWorkspaceBackend({
        repositoryRoot,
        workspaceRoot,
        command: cleanStatusOverride ? realJjExecutor({ forceCleanStatus: true }) : undefined,
      });
      const pinned = await backend.pinBaseline(repositoryRoot);
      const lane = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane" });
      await writeFile(path.join(lane.workspacePath, "work.txt"), "meaningful work\n");
      await runRealJj(["describe", "-m", "feat: unfinished tip"], lane.workspacePath);
      const nonEmptyTip = await realRevision(lane.workspacePath, "@");

      const promise = backend.fanIn({
        parentCastId: "cast", loopId: "build", runId: "run", cwd: repositoryRoot,
        baseline: pinned.baseline, queueOrder: ["lane"],
        lanes: [{ laneId: "lane", streamIndex: 0, queueIndex: 0, workItemIndexes: [0], status: "accepted", acceptedHead: nonEmptyTip, workspace: lane }],
      });
      await expect(promise).rejects.toMatchObject({
        code: cleanStatusOverride ? "fan_in_lane_tip_not_empty" : "fan_in_lane_dirty",
      });
    }
  });

  test("rejects real-jj internal empty history as malformed", async () => {
    if (!(await hasRealJj())) return;
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-malformed-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-workspaces-"));
    await runRealJj(["git", "init", repositoryRoot], process.cwd());
    const backend = createJjWorkspaceBackend({ repositoryRoot, workspaceRoot });
    const pinned = await backend.pinBaseline(repositoryRoot);
    const lane = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane" });
    await runRealJj(["new"], lane.workspacePath);
    await writeFile(path.join(lane.workspacePath, "work.txt"), "work after empty boundary\n");
    await runRealJj(["describe", "-m", "feat: work after empty"], lane.workspacePath);
    await runRealJj(["new"], lane.workspacePath);
    const working = await realRevision(lane.workspacePath, "@");

    const promise = backend.fanIn({
      parentCastId: "cast", loopId: "build", runId: "run", cwd: repositoryRoot,
      baseline: pinned.baseline, queueOrder: ["lane"],
      lanes: [{ laneId: "lane", streamIndex: 0, queueIndex: 0, workItemIndexes: [0], status: "accepted", acceptedHead: working, workspace: lane }],
    });
    await expect(promise).rejects.toMatchObject({ code: "fan_in_lane_history_malformed" });
  });

  test("rejects a real-jj merged lane history as malformed", async () => {
    if (!(await hasRealJj())) return;
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-merged-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-workspaces-"));
    await runRealJj(["git", "init", repositoryRoot], process.cwd());
    const backend = createJjWorkspaceBackend({ repositoryRoot, workspaceRoot });
    const pinned = await backend.pinBaseline(repositoryRoot);
    const lane = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane" });
    await writeFile(path.join(lane.workspacePath, "a.txt"), "a\n");
    await runRealJj(["describe", "-m", "feat: branch a"], lane.workspacePath);
    const branchA = await realRevision(lane.workspacePath, "@");
    await runRealJj(["new", pinned.baseline.commitId], lane.workspacePath);
    await writeFile(path.join(lane.workspacePath, "b.txt"), "b\n");
    await runRealJj(["describe", "-m", "feat: branch b"], lane.workspacePath);
    const branchB = await realRevision(lane.workspacePath, "@");
    await runRealJj(["new", branchA.commitId, branchB.commitId], lane.workspacePath);
    const mergeWorking = await realRevision(lane.workspacePath, "@");

    const promise = backend.fanIn({
      parentCastId: "cast", loopId: "build", runId: "run", cwd: repositoryRoot,
      baseline: pinned.baseline, queueOrder: ["lane"],
      lanes: [{ laneId: "lane", streamIndex: 0, queueIndex: 0, workItemIndexes: [0], status: "accepted", acceptedHead: mergeWorking, workspace: lane }],
    });
    await expect(promise).rejects.toMatchObject({ code: "fan_in_lane_history_malformed" });
  });

  test("rejects real-jj accepted-head ancestry drift", async () => {
    if (!(await hasRealJj())) return;
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-drift-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-real-workspaces-"));
    await runRealJj(["git", "init", repositoryRoot], process.cwd());
    const backend = createJjWorkspaceBackend({ repositoryRoot, workspaceRoot });
    const pinned = await backend.pinBaseline(repositoryRoot);
    const lane = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane" });
    const acceptedWorking = await realRevision(lane.workspacePath, "@");
    await runRealJj(["new"], lane.workspacePath);

    const promise = backend.fanIn({
      parentCastId: "cast", loopId: "build", runId: "run", cwd: repositoryRoot,
      baseline: pinned.baseline, queueOrder: ["lane"],
      lanes: [{ laneId: "lane", streamIndex: 0, queueIndex: 0, workItemIndexes: [0], status: "accepted", acceptedHead: acceptedWorking, workspace: lane }],
    });
    await expect(promise).rejects.toMatchObject({ code: "fan_in_head_drift" });
  });

  test("rejects dirty, non-empty-tip, malformed, and ancestry-drift lane histories", async () => {
    const cases = [
      {
        name: "dirty",
        options: { laneStatus: "Working copy changes:\nM file.txt\n" },
        code: "fan_in_lane_dirty",
      },
      {
        name: "non-empty-tip",
        options: { stackOutput: "baseline\tbaseline-change\troot\tfalse\tfalse\nlane-working\tchange-lane-working\tbaseline\tfalse\tfalse\n" },
        code: "fan_in_lane_tip_not_empty",
      },
      {
        name: "malformed",
        options: { stackOutput: "baseline\tbaseline-change\troot\tfalse\tfalse\nitem\tchange-item\tbaseline,other\tfalse\tfalse\nlane-working\tchange-lane-working\titem\tfalse\ttrue\n" },
        code: "fan_in_lane_history_malformed",
      },
      {
        name: "ancestry-drift",
        options: { stackOutput: "other\tchange-other\troot\tfalse\tfalse\nlane-working\tchange-lane-working\tother\tfalse\ttrue\n" },
        code: "fan_in_lane_ancestry_drift",
      },
    ] as const;

    for (const testCase of cases) {
      const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), `materia-jj-${testCase.name}-`));
      const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-workspaces-"));
      const fake = fakeFanInJj(repositoryRoot, testCase.options);
      const backend = createJjWorkspaceBackend({ workspaceRoot, command: fake.command });
      const pinned = await backend.pinBaseline(repositoryRoot);
      const lane = await backend.create({ cwd: repositoryRoot, baseline: pinned.baseline, parentCastId: "cast", loopId: "build", laneId: "lane" });
      const promise = backend.fanIn({
        parentCastId: "cast", loopId: "build", runId: "run", cwd: repositoryRoot,
        baseline: pinned.baseline, queueOrder: ["lane"],
        lanes: [{ laneId: "lane", streamIndex: 0, queueIndex: 0, workItemIndexes: [0], status: "accepted", acceptedHead: lane.revision, workspace: lane }],
      });
      await expect(promise).rejects.toMatchObject({ code: testCase.code });
    }
  });

  test("rejects repository-local roots and traversal/symlink cleanup escapes", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-repo-"));
    const fake = fakeJj(repositoryRoot);
    const backend = createJjWorkspaceBackend({ workspaceRoot: await mkdtemp(path.join(os.tmpdir(), "materia-jj-workspaces-")), command: fake.command });
    await expect(backend.create({ cwd: repositoryRoot, workspaceRoot: path.join(repositoryRoot, "lanes"), parentCastId: "cast", loopId: "loop", laneId: "lane" })).rejects.toThrow("external");
    await backend.create({ cwd: repositoryRoot, parentCastId: "cast", loopId: "loop", laneId: "valid" });
    await expect(backend.inspect("../outside")).rejects.toThrow("outside owned root");

    const safeRoot = await mkdtemp(path.join(os.tmpdir(), "materia-jj-safe-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "materia-jj-outside-"));
    const safeBackend = createJjWorkspaceBackend({ workspaceRoot: safeRoot, command: fake.command });
    const lane = await safeBackend.create({ cwd: repositoryRoot, parentCastId: "cast", loopId: "loop", laneId: "symlink" });
    await safeBackend.forget(lane);
    await rm(lane.path, { recursive: true, force: true });
    await symlink(outside, lane.path);
    await expect(safeBackend.remove(lane)).rejects.toThrow(/symlink|outside/);
    expect(await readdir(outside)).toEqual([]);
    await rm(lane.path, { force: true });
  });
});

async function hasRealJj(): Promise<boolean> {
  try {
    await runRealJj(["--version"], process.cwd());
    return true;
  } catch {
    return false;
  }
}

function realJjExecutor(options: { forceCleanStatus?: boolean } = {}): JjCommandExecutor {
  return async (input) => {
    const args = input.args.filter((arg) => arg !== "--ignore-working-copy");
    if (options.forceCleanStatus && args[0] === "status") {
      return { stdout: "The working copy has no changes.\n", stderr: "", exitCode: 0 };
    }
    const child = Bun.spawn([input.executable, ...input.args], { cwd: input.cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
}

async function realRevision(cwd: string, revset: string): Promise<{ commitId: string; changeId: string }> {
  const { stdout } = await runRealJj(["log", "-r", revset, "--no-graph", "-T", 'commit_id ++ "\\t" ++ change_id'], cwd);
  const [commitId, changeId] = stdout.trim().split("\t");
  if (!commitId || !changeId) throw new Error(`Missing real jj revision for ${revset}`);
  return { commitId, changeId };
}

async function runRealJj(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(["jj", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`jj ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  return { stdout, stderr };
}

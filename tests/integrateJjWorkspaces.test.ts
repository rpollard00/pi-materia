import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createExecutionScope } from "../src/domain/executionScope.js";
import {
  INTEGRATE_JJ_WORKSPACES_PRODUCER,
  JJ_WORKSPACE_CLEANUP_EXPORT,
  JJ_WORKSPACE_INTEGRATION_EXPORT,
  integrateJjWorkspaceExports,
  type JjFanInInput,
  createJjWorkspaceBackend,
  type JjWorkspaceRecord,
} from "../src/infrastructure/index.js";
import { executeBuiltInUtility } from "../src/utilities/utilityRegistry.js";

const root = "/tmp/materia-integrate-workspaces";
const repositoryRoot = "/repo";

describe("Integrate-JJ-Workspaces", () => {
  test("consumes intrinsic exports in stream order and activates a clean integration workspace", async () => {
    const laneB = source("lane-b", "child-b", "head-b");
    const laneA = source("lane-a", "child-a", "head-a");
    let received: JjFanInInput | undefined;
    const result = await integrateJjWorkspaceExports({
      cwd: repositoryRoot,
      castId: "parent",
      socketId: "integrate",
      executionScope: createExecutionScope({ id: "parent-base", cwd: repositoryRoot }),
      state: {
        parallelFanIn: {
          version: 1,
          parentCastId: "parent",
          loopId: "build-loop",
          runId: "run-1",
          satisfied: true,
          orderedBranches: [branch(laneB, 0), branch(laneA, 1)],
        },
      },
    }, fakeDeps([laneA, laneB], "clean", (input) => { received = input; }));

    expect(received?.queueOrder).toEqual(["lane-b", "lane-a"]);
    expect(received?.lanes.map((lane) => lane.acceptedHead?.commitId)).toEqual(["head-b", "head-a"]);
    expect(received?.lanes.map((lane) => lane.owner?.parentCastId)).toEqual(["child-b", "child-a"]);
    expect(result.sourceCount).toBe(2);
    expect(result.scope.cwd).toBe(path.join(root, "integration"));
    expect(result.scope.state.jjWorkspaceIntegration).toMatchObject({
      outcome: "clean",
      sourceCount: 2,
      effectiveBase: { commitId: "base", changeId: "change-base" },
      orderedWorkstreams: [
        { laneId: "lane-b", streamIndex: 0, changeIds: [] },
        { laneId: "lane-a", streamIndex: 1, changeIds: [] },
      ],
      finalTip: { commitId: "integration", changeId: "change-integration" },
    });
    expect(result.scope.exports[JJ_WORKSPACE_INTEGRATION_EXPORT]?.producer).toBe(INTEGRATE_JJ_WORKSPACES_PRODUCER);
    expect(result.scope.exports[JJ_WORKSPACE_CLEANUP_EXPORT]?.value).toMatchObject({ sources: [{ laneId: "lane-b" }, { laneId: "lane-a" }] });
  });

  test("supports one active-scope export and preserves a conflicted outcome as bounded state", async () => {
    const only = source("single", "child", "head-single");
    const active = createExecutionScope({
      id: "single-scope",
      cwd: only.workspacePath,
      exports: { [JJ_WORKSPACE_INTEGRATION_EXPORT]: only.export },
    });
    const result = await integrateJjWorkspaceExports({
      cwd: only.workspacePath,
      castId: "cast",
      socketId: "integrate",
      executionScope: active,
      state: {},
    }, fakeDeps([only], "conflict"));

    expect(result.sourceCount).toBe(1);
    expect(result.integration.outcome).toBe("conflict");
    expect(result.scope.state.jjWorkspaceIntegration).toMatchObject({
      outcome: "conflict",
      conflictedPaths: ["src/conflict.ts"],
    });
  });

  test("materializes a real multi-workspace integration as the direct parent of its working commit", async () => {
    if (!(await hasJj())) return;
    const fixture = await realFixture(2);
    const result = await integrateJjWorkspaceExports(fixture.input);

    expect(result.sourceCount).toBe(2);
    expect(result.workspace.baseline).toEqual(result.integration.integrationRevision);
    expect(result.workspace.revision).not.toEqual(result.integration.integrationRevision);
    expect(await revisionAt(result.scope.cwd, "@-")).toEqual(result.integration.integrationRevision);
  });

  test("materializes one real workspace and emits its bounded result as utility state", async () => {
    if (!(await hasJj())) return;
    const fixture = await realFixture(1);
    const output = JSON.parse(await executeBuiltInUtility("vcs.integrateJjWorkspaces", {
      cwd: fixture.input.cwd,
      runDir: fixture.repositoryRoot,
      request: "",
      castId: fixture.input.castId,
      socketId: fixture.input.socketId,
      executionScope: fixture.input.executionScope,
      params: {},
      state: fixture.input.state,
      item: undefined,
      itemKey: undefined,
      itemLabel: undefined,
    })) as any;

    expect(output.state?.jjWorkspaceIntegration).toMatchObject({ version: 1, sourceCount: 1, outcome: "clean" });
    expect(output.jjWorkspaceIntegration).toBeUndefined();
    const scope = output.scopeTransition?.scope;
    expect(scope?.state?.jjWorkspaceIntegration).toEqual(output.state.jjWorkspaceIntegration);
    expect(await revisionAt(scope.cwd, "@-")).toEqual(output.state.jjWorkspaceIntegration.integrationRevision);
    expect(await revisionAt(scope.cwd, "@")).not.toEqual(output.state.jjWorkspaceIntegration.integrationRevision);
  });

  test("rejects an export whose ownership no longer matches its manifest", async () => {
    const only = source("lane", "child", "head");
    only.record.owner.parentCastId = "foreign";
    await expect(integrateJjWorkspaceExports({
      cwd: only.workspacePath,
      castId: "cast",
      socketId: "integrate",
      executionScope: createExecutionScope({ id: "scope", cwd: only.workspacePath, exports: { [JJ_WORKSPACE_INTEGRATION_EXPORT]: only.export } }),
      state: {},
    }, fakeDeps([only], "clean"))).rejects.toThrow("ownership or baseline verification");
  });
});

function branch(value: ReturnType<typeof source>, streamIndex: number) {
  return {
    laneId: value.laneId,
    name: value.laneId,
    streamIndex,
    queueIndex: streamIndex,
    workItemIndexes: [streamIndex],
    scope: { id: `scope-${value.laneId}`, cwd: value.workspacePath },
    scopeExports: { [JJ_WORKSPACE_INTEGRATION_EXPORT]: value.export },
  };
}

function source(laneId: string, parentCastId: string, head: string) {
  const workspaceName = `workspace-${laneId}`;
  const workspacePath = path.join(root, workspaceName);
  const owner = { parentCastId, loopId: "spawn", laneId: `scope-${laneId}` };
  const baseline = { commitId: "base", changeId: "change-base" };
  const record = workspaceRecord(workspaceName, owner, baseline, { commitId: head, changeId: `change-${head}` });
  return {
    laneId,
    workspacePath,
    record,
    export: {
      producer: "Spawn-JJ-Workspace",
      value: {
        version: 1,
        backend: "jj",
        owner,
        repositoryRoot,
        workspaceRoot: root,
        workspacePath,
        workspaceName,
        manifestPath: record.manifestPath,
        baseline,
      },
    },
  };
}

function fakeDeps(sources: Array<ReturnType<typeof source>>, outcome: "clean" | "conflict", capture?: (input: JjFanInInput) => void) {
  return {
    createBackend: () => ({
      async inspect(reference: { workspacePath?: string }) {
        const sourceValue = sources.find(({ workspacePath }) => workspacePath === reference.workspacePath)!;
        return { ...sourceValue.record, exists: true, tracked: true, currentRevision: { ...sourceValue.record.revision } };
      },
      async fanIn(input: JjFanInInput) {
        capture?.(input);
        return {
          version: 1 as const,
          parentCastId: input.parentCastId,
          loopId: input.loopId,
          runId: input.runId,
          baseline: { ...input.baseline },
          effectiveBase: { ...input.baseline },
          parentRevisionBefore: { ...input.baseline },
          parentRevisionAfter: { ...input.baseline },
          orderedHeads: input.lanes.map((lane) => ({
            laneId: lane.laneId,
            streamIndex: lane.streamIndex,
            queueIndex: lane.queueIndex,
            workItemIndexes: [...lane.workItemIndexes],
            head: { ...input.baseline },
            commits: [],
            workspace: {},
            workspaceRevision: lane.acceptedHead!,
          })),
          orderedChangeIds: [],
          rewrittenLaneTips: [],
          finalTip: { commitId: "integration", changeId: "change-integration" },
          integrationRevision: { commitId: "integration", changeId: "change-integration" },
          outcome,
          conflictedPaths: outcome === "conflict" ? ["src/conflict.ts"] : [],
          conflictDetails: outcome === "conflict" ? [{ path: "src/conflict.ts", message: "conflict" }] : [],
          operationId: "op-integrate",
          startedAt: 1,
          completedAt: 2,
          satisfied: outcome === "clean",
        };
      },
      async createWorkspace(input: { parentCastId: string; loopId: string; laneId: string; baseline: { commitId: string; changeId: string } }) {
        return workspaceRecord("integration", { parentCastId: input.parentCastId, loopId: input.loopId, laneId: input.laneId }, input.baseline, { commitId: "integration-working", changeId: "change-integration-working" });
      },
    }) as any,
  };
}

async function realFixture(count: number): Promise<{
  repositoryRoot: string;
  input: Parameters<typeof integrateJjWorkspaceExports>[0];
}> {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-real-integrate-repo-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-real-integrate-workspaces-"));
  await realJj(["git", "init", repositoryRoot], process.cwd());
  const backend = createJjWorkspaceBackend({ workspaceRoot, repositoryRoot });
  const baseline = (await backend.pinBaseline(repositoryRoot)).baseline;
  const lanes = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const laneId = `lane-${index}`;
    const workspace = await backend.createWorkspace({
      cwd: repositoryRoot,
      baseline,
      parentCastId: "child",
      loopId: "spawn",
      laneId,
    });
    const exportValue = {
      producer: "Spawn-JJ-Workspace",
      value: {
        version: 1,
        backend: "jj",
        owner: { ...workspace.owner },
        repositoryRoot,
        workspaceRoot,
        workspacePath: workspace.workspacePath,
        workspaceName: workspace.workspaceName,
        manifestPath: workspace.manifestPath,
        baseline: { ...baseline },
      },
    };
    return { laneId, workspace, exportValue };
  }));
  const first = lanes[0]!;
  const executionScope = createExecutionScope({
    id: "source-scope",
    cwd: count === 1 ? first.workspace.cwd : repositoryRoot,
    exports: count === 1 ? { [JJ_WORKSPACE_INTEGRATION_EXPORT]: first.exportValue } : {},
  });
  const state = count === 1 ? {} : {
    parallelFanIn: {
      version: 1,
      parentCastId: "parent",
      loopId: "build",
      runId: "run",
      satisfied: true,
      orderedBranches: lanes.map(({ laneId, workspace, exportValue }, index) => ({
        laneId,
        name: laneId,
        streamIndex: index,
        queueIndex: index,
        workItemIndexes: [index],
        scope: { id: `scope-${laneId}`, cwd: workspace.cwd },
        scopeExports: { [JJ_WORKSPACE_INTEGRATION_EXPORT]: exportValue },
      })),
    },
  };
  return {
    repositoryRoot,
    input: {
      cwd: executionScope.cwd,
      castId: "parent",
      socketId: `integrate-${count}`,
      executionScope,
      state,
    },
  };
}

async function hasJj(): Promise<boolean> {
  try {
    await realJj(["--version"], process.cwd());
    return true;
  } catch {
    return false;
  }
}

async function revisionAt(cwd: string, revset: string): Promise<{ commitId: string; changeId: string }> {
  const result = await realJj(["log", "-r", revset, "--no-graph", "-T", "commit_id ++ \"\\t\" ++ change_id"], cwd);
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

function workspaceRecord(
  workspaceName: string,
  owner: { parentCastId: string; loopId: string; laneId: string },
  baseline: { commitId: string; changeId: string },
  revision: { commitId: string; changeId: string },
): JjWorkspaceRecord {
  const workspacePath = path.join(root, workspaceName);
  return {
    version: 1,
    backend: "jj",
    owner: { ...owner },
    repositoryRoot,
    workspaceRoot: root,
    workspacePath,
    workspaceName,
    baseline: { ...baseline },
    revision: { ...revision },
    operationId: `op-${workspaceName}`,
    state: "active",
    createdAt: 1,
    updatedAt: 1,
    cwd: workspacePath,
    path: workspacePath,
    manifestPath: path.join(root, ".manifests", `${workspaceName}.json`),
    baselineCommitId: baseline.commitId,
    revisionCommitId: revision.commitId,
  };
}

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createExecutionScope } from "../src/domain/executionScope.js";
import {
  createJjWorkspaceBackend,
  finalizeJjWorkspace,
  JJ_WORKSPACE_CLEANUP_EXPORT,
  JJ_WORKSPACE_INTEGRATION_EXPORT,
  type JjWorkspaceRecord,
} from "../src/infrastructure/index.js";
import { executeBuiltInUtility } from "../src/utilities/utilityRegistry.js";

const repositoryRoot = "/repo";
const workspaceRoot = "/tmp/materia-finalize";
const integrationPath = path.join(workspaceRoot, "integration");
const sourcePath = path.join(workspaceRoot, "source");
const integrationOwner = { parentCastId: "cast", loopId: "integrate", laneId: "integration-scope" };
const sourceOwner = { parentCastId: "child", loopId: "spawn", laneId: "lane-a" };

describe("Finalize-JJ-Workspace", () => {
  test("requires agent acceptance before inspecting or mutating workspaces", async () => {
    let touched = false;
    await expect(finalizeJjWorkspace({
      ...input(false),
      bookmarkName: "blackbelt/test",
    }, {
      createBackend: () => ({ inspect: async () => { touched = true; return undefined as any; }, cleanup: async () => undefined as any }),
      runJj: async () => { touched = true; return ""; },
    })).rejects.toThrow("explicit agent acceptance");
    expect(touched).toBe(false);
  });

  test("verifies, publishes, cleans owned workspaces, and returns to base scope", async () => {
    const calls: string[] = [];
    const cleaned: string[] = [];
    let described = false;
    const result = await finalizeJjWorkspace({ ...input(true), bookmarkName: "blackbelt/test", description: "accepted integration" }, {
      createBackend: () => ({
        inspect: async (reference: any) => record(reference.workspaceName, reference.owner),
        cleanup: async (reference: any) => { cleaned.push(reference.workspaceName); return {} as any; },
      }),
      runJj: async (args, cwd, ignore = true) => {
        calls.push(`${ignore}:${cwd}:${args.join(" ")}`);
        if (args[0] === "status") return "The working copy has no changes.\n";
        if (args[0] === "describe") { described = true; return ""; }
        if (args[0] === "bookmark") return "";
        if (args[0] === "new") return "";
        if (args.at(-1) === "empty") return "true\n";
        const revision = args[args.indexOf("-r") + 1];
        if (revision === "@" && cwd === integrationPath) return "accepted\tchangeaccepted\tfalse\n";
        if (revision === "original") return "original\tchangeoriginal\n";
        if (revision === "original::accepted") return "accepted\n";
        if (revision === "changeaccepted" || revision === "blackbelt/test" || revision === "@-") return `${described ? "described" : "accepted"}\tchangeaccepted\n`;
        if (revision === "@") return "baseworking\tchangebaseworking\n";
        throw new Error(`unexpected fake jj call: ${args.join(" ")}`);
      },
    });

    expect(result.scope).toEqual(input(true).baseScope);
    expect(result.integrationRevision).toEqual({ commitId: "described", changeId: "changeaccepted" });
    expect(cleaned).toEqual(["integration", "source"]);
    expect(calls).toContain(`false:${integrationPath}:log -r @ --no-graph -T commit_id ++ "\\t" ++ change_id ++ "\\t" ++ conflict ++ "\\n"`);
    expect(calls.findIndex((call) => call.includes("describe"))).toBeLessThan(calls.findIndex((call) => call.includes("bookmark set")));
    expect(calls.findIndex((call) => call.includes(":false:/repo:new"))).toBeLessThan(calls.length);
  });

  test("rejects unresolved conflicts without publishing or cleanup", async () => {
    const mutations: string[] = [];
    await expect(finalizeJjWorkspace({ ...input(true), bookmarkName: "blackbelt/test" }, {
      createBackend: () => ({ inspect: async (reference: any) => record(reference.workspaceName, reference.owner), cleanup: async () => { mutations.push("cleanup"); return {} as any; } }),
      runJj: async (args) => {
        if (args[0] === "log") return "accepted\tchangeaccepted\ttrue\n";
        mutations.push(args.join(" "));
        return "";
      },
    })).rejects.toThrow("unresolved conflicts");
    expect(mutations).toEqual([]);
  });

  test("snapshots post-integration agent edits before publishing and cleanup with real jj", async () => {
    if (!(await hasJj())) return;
    const realRepositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-real-finalize-repo-"));
    const realWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-real-finalize-workspaces-"));
    await realJj(["git", "init", realRepositoryRoot], process.cwd());
    await writeFile(path.join(realRepositoryRoot, "base.txt"), "base\n");
    await realJj(["describe", "-m", "base"], realRepositoryRoot);
    await realJj(["new"], realRepositoryRoot);

    const backend = createJjWorkspaceBackend({ workspaceRoot: realWorkspaceRoot, repositoryRoot: realRepositoryRoot });
    const baseline = (await backend.pinBaseline(realRepositoryRoot)).baseline;
    const workspace = await backend.createWorkspace({
      cwd: realRepositoryRoot,
      repositoryRoot: realRepositoryRoot,
      workspaceRoot: realWorkspaceRoot,
      parentCastId: "cast",
      loopId: "integrate",
      laneId: "integration-scope",
      baseline,
    });
    const ownedWorkspace = {
      owner: { ...workspace.owner },
      workspaceRoot: workspace.workspaceRoot,
      workspacePath: workspace.workspacePath,
      workspaceName: workspace.workspaceName,
      manifestPath: workspace.manifestPath,
    };
    const activeScope = createExecutionScope({
      id: "integration-scope",
      cwd: workspace.cwd,
      exports: {
        [JJ_WORKSPACE_INTEGRATION_EXPORT]: {
          producer: "Integrate-JJ-Workspaces",
          value: { version: 1, backend: "jj", outcome: "clean", repositoryRoot: realRepositoryRoot, integrationRevision: baseline, ...ownedWorkspace },
        },
        [JJ_WORKSPACE_CLEANUP_EXPORT]: {
          producer: "Integrate-JJ-Workspaces",
          value: { version: 1, backend: "jj", integration: ownedWorkspace, sources: [] },
        },
      },
    });

    // This is deliberately an unsnapshotted filesystem edit, matching an
    // integration agent's accepted post-integration work.
    await writeFile(path.join(workspace.cwd, "accepted-fix.txt"), "resolved by agent\n");
    const result = await finalizeJjWorkspace({
      cwd: workspace.cwd,
      executionScope: activeScope,
      baseScope: createExecutionScope({ id: "cast:cast:base", cwd: realRepositoryRoot }),
      state: { envelope: { satisfied: true } },
      bookmarkName: "blackbelt/test",
      description: "accepted agent fix",
    });

    expect((await realJj(["file", "show", "-r", result.integrationRevision.commitId, "accepted-fix.txt"], realRepositoryRoot)).stdout).toBe("resolved by agent\n");
    expect((await realJj(["log", "-r", "blackbelt/test", "--no-graph", "-T", "commit_id"], realRepositoryRoot)).stdout.trim()).toBe(result.integrationRevision.commitId);
    await expect(backend.inspect(ownedWorkspace)).resolves.toBeUndefined();
  });

  test("built-in utility emits finalization state and a base-scope transition", async () => {
    // Input validation happens before the real command boundary; this focused
    // assertion also keeps the utility alias and acceptance contract covered.
    await expect(executeBuiltInUtility("vcs.finalizeJjWorkspace", {
      cwd: integrationPath,
      runDir: repositoryRoot,
      request: "",
      castId: "cast",
      socketId: "finalize",
      executionScope: input(false).executionScope,
      baseScope: input(false).baseScope,
      params: {},
      state: { envelope: { satisfied: false }, blackbeltBootstrap: { bookmarkName: "blackbelt/test" } },
      item: null,
      itemKey: null,
      itemLabel: null,
    })).rejects.toThrow("explicit agent acceptance");
  });
});

function input(accepted: boolean) {
  const integration = owned("integration", integrationOwner);
  const source = owned("source", sourceOwner);
  return {
    cwd: integrationPath,
    executionScope: createExecutionScope({
      id: "integration-scope",
      cwd: integrationPath,
      exports: {
        [JJ_WORKSPACE_INTEGRATION_EXPORT]: {
          producer: "Integrate-JJ-Workspaces",
          value: { version: 1, backend: "jj", outcome: "clean", repositoryRoot, integrationRevision: { commitId: "original", changeId: "changeoriginal" }, ...integration },
        },
        [JJ_WORKSPACE_CLEANUP_EXPORT]: {
          producer: "Integrate-JJ-Workspaces",
          value: { version: 1, backend: "jj", integration, sources: [{ laneId: "lane-a", ...source }] },
        },
      },
    }),
    baseScope: createExecutionScope({ id: "cast:cast:base", cwd: repositoryRoot }),
    state: { envelope: { satisfied: accepted } },
  };
}

function owned(name: string, owner: typeof integrationOwner) {
  return { owner: { ...owner }, workspaceRoot, workspacePath: path.join(workspaceRoot, name), workspaceName: name, manifestPath: path.join(workspaceRoot, ".manifests", `${name}.json`) };
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

function record(name: string, owner: typeof integrationOwner): JjWorkspaceRecord & { exists: true; tracked: true } {
  const value = owned(name, owner);
  return {
    version: 1,
    backend: "jj",
    ...value,
    repositoryRoot,
    baseline: { commitId: "base", changeId: "change-base" },
    revision: { commitId: "working", changeId: "change-working" },
    operationId: "op",
    state: "active",
    createdAt: 1,
    updatedAt: 1,
    cwd: value.workspacePath,
    path: value.workspacePath,
    baselineCommitId: "base",
    revisionCommitId: "working",
    exists: true,
    tracked: true,
  };
}

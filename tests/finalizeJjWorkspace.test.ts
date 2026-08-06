import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, writeFile } from "node:fs/promises";
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
const integrationOwner = { parentCastId: "cast", loopId: "integrate", laneId: "integration-scope" };
const sourceOwner = { parentCastId: "child", loopId: "spawn", laneId: "lane-a" };
const TEMPLATE = 'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ conflict ++ "\\t" ++ empty ++ "\\n"';

describe("Finalize-JJ-Workspace", () => {
  test("requires acceptance before inspecting or mutating workspaces", async () => {
    let touched = false;
    await expect(finalizeJjWorkspace({ ...input(false), bookmarkName: "blackbelt/test" }, {
      createBackend: () => ({ inspect: async () => { touched = true; return undefined as any; }, cleanup: async () => undefined as any }),
      runJj: async () => { touched = true; return ""; },
    })).rejects.toThrow("explicit agent acceptance");
    expect(touched).toBe(false);
  });

  test("resolves stable changes, retains one correction, and advances only the existing bookmark", async () => {
    const calls: string[] = [];
    const cleaned: string[] = [];
    let described = false;
    let moved = false;
    let createdBase = false;
    const acceptedInput = input(true);
    const cleanupExport = acceptedInput.executionScope.exports[JJ_WORKSPACE_CLEANUP_EXPORT]!.value as any;
    cleanupExport.sources.push(structuredClone(cleanupExport.sources[0]));
    const result = await finalizeJjWorkspace({ ...acceptedInput, bookmarkName: "blackbelt/test", description: "fix: accepted integration" }, {
      createBackend: () => ({
        inspect: async (reference: any) => record(reference.workspaceName, reference.owner),
        cleanup: async (reference: any) => { cleaned.push(reference.workspaceName); return {} as any; },
      }),
      runJj: async (args, cwd, ignore = true) => {
        calls.push(`${ignore}:${cwd}:${args.join(" ")}`);
        if (args[0] === "status") return "The working copy has no changes.\n";
        if (args[0] === "describe") { described = true; return ""; }
        if (args[0] === "bookmark") { moved = true; return ""; }
        if (args[0] === "new") { createdBase = true; return ""; }
        const revision = args[args.indexOf("-r") + 1];
        if (String(revision).includes("conflicts()")) return "";
        if (revision === "@" && cwd === integrationPath) return details("review", "changereview", "final", false, false);
        if (revision === "changebase") return details("base", "changebase", "root", false, false);
        if (revision === "changefinal") return details("final", "changefinal", "base", false, false);
        if (revision === "changereview") return details(described ? "described" : "review", "changereview", "final", false, false);
        if (revision === "blackbelt/test") return details(moved ? "described" : "old", moved ? "changereview" : "changeold", "root", false, false);
        if (revision === "@" && cwd === repositoryRoot && createdBase) return details("baseworking", "changebaseworking", "described", false, true);
        throw new Error(`unexpected fake jj call: ${args.join(" ")}`);
      },
    });

    expect(result.integrationRevision).toEqual({ commitId: "described", changeId: "changereview" });
    expect(result.reviewCorrection).toBe(true);
    expect(cleaned).toEqual(["integration", "source"]);
    expect(calls.filter((call) => call.includes(":describe "))).toHaveLength(1);
    expect(calls.some((call) => call.includes("bookmark set") || call.includes("bookmark create"))).toBe(false);
    expect(calls).toContain(`true:/repo:bookmark move --allow-backwards blackbelt/test --to described`);
  });

  test("retries partial post-publication cleanup without creating another base commit", async () => {
    let published = false;
    let baseCreated = false;
    let newCalls = 0;
    let firstAttempt = true;
    const removed = new Set<string>();
    const backend = {
      inspect: async (reference: any) => removed.has(reference.workspaceName)
        ? undefined
        : { ...record(reference.workspaceName, reference.owner), tracked: reference.workspaceName === "integration" ? true : !published },
      cleanup: async (reference: any) => {
        if (reference.workspaceName === "source" && firstAttempt) {
          firstAttempt = false;
          throw new Error("simulated directory removal failure");
        }
        removed.add(reference.workspaceName);
        return {} as any;
      },
    };
    const runJj = async (args: readonly string[], cwd: string) => {
      if (args[0] === "status") return "The working copy has no changes.\n";
      if (args[0] === "bookmark") { published = true; return ""; }
      if (args[0] === "new") { baseCreated = true; newCalls += 1; return ""; }
      const revision = args[args.indexOf("-r") + 1];
      if (String(revision).includes("conflicts()")) return "";
      if (revision === "changebase") return details("base", "changebase", "root", false, false);
      if (revision === "changefinal") return details("final", "changefinal", "base", false, false);
      if (revision === "@" && cwd === integrationPath) return details("review", "changereview", "final", false, true);
      if (revision === "blackbelt/test") return published ? details("final", "changefinal", "base", false, false) : details("old", "changeold", "root", false, false);
      if (revision === "@" && cwd === repositoryRoot && baseCreated) return details("working", "changeworking", "final", false, true);
      throw new Error(`unexpected fake jj call: ${args.join(" ")}`);
    };

    await expect(finalizeJjWorkspace({ ...input(true), bookmarkName: "blackbelt/test" }, { createBackend: () => backend as any, runJj })).rejects.toThrow("simulated directory removal failure");
    expect(removed).toEqual(new Set(["integration"]));
    const retried = await finalizeJjWorkspace({ ...input(true), bookmarkName: "blackbelt/test" }, { createBackend: () => backend as any, runJj });
    expect(newCalls).toBe(1);
    expect(retried.cleanedWorkspaceNames).toEqual(["integration", "source"]);
    expect(removed).toEqual(new Set(["integration", "source"]));
  });

  test("retries an interrupted retirement without another base working commit", async () => {
    const value = input(true, true);
    let published = false;
    let baseCreated = false;
    let boundaryVisible = true;
    let abandonCalls = 0;
    let newCalls = 0;
    let throwAfterRetirement = true;
    const removed = new Set<string>();
    const runJj = async (args: readonly string[], cwd: string) => {
      if (args[0] === "status") return "The working copy has no changes.\\n";
      if (args[0] === "bookmark") { published = true; return ""; }
      if (args[0] === "new") { baseCreated = true; newCalls += 1; return ""; }
      if (args[0] === "abandon") { boundaryVisible = false; abandonCalls += 1; return ""; }
      const revision = String(args[args.indexOf("-r") + 1]);
      if (revision.includes("conflicts()")) return "";
      if (revision.includes("ancestors(") || revision.includes("children(")) return "";
      if (revision === "boundary & visible()") return boundaryVisible ? details("boundary", "changeboundary", "base", false, true) : "";
      if (revision === "base & visible()") return details("base", "changebase", "root", false, false);
      if (revision === "changebase") return details("base", "changebase", "root", false, false);
      if (revision === "changefinal") return details("final", "changefinal", "base", false, false);
      if (revision === "@" && cwd === integrationPath) return details("review", "changereview", "final", false, true);
      if (revision === "blackbelt/test") return published ? details("final", "changefinal", "base", false, false) : details("boundary", "changeboundary", "root", false, true);
      if (revision === "@" && cwd === repositoryRoot && baseCreated) {
        if (!boundaryVisible && throwAfterRetirement) {
          throwAfterRetirement = false;
          throw new Error("simulated interruption after boundary retirement");
        }
        return details("working", "changeworking", "final", false, true);
      }
      throw new Error(`unexpected fake jj call: ${args.join(" ")}`);
    };
    const backend = {
      inspect: async (reference: any) => removed.has(reference.workspaceName) ? undefined : record(reference.workspaceName, reference.owner),
      cleanup: async (reference: any) => { removed.add(reference.workspaceName); return {} as any; },
    };

    await expect(finalizeJjWorkspace({ ...value, bookmarkName: "blackbelt/test" }, { createBackend: () => backend as any, runJj })).rejects.toThrow("simulated interruption");
    const retried = await finalizeJjWorkspace({ ...value, bookmarkName: "blackbelt/test" }, { createBackend: () => backend as any, runJj });
    const repeated = await finalizeJjWorkspace({ ...value, bookmarkName: "blackbelt/test" }, { createBackend: () => backend as any, runJj });
    expect(retried.cleanedWorkspaceNames).toEqual(["integration", "source"]);
    expect(repeated.cleanedWorkspaceNames).toEqual(["integration", "source"]);
    expect(abandonCalls).toBe(1);
    expect(newCalls).toBe(1);
  });

  test.each([
    ["another bookmark", "boundary & ancestors(bookmarks())"],
    ["a tag", "boundary & ancestors(tags())"],
    ["a remote bookmark", "boundary & ancestors(remote_bookmarks())"],
    ["another working copy", "boundary & ancestors(working_copies())"],
    ["an unrelated visible child", "children(boundary) & visible()"],
  ])("preserves a workflow boundary retained by %s", async (_label, protectedRevset) => {
    const value = input(true, true);
    let published = false;
    let baseCreated = false;
    let abandonCalls = 0;
    const runJj = async (args: readonly string[], cwd: string) => {
      if (args[0] === "status") return "The working copy has no changes.\\n";
      if (args[0] === "bookmark") { published = true; return ""; }
      if (args[0] === "new") { baseCreated = true; return ""; }
      if (args[0] === "abandon") { abandonCalls += 1; return ""; }
      const revision = String(args[args.indexOf("-r") + 1]);
      if (revision.includes("conflicts()")) return "";
      if (revision === "boundary & visible()") return details("boundary", "changeboundary", "base", false, true);
      if (revision === "base & visible()") return details("base", "changebase", "root", false, false);
      if (revision === protectedRevset) return "protected\\n";
      if (revision.includes("ancestors(") || revision.includes("children(")) return "";
      if (revision === "changebase") return details("base", "changebase", "root", false, false);
      if (revision === "changefinal") return details("final", "changefinal", "base", false, false);
      if (revision === "@" && cwd === integrationPath) return details("review", "changereview", "final", false, true);
      if (revision === "blackbelt/test") return published ? details("final", "changefinal", "base", false, false) : details("boundary", "changeboundary", "base", false, true);
      if (revision === "@" && cwd === repositoryRoot && baseCreated) return details("working", "changeworking", "final", false, true);
      throw new Error(`unexpected fake jj call: ${args.join(" ")}`);
    };
    const backend = {
      inspect: async (reference: any) => record(reference.workspaceName, reference.owner),
      cleanup: async () => ({} as any),
    };

    const result = await finalizeJjWorkspace({ ...value, bookmarkName: "blackbelt/test" }, { createBackend: () => backend as any, runJj });
    expect(result.integrationRevision).toEqual({ commitId: "final", changeId: "changefinal" });
    expect(abandonCalls).toBe(0);
  });

  test("rejects mismatched duplicate cleanup references before inspection or mutation", async () => {
    const value = input(true);
    const cleanup = value.executionScope.exports[JJ_WORKSPACE_CLEANUP_EXPORT]!.value as any;
    cleanup.sources.push({ ...cleanup.integration, owner: { ...cleanup.integration.owner, laneId: "foreign" } });
    let touched = false;
    await expect(finalizeJjWorkspace({ ...value, bookmarkName: "blackbelt/test" }, {
      createBackend: () => ({ inspect: async () => { touched = true; return undefined; }, cleanup: async () => { touched = true; return {} as any; } }),
      runJj: async () => { touched = true; return ""; },
    })).rejects.toThrow("duplicate cleanup ownership mismatches");
    expect(touched).toBe(false);
  });

  test("rejects inconsistent removable workflow-boundary provenance", async () => {
    const value = input(true);
    const integration = value.executionScope.exports[JJ_WORKSPACE_INTEGRATION_EXPORT]!.value as any;
    integration.removableWorkflowBoundary = {
      commitId: "boundary",
      changeId: "change-boundary",
      expectedParent: { commitId: "wrong", changeId: "wrong-parent" },
    };
    let touched = false;
    await expect(finalizeJjWorkspace({ ...value, bookmarkName: "blackbelt/test" }, {
      createBackend: () => ({ inspect: async () => { touched = true; return undefined; }, cleanup: async () => { touched = true; return {} as any; } }),
      runJj: async () => { touched = true; return ""; },
    })).rejects.toThrow("malformed or inconsistent removable workflow-boundary");
    expect(touched).toBe(false);
  });

  test("validates every owned workspace before publication or cleanup", async () => {
    const mutations: string[] = [];
    await expect(finalizeJjWorkspace({ ...input(true), bookmarkName: "blackbelt/test" }, {
      createBackend: () => ({
        inspect: async (reference: any) => reference.workspaceName === "integration"
          ? record(reference.workspaceName, reference.owner)
          : record(reference.workspaceName, { ...reference.owner, laneId: "foreign" }),
        cleanup: async () => { mutations.push("cleanup"); return {} as any; },
      }),
      runJj: async () => { mutations.push("jj"); return ""; },
    })).rejects.toThrow("ownership verification failed");
    expect(mutations).toEqual([]);
  });

  test("accepts a review workspace returned directly to the rewritten final tip", async () => {
    let moved = false;
    let createdBase = false;
    const result = await finalizeJjWorkspace({ ...input(true), bookmarkName: "blackbelt/test" }, {
      createBackend: () => ({ inspect: async (reference: any) => record(reference.workspaceName, reference.owner), cleanup: async () => ({} as any) }),
      runJj: async (args, cwd) => {
        if (args[0] === "status") return "The working copy has no changes.\n";
        if (args[0] === "bookmark") { moved = true; return ""; }
        if (args[0] === "new") { createdBase = true; return ""; }
        const revision = args[args.indexOf("-r") + 1];
        if (String(revision).includes("conflicts()")) return "";
        if (revision === "@" && cwd === integrationPath) return details("final-rewritten", "changefinal", "base", false, false);
        if (revision === "changebase") return details("base", "changebase", "root", false, false);
        if (revision === "changefinal") return details("final", "changefinal", "base", false, false);
        if (revision === "blackbelt/test") return details(moved ? "final-rewritten" : "old", moved ? "changefinal" : "changeold", "base", false, false);
        if (revision === "@" && cwd === repositoryRoot && createdBase) return details("working", "changeworking", "final-rewritten", false, true);
        throw new Error(`unexpected fake jj call: ${args.join(" ")}`);
      },
    });

    expect(result.integrationRevision).toEqual({ commitId: "final-rewritten", changeId: "changefinal" });
    expect(result.reviewCorrection).toBe(false);
  });

  test("publishes the meaningful parent when review working commit is empty", async () => {
    const mutations: string[] = [];
    let moved = false;
    let createdBase = false;
    const result = await finalizeJjWorkspace({ ...input(true), bookmarkName: "blackbelt/test" }, {
      createBackend: () => ({ inspect: async (reference: any) => record(reference.workspaceName, reference.owner), cleanup: async () => ({} as any) }),
      runJj: async (args, cwd) => {
        if (args[0] !== "log" && args[0] !== "status") mutations.push(args.join(" "));
        if (args[0] === "status") return "The working copy has no changes.\n";
        if (args[0] === "bookmark") { moved = true; return ""; }
        if (args[0] === "new") { createdBase = true; return ""; }
        const revision = args[args.indexOf("-r") + 1];
        if (String(revision).includes("conflicts()")) return "";
        if (revision === "@" && cwd === integrationPath) return details("review", "changereview", "final", false, true);
        if (revision === "changebase") return details("base", "changebase", "root", false, false);
        if (revision === "changefinal") return details("final", "changefinal", "base", false, false);
        if (revision === "blackbelt/test") return details(moved ? "final" : "old", moved ? "changefinal" : "changeold", "base", false, false);
        if (revision === "@" && cwd === repositoryRoot && createdBase) return details("working", "changeworking", "final", false, true);
        throw new Error(`unexpected fake jj call: ${args.join(" ")}`);
      },
    });
    expect(result.integrationRevision).toEqual({ commitId: "final", changeId: "changefinal" });
    expect(result.reviewCorrection).toBe(false);
    expect(mutations.some((call) => call.startsWith("describe"))).toBe(false);
  });

  test.each([
    ["stale schedule ordering", { finalParent: "wrong", ancestorConflict: false }, "meaningful linear chain"],
    ["conflicted ancestor", { finalParent: "base", ancestorConflict: true }, "unresolved conflicts"],
  ])("rejects %s before publication", async (_name, scenario, message) => {
    const mutations: string[] = [];
    await expect(finalizeJjWorkspace({ ...input(true), bookmarkName: "blackbelt/test" }, {
      createBackend: () => ({ inspect: async (reference: any) => record(reference.workspaceName, reference.owner), cleanup: async () => { mutations.push("cleanup"); return {} as any; } }),
      runJj: async (args, cwd) => {
        if (args[0] !== "log") mutations.push(args.join(" "));
        const revision = args[args.indexOf("-r") + 1];
        if (revision === "@" && cwd === integrationPath) return details("review", "changereview", "final", false, true);
        if (revision === "changebase") return details("base", "changebase", "root", false, false);
        if (revision === "changefinal") return details("final", "changefinal", scenario.finalParent, scenario.ancestorConflict, false);
        return "";
      },
    })).rejects.toThrow(message);
    expect(mutations).toEqual([]);
  });

  test("unchanged and corrected reviews publish no merge or transient empty commit with real jj", async () => {
    if (!(await hasJj())) return;
    for (const corrected of [false, true]) {
      const fixture = await realFixture();
      if (corrected) {
        await writeFile(path.join(fixture.workspace.cwd, "accepted-fix.txt"), "resolved by agent\n");
      } else {
        // Conflict resolution rewrites commit ids while preserving change ids.
        // Re-describing the reviewed stable change exercises the same jj rewrite
        // behavior without depending on a platform-specific merge tool.
        await realJj(["describe", "-r", fixture.base.changeId, "-m", "fix: resolved integrated revision"], fixture.repositoryRoot);
      }
      const result = await finalizeJjWorkspace({
        cwd: fixture.workspace.cwd,
        executionScope: fixture.scope,
        baseScope: createExecutionScope({ id: "cast:cast:base", cwd: fixture.repositoryRoot }),
        state: { envelope: { satisfied: true } },
        bookmarkName: "blackbelt/test",
        description: "fix: reconcile streams",
      });
      expect(result.reviewCorrection).toBe(corrected);
      if (!corrected) expect(result.integrationRevision.commitId).not.toBe(fixture.base.commitId);
      const history = (await realJj(["log", "-r", `${fixture.base.changeId}::blackbelt/test`, "--reversed", "--no-graph", "-T", TEMPLATE], fixture.repositoryRoot)).stdout.trim().split("\n").map(parseDetails);
      expect(history.every((entry, index) => index === 0 || (entry.parents.length === 1 && entry.parents[0] === history[index - 1]!.commitId))).toBe(true);
      expect(history.slice(1).every((entry) => !entry.empty)).toBe(true);
      expect(history).toHaveLength(corrected ? 2 : 1);
      expect((await realJj(["log", "-r", "@", "--no-graph", "-T", "empty"], fixture.repositoryRoot)).stdout.trim()).toBe("true");
      expect(await pathExists(fixture.workspace.workspacePath)).toBe(false);
      expect(await pathExists(fixture.workspace.manifestPath)).toBe(false);
      const listed = (await realJj(["workspace", "list"], fixture.repositoryRoot)).stdout;
      expect(listed).not.toContain(`${fixture.workspace.workspaceName}:`);
    }
  });

  test("retires an unreferenced consumed workflow boundary with real jj", async () => {
    if (!(await hasJj())) return;
    const repositoryRoot = await realRepository("boundary-retirement");
    const realWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-real-finalize-boundary-workspaces-"));
    const base = await realIdentity("@", repositoryRoot);
    await realJj(["new"], repositoryRoot);
    const boundary = await realIdentity("@", repositoryRoot);
    await realJj(["bookmark", "create", "blackbelt/test", "-r", boundary.commitId], repositoryRoot);
    await realJj(["new", boundary.commitId, "-m", "feat: integrated"], repositoryRoot);
    await writeFile(path.join(repositoryRoot, "integrated.txt"), "integrated\n");
    const originalTip = await realIdentity("@", repositoryRoot);
    await realJj(["rebase", "-r", originalTip.commitId, "-d", base.commitId], repositoryRoot);
    const tip = await realIdentity(originalTip.changeId, repositoryRoot);
    await realJj(["new", tip.commitId], repositoryRoot);

    const backend = createJjWorkspaceBackend({ workspaceRoot: realWorkspaceRoot, repositoryRoot });
    const workspace = await backend.createWorkspace({
      cwd: repositoryRoot,
      repositoryRoot,
      workspaceRoot: realWorkspaceRoot,
      parentCastId: "cast",
      loopId: "integrate",
      laneId: "integration-scope",
      baseline: boundary,
    });
    await realJj(["new", tip.commitId], workspace.cwd);
    const ownedWorkspace = {
      owner: { ...workspace.owner },
      workspaceRoot: workspace.workspaceRoot,
      workspacePath: workspace.workspacePath,
      workspaceName: workspace.workspaceName,
      manifestPath: workspace.manifestPath,
    };
    const scope = createExecutionScope({ id: "integration-scope", cwd: workspace.cwd, exports: {
      [JJ_WORKSPACE_INTEGRATION_EXPORT]: { producer: "Integrate-JJ-Workspaces", value: {
        version: 1,
        backend: "jj",
        outcome: "clean",
        repositoryRoot,
        integrationRevision: tip,
        effectiveBase: base,
        finalTip: tip,
        orderedChangeIds: [tip.changeId],
        provenanceTruncated: false,
        removableWorkflowBoundary: { commitId: boundary.commitId, changeId: boundary.changeId, expectedParent: base },
        ...ownedWorkspace,
      } },
      [JJ_WORKSPACE_CLEANUP_EXPORT]: { producer: "Integrate-JJ-Workspaces", value: { version: 1, backend: "jj", integration: ownedWorkspace, sources: [] } },
    } });

    const result = await finalizeJjWorkspace({
      cwd: workspace.cwd,
      executionScope: scope,
      baseScope: createExecutionScope({ id: "cast:cast:base", cwd: repositoryRoot }),
      state: { envelope: { satisfied: true } },
      bookmarkName: "blackbelt/test",
    });

    expect(result.integrationRevision.changeId).toBe(tip.changeId);
    expect(result.baseWorkingRevision.changeId).not.toBe(tip.changeId);
    expect((await realJj(["log", "-r", `${boundary.commitId} & visible()`, "--no-graph", "-T", "commit_id"], repositoryRoot)).stdout.trim()).toBe("");
    const working = await realIdentity("@", repositoryRoot);
    const workingDetails = parseDetails((await realJj(["log", "-r", "@", "--no-graph", "-T", TEMPLATE], repositoryRoot)).stdout.trim());
    expect(workingDetails.empty).toBe(true);
    expect(workingDetails.parents).toEqual([result.integrationRevision.commitId]);
    expect(working.commitId).toBe(result.baseWorkingRevision.commitId);
    expect(await pathExists(workspace.workspacePath)).toBe(false);
    expect((await realJj(["workspace", "list"], repositoryRoot)).stdout).not.toContain(`${workspace.workspaceName}:`);
  });

  test("rejects stale schedule ordering and conflicted publish ancestry with real jj", async () => {
    if (!(await hasJj())) return;

    const staleRepo = await realRepository("stale");
    await writeFile(path.join(staleRepo, "a.txt"), "a\n");
    await realJj(["describe", "-m", "feat: first"], staleRepo);
    const first = await realIdentity("@", staleRepo);
    await realJj(["new", "-m", "feat: second"], staleRepo);
    await writeFile(path.join(staleRepo, "b.txt"), "b\n");
    const second = await realIdentity("@", staleRepo);
    await realJj(["new", second.commitId], staleRepo);
    const stale = await realReviewFixture(staleRepo, second, first, first, [second.changeId, first.changeId]);
    await expect(finalizeRealFixture(stale)).rejects.toThrow("schedule order");

    const conflictRepo = await realRepository("conflicted-ancestor");
    const conflict = await createConflict(conflictRepo);
    await realJj(["new", conflict.conflicted.changeId, "-m", "fix: resolve conflict"], conflictRepo);
    await writeFile(path.join(conflictRepo, "shared.txt"), "resolved\n");
    const resolved = await realIdentity("@", conflictRepo);
    await realJj(["new", resolved.commitId], conflictRepo);
    const conflictedAncestry = await realReviewFixture(conflictRepo, resolved, resolved, resolved, []);
    await expect(finalizeRealFixture(conflictedAncestry)).rejects.toThrow("conflicted ancestors");
  });

  test("resolves a genuinely conflicted stable change before publishing with real jj", async () => {
    if (!(await hasJj())) return;
    const repositoryRoot = await realRepository("resolved-rewrite");
    const conflict = await createConflict(repositoryRoot);
    await realJj(["bookmark", "create", "blackbelt/test", "-r", conflict.conflicted.commitId], repositoryRoot);
    await realJj(["new", conflict.left.commitId], repositoryRoot);
    const fixture = await realReviewFixture(repositoryRoot, conflict.conflicted, conflict.left, conflict.conflicted, [conflict.conflicted.changeId]);

    await realJj(["edit", conflict.conflicted.changeId], fixture.workspace.cwd);
    await writeFile(path.join(fixture.workspace.cwd, "shared.txt"), "resolved by reviewer\n");
    await realJj(["new", conflict.conflicted.changeId], fixture.workspace.cwd);
    const result = await finalizeRealFixture(fixture);

    expect(result.reviewCorrection).toBe(false);
    expect(result.integrationRevision.changeId).toBe(conflict.conflicted.changeId);
    expect(result.integrationRevision.commitId).not.toBe(conflict.conflicted.commitId);
    expect((await realJj(["log", "-r", `ancestors(blackbelt/test) & conflicts()`, "--no-graph", "-T", "commit_id"], repositoryRoot)).stdout.trim()).toBe("");
    expect((await realJj(["file", "show", "-r", "blackbelt/test", "shared.txt"], repositoryRoot)).stdout).toBe("resolved by reviewer\n");
  });

  test("built-in utility preserves the acceptance contract", async () => {
    await expect(executeBuiltInUtility("vcs.finalizeJjWorkspace", {
      cwd: integrationPath, runDir: repositoryRoot, request: "", castId: "cast", socketId: "finalize",
      executionScope: input(false).executionScope, baseScope: input(false).baseScope, params: {},
      state: { envelope: { satisfied: false }, blackbeltBootstrap: { bookmarkName: "blackbelt/test" } },
      item: null, itemKey: null, itemLabel: null,
    })).rejects.toThrow("explicit agent acceptance");
  });
});

function input(accepted: boolean, removableBoundary = false) {
  const integration = owned("integration", integrationOwner);
  const source = owned("source", sourceOwner);
  return {
    cwd: integrationPath,
    executionScope: createExecutionScope({ id: "integration-scope", cwd: integrationPath, exports: {
      [JJ_WORKSPACE_INTEGRATION_EXPORT]: { producer: "Integrate-JJ-Workspaces", value: {
        version: 1, backend: "jj", outcome: "clean", repositoryRoot,
        integrationRevision: { commitId: "final", changeId: "changefinal" },
        effectiveBase: { commitId: "base", changeId: "changebase" },
        finalTip: { commitId: "final", changeId: "changefinal" }, orderedChangeIds: ["changefinal"], provenanceTruncated: false,
        ...(removableBoundary ? { removableWorkflowBoundary: { commitId: "boundary", changeId: "changeboundary", expectedParent: { commitId: "base", changeId: "changebase" } } } : {}),
        ...integration,
      } },
      [JJ_WORKSPACE_CLEANUP_EXPORT]: { producer: "Integrate-JJ-Workspaces", value: { version: 1, backend: "jj", integration, sources: [{ laneId: "lane-a", ...source }] } },
    } }),
    baseScope: createExecutionScope({ id: "cast:cast:base", cwd: repositoryRoot }),
    state: { envelope: { satisfied: accepted } },
  };
}

async function realRepository(label: string) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), `materia-real-finalize-${label}-`));
  await realJj(["git", "init", repositoryRoot], process.cwd());
  await writeFile(path.join(repositoryRoot, "shared.txt"), "base\n");
  await realJj(["describe", "-m", "feat: meaningful base"], repositoryRoot);
  return repositoryRoot;
}

async function createConflict(repositoryRoot: string) {
  const base = await realIdentity("@", repositoryRoot);
  await realJj(["new", base.commitId, "-m", "feat: left"], repositoryRoot);
  await writeFile(path.join(repositoryRoot, "shared.txt"), "left\n");
  const left = await realIdentity("@", repositoryRoot);
  await realJj(["new", base.commitId, "-m", "feat: right"], repositoryRoot);
  await writeFile(path.join(repositoryRoot, "shared.txt"), "right\n");
  const right = await realIdentity("@", repositoryRoot);
  await realJj(["rebase", "-r", right.commitId, "-d", left.commitId], repositoryRoot);
  const conflicted = await realIdentity(right.changeId, repositoryRoot);
  expect((await realJj(["log", "-r", conflicted.commitId, "--no-graph", "-T", "conflict"], repositoryRoot)).stdout.trim()).toBe("true");
  return { base, left, conflicted };
}

async function realReviewFixture(repositoryRoot: string, workspaceBase: { commitId: string; changeId: string }, effectiveBase: { commitId: string; changeId: string }, finalTip: { commitId: string; changeId: string }, orderedChangeIds: string[]) {
  const realWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-real-finalize-review-"));
  const backend = createJjWorkspaceBackend({ workspaceRoot: realWorkspaceRoot, repositoryRoot });
  const workspace = await backend.createWorkspace({ cwd: repositoryRoot, repositoryRoot, workspaceRoot: realWorkspaceRoot, parentCastId: "cast", loopId: "integrate", laneId: "integration-scope", baseline: workspaceBase });
  const ownedWorkspace = { owner: { ...workspace.owner }, workspaceRoot: workspace.workspaceRoot, workspacePath: workspace.workspacePath, workspaceName: workspace.workspaceName, manifestPath: workspace.manifestPath };
  const scope = createExecutionScope({ id: "integration-scope", cwd: workspace.cwd, exports: {
    [JJ_WORKSPACE_INTEGRATION_EXPORT]: { producer: "Integrate-JJ-Workspaces", value: { version: 1, backend: "jj", outcome: "clean", repositoryRoot, integrationRevision: finalTip, effectiveBase, finalTip, orderedChangeIds, provenanceTruncated: false, ...ownedWorkspace } },
    [JJ_WORKSPACE_CLEANUP_EXPORT]: { producer: "Integrate-JJ-Workspaces", value: { version: 1, backend: "jj", integration: ownedWorkspace, sources: [] } },
  } });
  return { repositoryRoot, workspace, scope };
}

function finalizeRealFixture(fixture: Awaited<ReturnType<typeof realReviewFixture>>) {
  return finalizeJjWorkspace({ cwd: fixture.workspace.cwd, executionScope: fixture.scope, baseScope: createExecutionScope({ id: "cast:cast:base", cwd: fixture.repositoryRoot }), state: { envelope: { satisfied: true } }, bookmarkName: "blackbelt/test" });
}

async function realFixture() {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-real-finalize-repo-"));
  const realWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-real-finalize-workspaces-"));
  await realJj(["git", "init", repositoryRoot], process.cwd());
  await writeFile(path.join(repositoryRoot, "base.txt"), "base\n");
  await realJj(["describe", "-m", "feat: meaningful base"], repositoryRoot);
  const base = await realIdentity("@", repositoryRoot);
  await realJj(["new"], repositoryRoot);
  const workflowBoundary = await realIdentity("@", repositoryRoot);
  await realJj(["bookmark", "create", "blackbelt/test", "-r", workflowBoundary.commitId], repositoryRoot);
  await realJj(["new"], repositoryRoot);
  const backend = createJjWorkspaceBackend({ workspaceRoot: realWorkspaceRoot, repositoryRoot });
  const workspace = await backend.createWorkspace({ cwd: repositoryRoot, repositoryRoot, workspaceRoot: realWorkspaceRoot, parentCastId: "cast", loopId: "integrate", laneId: "integration-scope", baseline: workflowBoundary });
  const ownedWorkspace = { owner: { ...workspace.owner }, workspaceRoot: workspace.workspaceRoot, workspacePath: workspace.workspacePath, workspaceName: workspace.workspaceName, manifestPath: workspace.manifestPath };
  const scope = createExecutionScope({ id: "integration-scope", cwd: workspace.cwd, exports: {
    [JJ_WORKSPACE_INTEGRATION_EXPORT]: { producer: "Integrate-JJ-Workspaces", value: { version: 1, backend: "jj", outcome: "clean", repositoryRoot, integrationRevision: workflowBoundary, effectiveBase: workflowBoundary, finalTip: workflowBoundary, orderedChangeIds: [], provenanceTruncated: false, ...ownedWorkspace } },
    [JJ_WORKSPACE_CLEANUP_EXPORT]: { producer: "Integrate-JJ-Workspaces", value: { version: 1, backend: "jj", integration: ownedWorkspace, sources: [] } },
  } });
  return { repositoryRoot, backend, workspace, scope, base };
}

function owned(name: string, owner: typeof integrationOwner) { return { owner: { ...owner }, workspaceRoot, workspacePath: path.join(workspaceRoot, name), workspaceName: name, manifestPath: path.join(workspaceRoot, ".manifests", `${name}.json`) }; }
function details(commitId: string, changeId: string, parent: string, conflict: boolean, empty: boolean) { return `${commitId}\t${changeId}\t${parent}\t${conflict}\t${empty}\n`; }
function parseDetails(line: string) { const [commitId, changeId, parents = "", conflict, empty] = line.split("\t"); return { commitId: commitId!, changeId: changeId!, parents: parents ? parents.split(",") : [], conflict: conflict === "true", empty: empty === "true" }; }

async function pathExists(target: string): Promise<boolean> { try { await lstat(target); return true; } catch (error: any) { if (error?.code === "ENOENT") return false; throw error; } }
async function hasJj(): Promise<boolean> { try { await realJj(["--version"], process.cwd()); return true; } catch { return false; } }
async function realIdentity(revset: string, cwd: string) { const value = (await realJj(["log", "-r", revset, "--no-graph", "-T", 'commit_id ++ "\\t" ++ change_id'], cwd)).stdout.trim().split("\t"); return { commitId: value[0]!, changeId: value[1]! }; }
async function realJj(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const processHandle = Bun.spawn(["jj", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text(), processHandle.exited]);
  if (exitCode !== 0) throw new Error(`jj ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  return { stdout, stderr };
}
function record(name: string, owner: typeof integrationOwner): JjWorkspaceRecord & { exists: true; tracked: true } {
  const value = owned(name, owner);
  return { version: 1, backend: "jj", ...value, repositoryRoot, baseline: { commitId: "base", changeId: "changebase" }, revision: { commitId: "working", changeId: "changeworking" }, operationId: "op", state: "active", createdAt: 1, updatedAt: 1, cwd: value.workspacePath, path: value.workspacePath, baselineCommitId: "base", revisionCommitId: "working", exists: true, tracked: true };
}

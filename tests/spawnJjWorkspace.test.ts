import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  JJ_WORKSPACE_CLEANUP_EXPORT,
  JJ_WORKSPACE_INTEGRATION_EXPORT,
  createJjWorkspaceBackend,
  spawnJjWorkspaceScope,
  type JjCommandExecutor,
  type JjWorkspaceCreateInput,
  type JjWorkspaceRecord,
} from "../src/infrastructure/index.js";
import { createExecutionScope } from "../src/domain/executionScope.js";

describe("Spawn-JJ-Workspace", () => {
  test("creates one owned workspace from the active scope and returns opaque integration and cleanup exports", async () => {
    const active = createExecutionScope({
      id: "cast:child:base:branch:build:lane-a",
      cwd: "/repo",
      state: { retained: true, blackbeltBootstrap: { ok: true, bookmarkName: "blackbelt/cast-bookmark" } },
      exports: { retained: { producer: "earlier", value: { value: 1 } } },
    });
    const record = workspaceRecord();
    let createInput: JjWorkspaceCreateInput | undefined;
    const result = await spawnJjWorkspaceScope({
      cwd: "/repo",
      castId: "child-cast",
      socketId: "spawn-workspace",
      executionScope: active,
    }, {
      backend: {
        async createWorkspace(input) {
          createInput = input;
          return record;
        },
      },
    });

    expect(createInput).toMatchObject({
      cwd: "/repo",
      parentCastId: "child-cast",
      loopId: "spawn-workspace",
      laneId: active.id,
    });
    expect(result.scope.cwd).toBe(record.cwd);
    expect(result).not.toHaveProperty("bookmarkName");
    expect(result.scope.id).toContain(active.id);
    expect(result.scope.state).toMatchObject({
      retained: true,
      blackbeltBootstrap: { ok: true, root: "/repo", newWorkingCommit: true },
    });
    expect(result.scope.state.blackbeltBootstrap).not.toHaveProperty("bookmarkName");
    expect(result.scope.exports.retained).toEqual(active.exports.retained);
    expect(result.scope.exports[JJ_WORKSPACE_INTEGRATION_EXPORT]).toMatchObject({
      producer: "Spawn-JJ-Workspace",
      value: { workspacePath: record.workspacePath, manifestPath: record.manifestPath },
    });
    expect(result.scope.exports[JJ_WORKSPACE_INTEGRATION_EXPORT]?.value).not.toHaveProperty("bookmarkName");
    expect(result.scope.exports[JJ_WORKSPACE_CLEANUP_EXPORT]).toMatchObject({
      producer: "Spawn-JJ-Workspace",
      value: { workspaceRoot: record.workspaceRoot, workspacePath: record.workspacePath, manifestPath: record.manifestPath },
    });
    // Scope construction must not mutate or redirect the source working copy.
    expect(active.cwd).toBe("/repo");
    expect(active.state).toEqual({ retained: true, blackbeltBootstrap: { ok: true, bookmarkName: "blackbelt/cast-bookmark" } });
    expect(active.exports).toEqual({ retained: { producer: "earlier", value: { value: 1 } } });
  });

  test("concurrently initializes one shared root for independent branch backends", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-spawn-repo-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-spawn-workspaces-"));
    const baseEntries = await readdir(repositoryRoot);
    const tracked = new Set<string>();
    let rootsWaiting = 0;
    let releaseRoots!: () => void;
    const allRootsWaiting = new Promise<void>((resolve) => { releaseRoots = resolve; });
    const command: JjCommandExecutor = async ({ args, cwd }) => {
      const commandArgs = args.filter((arg) => arg !== "--ignore-working-copy");
      if (commandArgs[0] === "root") {
        rootsWaiting += 1;
        if (rootsWaiting === 4) releaseRoots();
        await allRootsWaiting;
        return { stdout: `${repositoryRoot}\n`, stderr: "", exitCode: 0 };
      }
      if (commandArgs[0] === "log") {
        const revision = path.resolve(cwd) === path.resolve(repositoryRoot) ? "base" : `lane-${path.basename(cwd)}`;
        return { stdout: `${revision}\tchange-${revision}\n`, stderr: "", exitCode: 0 };
      }
      if (commandArgs[0] === "workspace" && commandArgs[1] === "add") {
        const name = commandArgs[commandArgs.indexOf("--name") + 1]!;
        await mkdir(commandArgs.at(-1)!, { recursive: true });
        tracked.add(name);
        return { stdout: "", stderr: "", exitCode: 0, operationId: `add-${name}` };
      }
      return { stdout: "", stderr: `unsupported command: ${commandArgs.join(" ")}`, exitCode: 1 };
    };
    const scopes = Array.from({ length: 4 }, (_, index) => createExecutionScope({
      id: `cast:child:base:branch:lane-${index}`,
      cwd: repositoryRoot,
    }));
    const commands: string[][] = [];

    const results = await Promise.all(scopes.map((executionScope, index) => spawnJjWorkspaceScope({
      cwd: repositoryRoot,
      castId: "child-cast",
      socketId: `spawn-${index}`,
      executionScope,
      workspaceRoot,
    }, {
      backend: createJjWorkspaceBackend({ workspaceRoot, command: async (input) => {
        commands.push([...input.args]);
        return command(input);
      } }),
    })));

    expect(new Set(results.map(({ workspace }) => workspace.workspacePath)).size).toBe(4);
    expect(tracked.size).toBe(4);
    expect(commands.some((args) => args.includes("bookmark"))).toBe(false);
    expect(await readdir(repositoryRoot)).toEqual(baseEntries);
    expect(scopes.map(({ cwd }) => cwd)).toEqual(Array(4).fill(repositoryRoot));
  });

  test("atomically initializes one shared root across branch processes", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "materia-spawn-process-repo-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "materia-spawn-process-workspaces-"));
    const helperRoot = await mkdtemp(path.join(os.tmpdir(), "materia-spawn-process-helper-"));
    const fakeJj = path.join(helperRoot, "jj-fake.mjs");
    await writeFile(fakeJj, `#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2).filter((arg) => arg !== "--ignore-working-copy");
if (args[0] === "root") process.stdout.write(process.env.TEST_REPOSITORY_ROOT + "\\n");
else if (args[0] === "log") {
  const revision = path.resolve(process.cwd()) === path.resolve(process.env.TEST_REPOSITORY_ROOT) ? "base" : "lane";
  process.stdout.write(revision + "\\tchange-" + revision + "\\n");
} else if (args[0] === "workspace" && args[1] === "add") mkdirSync(args.at(-1), { recursive: true });
else if (args[0] === "op") process.stdout.write("operation\\n");
`, "utf8");
    await chmod(fakeJj, 0o700);

    const infrastructureUrl = new URL("../src/infrastructure/index.ts", import.meta.url).href;
    const scopeUrl = new URL("../src/domain/executionScope.ts", import.meta.url).href;
    const runBranch = (index: number) => {
      const source = `
        import { createJjWorkspaceBackend, spawnJjWorkspaceScope } from ${JSON.stringify(infrastructureUrl)};
        import { createExecutionScope } from ${JSON.stringify(scopeUrl)};
        const index = ${index};
        const cwd = process.env.TEST_REPOSITORY_ROOT;
        const executionScope = createExecutionScope({ id: "branch-" + index, cwd });
        const result = await spawnJjWorkspaceScope({ cwd, castId: "cast", socketId: "spawn-" + index, executionScope, workspaceRoot: process.env.TEST_WORKSPACE_ROOT }, {
          backend: createJjWorkspaceBackend({ workspaceRoot: process.env.TEST_WORKSPACE_ROOT, jjExecutable: process.env.TEST_FAKE_JJ }),
        });
        console.log(JSON.stringify({ workspacePath: result.workspace.workspacePath, hasBookmarkName: "bookmarkName" in result }));
      `;
      return Bun.spawn([process.execPath, "-e", source], {
        env: { ...process.env, TEST_REPOSITORY_ROOT: repositoryRoot, TEST_WORKSPACE_ROOT: workspaceRoot, TEST_FAKE_JJ: fakeJj },
        stdout: "pipe",
        stderr: "pipe",
      });
    };

    const processes = Array.from({ length: 12 }, (_, index) => runBranch(index));
    const outputs = await Promise.all(processes.map(async (child) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as { workspacePath: string; hasBookmarkName: boolean };
    }));

    expect(new Set(outputs.map(({ workspacePath }) => workspacePath)).size).toBe(outputs.length);
    expect(outputs.every(({ hasBookmarkName }) => !hasBookmarkName)).toBe(true);
    expect(await readdir(repositoryRoot)).toEqual([]);
  }, 20_000);

  test("rejects a cwd that does not represent the active execution scope", async () => {
    const active = createExecutionScope({ id: "scope", cwd: "/repo" });
    await expect(spawnJjWorkspaceScope({ cwd: "/other", castId: "cast", socketId: "spawn", executionScope: active }, {
      backend: { async createWorkspace() { throw new Error("must not run"); } },
    })).rejects.toThrow("must match the active execution scope");
  });
});

function workspaceRecord(): JjWorkspaceRecord {
  const workspaceRoot = "/tmp/pi-materia/jj-workspaces";
  const workspaceName = "materia-lane-a-1234567890abcdef";
  const workspacePath = path.join(workspaceRoot, workspaceName);
  return {
    version: 1,
    backend: "jj",
    owner: { parentCastId: "child-cast", loopId: "spawn-workspace", laneId: "cast:child:base:branch:build:lane-a" },
    repositoryRoot: "/repo",
    workspaceRoot,
    workspacePath,
    workspaceName,
    baseline: { commitId: "base", changeId: "base-change" },
    revision: { commitId: "lane", changeId: "lane-change" },
    operationId: "op-1",
    state: "active",
    createdAt: 1,
    updatedAt: 1,
    cwd: workspacePath,
    path: workspacePath,
    manifestPath: path.join(workspaceRoot, ".manifests", `${workspaceName}.json`),
    baselineCommitId: "base",
    revisionCommitId: "lane",
  };
}

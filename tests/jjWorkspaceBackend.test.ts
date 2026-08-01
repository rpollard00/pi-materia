import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
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

function fakeFanInJj(repositoryRoot: string) {
  const tracked = new Set<string>();
  const calls: JjCommandInput[] = [];
  const command: JjCommandExecutor = async (input) => {
    calls.push({ ...input, args: [...input.args] });
    const args = input.args.filter((arg) => arg !== "--ignore-working-copy");
    if (args[0] === "root") return { stdout: `${repositoryRoot}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "log") {
      const template = args[args.indexOf("-T") + 1] ?? "";
      if (template.includes("parents.map")) {
        return { stdout: "1234567890abcdef\tintegration-change\tbaseline\tfalse\t\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "baseline\tbaseline-change\n", stderr: "", exitCode: 0 };
    }
    if (args[0] === "status") return { stdout: "The working copy has no changes.\n", stderr: "", exitCode: 0 };
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
    if (args[0] === "new") return { stdout: "Created new commit integration 12345678\n", stderr: "", exitCode: 0, operationId: "operation-fan-in" };
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
        { laneId: "lane-a", streamIndex: 0, queueIndex: 0, workItemIndexes: [0], status: "accepted", acceptedHead: pinned.baseline, workspace: laneA },
        { laneId: "lane-b", streamIndex: 1, queueIndex: 1, workItemIndexes: [1], status: "accepted", acceptedHead: pinned.baseline, workspace: laneB },
      ],
    });

    const newCall = fake.calls.find(({ args }) => args.includes("new"));
    expect(newCall?.args.filter((arg) => arg !== "--ignore-working-copy")).toEqual(["new", "--no-edit", pinned.baseline.commitId]);
    expect(result.orderedHeads.map((entry) => entry.laneId)).toEqual(["lane-a", "lane-b"]);
    expect(result.orderedHeads.map((entry) => entry.head)).toEqual([pinned.baseline, pinned.baseline]);
    expect(result.integrationRevision).toEqual({ commitId: "1234567890abcdef", changeId: "integration-change" });
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

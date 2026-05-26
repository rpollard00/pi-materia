import { describe, expect, test, beforeAll } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = path.resolve("config", "utilities", "blackbelt-maintain.mjs");

async function runScript(stdin: unknown, cwd?: string): Promise<{ satisfied: boolean; context: string }> {
  const input = JSON.stringify(stdin);
  const { stdout } = await execFileAsync("node", [SCRIPT_PATH], {
    cwd: cwd ?? process.cwd(),
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PATH: process.env.PATH },
  }).catch((error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
    // Capture both stdout and stderr on failure
    const out = error.stdout ?? "";
    const err = error.stderr ?? "";
    if (out.trim()) {
      try {
        return { stdout: out } as { stdout: string };
      } catch {
        throw new Error(`Script failed with exit ${error.code}: ${err}`);
      }
    }
    throw error;
  });

  return JSON.parse(stdout.trim().split("\n").pop()!) as { satisfied: boolean; context: string };
}

// We pass JSON via stdin; execFile doesn't support stdin directly so we use spawn-like approach
async function runScriptWithStdin(stdin: unknown, cwd: string): Promise<{ satisfied: boolean; context: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SCRIPT_PATH], {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code: number | null) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Script exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const trimmed = stdout.trim();
        const lastLine = trimmed.split("\n").pop() ?? trimmed;
        resolve(JSON.parse(lastLine));
      } catch (e) {
        // If we have some output, try to return it
        if (stdout.trim()) {
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch {
            reject(new Error(`Failed to parse script output: ${stdout.slice(0, 200)}`));
          }
        } else {
          reject(new Error(`Empty script output. stderr: ${stderr}`));
        }
      }
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify(stdin));
    child.stdin.end();
  });
}

async function initJjRepo(dir: string): Promise<void> {
  await execFileAsync("jj", ["git", "init"], { cwd: dir, timeout: 10000 });
}

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: dir, timeout: 10000 });
  await execFileAsync("git", ["config", "user.email", "test@pi-materia.local"], { cwd: dir, timeout: 5000 });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir, timeout: 5000 });
}

describe("Blackbelt-Maintain script: jj workflows", () => {
  test("clean jj repo: no-op and returns satisfied true", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-jj-clean-"));
    await initJjRepo(dir);

    const result = await runScriptWithStdin({ item: { title: "Test clean jj" } }, dir);

    expect(result.satisfied).toBe(true);
    expect(result.context).toContain("no-op");
    expect(result.context).toContain("clean jj working commit");
  });

  test("dirty jj repo: describe then new with item.title as message", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-jj-dirty-"));
    await initJjRepo(dir);

    // Make a dirty change
    await writeFile(path.join(dir, "README.md"), "# Test\n", "utf8");

    const result = await runScriptWithStdin({ item: { title: "Add README draft" } }, dir);

    expect(result.satisfied).toBe(true);
    expect(result.context).toContain("jj checkpoint created");
    expect(result.context).toContain("new working commit");

    // Verify the change was described
    const { stdout: descOut } = await execFileAsync("jj", ["log", "-r", "@-", "--no-graph", "-T", "description"], { cwd: dir });
    expect(descOut.trim()).toContain("Add README draft");
  });

  test("dirty jj repo with cwd override", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-jj-cwd-"));
    await initJjRepo(dir);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "lib.ts"), "export const x = 1;\n", "utf8");

    const result = await runScriptWithStdin({ item: { title: "Add lib module" }, cwd: dir }, dir);

    expect(result.satisfied).toBe(true);
    expect(result.context).toContain("jj checkpoint");
  });
});

describe("Blackbelt-Maintain script: git workflows", () => {
  test("clean git repo: no-op and returns satisfied true", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-git-clean-"));
    await initGitRepo(dir);

    // First commit so there's no initial untracked status
    await writeFile(path.join(dir, "initial.txt"), "initial\n", "utf8");
    await execFileAsync("git", ["add", "-A"], { cwd: dir, timeout: 5000 });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir, timeout: 5000 });

    const result = await runScriptWithStdin({ item: { title: "Test clean git" } }, dir);

    expect(result.satisfied).toBe(true);
    expect(result.context).toContain("no-op");
    expect(result.context).toContain("clean git working tree");
  });

  test("dirty git repo: add -A and commit with item.title", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-git-dirty-"));
    await initGitRepo(dir);

    // Initial commit to have a baseline
    await writeFile(path.join(dir, "initial.txt"), "initial\n", "utf8");
    await execFileAsync("git", ["add", "-A"], { cwd: dir, timeout: 5000 });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir, timeout: 5000 });

    // Make a dirty change
    await writeFile(path.join(dir, "CHANGELOG.md"), "# Changelog\n", "utf8");

    const result = await runScriptWithStdin({ item: { title: "Update changelog" } }, dir);

    expect(result.satisfied).toBe(true);
    expect(result.context).toContain("git commit created");

    // Verify the commit was made
    const { stdout: logOut } = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: dir });
    expect(logOut.trim()).toBe("Update changelog");
  });
});

describe("Blackbelt-Maintain script: VCS preference", () => {
  test("prefers jj over git when both are present", async () => {
    // jj git init creates both .jj and .git
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-jj-prefer-"));
    await initJjRepo(dir);

    // Make a dirty change
    await writeFile(path.join(dir, "data.json"), '{ "key": "value" }\n', "utf8");

    const result = await runScriptWithStdin({ item: { title: "Add data file" } }, dir);

    expect(result.satisfied).toBe(true);
    // Should use jj, not git
    expect(result.context).toContain("jj checkpoint");
    expect(result.context).not.toContain("git commit");
  });

  test("falls back to git when jj is not a repo", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-git-fallback-"));
    await initGitRepo(dir);

    // Initial commit
    await writeFile(path.join(dir, "initial.txt"), "initial\n", "utf8");
    await execFileAsync("git", ["add", "-A"], { cwd: dir, timeout: 5000 });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir, timeout: 5000 });

    // Dirty change
    await writeFile(path.join(dir, "notes.md"), "# Notes\n", "utf8");

    const result = await runScriptWithStdin({ item: { title: "Add notes" } }, dir);

    expect(result.satisfied).toBe(true);
    expect(result.context).toContain("git commit created");
  });
});

describe("Blackbelt-Maintain script: error and edge cases", () => {
  test("returns satisfied false with context when no title is provided", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-no-title-"));
    await initGitRepo(dir);

    const result = await runScriptWithStdin({ item: { title: "" } }, dir);

    expect(result.satisfied).toBe(false);
    expect(result.context).toContain("no item title available");
  });

  test("returns satisfied false when item is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-no-item-"));
    await initGitRepo(dir);

    const result = await runScriptWithStdin({}, dir);

    expect(result.satisfied).toBe(false);
    expect(result.context).toContain("no item title available");
  });

  test("returns satisfied false when no VCS is detected", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-no-vcs-"));

    const result = await runScriptWithStdin({ item: { title: "No VCS test" } }, dir);

    expect(result.satisfied).toBe(false);
    expect(result.context).toContain("no supported VCS");
  });

  test("returns satisfied false with exit details when jj command fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-jj-fail-"));
    await initJjRepo(dir);

    // Make a change then corrupt jj's store so diff/describe fails
    await writeFile(path.join(dir, "file.txt"), "change\n", "utf8");
    // Remove the internal store to break jj operations while keeping .jj root detectable
    const { rm } = await import("node:fs/promises");
    await rm(path.join(dir, ".jj", "repo", "store"), { recursive: true, force: true });

    const result = await runScriptWithStdin({ item: { title: "Should fail" } }, dir);

    expect(result.satisfied).toBe(false);
    // Either jj command fails in handleJj or the top-level catch
    expect(result.context.includes("jj command failed") || result.context.includes("unexpected error")).toBe(true);
  });

  test("returns satisfied false when git commit fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-bb-git-fail-"));
    await initGitRepo(dir);

    // Initial commit
    await writeFile(path.join(dir, "initial.txt"), "initial\n", "utf8");
    await execFileAsync("git", ["add", "-A"], { cwd: dir, timeout: 5000 });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir, timeout: 5000 });

    // Make a dirty change
    await writeFile(path.join(dir, "file.txt"), "change\n", "utf8");

    // Break git by making .git directory not writable to cause commit to fail
    const { chmod } = await import("node:fs/promises");
    await chmod(path.join(dir, ".git"), 0o500);

    try {
      const result = await runScriptWithStdin({ item: { title: "Should fail git" } }, dir);

      expect(result.satisfied).toBe(false);
      expect(result.context).toContain("git command failed");
    } finally {
      // Restore permissions for cleanup
      await chmod(path.join(dir, ".git"), 0o700).catch(() => {});
    }
  });
});

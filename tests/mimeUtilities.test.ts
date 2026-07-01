import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const bootstrapScript = path.resolve("config", "utilities", "mime-bootstrap.mjs");
const maintainScript = path.resolve("config", "utilities", "mime-maintain.mjs");
const prScript = path.resolve("config", "utilities", "mime-gh-pr.mjs");

// ---------------------------------------------------------------------------
// Fake git for bootstrap tests
// ---------------------------------------------------------------------------
async function makeFakeGitForBootstrap() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-fake-git-bootstrap-"));
  const log = path.join(dir, "git.log");
  const git = path.join(dir, "git");
  await writeFile(
    git,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG"
case "$1" in
  rev-parse)
    if [ "$GIT_NO_REPO" = "1" ]; then
      echo "fatal: not a git repository" >&2
      exit 128
    fi
    pwd
    ;;
  status)
    if [ "$GIT_DIRTY" = "1" ]; then echo "M file.txt"; fi
    ;;
  branch)
    case "$2" in
      --list)
        if [ "$GIT_BRANCH_EXISTS" = "1" ]; then
          echo "  $3"
        fi
        ;;
    esac
    ;;
  checkout)
    if [ "$GIT_CHECKOUT_FAIL" = "1" ]; then
      echo "fatal: checkout failed" >&2
      exit 1
    fi
    # Record the checkout command for assertion
    ;;
esac
`,
    "utf8",
  );
  await chmod(git, 0o755);
  await writeFile(log, "", "utf8");
  return { dir, log };
}

// ---------------------------------------------------------------------------
// Fake git for maintain tests
// ---------------------------------------------------------------------------
async function makeFakeGitForMaintain() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-fake-git-maintain-"));
  const log = path.join(dir, "git.log");
  const git = path.join(dir, "git");
  await writeFile(
    git,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG"
case "$1" in
  rev-parse)
    if [ "$GIT_NO_REPO" = "1" ]; then
      echo "fatal: not a git repository" >&2
      exit 128
    fi
    pwd
    ;;
  status)
    if [ "$GIT_DIRTY" = "1" ]; then
      echo "M file.txt"
      echo "A new-file.txt"
    fi
    ;;
  add)
    # Stage: succeeds
    ;;
  commit)
    if [ "$GIT_COMMIT_FAIL" = "1" ]; then
      echo "fatal: commit failed" >&2
      exit 1
    fi
    # -m is $3, message is $4
    ;;
esac
`,
    "utf8",
  );
  await chmod(git, 0o755);
  await writeFile(log, "", "utf8");
  return { dir, log };
}

// ---------------------------------------------------------------------------
// Fake git for PR tests
// ---------------------------------------------------------------------------
async function makeFakeGitForPr() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-fake-git-pr-"));
  const log = path.join(dir, "git.log");
  const git = path.join(dir, "git");
  await writeFile(
    git,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG"
case "$1" in
  rev-parse)
    if [ "$GIT_NO_REPO" = "1" ]; then
      echo "fatal: not a git repository" >&2
      exit 128
    fi
    pwd
    ;;
  branch)
    case "$2" in
      --show-current)
        if [ "$PR_CURRENT_BRANCH" = "__empty__" ]; then
          :
        elif [ -n "$PR_CURRENT_BRANCH" ]; then
          echo "$PR_CURRENT_BRANCH"
        else
          echo "mime/test-branch"
        fi
        ;;
      --list)
        if [ "$PR_NO_BRANCH" = "1" ]; then
          # Print nothing — branch does not exist
          :
        elif [ -n "$PR_BRANCH_LIST" ]; then
          printf '%s\\n' "$PR_BRANCH_LIST"
        else
          echo "  mime/test-branch"
        fi
        ;;
    esac
    ;;
  remote)
    if [ -n "$GH_REMOTE_URL" ]; then
      echo "$GH_REMOTE_URL"
    else
      echo "https://github.com/test-owner/test-repo.git"
    fi
    ;;
  push)
    if [ "$PR_PUSH_FAIL" = "1" ]; then
      echo "fatal: push failed" >&2
      exit 1
    fi
    ;;
  log)
    if [ "$PR_EMPTY_LOG" = "1" ]; then
      # Output nothing — simulates empty log
      :
    elif [ -n "$PR_LOG_MESSAGE" ]; then
      printf '%s\\n' "$PR_LOG_MESSAGE"
    else
      echo "feat: default commit message"
    fi
    ;;
esac
`,
    "utf8",
  );
  await chmod(git, 0o755);
  await writeFile(log, "", "utf8");
  return { dir, log };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function runUtility(
  script: string,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  const proc = Bun.spawn([process.execPath, script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(`${JSON.stringify(input)}\n`);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, json: JSON.parse(stdout) };
}

async function runBootstrap(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  const fake = await makeFakeGitForBootstrap();
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-mime-bootstrap-cwd-"));
  return {
    result: await runUtility(
      bootstrapScript,
      { cwd, runDir: path.join(cwd, ".pi", "pi-materia", "run"), state: {}, ...input },
      { PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`, GIT_LOG: fake.log, ...env },
    ),
    fake,
  };
}

async function runMaintain(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  const fake = await makeFakeGitForMaintain();
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-mime-maintain-cwd-"));
  return {
    result: await runUtility(
      maintainScript,
      { cwd, state: {}, ...input },
      { PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`, GIT_LOG: fake.log, ...env },
    ),
    fake,
  };
}

function expectAbsoluteHttpUrl(value: unknown): URL {
  expect(typeof value).toBe("string");
  expect((value as string).length).toBeGreaterThan(0);
  const parsed = new URL(value as string);
  expect(parsed.protocol === "http:" || parsed.protocol === "https:").toBe(true);
  expect(parsed.host.length).toBeGreaterThan(0);
  return parsed;
}

// ---------------------------------------------------------------------------
// Fake GitHub API server for PR tests (shared with blackbelt-gh-pr pattern)
// ---------------------------------------------------------------------------
function startFakeGitHubApi() {
  let simulatedApiError: string | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.text().catch(() => "") : "";

      // GET /repos/:owner/:repo → return default_branch
      const repoMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
      if (repoMatch && request.method === "GET") {
        return Response.json({ default_branch: "main", full_name: `${repoMatch[1]}/${repoMatch[2]}` });
      }

      // POST /repos/:owner/:repo/pulls → create PR
      const pullsMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
      if (pullsMatch && request.method === "POST") {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        if (simulatedApiError === "422") {
          return Response.json(
            { message: "Validation Failed: head branch not found" },
            { status: 422 },
          );
        }
        if (simulatedApiError === "401") {
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        }
        return Response.json(
          {
            number: 42,
            html_url: `https://github.com/${pullsMatch[1]}/${pullsMatch[2]}/pull/42`,
            title: parsed.title ?? "Untitled",
            draft: parsed.draft ?? false,
          },
          { status: 201 },
        );
      }

      return new Response("Not Found", { status: 404 });
    },
  });
  return {
    server,
    baseUrl: server.url.origin,
    setSimulatedApiError(code: string | null) {
      simulatedApiError = code;
    },
  };
}

async function runPrUtility(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
  apiBaseUrl: string,
  opts: { noGit?: boolean } = {},
) {
  const fake = opts.noGit ? null : await makeFakeGitForPr();
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-mime-gh-pr-cwd-"));

  const params =
    typeof input.params === "object" && input.params !== null
      ? { ...(input.params as Record<string, unknown>), apiBaseUrl }
      : { apiBaseUrl };

  const proc = Bun.spawn([process.execPath, prScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: fake
        ? `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`
        : (process.env.PATH ?? ""),
      ...(fake ? { GIT_LOG: fake.log } : {}),
      ...env,
    },
  });
  proc.stdin.write(`${JSON.stringify({ cwd, ...input, params })}\n`);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, json: JSON.parse(stdout), fake };
}

// =========================================================================
// Mime-Bootstrap tests
// =========================================================================

describe("Mime-Bootstrap utility script", () => {
  test("generates deterministic noun-verb-hash branch names from castId", async () => {
    const castId = "2026-06-06T19-39-18-566Z";
    const first = await runBootstrap({ castId });
    const second = await runBootstrap({ castId });

    expect(first.result.exitCode).toBe(0);
    expect(second.result.exitCode).toBe(0);
    const branchName = first.result.json.state.mimeBootstrap.branchName;
    expect(branchName).toBe(second.result.json.state.mimeBootstrap.branchName);
    expect(branchName).toMatch(/^mime\/[a-z0-9]+-[a-z]+-[a-f0-9]{10}$/);
    expect(branchName.endsWith(createHash("sha256").update(castId).digest("hex").slice(0, 10))).toBe(true);
    expect(branchName).not.toContain(castId.toLowerCase());
  });

  test("generated names are ref-safe and do not expose raw cast ids", async () => {
    const castId = "Feature/Bad @{Cast} Name.lock 2026-06-06T19:39:18.566Z";
    const { result } = await runBootstrap({ castId });

    expect(result.exitCode).toBe(0);
    const branchName = result.json.state.mimeBootstrap.branchName;
    expect(branchName).toMatch(/^mime\/[a-z0-9]+-[a-z]+-[a-f0-9]{10}$/);
    expect(branchName).not.toContain("feature");
    expect(branchName).not.toContain("name.lock");
    expect(branchName).not.toContain("@{");
    expect(branchName).not.toContain(" ");
  });

  test("preserves explicit branchName as a sanitized override", async () => {
    const { result } = await runBootstrap({
      castId: "ignored-cast-id",
      params: { branchName: "Feature Name.lock" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.state.mimeBootstrap.branchName).toBe("mime/feature-name-lock");
  });

  test("uses cwd as seed when castId is absent", async () => {
    const { result } = await runBootstrap({});

    expect(result.exitCode).toBe(0);
    const branchName = result.json.state.mimeBootstrap.branchName;
    expect(branchName).toMatch(/^mime\/[a-z0-9]+-[a-z]+-[a-f0-9]{10}$/);
  });

  test("uses runDir as seed when castId is absent but runDir is present", async () => {
    const { result } = await runBootstrap({ runDir: "/custom/run/dir" });

    expect(result.exitCode).toBe(0);
    const branchName = result.json.state.mimeBootstrap.branchName;
    expect(branchName).toMatch(/^mime\/[a-z0-9]+-[a-z]+-[a-f0-9]{10}$/);
  });

  test("returns structured state with root and available info on success", async () => {
    const { result } = await runBootstrap({ castId: "2026-06-06T19-39-18-566Z" });

    expect(result.exitCode).toBe(0);
    const state = result.json.state.mimeBootstrap;
    expect(state.ok).toBe(true);
    expect(state.available).toEqual({ git: true });
    expect(typeof state.root).toBe("string");
    expect(state.root.length).toBeGreaterThan(0);
    expect(typeof state.cleanWorkingTree).toBe("boolean");
    expect(typeof state.branchName).toBe("string");
    expect(state.initialized).toBe(false);
  });

  test("fails with clear error when git is not on PATH", async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), "pi-materia-no-git-bootstrap-"));
    try {
      const result = await runUtility(
        bootstrapScript,
        { cwd: "/tmp" },
        { PATH: emptyDir },
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeBootstrap.ok).toBe(false);
      expect(result.json.state.mimeBootstrap.error).toContain("git is required");
      expect(result.json.state.mimeBootstrap.available?.git).toBe(false);
    } finally {
      await rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("fails with clear error outside a git repo", async () => {
    const fake = await makeFakeGitForBootstrap();
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-non-repo-"));
    const result = await runUtility(
      bootstrapScript,
      { cwd },
      { PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`, GIT_NO_REPO: "1" },
    );

    expect(result.exitCode).toBe(1);
    expect(result.json.state.mimeBootstrap.ok).toBe(false);
    expect(result.json.state.mimeBootstrap.error).toContain("no git repository");
    expect(result.json.state.mimeBootstrap.hasGitRepo).toBe(false);
  });

  test("detects clean working tree with status --porcelain", async () => {
    const { result } = await runBootstrap({ castId: "2026-06-06T19-39-18-566Z" });

    expect(result.exitCode).toBe(0);
    expect(result.json.state.mimeBootstrap.cleanWorkingTree).toBe(true);
  });

  test("detects dirty working tree with status --porcelain", async () => {
    const { result } = await runBootstrap(
      { castId: "2026-06-06T19-39-18-566Z" },
      { GIT_DIRTY: "1" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json.state.mimeBootstrap.cleanWorkingTree).toBe(false);
  });

  test("creates new branch with checkout -b when branch does not exist", async () => {
    const { result, fake } = await runBootstrap(
      { castId: "2026-06-06T19-39-18-566Z" },
      { GIT_BRANCH_EXISTS: "0" },
    );

    expect(result.exitCode).toBe(0);
    const logContent = await readFile(fake.log, "utf8");
    expect(logContent).toContain("checkout -b");
    expect(logContent).toContain(`mime/`);
  });

  test("switches to existing branch with checkout when branch already exists", async () => {
    const { result, fake } = await runBootstrap(
      { castId: "2026-06-06T19-39-18-566Z" },
      { GIT_BRANCH_EXISTS: "1" },
    );

    expect(result.exitCode).toBe(0);
    const logContent = await readFile(fake.log, "utf8");
    // Should have 'checkout' but not 'checkout -b'
    expect(logContent).toContain("checkout");
    // branch --list should have been called
    expect(logContent).toContain("branch --list");
  });

  test("does not depend on jj or blackbelt code", async () => {
    const scriptContent = await readFile(bootstrapScript, "utf8");
    expect(scriptContent).not.toContain("bookmark");
    // Must not exec jj — only exec git via execFileText helper
    expect(scriptContent).not.toMatch(/execFile(?:Text)?\(["']jj["']/);
    expect(scriptContent).toMatch(/execFile(?:Text)?\(["']git["']/);
  });
});

// =========================================================================
// Mime-Maintain tests
// =========================================================================

describe("Mime-Maintain utility script", () => {
  test("stages and commits with workItem title as commit message", async () => {
    const { result, fake } = await runMaintain(
      { item: { title: "feat: add mime support" } },
      { GIT_DIRTY: "1" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json.state.mimeMaintain.ok).toBe(true);
    expect(result.json.state.mimeMaintain.committed).toBe(true);
    expect(result.json.state.mimeMaintain.noop).toBe(false);
    expect(result.json.state.mimeMaintain.message).toBe("feat: add mime support");

    const logContent = await readFile(fake.log, "utf8");
    expect(logContent).toContain("add -A");
    expect(logContent).toContain("commit -m feat: add mime support");
  });

  test("reports deterministic no-op when working tree is clean", async () => {
    const { result } = await runMaintain(
      { item: { title: "feat: nothing to commit" } },
      { GIT_DIRTY: "0" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json.state.mimeMaintain.ok).toBe(true);
    expect(result.json.state.mimeMaintain.committed).toBe(false);
    expect(result.json.state.mimeMaintain.noop).toBe(true);
    expect(result.json.state.mimeMaintain.message).toContain("working tree clean");
  });

  test("fails with clear error when git is not available", async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), "pi-materia-no-git-maintain-"));
    try {
      const result = await runUtility(
        maintainScript,
        { cwd: "/tmp", item: { title: "fix: test" } },
        { PATH: emptyDir },
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeMaintain.ok).toBe(false);
      expect(result.json.state.mimeMaintain.error).toContain("git is required");
      expect(result.json.state.mimeMaintain.available?.git).toBe(false);
    } finally {
      await rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("fails with clear error outside a git repo", async () => {
    const fake = await makeFakeGitForMaintain();
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-non-repo-"));
    const result = await runUtility(
      maintainScript,
      { cwd, item: { title: "fix: no repo" } },
      { PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`, GIT_NO_REPO: "1" },
    );

    expect(result.exitCode).toBe(1);
    expect(result.json.state.mimeMaintain.ok).toBe(false);
    expect(result.json.state.mimeMaintain.error).toContain("no git repository");
    expect(result.json.state.mimeMaintain.hasGitRepo).toBe(false);
  });

  test("fails with clear error when no item title is available", async () => {
    const { result } = await runMaintain({});

    expect(result.exitCode).toBe(1);
    expect(result.json.state.mimeMaintain.ok).toBe(false);
    expect(result.json.state.mimeMaintain.error).toContain("no item title");
  });

  test("fails with clear error when item.title is empty string", async () => {
    const { result } = await runMaintain({ item: { title: "" } });

    expect(result.exitCode).toBe(1);
    expect(result.json.state.mimeMaintain.ok).toBe(false);
    expect(result.json.state.mimeMaintain.error).toContain("no item title");
  });

  test("reads branchName from state.mimeBootstrap for status reference", async () => {
    const { result } = await runMaintain(
      {
        item: { title: "chore: with bootstrap state" },
        state: { mimeBootstrap: { branchName: "mime/crystal-casts-abc123def0" } },
      },
      { GIT_DIRTY: "1" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json.state.mimeMaintain.ok).toBe(true);
    expect(result.json.state.mimeMaintain.branchName).toBe("mime/crystal-casts-abc123def0");
  });

  test("branchName is null when bootstrap state is absent", async () => {
    const { result } = await runMaintain(
      { item: { title: "fix: no bootstrap" }, state: {} },
      { GIT_DIRTY: "1" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json.state.mimeMaintain.ok).toBe(true);
    expect(result.json.state.mimeMaintain.branchName).toBeNull();
  });

  test("preserves noop state with branchName when clean", async () => {
    const { result } = await runMaintain(
      {
        item: { title: "chore: clean" },
        state: { mimeBootstrap: { branchName: "mime/ribbon-guards-bdf5a27220" } },
      },
      { GIT_DIRTY: "0" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json.state.mimeMaintain.ok).toBe(true);
    expect(result.json.state.mimeMaintain.noop).toBe(true);
    expect(result.json.state.mimeMaintain.branchName).toBe("mime/ribbon-guards-bdf5a27220");
  });

  test("does not depend on jj or blackbelt code", async () => {
    const scriptContent = await readFile(maintainScript, "utf8");
    expect(scriptContent).not.toContain("bookmark");
    expect(scriptContent).not.toContain("checkpoint");
    // Must not exec jj — only exec git via execFileText helper
    expect(scriptContent).not.toMatch(/execFile(?:Text)?\(["']jj["']/);
    expect(scriptContent).toMatch(/execFile(?:Text)?\(["']git["']/);
  });
});

// =========================================================================
// Mime-GH-PR tests
// =========================================================================

describe("Mime-GH-PR utility script", () => {
  test("fails with clear error when git is not available (no jj fallback)", async () => {
    const api = startFakeGitHubApi();
    try {
      const sanitizedPath = ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter);

      const result = await runPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PATH: sanitizedPath },
        api.baseUrl,
        { noGit: true },
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.error).toMatch(/git is required|git|git/);
    } finally {
      api.server.stop();
    }
  });

  test("fails with clear error when GITHUB_TOKEN is missing", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { GITHUB_TOKEN: "" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.error).toContain("GITHUB_TOKEN");
      expect(result.json.state.mimeGhPr.tokenFound).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails with clear error when configured authEnv variable is missing", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: { branch: "mime/test-branch", authEnv: "GH_PAT" },
          state: {},
        },
        { GITHUB_TOKEN: "wrong-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.error).toContain("GH_PAT");
      expect(result.json.state.mimeGhPr.tokenFound).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails when branch does not exist", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: { branch: "nonexistent-branch" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_NO_BRANCH: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.error).toContain("nonexistent-branch");
      expect(result.json.state.mimeGhPr.branchExists).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails when push to remote fails", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_PUSH_FAIL: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.error).toContain("push failed");
      expect(result.json.state.mimeGhPr.pushOk).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails on GitHub API error (422)", async () => {
    const api = startFakeGitHubApi();
    api.setSimulatedApiError("422");
    try {
      const result = await runPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.error).toContain("GitHub API error");
      expect(result.json.state.mimeGhPr.apiStatus).toBe(422);
    } finally {
      api.server.stop();
    }
  });

  test("fails on GitHub API auth error (401)", async () => {
    const api = startFakeGitHubApi();
    api.setSimulatedApiError("401");
    try {
      const result = await runPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.error).toContain("Bad credentials");
      expect(result.json.state.mimeGhPr.apiStatus).toBe(401);
    } finally {
      api.server.stop();
    }
  });

  test("fails outside a git repo", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", GIT_NO_REPO: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.error).toContain("no git repository");
    } finally {
      api.server.stop();
    }
  });

  test("fails when no branch can be resolved", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {},
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_CURRENT_BRANCH: "__empty__" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.error).toContain("no branch resolved");
    } finally {
      api.server.stop();
    }
  });

  test("successfully pushes branch and creates PR with explicit params", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            title: "feat: custom pr title",
            body: "This is a test PR body.",
            base: "develop",
            draft: true,
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeGhPr.ok).toBe(true);
      expect(result.json.state.mimeGhPr.prNumber).toBe(42);
      expect(result.json.state.mimeGhPr.prUrl).toBe("https://github.com/test-owner/test-repo/pull/42");
      expect(result.json.state.mimeGhPr.branchName).toBe("mime/test-branch");
      expect(result.json.state.mimeGhPr.title).toBe("feat: custom pr title");
      expect(result.json.state.mimeGhPr.base).toBe("develop");
      expect(result.json.state.mimeGhPr.draft).toBe(true);
      expect(result.json.state.mimeGhPr.repo).toBe("test-owner/test-repo");
    } finally {
      api.server.stop();
    }
  });

  test("infers PR title from latest commit message when params.title is absent", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_LOG_MESSAGE: "fix: inferred from git log\n\nBody text here." },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeGhPr.ok).toBe(true);
      expect(result.json.state.mimeGhPr.title).toBe("fix: inferred from git log");
    } finally {
      api.server.stop();
    }
  });

  test("falls back to branch name when git log is empty", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_EMPTY_LOG: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeGhPr.ok).toBe(true);
      expect(result.json.state.mimeGhPr.title).toBe("mime/test-branch");
    } finally {
      api.server.stop();
    }
  });

  test("resolves branch from bootstrap state when params.branch is absent", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            repo: "test-owner/test-repo",
            title: "chore: from bootstrap state",
          },
          state: {
            mimeBootstrap: {
              branchName: "mime/test-branch",
            },
          },
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeGhPr.ok).toBe(true);
      expect(result.json.state.mimeGhPr.branchName).toBe("mime/test-branch");
      expect(result.json.state.mimeGhPr.title).toBe("chore: from bootstrap state");
    } finally {
      api.server.stop();
    }
  });

  test("resolves branch from git branch --show-current as last resort", async () => {
    const api = startFakeGitHubApi();
    try {
      // With no params.branch and no bootstrap state, uses --show-current
      const result = await runPrUtility(
        {
          params: {
            repo: "test-owner/test-repo",
            title: "test: from current branch",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeGhPr.ok).toBe(true);
      expect(result.json.state.mimeGhPr.branchName).toBe("mime/test-branch");
    } finally {
      api.server.stop();
    }
  });

  test("uses custom authEnv to locate the token", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            repo: "test-owner/test-repo",
            title: "test: custom auth env",
            authEnv: "CUSTOM_GH_TOKEN",
          },
          state: {},
        },
        { CUSTOM_GH_TOKEN: "custom-token-value" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeGhPr.ok).toBe(true);
    } finally {
      api.server.stop();
    }
  });

  test("pushes with -u flag to set upstream tracking", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            repo: "test-owner/test-repo",
            title: "test: push upstream",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      const logContent = await readFile(result.fake!.log, "utf8");
      expect(logContent).toContain("push -u");
      expect(logContent).toContain("mime/test-branch");
    } finally {
      api.server.stop();
    }
  });

  test("uses custom remote when params.remote is provided", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            remote: "upstream",
            repo: "test-owner/test-repo",
            title: "test: custom remote",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", GH_REMOTE_URL: "https://github.com/test-owner/test-repo.git" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeGhPr.ok).toBe(true);
      const logContent = await readFile(result.fake!.log, "utf8");
      expect(logContent).toContain("remote get-url upstream");
    } finally {
      api.server.stop();
    }
  });

  test("parses GitHub owner/repo from remote URL automatically", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            title: "test: auto repo",
          },
          state: {},
        },
        {
          GITHUB_TOKEN: "test-token",
          GH_REMOTE_URL: "https://github.com/auto-owner/auto-repo.git",
        },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeGhPr.ok).toBe(true);
      expect(result.json.state.mimeGhPr.repo).toBe("auto-owner/auto-repo");
    } finally {
      api.server.stop();
    }
  });

  test("does not depend on jj or blackbelt code", async () => {
    const scriptContent = await readFile(prScript, "utf8");
    expect(scriptContent).not.toContain("bookmark");
    // Must not exec jj — only exec git via execFileText helper
    expect(scriptContent).not.toMatch(/execFile(?:Text)?\(["']jj["']/);
    expect(scriptContent).toMatch(/execFile(?:Text)?\(["']git["']/);
  });

  test("no jj fallback — error message mentions git, not jj", async () => {
    const api = startFakeGitHubApi();
    try {
      const sanitizedPath = ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter);

      const result = await runPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PATH: sanitizedPath },
        api.baseUrl,
        { noGit: true },
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      // Error should mention git, not jj
      expect(result.json.state.mimeGhPr.error).toMatch(/git/);
      expect(result.json.state.mimeGhPr.error).not.toMatch(/\bjj\b/);
    } finally {
      api.server.stop();
    }
  });

  test("emits result.pr_created event on successful PR creation", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            title: "feat: mime gh pr event test",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeGhPr.ok).toBe(true);
      expect(result.json.event).toBeDefined();
      expect(Array.isArray(result.json.event)).toBe(true);
      expect(result.json.event).toHaveLength(1);
      expect(result.json.event[0].type).toBe("result.pr_created");
      expect(result.json.event[0].message).toContain("PR #42");
      expect(result.json.event[0].payload.prUrl).toBe("https://github.com/test-owner/test-repo/pull/42");
      // Strengthen: prUrl must parse as an absolute http(s) URL, not merely match a string.
      expectAbsoluteHttpUrl(result.json.event[0].payload.prUrl);
      expect(result.json.event[0].payload.prNumber).toBe(42);
      expect(result.json.event[0].payload.branchName).toBe("mime/test-branch");
      expect(result.json.event[0].payload.baseBranch).toBe("main");
      expect(result.json.event[0].payload.repo).toBe("test-owner/test-repo");
    } finally {
      api.server.stop();
    }
  });

  test("pushOnly mode emits result.branch_pushed and does not create a PR", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            pushOnly: true,
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeGhPr.ok).toBe(true);
      expect(result.json.state.mimeGhPr.pushOnly).toBe(true);
      expect(result.json.state.mimeGhPr.prNumber).toBeUndefined();
      expect(result.json.state.mimeGhPr.prUrl).toBeUndefined();
      expect(result.json.event).toBeDefined();
      expect(result.json.event).toHaveLength(1);
      expect(result.json.event[0].type).toBe("result.branch_pushed");
      expect(result.json.event[0].message).toContain("pushed");
      expect(result.json.event[0].message).toContain("mime/test-branch");
      expect(result.json.event[0].payload.branchName).toBe("mime/test-branch");
      expect(result.json.event[0].payload.remote).toBe("origin");
      expect(result.json.event[0].payload.repo).toBe("test-owner/test-repo");
    } finally {
      api.server.stop();
    }
  });

  test("error output does not include an event array", async () => {
    const api = startFakeGitHubApi();
    api.setSimulatedApiError("422");
    try {
      const result = await runPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            title: "test: error path",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      // Error output must not include an event array.
      expect(result.json.event).toBeUndefined();
    } finally {
      api.server.stop();
    }
  });
});

// ===========================================================================
// Mime-ADO-PR tests
// ===========================================================================

const adoPrScript = path.resolve("config", "utilities", "mime-ado-pr.mjs");

function startFakeAdoApi() {
  let simulatedApiError: string | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.text().catch(() => "") : "";

      // GET /org/project/_apis/git/repositories/repo → return defaultBranch
      const repoMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)\/_apis\/git\/repositories\/([^/]+)$/);
      if (repoMatch && request.method === "GET") {
        return Response.json({ defaultBranch: "refs/heads/main", name: repoMatch[3] });
      }

      // POST /org/project/_apis/git/repositories/repo/pullrequests → create PR
      const pullsMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullrequests$/);
      if (pullsMatch && request.method === "POST") {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        if (simulatedApiError === "422") {
          return Response.json({ message: "Validation Failed: source ref not found" }, { status: 422 });
        }
        if (simulatedApiError === "401") {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }
        return Response.json({
          pullRequestId: 99,
          title: parsed.title ?? "Untitled",
          isDraft: parsed.isDraft ?? false,
        }, { status: 201 });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
  return {
    server,
    baseUrl: server.url.origin,
    setSimulatedApiError(code: string | null) { simulatedApiError = code; },
  };
}

async function makeFakeGitForAdoPr() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-fake-git-ado-pr-"));
  const log = path.join(dir, "git.log");
  const git = path.join(dir, "git");
  await writeFile(
    git,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG"
case "$1" in
  rev-parse)
    if [ "$GIT_NO_REPO" = "1" ]; then
      echo "fatal: not a git repository" >&2
      exit 128
    fi
    pwd
    ;;
  branch)
    case "$2" in
      --show-current)
        if [ "$PR_CURRENT_BRANCH" = "__empty__" ]; then
          :
        elif [ -n "$PR_CURRENT_BRANCH" ]; then
          echo "$PR_CURRENT_BRANCH"
        else
          echo "mime/test-branch"
        fi
        ;;
      --list)
        if [ "$PR_NO_BRANCH" = "1" ]; then
          :
        elif [ -n "$PR_BRANCH_LIST" ]; then
          printf '%s\\n' "$PR_BRANCH_LIST"
        else
          echo "  mime/test-branch"
        fi
        ;;
    esac
    ;;
  remote)
    if [ -n "$ADO_REMOTE_URL" ]; then
      echo "$ADO_REMOTE_URL"
    else
      echo "https://dev.azure.com/test-org/test-project/_git/test-repo"
    fi
    ;;
  push)
    if [ "$PR_PUSH_FAIL" = "1" ]; then
      echo "fatal: push failed" >&2
      exit 1
    fi
    ;;
  log)
    if [ "$PR_EMPTY_LOG" = "1" ]; then
      :
    elif [ -n "$PR_LOG_MESSAGE" ]; then
      printf '%s\\n' "$PR_LOG_MESSAGE"
    else
      echo "feat: default commit message"
    fi
    ;;
esac
`,
    "utf8",
  );
  await chmod(git, 0o755);
  await writeFile(log, "", "utf8");
  return { dir, log };
}

async function runAdoPrUtility(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
  apiBaseUrl: string,
  opts: { noGit?: boolean } = {},
) {
  const fake = opts.noGit ? null : await makeFakeGitForAdoPr();
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-mime-ado-pr-cwd-"));

  const params =
    typeof input.params === "object" && input.params !== null
      ? { ...(input.params as Record<string, unknown>), apiBaseUrl }
      : { apiBaseUrl };

  const proc = Bun.spawn([process.execPath, adoPrScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: fake
        ? `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`
        : (process.env.PATH ?? ""),
      ...(fake ? { GIT_LOG: fake.log } : {}),
      ...env,
    },
  });
  proc.stdin.write(`${JSON.stringify({ cwd, ...input, params })}\n`);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, json: JSON.parse(stdout), fake };
}

describe("Mime-ADO-PR utility script", () => {
  test("fails with clear error when git is not available (no jj fallback)", async () => {
    const api = startFakeAdoApi();
    try {
      const sanitizedPath = ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter);

      const result = await runAdoPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token", PATH: sanitizedPath },
        api.baseUrl,
        { noGit: true },
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.error).toMatch(/git is required|git/);
    } finally {
      api.server.stop();
    }
  });

  test("fails with clear error when AZURE_DEVOPS_EXT_PAT is missing", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.error).toContain("AZURE_DEVOPS_EXT_PAT");
      expect(result.json.state.mimeAdoPr.tokenFound).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails with clear error when configured authEnv variable is missing", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: { branch: "mime/test-branch", authEnv: "ADO_PAT" },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "wrong-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.error).toContain("ADO_PAT");
      expect(result.json.state.mimeAdoPr.tokenFound).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails when branch does not exist", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: { branch: "nonexistent-branch" },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token", PR_NO_BRANCH: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.error).toContain("nonexistent-branch");
      expect(result.json.state.mimeAdoPr.branchExists).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails when push to remote fails", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token", PR_PUSH_FAIL: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.error).toContain("push failed");
      expect(result.json.state.mimeAdoPr.pushOk).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails on ADO API error (422)", async () => {
    const api = startFakeAdoApi();
    api.setSimulatedApiError("422");
    try {
      const result = await runAdoPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.error).toContain("Azure DevOps API error");
      expect(result.json.state.mimeAdoPr.apiStatus).toBe(422);
    } finally {
      api.server.stop();
    }
  });

  test("fails on ADO API auth error (401)", async () => {
    const api = startFakeAdoApi();
    api.setSimulatedApiError("401");
    try {
      const result = await runAdoPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.error).toContain("Unauthorized");
      expect(result.json.state.mimeAdoPr.apiStatus).toBe(401);
    } finally {
      api.server.stop();
    }
  });

  test("fails outside a git repo", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token", GIT_NO_REPO: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.error).toContain("no git repository");
    } finally {
      api.server.stop();
    }
  });

  test("fails when no branch can be resolved", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: {},
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token", PR_CURRENT_BRANCH: "__empty__" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.error).toContain("no branch resolved");
    } finally {
      api.server.stop();
    }
  });

  test("successfully pushes branch and creates ADO PR with explicit params", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            title: "feat: custom ado pr title",
            body: "This is a test ADO PR body.",
            base: "develop",
            draft: true,
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeAdoPr.ok).toBe(true);
      expect(result.json.state.mimeAdoPr.prNumber).toBe(99);
      expect(result.json.state.mimeAdoPr.prUrl).toBe("https://dev.azure.com/test-org/test-project/_git/test-repo/pullrequest/99");
      expect(result.json.state.mimeAdoPr.branchName).toBe("mime/test-branch");
      expect(result.json.state.mimeAdoPr.title).toBe("feat: custom ado pr title");
      expect(result.json.state.mimeAdoPr.base).toBe("develop");
      expect(result.json.state.mimeAdoPr.draft).toBe(true);
      expect(result.json.state.mimeAdoPr.organization).toBe("test-org");
      expect(result.json.state.mimeAdoPr.project).toBe("test-project");
      expect(result.json.state.mimeAdoPr.repository).toBe("test-repo");
    } finally {
      api.server.stop();
    }
  });

  test("infers PR title from latest commit message when params.title is absent", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token", PR_LOG_MESSAGE: "fix: inferred from git log\n\nBody text here." },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeAdoPr.ok).toBe(true);
      expect(result.json.state.mimeAdoPr.title).toBe("fix: inferred from git log");
    } finally {
      api.server.stop();
    }
  });

  test("falls back to branch name when git log is empty", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token", PR_EMPTY_LOG: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeAdoPr.ok).toBe(true);
      expect(result.json.state.mimeAdoPr.title).toBe("mime/test-branch");
    } finally {
      api.server.stop();
    }
  });

  test("resolves branch from bootstrap state when params.branch is absent", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: {
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
            title: "chore: from bootstrap state",
          },
          state: {
            mimeBootstrap: {
              branchName: "mime/test-branch",
            },
          },
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeAdoPr.ok).toBe(true);
      expect(result.json.state.mimeAdoPr.branchName).toBe("mime/test-branch");
      expect(result.json.state.mimeAdoPr.title).toBe("chore: from bootstrap state");
    } finally {
      api.server.stop();
    }
  });

  test("parses ADO org/project/repo from remote URL automatically", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            title: "test: auto ado config",
          },
          state: {},
        },
        {
          AZURE_DEVOPS_EXT_PAT: "test-token",
          ADO_REMOTE_URL: "https://dev.azure.com/auto-org/auto-project/_git/auto-repo",
        },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeAdoPr.ok).toBe(true);
      expect(result.json.state.mimeAdoPr.organization).toBe("auto-org");
      expect(result.json.state.mimeAdoPr.project).toBe("auto-project");
      expect(result.json.state.mimeAdoPr.repository).toBe("auto-repo");
    } finally {
      api.server.stop();
    }
  });

  test("resolves ADO config from params.repo as org/project/repo", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            repo: "repo-org/repo-project/repo-name",
            title: "test: repo param",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeAdoPr.ok).toBe(true);
      expect(result.json.state.mimeAdoPr.organization).toBe("repo-org");
      expect(result.json.state.mimeAdoPr.project).toBe("repo-project");
      expect(result.json.state.mimeAdoPr.repository).toBe("repo-name");
    } finally {
      api.server.stop();
    }
  });

  test("uses custom authEnv to locate the token", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
            title: "test: custom auth env",
            authEnv: "CUSTOM_ADO_TOKEN",
          },
          state: {},
        },
        { CUSTOM_ADO_TOKEN: "custom-token-value" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeAdoPr.ok).toBe(true);
    } finally {
      api.server.stop();
    }
  });

  test("pushes with -u flag to set upstream tracking", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
            title: "test: push upstream",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      const logContent = await readFile(result.fake!.log, "utf8");
      expect(logContent).toContain("push -u");
      expect(logContent).toContain("mime/test-branch");
    } finally {
      api.server.stop();
    }
  });

  test("does not depend on jj or blackbelt code", async () => {
    const scriptContent = await readFile(adoPrScript, "utf8");
    expect(scriptContent).not.toContain("bookmark");
    expect(scriptContent).not.toMatch(/execFile(?:Text)?\(["']jj["']/);
    expect(scriptContent).toMatch(/execFile(?:Text)?\(["']git["']/);
  });

  test("no jj fallback — error message mentions git, not jj", async () => {
    const api = startFakeAdoApi();
    try {
      const sanitizedPath = ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter);

      const result = await runAdoPrUtility(
        {
          params: { branch: "mime/test-branch" },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token", PATH: sanitizedPath },
        api.baseUrl,
        { noGit: true },
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.error).toMatch(/git/);
      expect(result.json.state.mimeAdoPr.error).not.toMatch(/\bjj\b/);
    } finally {
      api.server.stop();
    }
  });

  test("emits result.pr_created event on successful PR creation", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            title: "feat: mime ado pr event test",
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeAdoPr.ok).toBe(true);
      expect(result.json.event).toBeDefined();
      expect(Array.isArray(result.json.event)).toBe(true);
      expect(result.json.event).toHaveLength(1);
      expect(result.json.event[0].type).toBe("result.pr_created");
      expect(result.json.event[0].message).toContain("PR #99");
      expect(result.json.event[0].payload.prUrl).toBe("https://dev.azure.com/test-org/test-project/_git/test-repo/pullrequest/99");
      // Strengthen: prUrl must parse as an absolute http(s) URL, not merely match a string.
      expectAbsoluteHttpUrl(result.json.event[0].payload.prUrl);
      expect(result.json.event[0].payload.prNumber).toBe(99);
      expect(result.json.event[0].payload.branchName).toBe("mime/test-branch");
      expect(result.json.event[0].payload.organization).toBe("test-org");
      expect(result.json.event[0].payload.project).toBe("test-project");
      expect(result.json.event[0].payload.repository).toBe("test-repo");
    } finally {
      api.server.stop();
    }
  });

  test("pushOnly mode emits result.branch_pushed and does not create a PR", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            pushOnly: true,
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeAdoPr.ok).toBe(true);
      expect(result.json.state.mimeAdoPr.pushOnly).toBe(true);
      expect(result.json.state.mimeAdoPr.prNumber).toBeUndefined();
      expect(result.json.state.mimeAdoPr.prUrl).toBeUndefined();
      expect(result.json.event).toBeDefined();
      expect(result.json.event).toHaveLength(1);
      expect(result.json.event[0].type).toBe("result.branch_pushed");
      expect(result.json.event[0].message).toContain("pushed");
      expect(result.json.event[0].message).toContain("mime/test-branch");
      expect(result.json.event[0].payload.branchName).toBe("mime/test-branch");
      expect(result.json.event[0].payload.remote).toBe("origin");
      expect(result.json.event[0].payload.organization).toBe("test-org");
      expect(result.json.event[0].payload.project).toBe("test-project");
      expect(result.json.event[0].payload.repository).toBe("test-repo");
    } finally {
      api.server.stop();
    }
  });

  test("error output does not include an event array", async () => {
    const api = startFakeAdoApi();
    api.setSimulatedApiError("422");
    try {
      const result = await runAdoPrUtility(
        {
          params: {
            branch: "mime/test-branch",
            title: "test: error path",
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      // Error output must not include an event array.
      expect(result.json.event).toBeUndefined();
    } finally {
      api.server.stop();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function expectAbsoluteHttpUrl(value: unknown): URL {
  expect(typeof value).toBe("string");
  expect((value as string).length).toBeGreaterThan(0);
  const parsed = new URL(value as string);
  expect(parsed.protocol === "http:" || parsed.protocol === "https:").toBe(true);
  expect(parsed.host.length).toBeGreaterThan(0);
  return parsed;
}

// ---------------------------------------------------------------------------
// Utility registration / naming tests — load default config directly
// ---------------------------------------------------------------------------

const defaultConfigPath = path.resolve("config", "default.json");

async function loadDefaultConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(defaultConfigPath, "utf8"));
}

describe("Mime PR utility registration (default config)", () => {
  test("Mime-GH-PR is registered with correct shipped-utility shape", async () => {
    const config = await loadDefaultConfig();
    const materia = (config.materia as Record<string, unknown>)["Mime-GH-PR"] as Record<string, unknown>;

    expect(materia).toBeDefined();
    expect(materia.type).toBe("utility");
    expect(materia.label).toBe("Mime-GH-PR");
    expect(materia.group).toBe("Utility");
    expect(materia.parse).toBe("json");
    expect(materia.script).toEqual({ kind: "shippedUtility", name: "mime-gh-pr.mjs", runtime: "node" });
    expect(typeof materia.description).toBe("string");
    expect((materia.description as string).length).toBeGreaterThan(0);
    expect((materia.description as string).toLowerCase()).toContain("github");
    expect((materia.description as string).toLowerCase()).toContain("pull request");
    expect(materia.assign).toBeUndefined();
    expect(materia.command).toBeUndefined();
  });

  test("Mime-ADO-PR is registered with correct shipped-utility shape", async () => {
    const config = await loadDefaultConfig();
    const materia = (config.materia as Record<string, unknown>)["Mime-ADO-PR"] as Record<string, unknown>;

    expect(materia).toBeDefined();
    expect(materia.type).toBe("utility");
    expect(materia.label).toBe("Mime-ADO-PR");
    expect(materia.group).toBe("Utility");
    expect(materia.parse).toBe("json");
    expect(materia.script).toEqual({ kind: "shippedUtility", name: "mime-ado-pr.mjs", runtime: "node" });
    expect(typeof materia.description).toBe("string");
    expect((materia.description as string).length).toBeGreaterThan(0);
    expect((materia.description as string).toLowerCase()).toContain("azure devops");
    expect((materia.description as string).toLowerCase()).toContain("pull request");
    expect(materia.assign).toBeUndefined();
    expect(materia.command).toBeUndefined();
  });

  test("GH and ADO PR utility labels embed platform specificity", async () => {
    const config = await loadDefaultConfig();
    const materia = config.materia as Record<string, unknown>;

    const ghLabel = (materia["Mime-GH-PR"] as Record<string, unknown>)?.label;
    const adoLabel = (materia["Mime-ADO-PR"] as Record<string, unknown>)?.label;

    expect(ghLabel).toBe("Mime-GH-PR");
    expect(adoLabel).toBe("Mime-ADO-PR");
    expect(ghLabel).not.toBe(adoLabel);
  });

  test("Mime-Bootstrap and Mime-Maintain are still registered for git workflow support", async () => {
    const config = await loadDefaultConfig();
    const materia = config.materia as Record<string, unknown>;

    expect(materia["Mime-Bootstrap"]).toBeDefined();
    expect((materia["Mime-Bootstrap"] as Record<string, unknown>)?.type).toBe("utility");
    expect(materia["Mime-Maintain"]).toBeDefined();
    expect((materia["Mime-Maintain"] as Record<string, unknown>)?.type).toBe("utility");
  });
});

// ---------------------------------------------------------------------------
// Representative mocked behavior — Mime-GH-PR
// ---------------------------------------------------------------------------

const ghPrScript = path.resolve("config", "utilities", "mime-gh-pr.mjs");

async function makeFakeGitForPr() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-ut-fake-git-gh-"));
  const log = path.join(dir, "git.log");
  const git = path.join(dir, "git");
  await writeFile(
    git,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG"
case "$1" in
  rev-parse)
    if [ "$GIT_NO_REPO" = "1" ]; then echo "fatal: not a git repository" >&2; exit 128; fi
    pwd
    ;;
  branch)
    case "$2" in
      --show-current)
        if [ -n "$PR_CURRENT_BRANCH" ]; then echo "$PR_CURRENT_BRANCH"; else echo "mime/test-branch"; fi
        ;;
      --list)
        if [ "$PR_NO_BRANCH" = "1" ]; then : ; else echo "  mime/test-branch"; fi
        ;;
    esac
    ;;
  remote)
    if [ -n "$GH_REMOTE_URL" ]; then echo "$GH_REMOTE_URL"; else echo "https://github.com/test-owner/test-repo.git"; fi
    ;;
  push)
    if [ "$PR_PUSH_FAIL" = "1" ]; then echo "fatal: push failed" >&2; exit 1; fi
    ;;
  log)
    if [ -n "$PR_LOG_MESSAGE" ]; then printf '%s\\n' "$PR_LOG_MESSAGE"; else echo "feat: default commit message"; fi
    ;;
esac
`,
    "utf8",
  );
  await chmod(git, 0o755);
  await writeFile(log, "", "utf8");
  return { dir, log };
}

function startFakeGitHubApi() {
  let simulatedStatus = 201;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      const repoMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
      if (repoMatch && request.method === "GET") {
        return Response.json({ default_branch: "main", full_name: `${repoMatch[1]}/${repoMatch[2]}` });
      }

      const pullsMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
      if (pullsMatch && request.method === "POST") {
        const body = await request.text().catch(() => "");
        const parsed = JSON.parse(body || "{}");
        if (simulatedStatus === 422) {
          return Response.json({ message: "Validation Failed: head branch not found" }, { status: 422 });
        }
        if (simulatedStatus === 401) {
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        }
        return Response.json({
          number: 42,
          html_url: `https://github.com/${pullsMatch[1]}/${pullsMatch[2]}/pull/42`,
          title: parsed.title ?? "Untitled",
          draft: parsed.draft ?? false,
        }, { status: 201 });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
  return {
    server,
    baseUrl: server.url.origin,
    setStatus(s: number) { simulatedStatus = s; },
  };
}

async function runGhPr(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
  apiBaseUrl: string,
  opts: { noGit?: boolean } = {},
) {
  const fake = opts.noGit ? null : await makeFakeGitForPr();
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-ut-mime-gh-pr-cwd-"));

  const params = typeof input.params === "object" && input.params !== null
    ? { ...input.params as Record<string, unknown>, apiBaseUrl }
    : { apiBaseUrl };

  const proc = Bun.spawn([process.execPath, ghPrScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: fake ? `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
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

describe("Mime-GH-PR mocked behavior", () => {
  test("successfully creates a GitHub PR with explicit params", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: {
            branch: "mime/test-branch",
            title: "feat: test mime gh pr",
            body: "PR body content",
            base: "main",
            draft: false,
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
      expect(result.json.state.mimeGhPr.title).toBe("feat: test mime gh pr");
      expect(result.json.state.mimeGhPr.base).toBe("main");
      expect(result.json.state.mimeGhPr.draft).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails with auth error when GITHUB_TOKEN is missing", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: { branch: "mime/test-branch", repo: "test-owner/test-repo" },
          state: {},
        },
        { GITHUB_TOKEN: "" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.tokenFound).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails when branch does not exist", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: { branch: "nonexistent-branch", repo: "test-owner/test-repo" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_NO_BRANCH: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.branchExists).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("resolves branch from bootstrap state when params.branch is absent", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: { repo: "test-owner/test-repo", title: "from state" },
          state: { mimeBootstrap: { branchName: "mime/test-branch" } },
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

  test("infers PR title from git log when params.title is absent", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: { branch: "mime/test-branch", repo: "test-owner/test-repo" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_LOG_MESSAGE: "fix: inferred from git log" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeGhPr.ok).toBe(true);
      expect(result.json.state.mimeGhPr.title).toBe("fix: inferred from git log");
    } finally {
      api.server.stop();
    }
  });

  test("fails when push to remote fails", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: { branch: "mime/test-branch", title: "test", repo: "test-owner/test-repo" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_PUSH_FAIL: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeGhPr.ok).toBe(false);
      expect(result.json.state.mimeGhPr.pushOk).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("uses custom authEnv to locate the token", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: {
            branch: "mime/test-branch",
            repo: "test-owner/test-repo",
            title: "test: custom auth",
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

  test("emits result.pr_created event on successful PR creation", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
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
      const result = await runGhPr(
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
    api.setStatus(422);
    try {
      const result = await runGhPr(
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

// ---------------------------------------------------------------------------
// Representative mocked behavior — Mime-ADO-PR
// ---------------------------------------------------------------------------

const adoPrScript = path.resolve("config", "utilities", "mime-ado-pr.mjs");

async function makeFakeGitForAdoPr() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-ut-fake-git-ado-"));
  const log = path.join(dir, "git.log");
  const git = path.join(dir, "git");
  await writeFile(
    git,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG"
case "$1" in
  rev-parse)
    if [ "$GIT_NO_REPO" = "1" ]; then echo "fatal: not a git repository" >&2; exit 128; fi
    pwd
    ;;
  branch)
    case "$2" in
      --show-current)
        if [ -n "$PR_CURRENT_BRANCH" ]; then echo "$PR_CURRENT_BRANCH"; else echo "mime/test-branch"; fi
        ;;
      --list)
        if [ "$PR_NO_BRANCH" = "1" ]; then : ; else echo "  mime/test-branch"; fi
        ;;
    esac
    ;;
  remote)
    if [ -n "$ADO_REMOTE_URL" ]; then echo "$ADO_REMOTE_URL"; else echo "https://dev.azure.com/test-org/test-project/_git/test-repo"; fi
    ;;
  push)
    if [ "$PR_PUSH_FAIL" = "1" ]; then echo "fatal: push failed" >&2; exit 1; fi
    ;;
  log)
    if [ -n "$PR_LOG_MESSAGE" ]; then printf '%s\\n' "$PR_LOG_MESSAGE"; else echo "feat: default commit message"; fi
    ;;
esac
`,
    "utf8",
  );
  await chmod(git, 0o755);
  await writeFile(log, "", "utf8");
  return { dir, log };
}

function startFakeAdoApi() {
  let simulatedStatus = 201;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      const repoMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)\/_apis\/git\/repositories\/([^/]+)$/);
      if (repoMatch && request.method === "GET") {
        return Response.json({ defaultBranch: "refs/heads/main", name: repoMatch[3] });
      }

      const pullsMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullrequests$/);
      if (pullsMatch && request.method === "POST") {
        const body = await request.text().catch(() => "");
        const parsed = JSON.parse(body || "{}");
        if (simulatedStatus === 422) {
          return Response.json({ message: "Validation Failed: source ref not found" }, { status: 422 });
        }
        if (simulatedStatus === 401) {
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
    setStatus(s: number) { simulatedStatus = s; },
  };
}

async function runAdoPr(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
  apiBaseUrl: string,
  opts: { noGit?: boolean } = {},
) {
  const fake = opts.noGit ? null : await makeFakeGitForAdoPr();
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-ut-mime-ado-pr-cwd-"));

  const params = typeof input.params === "object" && input.params !== null
    ? { ...input.params as Record<string, unknown>, apiBaseUrl }
    : { apiBaseUrl };

  const proc = Bun.spawn([process.execPath, adoPrScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: fake ? `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
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

describe("Mime-ADO-PR mocked behavior", () => {
  test("successfully creates an ADO PR with explicit params", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPr(
        {
          params: {
            branch: "mime/test-branch",
            title: "feat: test mime ado pr",
            body: "ADO PR body",
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
      expect(result.json.state.mimeAdoPr.title).toBe("feat: test mime ado pr");
      expect(result.json.state.mimeAdoPr.base).toBe("develop");
      expect(result.json.state.mimeAdoPr.draft).toBe(true);
      expect(result.json.state.mimeAdoPr.organization).toBe("test-org");
      expect(result.json.state.mimeAdoPr.project).toBe("test-project");
      expect(result.json.state.mimeAdoPr.repository).toBe("test-repo");
    } finally {
      api.server.stop();
    }
  });

  test("fails with auth error when AZURE_DEVOPS_EXT_PAT is missing", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPr(
        {
          params: {
            branch: "mime/test-branch",
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.tokenFound).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails with API error when ADO returns 422", async () => {
    const api = startFakeAdoApi();
    api.setStatus(422);
    try {
      const result = await runAdoPr(
        {
          params: {
            branch: "mime/test-branch",
            title: "test",
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
      expect(result.json.state.mimeAdoPr.apiStatus).toBe(422);
    } finally {
      api.server.stop();
    }
  });

  test("resolves ADO config from params.repo as org/project/repo", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPr(
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

  test("parses ADO org/project/repo from remote URL automatically", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPr(
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

  test("resolves branch from bootstrap state when params.branch is absent", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPr(
        {
          params: {
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
            title: "from state",
          },
          state: { mimeBootstrap: { branchName: "mime/test-branch" } },
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeAdoPr.ok).toBe(true);
      expect(result.json.state.mimeAdoPr.branchName).toBe("mime/test-branch");
    } finally {
      api.server.stop();
    }
  });

  test("infers PR title from git log when params.title is absent", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPr(
        {
          params: {
            branch: "mime/test-branch",
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token", PR_LOG_MESSAGE: "fix: inferred from git log" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.mimeAdoPr.ok).toBe(true);
      expect(result.json.state.mimeAdoPr.title).toBe("fix: inferred from git log");
    } finally {
      api.server.stop();
    }
  });

  test("fails when push to remote fails", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPr(
        {
          params: {
            branch: "mime/test-branch",
            title: "test",
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token", PR_PUSH_FAIL: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.mimeAdoPr.ok).toBe(false);
      expect(result.json.state.mimeAdoPr.pushOk).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("emits result.pr_created event on successful PR creation", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPr(
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
      const result = await runAdoPr(
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
    api.setStatus(422);
    try {
      const result = await runAdoPr(
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

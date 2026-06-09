import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Utility registration / naming tests — load default config directly
// ---------------------------------------------------------------------------

const defaultConfigPath = path.resolve("config", "default.json");

async function loadDefaultConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(defaultConfigPath, "utf8"));
}

describe("Blackbelt PR utility registration (default config)", () => {
  test("Blackbelt-GH-PR is registered with correct shipped-utility shape", async () => {
    const config = await loadDefaultConfig();
    const materia = (config.materia as Record<string, unknown>)["Blackbelt-GH-PR"] as Record<string, unknown>;

    expect(materia).toBeDefined();
    expect(materia.type).toBe("utility");
    expect(materia.label).toBe("Blackbelt-GH-PR");
    expect(materia.group).toBe("Utility");
    expect(materia.parse).toBe("json");
    expect(materia.script).toEqual({ kind: "shippedUtility", name: "blackbelt-gh-pr.mjs", runtime: "node" });
    expect(typeof materia.description).toBe("string");
    expect((materia.description as string).length).toBeGreaterThan(0);
    expect((materia.description as string).toLowerCase()).toContain("github");
    expect((materia.description as string).toLowerCase()).toContain("pull request");
    expect(materia.assign).toBeUndefined();
    expect(materia.command).toBeUndefined();
  });

  test("Blackbelt-ADO-PR is registered with correct shipped-utility shape", async () => {
    const config = await loadDefaultConfig();
    const materia = (config.materia as Record<string, unknown>)["Blackbelt-ADO-PR"] as Record<string, unknown>;

    expect(materia).toBeDefined();
    expect(materia.type).toBe("utility");
    expect(materia.label).toBe("Blackbelt-ADO-PR");
    expect(materia.group).toBe("Utility");
    expect(materia.parse).toBe("json");
    expect(materia.script).toEqual({ kind: "shippedUtility", name: "blackbelt-ado-pr.mjs", runtime: "node" });
    expect(typeof materia.description).toBe("string");
    expect((materia.description as string).length).toBeGreaterThan(0);
    expect((materia.description as string).toLowerCase()).toContain("azure devops");
    expect((materia.description as string).toLowerCase()).toContain("pull request");
    expect(materia.assign).toBeUndefined();
    expect(materia.command).toBeUndefined();
  });

  test("old names blackbelt-pr and mime-pr are absent from default config", async () => {
    const config = await loadDefaultConfig();
    const materia = config.materia as Record<string, unknown>;

    expect(materia["blackbelt-pr"]).toBeUndefined();
    expect(materia["mime-pr"]).toBeUndefined();
    expect(materia["Blackbelt-PR"]).toBeUndefined();
    expect(materia["Mime-PR"]).toBeUndefined();
  });

  test("GH and ADO PR utility labels embed platform specificity", async () => {
    const config = await loadDefaultConfig();
    const materia = config.materia as Record<string, unknown>;

    const ghLabel = (materia["Blackbelt-GH-PR"] as Record<string, unknown>)?.label;
    const adoLabel = (materia["Blackbelt-ADO-PR"] as Record<string, unknown>)?.label;

    expect(ghLabel).toBe("Blackbelt-GH-PR");
    expect(adoLabel).toBe("Blackbelt-ADO-PR");
    expect(ghLabel).not.toBe(adoLabel);
  });
});

// ---------------------------------------------------------------------------
// Representative mocked behavior — Blackbelt-GH-PR
// ---------------------------------------------------------------------------

const ghPrScript = path.resolve("config", "utilities", "blackbelt-gh-pr.mjs");

async function makeFakeJjForPr() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-ut-fake-jj-"));
  const log = path.join(dir, "jj.log");
  const jj = path.join(dir, "jj");
  await writeFile(
    jj,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$JJ_LOG"
case "$1" in
  root) pwd ;;
  diff)
    if [ -n "$PR_DIFF_EMPTY" ]; then : ; else echo "M file.txt"; fi
    ;;
  bookmark)
    case "$2" in
      list)
        if [ "$PR_NO_BOOKMARK" = "1" ]; then echo "No bookmarks found."; exit 1; fi
        if [ -n "$PR_BOOKMARK_LIST" ]; then printf '%s\\n' "$PR_BOOKMARK_LIST"; else echo "blackbelt/test-bookmark: xxxxxxxx (desc)"; fi
        ;;
      set) ;;
    esac
    ;;
  git)
    case "$2" in
      remote)
        if [ -n "$GH_REMOTE_URL" ]; then echo "origin $GH_REMOTE_URL"; else echo "origin https://github.com/test-owner/test-repo.git"; fi
        ;;
      push)
        if [ "$PR_PUSH_FAIL" = "1" ]; then echo "Push failed" >&2; exit 1; fi
        ;;
    esac
    ;;
  log)
    if [ -n "$PR_DESCRIPTION" ]; then printf '%s\\n' "$PR_DESCRIPTION"; else echo "feat: default description"; echo ""; echo "More context."; fi
    ;;
esac
`,
    "utf8",
  );
  await chmod(jj, 0o755);
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
          return Response.json({ message: "Validation Failed" }, { status: 422 });
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

async function runGhPr(input: Record<string, unknown>, env: Record<string, string> = {}, apiBaseUrl: string) {
  const fake = await makeFakeJjForPr();
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-ut-gh-pr-cwd-"));

  const params = typeof input.params === "object" && input.params !== null
    ? { ...input.params as Record<string, unknown>, apiBaseUrl }
    : { apiBaseUrl };

  const proc = Bun.spawn([process.execPath, ghPrScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`,
      JJ_LOG: fake.log,
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

describe("Blackbelt-GH-PR mocked behavior", () => {
  test("successfully creates a GitHub PR with explicit params", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            title: "feat: test gh pr",
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
      expect(result.json.state.blackbeltGhPr.ok).toBe(true);
      expect(result.json.state.blackbeltGhPr.prNumber).toBe(42);
      expect(result.json.state.blackbeltGhPr.prUrl).toBe("https://github.com/test-owner/test-repo/pull/42");
      expect(result.json.state.blackbeltGhPr.title).toBe("feat: test gh pr");
      expect(result.json.state.blackbeltGhPr.base).toBe("main");
      expect(result.json.state.blackbeltGhPr.draft).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails with auth error when token is missing", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: { bookmark: "blackbelt/test-bookmark", repo: "test-owner/test-repo" },
          state: {},
        },
        { GITHUB_TOKEN: "" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.tokenFound).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails with API error when GitHub returns 422", async () => {
    const api = startFakeGitHubApi();
    api.setStatus(422);
    try {
      const result = await runGhPr(
        {
          params: { bookmark: "blackbelt/test-bookmark", title: "test", repo: "test-owner/test-repo" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.apiStatus).toBe(422);
    } finally {
      api.server.stop();
    }
  });

  test("resolves bookmark from bootstrap state when params.bookmark is absent", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: { repo: "test-owner/test-repo", title: "from state" },
          state: { blackbeltBootstrap: { bookmarkName: "blackbelt/test-bookmark" } },
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.blackbeltGhPr.ok).toBe(true);
      expect(result.json.state.blackbeltGhPr.bookmarkName).toBe("blackbelt/test-bookmark");
    } finally {
      api.server.stop();
    }
  });

  test("fails when bookmark does not exist", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: { bookmark: "nonexistent-bookmark", repo: "test-owner/test-repo" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_NO_BOOKMARK: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.bookmarkExists).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails when push to remote fails", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runGhPr(
        {
          params: { bookmark: "blackbelt/test-bookmark", title: "test", repo: "test-owner/test-repo" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_PUSH_FAIL: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.pushOk).toBe(false);
    } finally {
      api.server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Representative mocked behavior — Blackbelt-ADO-PR
// ---------------------------------------------------------------------------

const adoPrScript = path.resolve("config", "utilities", "blackbelt-ado-pr.mjs");

async function makeFakeJjForAdoPr() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-ut-fake-jj-ado-"));
  const log = path.join(dir, "jj.log");
  const jj = path.join(dir, "jj");
  await writeFile(
    jj,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$JJ_LOG"
case "$1" in
  root) pwd ;;
  diff)
    if [ -n "$PR_DIFF_EMPTY" ]; then : ; else echo "M file.txt"; fi
    ;;
  bookmark)
    case "$2" in
      list)
        if [ "$PR_NO_BOOKMARK" = "1" ]; then echo "No bookmarks found."; exit 1; fi
        echo "blackbelt/test-bookmark: xxxxxxxx (desc)"
        ;;
      set) ;;
    esac
    ;;
  git)
    case "$2" in
      remote)
        if [ -n "$ADO_REMOTE_URL" ]; then echo "origin $ADO_REMOTE_URL"; else echo "origin https://dev.azure.com/test-org/test-project/_git/test-repo"; fi
        ;;
      push)
        if [ "$PR_PUSH_FAIL" = "1" ]; then echo "Push failed" >&2; exit 1; fi
        ;;
    esac
    ;;
  log)
    if [ -n "$PR_DESCRIPTION" ]; then printf '%s\\n' "$PR_DESCRIPTION"; else echo "feat: default description"; echo ""; echo "More context."; fi
    ;;
esac
`,
    "utf8",
  );
  await chmod(jj, 0o755);
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
          return Response.json({ message: "Validation Failed" }, { status: 422 });
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

async function runAdoPr(input: Record<string, unknown>, env: Record<string, string> = {}, apiBaseUrl: string) {
  const fake = await makeFakeJjForAdoPr();
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-ut-ado-pr-cwd-"));

  const params = typeof input.params === "object" && input.params !== null
    ? { ...input.params as Record<string, unknown>, apiBaseUrl }
    : { apiBaseUrl };

  const proc = Bun.spawn([process.execPath, adoPrScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`,
      JJ_LOG: fake.log,
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

describe("Blackbelt-ADO-PR mocked behavior", () => {
  test("successfully creates an ADO PR with explicit params", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPr(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            title: "feat: test ado pr",
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
      expect(result.json.state.blackbeltAdoPr.ok).toBe(true);
      expect(result.json.state.blackbeltAdoPr.prNumber).toBe(99);
      expect(result.json.state.blackbeltAdoPr.prUrl).toBe("https://dev.azure.com/test-org/test-project/_git/test-repo/pullrequest/99");
      expect(result.json.state.blackbeltAdoPr.title).toBe("feat: test ado pr");
      expect(result.json.state.blackbeltAdoPr.base).toBe("develop");
      expect(result.json.state.blackbeltAdoPr.draft).toBe(true);
      expect(result.json.state.blackbeltAdoPr.organization).toBe("test-org");
      expect(result.json.state.blackbeltAdoPr.project).toBe("test-project");
      expect(result.json.state.blackbeltAdoPr.repository).toBe("test-repo");
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
            bookmark: "blackbelt/test-bookmark",
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
      expect(result.json.state.blackbeltAdoPr.ok).toBe(false);
      expect(result.json.state.blackbeltAdoPr.tokenFound).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails with API error when ADO returns 401", async () => {
    const api = startFakeAdoApi();
    api.setStatus(401);
    try {
      const result = await runAdoPr(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
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
      expect(result.json.state.blackbeltAdoPr.ok).toBe(false);
      expect(result.json.state.blackbeltAdoPr.apiStatus).toBe(401);
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
            bookmark: "blackbelt/test-bookmark",
            repo: "repo-org/repo-project/repo-name",
            title: "test: repo param",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.blackbeltAdoPr.ok).toBe(true);
      expect(result.json.state.blackbeltAdoPr.organization).toBe("repo-org");
      expect(result.json.state.blackbeltAdoPr.project).toBe("repo-project");
      expect(result.json.state.blackbeltAdoPr.repository).toBe("repo-name");
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
            bookmark: "blackbelt/test-bookmark",
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
      expect(result.json.state.blackbeltAdoPr.ok).toBe(true);
      expect(result.json.state.blackbeltAdoPr.organization).toBe("auto-org");
      expect(result.json.state.blackbeltAdoPr.project).toBe("auto-project");
      expect(result.json.state.blackbeltAdoPr.repository).toBe("auto-repo");
    } finally {
      api.server.stop();
    }
  });

  test("fails when bookmark does not exist", async () => {
    const api = startFakeAdoApi();
    try {
      const result = await runAdoPr(
        {
          params: {
            bookmark: "nonexistent-bookmark",
            organization: "test-org",
            project: "test-project",
            repository: "test-repo",
          },
          state: {},
        },
        { AZURE_DEVOPS_EXT_PAT: "test-token", PR_NO_BOOKMARK: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltAdoPr.ok).toBe(false);
      expect(result.json.state.blackbeltAdoPr.bookmarkExists).toBe(false);
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
            bookmark: "blackbelt/test-bookmark",
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
      expect(result.json.state.blackbeltAdoPr.ok).toBe(false);
      expect(result.json.state.blackbeltAdoPr.pushOk).toBe(false);
    } finally {
      api.server.stop();
    }
  });
});

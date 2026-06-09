import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const bootstrapScript = path.resolve("config", "utilities", "blackbelt-bootstrap.mjs");
const maintainScript = path.resolve("config", "utilities", "blackbelt-maintain.mjs");
const prScript = path.resolve("config", "utilities", "blackbelt-gh-pr.mjs");

async function makeFakeJj() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-fake-jj-"));
  const log = path.join(dir, "jj.log");
  const jj = path.join(dir, "jj");
  await writeFile(
    jj,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$JJ_LOG"
case "$1" in
  root)
    pwd
    ;;
  diff)
    if [ "$JJ_DIRTY" = "1" ]; then echo 'M file.txt'; fi
    ;;
  git|bookmark|describe|new)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
    "utf8",
  );
  await chmod(jj, 0o755);
  await writeFile(log, "", "utf8");
  return { dir, log };
}

/**
 * Create a fake jj that supports the specific commands used by blackbelt-gh-pr.
 *
 * Supports:
 *   jj root             → prints cwd
 *   jj bookmark list    → prints "blackbelt/test-bookmark: ..." so the bookmark
 *                          existence check passes (unless PR_NO_BOOKMARK=1).
 *                          Set PR_BOOKMARK_LIST to override the entire bookmark
 *                          list output (one bookmark per line).
 *   jj bookmark set     → succeeds (unless PR_BOOKMARK_SET_FAIL=1)
 *   jj git remote list  → prints "origin https://github.com/test-owner/test-repo.git"
 *                          (or GH_REMOTE_URL if set)
 *   jj git push ...     → succeeds (unless PR_PUSH_FAIL=1)
 *   jj log -T commit_id → outputs a fake commit hash (unless PR_REVISION_INVALID=1)
 *   jj log -T description → prints PR_DESCRIPTION if set, else default title
 */
async function makeFakeJjForPr() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-materia-fake-jj-pr-"));
  const log = path.join(dir, "jj.log");
  const diffCountFile = path.join(dir, "diff.count");
  const jj = path.join(dir, "jj");
  await writeFile(
    jj,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$JJ_LOG"
case "$1" in
  root)
    pwd
    ;;
  diff)
    # Check if -r flag is present (specific revision diff for pre-push check).
    rflag=0
    prev=""
    for a in "$@"; do
      if [ "$prev" = "-r" ]; then rflag=1; diff_rev="$a"; fi
      prev="$a"
    done
    if [ "$rflag" = "1" ]; then
      # Count diff calls so we can distinguish tip (first) from parent (subsequent).
      cnt=$(cat "$JJ_DIFF_COUNT" 2>/dev/null || echo 0)
      cnt=$((cnt + 1))
      echo "$cnt" > "$JJ_DIFF_COUNT"
      if [ "$PR_TIP_EMPTY" = "1" ] && [ "$cnt" -eq 1 ]; then
        : # empty diff for tip
      elif [ "$cnt" -gt 1 ] && [ "$PR_PARENT_DIFF_EMPTY" = "1" ]; then
        : # empty diff for parent too
      elif [ "$cnt" -gt 1 ] && [ "$PR_ALL_PARENTS_EMPTY" = "1" ]; then
        : # all parents empty (no pushable ancestor)
      else
        echo "M file.txt"
      fi
    else
      # No -r flag — legacy bootstrap/maintain mode.
      if [ "$JJ_DIRTY" = "1" ]; then echo 'M file.txt'; fi
    fi
    ;;
  bookmark)
    case "$2" in
      list)
        if [ "$PR_NO_BOOKMARK" = "1" ]; then
          echo "No bookmarks found."
          exit 1
        fi
        if [ -n "$PR_BOOKMARK_LIST" ]; then
          printf '%s\n' "$PR_BOOKMARK_LIST"
        else
          echo "blackbelt/test-bookmark: xxxxxxxx (some description)"
          echo "main: yyyyyyyy"
        fi
        ;;
      set)
        if [ "$PR_BOOKMARK_SET_FAIL" = "1" ]; then
          echo "Bookmark set failed" >&2
          exit 1
        fi
        ;;
    esac
    ;;
  git)
    case "$2" in
      remote)
        if [ -n "$GH_REMOTE_URL" ]; then
          echo "origin $GH_REMOTE_URL"
        else
          echo "origin https://github.com/test-owner/test-repo.git"
        fi
        ;;
      push)
        if [ "$PR_PUSH_FAIL" = "1" ]; then
          echo "Push failed: rejected" >&2
          exit 1
        fi
        ;;
    esac
    ;;
  log)
    # Check if -T commit_id is requested (revision existence check or parent walking).
    # The -T value may be "commit_id" or "commit_id ++ \"\\n\"" so use pattern match.
    wants_commit_id=0
    for arg in "$@"; do
      case "$arg" in
        *commit_id*) wants_commit_id=1 ;;
      esac
    done
    if [ "$wants_commit_id" = "1" ]; then
      # Check if -r uses parents() for ancestor walking.
      for a in "$@"; do
        case "$a" in
          parents\\(*\\))
            if [ "$PR_NO_PARENT" = "1" ]; then
              : # no parent
            else
              echo "\${PR_PARENT_ID:-parent-commit-id}"
            fi
            exit 0
            ;;
        esac
      done
      # Plain revision existence check.
      if [ "$PR_REVISION_INVALID" = "1" ]; then
        echo "Error: No such revision" >&2
        exit 1
      fi
      echo "abcdef1234567890abcdef1234567890abcdef12"
      exit 0
    fi
    # Otherwise -T description (title inference / preflight description check).
    # Extract the -r revision to differentiate tip vs parent/ancestor queries
    # so that PR_EMPTY_DESCRIPTION only affects the tip while the parent can
    # be controlled independently via PR_PARENT_DESCRIPTION.
    queried_rev=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = "-r" ]; then queried_rev="$a"; fi
      prev="$a"
    done
    is_parent=0
    case "$queried_rev" in
      *parent-commit-id*) is_parent=1 ;;
    esac
    if [ "$PR_EMPTY_DESCRIPTION" = "1" ]; then
      if [ "$is_parent" = "1" ] && [ -n "$PR_PARENT_DESCRIPTION" ]; then
        printf '%s\n' "$PR_PARENT_DESCRIPTION"
      else
        : # empty — simulates a revision with no description.
      fi
    elif [ -n "$PR_DESCRIPTION" ]; then
      printf '%s\n' "$PR_DESCRIPTION"
    else
      echo "feat: test pr description"
      echo ""
      echo "Additional context line."
    fi
    ;;
  *)
    exit 0
    ;;
esac
`,
    "utf8",
  );
  await chmod(jj, 0o755);
  await writeFile(log, "", "utf8");
  await writeFile(diffCountFile, "0", "utf8");
  return { dir, log, diffCountFile };
}

async function runUtility(script: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(`${JSON.stringify(input)}\n`);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode, json: JSON.parse(stdout) };
}

async function runBootstrap(input: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const fake = await makeFakeJj();
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-bootstrap-cwd-"));
  const result = await runUtility(
    bootstrapScript,
    { cwd, runDir: path.join(cwd, ".pi", "pi-materia", "run"), state: {}, ...input },
    { PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`, JJ_LOG: fake.log, ...extraEnv },
  );
  return { ...result, fake };
}

describe("Blackbelt utility scripts", () => {
  test("bootstrap generates deterministic noun-verb-hash bookmark names from castId", async () => {
    const castId = "2026-06-06T19-39-18-566Z";
    const first = await runBootstrap({ castId });
    const second = await runBootstrap({ castId });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    const bookmarkName = first.json.state.blackbeltBootstrap.bookmarkName;
    expect(bookmarkName).toBe(second.json.state.blackbeltBootstrap.bookmarkName);
    expect(bookmarkName).toMatch(/^blackbelt\/[a-z0-9]+-[a-z]+-[a-f0-9]{10}$/);
    expect(bookmarkName.endsWith(createHash("sha256").update(castId).digest("hex").slice(0, 10))).toBe(true);
    expect(bookmarkName).not.toContain(castId.toLowerCase());
  });

  test("bootstrap generated names are ref-safe and do not expose raw cast ids", async () => {
    const castId = "Feature/Bad @{Cast} Name.lock 2026-06-06T19:39:18.566Z";
    const result = await runBootstrap({ castId });

    expect(result.exitCode).toBe(0);
    const bookmarkName = result.json.state.blackbeltBootstrap.bookmarkName;
    expect(bookmarkName).toMatch(/^blackbelt\/[a-z0-9]+-[a-z]+-[a-f0-9]{10}$/);
    expect(bookmarkName).not.toContain("feature");
    expect(bookmarkName).not.toContain("name.lock");
    expect(bookmarkName).not.toContain("@{");
    expect(bookmarkName).not.toContain(" ");
  });

  test("bootstrap preserves explicit bookmarkName as a sanitized override", async () => {
    const result = await runBootstrap({
      castId: "ignored-cast-id",
      params: { bookmarkName: "Feature Name.lock" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.state.blackbeltBootstrap.bookmarkName).toBe("blackbelt/feature-name-lock");
  });

  test("bootstrap describes dirty pre-existing work before jj new and sets bookmark on the described revision", async () => {
    const castId = "2026-06-06T19-39-18-566Z";
    const result = await runBootstrap({ castId }, { JJ_DIRTY: "1" });

    expect(result.exitCode).toBe(0);
    expect(result.json.state.blackbeltBootstrap.ok).toBe(true);
    expect(result.json.state.blackbeltBootstrap.newWorkingCommit).toBe(true);
    expect(result.json.state.blackbeltBootstrap.emptyHead).toBe(true);

    // Verify command order in jj.log: describe before bookmark set before new.
    const jjLog = await readFile(result.fake.log, "utf8");
    const lines = jjLog.split(/\r?\n/).filter(Boolean);

    const describeIdx = lines.findIndex((l) => l.startsWith("describe"));
    const bookmarkIdx = lines.findIndex((l) => l.startsWith("bookmark set"));
    const newIdx = lines.findIndex((l) => l === "new");

    expect(describeIdx).toBeGreaterThan(-1);
    expect(bookmarkIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(-1);
    // describe must come before bookmark set, which must come before new.
    expect(describeIdx).toBeLessThan(bookmarkIdx);
    expect(bookmarkIdx).toBeLessThan(newIdx);
  });

  test("bootstrap describe message includes the deterministic bookmark name for dirty head", async () => {
    const castId = "2026-06-06T19-39-18-566Z";
    const result = await runBootstrap({ castId }, { JJ_DIRTY: "1" });

    expect(result.exitCode).toBe(0);
    const bookmarkName = result.json.state.blackbeltBootstrap.bookmarkName;
    expect(bookmarkName).toBeTruthy();

    // The describe message should reference the bookmark name.
    const jjLog = await readFile(result.fake.log, "utf8");
    expect(jjLog).toContain(`describe -m bootstrap: ${bookmarkName}`);
  });

  test("bootstrap clean head no-op: no describe, no new — only bookmark set", async () => {
    const castId = "2026-06-06T19-39-18-566Z";
    // No JJ_DIRTY → diff --summary returns empty → clean head.
    const result = await runBootstrap({ castId });

    expect(result.exitCode).toBe(0);
    expect(result.json.state.blackbeltBootstrap.ok).toBe(true);
    expect(result.json.state.blackbeltBootstrap.newWorkingCommit).toBe(false);
    expect(result.json.state.blackbeltBootstrap.emptyHead).toBe(true);

    const jjLog = await readFile(result.fake.log, "utf8");
    const lines = jjLog.split(/\r?\n/).filter(Boolean);

    // Should have bookmark set but NOT describe or new.
    expect(lines.some((l) => l.startsWith("bookmark set"))).toBe(true);
    expect(lines.some((l) => l.startsWith("describe"))).toBe(false);
    expect(lines.some((l) => l === "new")).toBe(false);
  });

  test("maintain refuses to invent a bookmark when bootstrap state is missing", async () => {
    const fake = await makeFakeJj();
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-maintain-cwd-"));
    const result = await runUtility(
      maintainScript,
      {
        cwd,
        castId: "2026-06-06T19-39-18-566Z",
        state: {},
        item: { title: "fix: checkpoint" },
      },
      { PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`, JJ_LOG: fake.log },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({
      satisfied: false,
      context: "Blackbelt-Maintain: missing state.blackbeltBootstrap.bookmarkName. Run Blackbelt-Bootstrap first so maintain can advance the bootstrap-owned bookmark.",
    });
    expect(await readFile(fake.log, "utf8")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Blackbelt-GH-PR tests
// ---------------------------------------------------------------------------

/**
 * Start a fake GitHub API server that responds to expected endpoints.
 * Uses a closure variable instead of process.env to avoid cross-test leaks.
 */
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
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        if (simulatedApiError === "422") {
          return Response.json({ message: "Validation Failed: head branch not found" }, { status: 422 });
        }
        if (simulatedApiError === "401") {
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
    setSimulatedApiError(code: string | null) { simulatedApiError = code; },
  };
}

/**
 * Run the blackbelt-gh-pr utility script against a fake jj and a fake GitHub API.
 *
 * Injects `params.apiBaseUrl` automatically from the fake API server.
 * If `noJj` is true, the fake jj dir is NOT prepended to PATH (and the
 * caller should supply a PATH that omits jj).
 */
async function runPrUtility(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
  apiBaseUrl: string,
  opts: { noJj?: boolean } = {},
) {
  const fake = opts.noJj ? null : await makeFakeJjForPr();
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-pr-cwd-"));

  // Inject apiBaseUrl into params so the utility hits our fake server.
  const params = typeof input.params === "object" && input.params !== null
    ? { ...input.params as Record<string, unknown>, apiBaseUrl }
    : { apiBaseUrl };

  const proc = Bun.spawn([process.execPath, prScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: fake ? `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
      ...(fake ? { JJ_LOG: fake.log, JJ_DIFF_COUNT: fake.diffCountFile } : {}),
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

describe("Blackbelt-GH-PR utility script", () => {
  test("fails with clear error when jj is not available (no git fallback)", async () => {
    const api = startFakeGitHubApi();
    try {
      // Build a PATH that only contains the fake API + essential system dirs,
      // explicitly excluding the real jj (if any).
      const sanitizedPath = ["/usr/bin", "/bin", "/usr/local/bin"]
        .filter((d) => {
          // Exclude known jj install locations; this is best-effort.
          return true; // We still include them but with noJj the fake isn't on PATH.
        })
        .join(path.delimiter);

      const result = await runPrUtility(
        {
          params: { bookmark: "blackbelt/test-bookmark" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PATH: sanitizedPath },
        api.baseUrl,
        { noJj: true },
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      // We may get "jj is required" (jj not on PATH) or "no jj repository"
      // (jj found but no repo). Both are valid no-git-fallback failures.
      expect(result.json.state.blackbeltGhPr.error).toMatch(/jj is required|no jj repository/);
    } finally {
      api.server.stop();
    }
  });

  test("fails with clear error when configured authEnv variable is missing", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: { bookmark: "blackbelt/test-bookmark", authEnv: "GH_PAT" },
          state: {},
        },
        { GITHUB_TOKEN: "wrong-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("GH_PAT");
      expect(result.json.state.blackbeltGhPr.tokenFound).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails when bookmark does not exist", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: { bookmark: "nonexistent-bookmark" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_NO_BOOKMARK: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("nonexistent-bookmark");
      expect(result.json.state.blackbeltGhPr.bookmarkExists).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails when push to remote fails", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: { bookmark: "blackbelt/test-bookmark" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_PUSH_FAIL: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("push failed");
      expect(result.json.state.blackbeltGhPr.pushOk).toBe(false);
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
          params: { bookmark: "blackbelt/test-bookmark" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("GitHub API error");
      expect(result.json.state.blackbeltGhPr.apiStatus).toBe(422);
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
          params: { bookmark: "blackbelt/test-bookmark" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("Bad credentials");
      expect(result.json.state.blackbeltGhPr.apiStatus).toBe(401);
    } finally {
      api.server.stop();
    }
  });

  test("successfully pushes bookmark and creates PR with explicit params", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
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
      expect(result.json.state.blackbeltGhPr.ok).toBe(true);
      expect(result.json.state.blackbeltGhPr.prNumber).toBe(42);
      expect(result.json.state.blackbeltGhPr.prUrl).toBe("https://github.com/test-owner/test-repo/pull/42");
      expect(result.json.state.blackbeltGhPr.bookmarkName).toBe("blackbelt/test-bookmark");
      expect(result.json.state.blackbeltGhPr.title).toBe("feat: custom pr title");
      expect(result.json.state.blackbeltGhPr.base).toBe("develop");
      expect(result.json.state.blackbeltGhPr.draft).toBe(true);
      expect(result.json.state.blackbeltGhPr.repo).toBe("test-owner/test-repo");
    } finally {
      api.server.stop();
    }
  });

  test("infers PR title from jj description when params.title is absent", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_DESCRIPTION: "fix: inferred from jj description\n\nBody text here." },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.blackbeltGhPr.ok).toBe(true);
      expect(result.json.state.blackbeltGhPr.title).toBe("fix: inferred from jj description");
    } finally {
      api.server.stop();
    }
  });

  test("fails with unnamedRevision when bookmark tip has changes but no description", async () => {
    const api = startFakeGitHubApi();
    try {
      // PR_EMPTY_DESCRIPTION=1 makes the fake jj output nothing for `jj log`.
      // The diff is non-empty (no PR_TIP_EMPTY), so the preflight catches an
      // unnamedRevision before reaching title inference — fail early.
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_EMPTY_DESCRIPTION: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("unnamed");
      expect(result.json.state.blackbeltGhPr.unnamedRevision).toBe(true);
      // Must NOT have attempted git push.
      const jjLog = result.fake ? await readFile(result.fake.log, "utf8") : "";
      expect(jjLog).not.toContain("git push");
    } finally {
      api.server.stop();
    }
  });

  test("resolves bookmark from bootstrap state when params.bookmark is absent", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            repo: "test-owner/test-repo",
            title: "chore: from bootstrap state",
          },
          state: {
            blackbeltBootstrap: {
              bookmarkName: "blackbelt/test-bookmark",
            },
          },
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.blackbeltGhPr.ok).toBe(true);
      expect(result.json.state.blackbeltGhPr.bookmarkName).toBe("blackbelt/test-bookmark");
      expect(result.json.state.blackbeltGhPr.title).toBe("chore: from bootstrap state");
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
            bookmark: "blackbelt/test-bookmark",
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
      expect(result.json.state.blackbeltGhPr.ok).toBe(true);
    } finally {
      api.server.stop();
    }
  });

  test("exact bookmark matching — does not match partial bookmark names", async () => {
    const api = startFakeGitHubApi();
    try {
      // Pretend only "blackbelt/test-bookmark-full" exists (not "blackbelt/test").
      // With substring matching, checking for "blackbelt/test" would falsely pass.
      const result = await runPrUtility(
        {
          params: { bookmark: "blackbelt/test" },
          state: {},
        },
        {
          GITHUB_TOKEN: "test-token",
          PR_BOOKMARK_LIST: "blackbelt/test-bookmark-full: abcdef123456 (some description)\nmain: fedcba987654",
        },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("blackbelt/test");
      expect(result.json.state.blackbeltGhPr.bookmarkExists).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("pushes a specific revision by setting the bookmark to that revision first", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            revision: "abc123def456",
            repo: "test-owner/test-repo",
            title: "feat: from specific revision",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.blackbeltGhPr.ok).toBe(true);
      expect(result.json.state.blackbeltGhPr.bookmarkName).toBe("blackbelt/test-bookmark");
      expect(result.json.state.blackbeltGhPr.revision).toBe("abc123def456");
      expect(result.json.state.blackbeltGhPr.title).toBe("feat: from specific revision");

      // Verify jj bookmark set was called.
      const jjLog = await readFile(result.fake!.log, "utf8");
      expect(jjLog).toContain("bookmark set blackbelt/test-bookmark --revision abc123def456");
      // Verify jj git push was called.
      expect(jjLog).toContain("git push --bookmark blackbelt/test-bookmark");
    } finally {
      api.server.stop();
    }
  });

  test("fails clearly when params.revision cannot be resolved", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            revision: "nonexistent-revision",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_REVISION_INVALID: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("nonexistent-revision");
      expect(result.json.state.blackbeltGhPr.revisionResolved).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("fails clearly when bookmark set fails for a valid revision", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            revision: "abc123def456",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_BOOKMARK_SET_FAIL: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("failed to set bookmark");
      expect(result.json.state.blackbeltGhPr.bookmarkSetOk).toBe(false);
    } finally {
      api.server.stop();
    }
  });

  test("infers title from revision description when params.revision is provided without params.title", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            revision: "abc123def456",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_DESCRIPTION: "fix: title from revision description" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.blackbeltGhPr.ok).toBe(true);
      expect(result.json.state.blackbeltGhPr.title).toBe("fix: title from revision description");
      expect(result.json.state.blackbeltGhPr.revision).toBe("abc123def456");
    } finally {
      api.server.stop();
    }
  });

  test("fails loudly when explicit revision has no description — unnamedRevision caught by preflight", async () => {
    // When a valid revision is provided but its description is empty and the
    // revision has changes, the preflight now catches it as an unnamedRevision
    // before reaching title inference — the commit is unpushable.
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            revision: "abc123def456",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PR_EMPTY_DESCRIPTION: "1" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("unnamed");
      expect(result.json.state.blackbeltGhPr.unnamedRevision).toBe(true);
      expect(result.json.state.blackbeltGhPr.revision).toBe("abc123def456");

      // Must NOT have attempted git push.
      const jjLog = result.fake ? await readFile(result.fake.log, "utf8") : "";
      expect(jjLog).not.toContain("git push");
    } finally {
      api.server.stop();
    }
  });

  test("no git fallback — does not attempt to use git when jj is missing", async () => {
    const api = startFakeGitHubApi();
    try {
      const sanitizedPath = ["/usr/bin", "/bin", "/usr/local/bin"]
        .join(path.delimiter);

      const result = await runPrUtility(
        {
          params: { bookmark: "blackbelt/test-bookmark" },
          state: {},
        },
        { GITHUB_TOKEN: "test-token", PATH: sanitizedPath },
        api.baseUrl,
        { noJj: true },
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      // The error must mention jj, not git.
      expect(result.json.state.blackbeltGhPr.error).toMatch(/jj/);
      // The error must not suggest using git as an alternative.
      expect(result.json.state.blackbeltGhPr.error).not.toMatch(/\brun\s+git\b|\bgit\s+push\b|\bgit\s+fallback\b/i);
    } finally {
      api.server.stop();
    }
  });

  test("no git fallback — utility has no git import or git command execution", async () => {
    // Read the pr script and ensure it never imports/execs git.
    const scriptContent = await readFile(prScript, "utf8");
    // Should not contain 'git' as a command to execute (beyond "github" in URLs and "git" in jj subcommands)
    // Specifically, should not have execFile("git", ...) or execFile('git', ...)
    expect(scriptContent).not.toMatch(/execFile\(["']git["']/);
  });

  // -----------------------------------------------------------------------
  // Pre-push revision check — empty tip handling
  // -----------------------------------------------------------------------

  test("empty tip with pushable parent: adjusts bookmark to non-empty named ancestor and pushes", async () => {
    const api = startFakeGitHubApi();
    try {
      // Tip is empty+descriptionless; parent is non-empty WITH a description
      // so the ancestor is pushable and the bookmark moves to it.
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            repo: "test-owner/test-repo",
            title: "feat: pushed from adjusted bookmark",
          },
          state: {},
        },
        {
          GITHUB_TOKEN: "test-token",
          PR_TIP_EMPTY: "1",
          PR_EMPTY_DESCRIPTION: "1",
          PR_PARENT_DESCRIPTION: "feat: parent has a description",
        },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.blackbeltGhPr.ok).toBe(true);
      expect(result.json.state.blackbeltGhPr.prNumber).toBe(42);
      expect(result.json.state.blackbeltGhPr.revisionAdjusted).toBe(true);
      // The revision should now be the parent commit ID.
      expect(result.json.state.blackbeltGhPr.revision).toBe("parent-commit-id");
      expect(result.json.state.blackbeltGhPr.originalRevision).toBe("blackbelt/test-bookmark");

      // Verify jj log shows bookmark was set to parent before push.
      const jjLog = await readFile(result.fake!.log, "utf8");
      expect(jjLog).toContain("bookmark set blackbelt/test-bookmark --revision parent-commit-id");
      expect(jjLog).toContain("git push --bookmark blackbelt/test-bookmark");
      // The bookmark set (to parent) must come before git push.
      const setIdx = jjLog.indexOf("bookmark set blackbelt/test-bookmark --revision parent-commit-id");
      const pushIdx = jjLog.indexOf("git push --bookmark blackbelt/test-bookmark");
      expect(setIdx).toBeLessThan(pushIdx);
    } finally {
      api.server.stop();
    }
  });

  test("empty tip with non-empty unnamed parent: fails with unnamedRevision (not moved to unnamed ancestor)", async () => {
    const api = startFakeGitHubApi();
    try {
      // Tip is empty+descriptionless; parent is non-empty but ALSO unnamed.
      // The preflight must NOT move the bookmark to the unnamed ancestor
      // and must not attempt jj git push — it must report unnamedRevision.
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        {
          GITHUB_TOKEN: "test-token",
          PR_TIP_EMPTY: "1",
          PR_EMPTY_DESCRIPTION: "1",
          // No PR_PARENT_DESCRIPTION → parent is also unnamed.
        },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("unnamed");
      expect(result.json.state.blackbeltGhPr.unnamedRevision).toBe(true);
      // The error must identify the unnamed ancestor, not the tip.
      expect(result.json.state.blackbeltGhPr.revision).toBe("parent-commit-id");
      expect(result.json.state.blackbeltGhPr.bookmarkName).toBe("blackbelt/test-bookmark");
      // Should include remediation guidance.
      expect(result.json.state.blackbeltGhPr.error).toMatch(/jj describe|describe.*-m/);

      // Must NOT have attempted git push.
      const jjLog = result.fake ? await readFile(result.fake.log, "utf8") : "";
      expect(jjLog).not.toContain("git push");
      // Must NOT have set the bookmark to the parent.
      expect(jjLog).not.toContain("bookmark set blackbelt/test-bookmark --revision parent-commit-id");
    } finally {
      api.server.stop();
    }
  });

  test("empty tip with no pushable work: fails with noPushableRevision", async () => {
    const api = startFakeGitHubApi();
    try {
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        {
          GITHUB_TOKEN: "test-token",
          PR_TIP_EMPTY: "1",
          PR_EMPTY_DESCRIPTION: "1",
          PR_NO_PARENT: "1",
        },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("no pushable revision");
      expect(result.json.state.blackbeltGhPr.noPushableRevision).toBe(true);

      // Must NOT have attempted git push.
      const jjLog = result.fake ? await readFile(result.fake.log, "utf8") : "";
      expect(jjLog).not.toContain("git push");
    } finally {
      api.server.stop();
    }
  });

  test("empty tip with all ancestors empty: fails with noPushableRevision", async () => {
    const api = startFakeGitHubApi();
    try {
      // All parents are also empty — no non-empty ancestor exists.
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        {
          GITHUB_TOKEN: "test-token",
          PR_TIP_EMPTY: "1",
          PR_EMPTY_DESCRIPTION: "1",
          PR_ALL_PARENTS_EMPTY: "1",
        },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("no pushable revision");
      expect(result.json.state.blackbeltGhPr.noPushableRevision).toBe(true);

      // Must NOT have attempted git push.
      const jjLog = result.fake ? await readFile(result.fake.log, "utf8") : "";
      expect(jjLog).not.toContain("git push");
    } finally {
      api.server.stop();
    }
  });

  test("explicit params.revision that is empty: adjusts bookmark to parent and pushes", async () => {
    const api = startFakeGitHubApi();
    try {
      // params.revision is provided and is empty+nodesc; parent is non-empty
      // WITH a description so the bookmark moves to it.
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            revision: "abc123def456",
            repo: "test-owner/test-repo",
            title: "feat: explicit revision adjusted",
          },
          state: {},
        },
        {
          GITHUB_TOKEN: "test-token",
          PR_TIP_EMPTY: "1",
          PR_EMPTY_DESCRIPTION: "1",
          PR_PARENT_DESCRIPTION: "feat: parent has a description",
        },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.blackbeltGhPr.ok).toBe(true);
      expect(result.json.state.blackbeltGhPr.revisionAdjusted).toBe(true);
      expect(result.json.state.blackbeltGhPr.revision).toBe("parent-commit-id");
      expect(result.json.state.blackbeltGhPr.originalRevision).toBe("abc123def456");

      // Verify jj log: first bookmark set to the explicit revision,
      // then bookmark set to parent after preflight, then push.
      const jjLog = await readFile(result.fake!.log, "utf8");
      expect(jjLog).toContain("bookmark set blackbelt/test-bookmark --revision abc123def456");
      expect(jjLog).toContain("bookmark set blackbelt/test-bookmark --revision parent-commit-id");
      expect(jjLog).toContain("git push --bookmark blackbelt/test-bookmark");
    } finally {
      api.server.stop();
    }
  });

  test("non-empty tip is unaffected by preflight — pushes normally", async () => {
    const api = startFakeGitHubApi();
    try {
      // Tip has changes (non-empty diff) and description — preflight should pass through.
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            repo: "test-owner/test-repo",
            title: "feat: normal push",
          },
          state: {},
        },
        { GITHUB_TOKEN: "test-token" },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(0);
      expect(result.json.state.blackbeltGhPr.ok).toBe(true);
      expect(result.json.state.blackbeltGhPr.revisionAdjusted).toBeUndefined();
      expect(result.json.state.blackbeltGhPr.revision).toBe("blackbelt/test-bookmark");

      // Should NOT have an extra bookmark set call (only from the push flow).
      const jjLog = await readFile(result.fake!.log, "utf8");
      expect(jjLog).not.toContain("bookmark set");
      expect(jjLog).toContain("git push --bookmark blackbelt/test-bookmark");
    } finally {
      api.server.stop();
    }
  });

  // -----------------------------------------------------------------------
  // Pre-push revision check — unnamed (non-empty + descriptionless) detection
  // -----------------------------------------------------------------------

  test("non-empty unnamed commit fails before push with remediation guidance", async () => {
    const api = startFakeGitHubApi();
    try {
      // Tip has changes (non-empty diff) but no description — jj git push
      // would reject this. Preflight should fail before push is attempted.
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        {
          GITHUB_TOKEN: "test-token",
          PR_EMPTY_DESCRIPTION: "1",
        },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("unnamed");
      expect(result.json.state.blackbeltGhPr.unnamedRevision).toBe(true);
      expect(result.json.state.blackbeltGhPr.revision).toBe("blackbelt/test-bookmark");
      expect(result.json.state.blackbeltGhPr.bookmarkName).toBe("blackbelt/test-bookmark");
      // Should include remediation guidance (jj describe command).
      expect(result.json.state.blackbeltGhPr.error).toMatch(/jj describe|describe.*-m/);

      // Must NOT have attempted git push.
      const jjLog = result.fake ? await readFile(result.fake.log, "utf8") : "";
      expect(jjLog).not.toContain("git push");
    } finally {
      api.server.stop();
    }
  });

  test("non-empty unnamed explicit revision fails before push with diagnostics", async () => {
    const api = startFakeGitHubApi();
    try {
      // params.revision points to a commit with changes but no description.
      // Preflight should detect and fail before push.
      const result = await runPrUtility(
        {
          params: {
            bookmark: "blackbelt/test-bookmark",
            revision: "abc123def456",
            repo: "test-owner/test-repo",
          },
          state: {},
        },
        {
          GITHUB_TOKEN: "test-token",
          PR_EMPTY_DESCRIPTION: "1",
        },
        api.baseUrl,
      );

      expect(result.exitCode).toBe(1);
      expect(result.json.state.blackbeltGhPr.ok).toBe(false);
      expect(result.json.state.blackbeltGhPr.error).toContain("unnamed");
      expect(result.json.state.blackbeltGhPr.unnamedRevision).toBe(true);
      expect(result.json.state.blackbeltGhPr.revision).toBe("abc123def456");
      expect(result.json.state.blackbeltGhPr.bookmarkName).toBe("blackbelt/test-bookmark");
      // Should include remediation guidance.
      expect(result.json.state.blackbeltGhPr.error).toMatch(/jj describe|describe.*-m/);
      // The error should identify the specific revision.
      expect(result.json.state.blackbeltGhPr.error).toContain("abc123def456");

      // Must NOT have attempted git push.
      const jjLog = result.fake ? await readFile(result.fake.log, "utf8") : "";
      expect(jjLog).not.toContain("git push");
    } finally {
      api.server.stop();
    }
  });
});

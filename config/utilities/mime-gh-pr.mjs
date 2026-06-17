#!/usr/bin/env node
/**
 * Mime-GH-PR — deterministic git-only GitHub pull request utility.
 *
 * Pushes the active git branch to a GitHub remote and creates a pull request
 * through the GitHub API.  Uses standard git commands only — no jj dependency.
 *
 * Input scope:
 *   - params.branch     → explicit branch name override
 *   - params.remote     → git remote name (default: origin)
 *   - params.repo       → explicit owner/repo (default: parsed from remote URL)
 *   - params.title      → PR title override
 *   - params.body       → PR body text
 *   - params.draft      → boolean, create as draft PR
 *   - params.base       → PR base branch (default: inferred from remote HEAD)
 *   - params.pushOnly   → boolean, push branch but skip PR creation (emits result.branch_pushed)
 *   - params.authEnv    → env var name for GitHub token (default: GITHUB_TOKEN)
 *   - params.apiBaseUrl → GitHub API base URL override (for GHE / testing)
 *   - state.mimeBootstrap.branchName  → fallback branch
 *
 * PR title inference (first available):
 *   1. params.title
 *   2. Latest commit message on the branch (via `git log -1 --format=%s`)
 *   3. The branch name itself
 *
 * Output contract: stdout JSON with top-level `state.mimeGhPr` and an
 * optional `event` array.  Successful PR creation emits result.pr_created;
 * pushOnly mode emits result.branch_pushed.  Stderr is reserved for
 * diagnostics.  All known failure modes (missing git, missing auth,
 * push failure, API error) return a mimeGhPr failure payload with no event
 * array.
 */
import { execFile } from "node:child_process";

class UtilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

try {
  const input = await readStdinJson();
  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();
  const params = isPlainObject(input.params) ? input.params : {};

  // Require git — no jj fallback.
  if (!(await isCommandAvailable("git"))) {
    throw new UtilityError("Mime-GH-PR: git is required but was not found on PATH.", {
      available: { git: false },
    });
  }

  // Verify we are inside a git repo.
  const gitRoot = await resolveGitRoot(cwd);
  if (gitRoot === null) {
    throw new UtilityError("Mime-GH-PR: no git repository detected. Run Mime-Bootstrap first.", {
      hasGitRepo: false,
    });
  }

  // Resolve branch name.
  const branchName = await resolveBranchName(input, cwd);
  if (typeof branchName !== "string" || branchName.trim().length === 0) {
    throw new UtilityError("Mime-GH-PR: no branch resolved. Provide params.branch, check out a branch, or run Mime-Bootstrap first.", {
      branchResolved: false,
    });
  }

  // Verify the branch exists.
  const branchExists = await checkBranchExists(branchName, cwd);
  if (!branchExists) {
    throw new UtilityError(`Mime-GH-PR: branch "${branchName}" does not exist.`, {
      branchName,
      branchExists: false,
    });
  }

  // Resolve remote.
  const remote = resolveRemote(params);
  const remoteUrl = await resolveRemoteUrl(remote, cwd);
  if (remoteUrl === null) {
    throw new UtilityError(`Mime-GH-PR: could not resolve URL for remote "${remote}". Check \`git remote -v\`.`, {
      remote,
      remoteResolved: false,
    });
  }

  // Resolve repository owner/name.
  const repo = resolveRepo(params, remoteUrl);
  if (repo === null) {
    throw new UtilityError(`Mime-GH-PR: could not determine GitHub owner/repo from remote URL "${remoteUrl}". Provide params.repo as "owner/name".`, {
      remoteUrl,
      repoResolved: false,
    });
  }

  // Resolve auth token.
  const authEnv = typeof params.authEnv === "string" && params.authEnv.trim().length > 0
    ? params.authEnv.trim()
    : "GITHUB_TOKEN";
  const token = process.env[authEnv];
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new UtilityError(`Mime-GH-PR: GitHub token not found in environment variable "${authEnv}". Set ${authEnv} or configure params.authEnv.`, {
      authEnv,
      tokenFound: false,
    });
  }

  // Resolve GitHub API base URL (supports GHE and testing overrides).
  const apiBaseUrl = typeof params.apiBaseUrl === "string" && params.apiBaseUrl.trim().length > 0
    ? params.apiBaseUrl.trim().replace(/\/$/, "")
    : (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");

  // Push the branch to GitHub.
  const pushResult = await pushBranch(branchName, remote, cwd);
  if (!pushResult.ok) {
    throw new UtilityError(`Mime-GH-PR: push failed for branch "${branchName}" to remote "${remote}": ${pushResult.error}`, {
      branchName,
      remote,
      pushOk: false,
      pushError: pushResult.error,
    });
  }

  // Infer PR title.
  const title = typeof params.title === "string" && params.title.trim().length > 0
    ? params.title.trim()
    : await inferPrTitle(branchName, params, cwd);

  // Resolve base branch.
  const base = typeof params.base === "string" && params.base.trim().length > 0
    ? params.base.trim()
    : await resolveDefaultBranch(repo, token, apiBaseUrl);

  const pushOnly = typeof params.pushOnly === "boolean" ? params.pushOnly : false;

  if (pushOnly) {
    writeStdoutJson({
      state: {
        mimeGhPr: {
          ok: true,
          branchName,
          remote,
          repo,
          pushOnly: true,
        },
      },
      event: [{
        type: "result.branch_pushed",
        message: `Branch ${branchName} pushed to ${remote}`,
        payload: {
          branchName,
          remote,
          repo,
        },
      }],
    });
    process.exit(0);
  }

  // Create the pull request.
  const draft = typeof params.draft === "boolean" ? params.draft : false;
  const body = typeof params.body === "string" && params.body.trim().length > 0
    ? params.body.trim()
    : undefined;

  const prResult = await createPullRequest(repo, title, branchName, base, token, apiBaseUrl, { body, draft });

  if (!prResult.ok) {
    throw new UtilityError(`Mime-GH-PR: GitHub API error creating pull request: ${prResult.error}`, {
      repo,
      prOk: false,
      apiError: prResult.error,
      apiStatus: prResult.status,
    });
  }

  writeStdoutJson({
    state: {
      mimeGhPr: {
        ok: true,
        prUrl: prResult.prUrl,
        prNumber: prResult.prNumber,
        branchName,
        remote,
        repo,
        base,
        draft,
        title,
      },
    },
    event: [{
      type: "result.pr_created",
      message: `PR #${prResult.prNumber} created`,
      payload: {
        prUrl: prResult.prUrl,
        prNumber: prResult.prNumber,
        branchName,
        baseBranch: base,
        repo,
      },
    }],
  });
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.startsWith("Mime-GH-PR:") ? rawMessage : `Mime-GH-PR: ${rawMessage}`;
  const details = error instanceof UtilityError ? error.details : {};
  console.error(message);
  writeStdoutJson({
    state: {
      mimeGhPr: {
        ok: false,
        error: message,
        ...details,
      },
    },
  });
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function writeStdoutJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isCommandAvailable(command) {
  const { access, constants } = await import("node:fs/promises");
  const pathValue = process.env.PATH ?? "";
  const { delimiter, join, platform } = await import("node:path");
  const extensions = platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        await access(join(dir, `${command}${ext}`), constants.X_OK);
        return true;
      } catch {
        // Try next candidate.
      }
    }
  }
  return false;
}

async function resolveGitRoot(cwd) {
  try {
    const stdout = await execFileText("git", ["rev-parse", "--show-toplevel"], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the branch name from:
 *   1. params.branch (explicit override)
 *   2. state.mimeBootstrap.branchName
 *   3. `git branch --show-current` (current branch)
 */
async function resolveBranchName(input, cwd) {
  const params = isPlainObject(input.params) ? input.params : {};
  if (typeof params.branch === "string" && params.branch.trim().length > 0) {
    return params.branch.trim();
  }

  const state = isPlainObject(input.state) ? input.state : {};
  const mb = isPlainObject(state.mimeBootstrap) ? state.mimeBootstrap : {};
  if (typeof mb.branchName === "string" && mb.branchName.trim().length > 0) {
    return mb.branchName.trim();
  }

  // Fall back to current branch detection.
  try {
    const stdout = await execFileText("git", ["branch", "--show-current"], cwd);
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

async function checkBranchExists(branchName, cwd) {
  try {
    const stdout = await execFileText("git", ["branch", "--list", branchName], cwd);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function resolveRemote(params) {
  if (typeof params.remote === "string" && params.remote.trim().length > 0) {
    return params.remote.trim();
  }
  return "origin";
}

async function resolveRemoteUrl(remote, cwd) {
  try {
    const stdout = await execFileText("git", ["remote", "get-url", remote], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Parse a GitHub owner/repo from a remote URL.
 * Supports:
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   git@github.com:owner/repo.git
 *   ssh://git@github.com/owner/repo.git
 */
function parseGitHubRepoFromUrl(url) {
  if (typeof url !== "string") return null;
  // HTTPS: https://github.com/owner/repo(.git)?
  let match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/\s.]+?)(?:\.git)?(?:\/)?$/);
  if (match) return `${match[1]}/${match[2]}`;
  // SSH alias: git@github.com:owner/repo(.git)?
  match = url.match(/^git@github\.com:([^/]+)\/([^/\s.]+?)(?:\.git)?$/);
  if (match) return `${match[1]}/${match[2]}`;
  // SSH URL: ssh://git@github.com/owner/repo(.git)?
  match = url.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/\s.]+?)(?:\.git)?$/);
  if (match) return `${match[1]}/${match[2]}`;
  return null;
}

function resolveRepo(params, remoteUrl) {
  if (typeof params.repo === "string" && params.repo.trim().length > 0) {
    return params.repo.trim();
  }
  return parseGitHubRepoFromUrl(remoteUrl);
}

async function inferPrTitle(branchName, params, cwd) {
  // 1. Explicit params.title
  if (typeof params.title === "string" && params.title.trim().length > 0) {
    return params.title.trim();
  }

  // 2. Latest commit message on the branch (via `git log -1 --format=%s`)
  try {
    const stdout = await execFileText("git", ["log", "-1", "--format=%s", branchName], cwd);
    const firstLine = stdout.trim().split(/\r?\n/)[0];
    if (firstLine && firstLine.trim().length > 0) {
      return firstLine.trim();
    }
  } catch {
    // Fall through to branch name.
  }

  // 3. Branch name itself
  return branchName;
}

async function pushBranch(branchName, remote, cwd) {
  try {
    await execFileText("git", ["push", "-u", remote, branchName], cwd);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatExecError(error) };
  }
}

async function resolveDefaultBranch(repo, token, apiBaseUrl) {
  try {
    const response = await fetch(`${apiBaseUrl}/repos/${repo}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "pi-materia-mime-gh-pr",
      },
    });
    if (!response.ok) return "main";
    const data = await response.json();
    return typeof data.default_branch === "string" ? data.default_branch : "main";
  } catch {
    return "main";
  }
}

async function createPullRequest(repo, title, head, base, token, apiBaseUrl, { body, draft } = {}) {
  const payload = { title, head, base, draft };
  if (typeof body === "string" && body.length > 0) {
    payload.body = body;
  }

  try {
    const response = await fetch(`${apiBaseUrl}/repos/${repo}/pulls`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "pi-materia-mime-gh-pr",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        error: data.message ?? `HTTP ${response.status}`,
        status: response.status,
      };
    }

    return {
      ok: true,
      prUrl: data.html_url ?? `https://github.com/${repo}/pull/${data.number}`,
      prNumber: data.number,
    };
  } catch (error) {
    return { ok: false, error: formatExecError(error) };
  }
}

function execFileText(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (stderr && stderr.trim().length > 0) {
        console.error(`[${command}] ${stderr.trim()}`);
      }
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

function formatExecError(error) {
  const message = typeof error === "object" && error !== null ? error.message ?? String(error) : String(error);
  let details = message;
  if (typeof error === "object" && error !== null && "stderr" in error && error.stderr) {
    details += ` (stderr: ${String(error.stderr).trim()})`;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    details += ` (exit: ${error.code})`;
  }
  return details;
}

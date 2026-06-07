#!/usr/bin/env node
/**
 * Blackbelt-PR — deterministic jj-only GitHub pull request utility.
 *
 * Pushes a specified or inferred jj bookmark to a GitHub remote and creates
 * a pull request through the GitHub API.  Requires jj (no git fallback).
 * Authentication uses a configurable environment variable name so secrets
 * never appear in plans, logs, or artifacts.
 *
 * Input scope:
 *   - params.bookmark   → explicit bookmark name override
 *   - params.revision   → revision to push (default: the bookmark or @)
 *   - params.base       → PR base branch (default: inferred from remote HEAD)
 *   - params.remote     → git remote name (default: first remote)
 *   - params.repo       → explicit owner/repo (default: parsed from remote URL)
 *   - params.title      → PR title override
 *   - params.body       → PR body text
 *   - params.draft      → boolean, create as draft PR
 *   - params.authEnv    → env var name for GitHub token (default: GITHUB_TOKEN)
 *   - state.blackbeltBootstrap.bookmarkName → fallback bookmark
 *
 * PR title inference (first available):
 *   1. params.title
 *   2. First line of the bookmarked revision's jj description
 *   3. The bookmark name itself
 *
 * Output contract: stdout JSON with top-level `state.blackbeltPr`.
 * Stderr is reserved for diagnostics.
 * All known failure modes (missing jj, missing auth, unresolved bookmark,
 * push failure, API error) return a blackbeltPr failure payload.
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

  // Require jj — no git fallback.
  if (!(await isCommandAvailable("jj"))) {
    throw new UtilityError("Blackbelt-PR: jj is required but was not found on PATH.", {
      available: { jj: false },
    });
  }

  // Verify we are inside a jj repo.
  const jjRoot = await resolveJjRoot(cwd);
  if (jjRoot === null) {
    throw new UtilityError("Blackbelt-PR: no jj repository detected. Run Blackbelt-Bootstrap first.", {
      hasJjRepo: false,
    });
  }

  // Resolve bookmark name.
  const bookmarkName = resolveBookmarkName(input) ?? resolveBootstrapBookmark(input);
  if (typeof bookmarkName !== "string" || bookmarkName.trim().length === 0) {
    throw new UtilityError("Blackbelt-PR: no bookmark resolved. Provide params.bookmark or run Blackbelt-Bootstrap first.", {
      bookmarkResolved: false,
    });
  }

  // Resolve and validate revision (or verify bookmark exists if no revision).
  const revision = typeof params.revision === "string" && params.revision.trim().length > 0
    ? params.revision.trim()
    : null;

  if (revision !== null) {
    // Validate that the revision can be resolved.
    const revisionExists = await checkRevisionExists(revision, cwd);
    if (!revisionExists) {
      throw new UtilityError(`Blackbelt-PR: revision "${revision}" could not be resolved.`, {
        revision,
        revisionResolved: false,
      });
    }

    // Set (or create) the bookmark to point at the requested revision.
    const setResult = await setBookmarkRevision(bookmarkName, revision, cwd);
    if (!setResult.ok) {
      throw new UtilityError(`Blackbelt-PR: failed to set bookmark "${bookmarkName}" to revision "${revision}": ${setResult.error}`, {
        bookmarkName,
        revision,
        bookmarkSetOk: false,
        bookmarkSetError: setResult.error,
      });
    }
  } else {
    // No revision specified — verify the bookmark exists.
    const bookmarkExists = await checkBookmarkExists(bookmarkName, cwd);
    if (!bookmarkExists) {
      throw new UtilityError(`Blackbelt-PR: bookmark "${bookmarkName}" does not exist.`, {
        bookmarkName,
        bookmarkExists: false,
      });
    }
  }

  // Resolve remote.
  const remote = resolveRemote(params);
  const remoteUrl = await resolveRemoteUrl(remote, cwd);
  if (remoteUrl === null) {
    throw new UtilityError(`Blackbelt-PR: could not resolve URL for remote "${remote}". Check jj git remote list.`, {
      remote,
      remoteResolved: false,
    });
  }

  // Resolve repository owner/name.
  const repo = resolveRepo(params, remoteUrl);
  if (repo === null) {
    throw new UtilityError(`Blackbelt-PR: could not determine GitHub owner/repo from remote URL "${remoteUrl}". Provide params.repo as "owner/name".`, {
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
    throw new UtilityError(`Blackbelt-PR: GitHub token not found in environment variable "${authEnv}". Set ${authEnv} or configure params.authEnv.`, {
      authEnv,
      tokenFound: false,
    });
  }

  // Resolve GitHub API base URL (supports GHE and testing overrides).
  const apiBaseUrl = typeof params.apiBaseUrl === "string" && params.apiBaseUrl.trim().length > 0
    ? params.apiBaseUrl.trim().replace(/\/$/, "")
    : (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");

  // Pre-push revision check: if the bookmark tip is an empty descriptionless
  // working commit, safely move the bookmark to the nearest pushable ancestor
  // when that drops no file changes.  Otherwise fail early without attempting
  // git push (which would reject unnamed, empty commits).
  const preflight = await preflightPushRevision(bookmarkName, revision, cwd);
  if (!preflight.pushable) {
    throw new UtilityError(
      `Blackbelt-PR: no pushable revision for bookmark "${bookmarkName}". ` +
        `The bookmark points to an empty, descriptionless commit with no non-empty ancestor. ` +
        `Describe the working commit or ensure there are changes before pushing.`,
      {
        bookmarkName,
        noPushableRevision: true,
        reason: preflight.reason,
      },
    );
  }
  // Use the potentially-adjusted revision for push and PR.
  const pushRevision = preflight.revision;

  // Push the bookmark to GitHub.
  const pushResult = await pushBookmark(bookmarkName, remote, cwd);
  if (!pushResult.ok) {
    throw new UtilityError(`Blackbelt-PR: push failed for bookmark "${bookmarkName}" to remote "${remote}": ${pushResult.error}`, {
      bookmarkName,
      remote,
      pushOk: false,
      pushError: pushResult.error,
    });
  }

  // Infer PR title.
  const title = await inferPrTitle(bookmarkName, pushRevision, params, cwd);

  // Resolve base branch.
  const base = typeof params.base === "string" && params.base.trim().length > 0
    ? params.base.trim()
    : await resolveDefaultBranch(repo, token, apiBaseUrl);

  // Create the pull request.
  const draft = typeof params.draft === "boolean" ? params.draft : false;
  const body = typeof params.body === "string" && params.body.trim().length > 0
    ? params.body.trim()
    : undefined;

  const prResult = await createPullRequest(repo, title, bookmarkName, base, token, apiBaseUrl, { body, draft });

  if (!prResult.ok) {
    throw new UtilityError(`Blackbelt-PR: GitHub API error creating pull request: ${prResult.error}`, {
      repo,
      prOk: false,
      apiError: prResult.error,
      apiStatus: prResult.status,
    });
  }

  writeStdoutJson({
    state: {
      blackbeltPr: {
        ok: true,
        prUrl: prResult.prUrl,
        prNumber: prResult.prNumber,
        bookmarkName,
        revision: preflight.adjusted ? preflight.revision : (revision ?? bookmarkName),
        remote,
        repo,
        base,
        draft,
        title,
        ...(preflight.adjusted ? { revisionAdjusted: true, originalRevision: revision ?? bookmarkName } : {}),
      },
    },
  });
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.startsWith("Blackbelt-PR:") ? rawMessage : `Blackbelt-PR: ${rawMessage}`;
  const details = error instanceof UtilityError ? error.details : {};
  console.error(message);
  writeStdoutJson({
    state: {
      blackbeltPr: {
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

async function resolveJjRoot(cwd) {
  try {
    const stdout = await execFileText("jj", ["root"], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function resolveBookmarkName(input) {
  const params = isPlainObject(input.params) ? input.params : {};
  if (typeof params.bookmark === "string" && params.bookmark.trim().length > 0) {
    return params.bookmark.trim();
  }
  return null;
}

function resolveBootstrapBookmark(input) {
  const state = isPlainObject(input.state) ? input.state : {};
  const bb = isPlainObject(state.blackbeltBootstrap) ? state.blackbeltBootstrap : {};
  if (typeof bb.bookmarkName === "string" && bb.bookmarkName.trim().length > 0) {
    return bb.bookmarkName.trim();
  }
  return null;
}

async function checkBookmarkExists(bookmarkName, cwd) {
  try {
    const stdout = await execFileText("jj", ["bookmark", "list"], cwd);
    const lines = stdout.split(/\r?\n/);
    return lines.some((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      // Format: "bookmark-name: revision (description)"
      // Leading flags like "* " for the active bookmark may appear.
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) return false;
      const name = trimmed.slice(0, colonIdx).replace(/^[* ]+/, "").trim();
      return name === bookmarkName;
    });
  } catch {
    return false;
  }
}

/**
 * Verify that a revision can be resolved by jj.
 */
async function checkRevisionExists(revision, cwd) {
  try {
    const stdout = await execFileText("jj", ["log", "--no-graph", "-r", revision, "-T", "commit_id"], cwd);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Set (or create) a bookmark to point at a specific revision.
 * Uses the idempotent bookmark-set strategy from blackbelt-maintain.
 */
async function setBookmarkRevision(bookmarkName, revision, cwd) {
  try {
    await execFileText("jj", ["bookmark", "set", bookmarkName, "--revision", revision], cwd);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatExecError(error) };
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
    const stdout = await execFileText("jj", ["git", "remote", "list"], cwd);
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2 && parts[0] === remote) {
        return parts.slice(1).join(" ");
      }
    }
    return null;
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

async function inferPrTitle(bookmarkName, revision, params, cwd) {
  // 1. Explicit params.title
  if (typeof params.title === "string" && params.title.trim().length > 0) {
    return params.title.trim();
  }

  // 2. First line of the revision's jj description.
  //    Use the explicitly-provided revision, or fall back to the bookmark name.
  const revForDescription = revision ?? bookmarkName;
  try {
    const description = await execFileText("jj", ["log", "--no-graph", "-r", revForDescription, "-T", "description"], cwd);
    const firstLine = description.trim().split(/\r?\n/)[0];
    if (firstLine && firstLine.trim().length > 0) {
      return firstLine.trim();
    }
  } catch (error) {
    // If the user explicitly provided a revision (and it was validated earlier),
    // this should not fail — escalate instead of silently falling back.
    if (revision !== null) {
      throw new UtilityError(`Blackbelt-PR: could not read description for revision "${revForDescription}": ${formatExecError(error)}`, {
        revision,
        descriptionResolved: false,
      });
    }
    // When reading the bookmark description fails, fall through to bookmark name.
  }

  // 3. Bookmark name itself
  return bookmarkName;
}

/**
 * Pre-push revision safety check.
 *
 * If the resolved bookmark tip is a purely empty, descriptionless working commit,
 * walk up parent chain to find the nearest non-empty ancestor.  Move the bookmark
 * to that ancestor only when it drops no file changes (the tip diff is empty so
 * no diffs are lost).  Return noPushableRevision when there is no non-empty ancestor.
 *
 * Returns { pushable: true, revision, adjusted: false } for normal revisions,
 *         { pushable: true, revision, adjusted: true, originalRevision } for adjusted,
 *         { pushable: false, reason: "noPushableRevision" } for failure.
 */
async function preflightPushRevision(bookmarkName, revision, cwd) {
  const checkRev = revision ?? bookmarkName;

  // 1. Check if the revision is empty (no diff).
  let diffSummary;
  try {
    diffSummary = (await execFileText("jj", ["diff", "--summary", "-r", checkRev], cwd)).trim();
  } catch {
    // Can't check diff — assume pushable.
    return { pushable: true, revision: checkRev, adjusted: false };
  }
  const isEmpty = diffSummary.length === 0;
  if (!isEmpty) {
    return { pushable: true, revision: checkRev, adjusted: false };
  }

  // 2. Check if the revision is descriptionless.
  let description;
  try {
    description = (await execFileText("jj", ["log", "--no-graph", "-r", checkRev, "-T", "description"], cwd)).trim();
  } catch {
    return { pushable: true, revision: checkRev, adjusted: false };
  }
  const isDescriptionless = description.length === 0;
  if (!isDescriptionless) {
    // Has a description — let the push attempt proceed normally.
    return { pushable: true, revision: checkRev, adjusted: false };
  }

  // 3. Empty AND descriptionless — find nearest non-empty ancestor.
  let ancestorRev = checkRev;
  const maxWalk = 50; // Safety valve to prevent infinite loops.
  for (let i = 0; i < maxWalk; i++) {
    // Get parent commit IDs.
    let parents;
    try {
      parents = (await execFileText("jj", [
        "log", "--no-graph", "-r", `parents(${ancestorRev})`,
        "-T", "commit_id ++ \"\\n\"",
      ], cwd)).trim();
    } catch {
      return { pushable: false, reason: "noPushableRevision" };
    }

    if (!parents) {
      return { pushable: false, reason: "noPushableRevision" };
    }

    const parentId = parents.split(/\r?\n/)[0].trim();

    // Check if parent has changes.
    let parentDiff;
    try {
      parentDiff = (await execFileText("jj", ["diff", "--summary", "-r", parentId], cwd)).trim();
    } catch {
      return { pushable: false, reason: "noPushableRevision" };
    }

    if (parentDiff.length > 0) {
      // Found a non-empty ancestor.  The tip is empty (no diff), so moving
      // the bookmark to this ancestor does not drop any file changes.
      try {
        await execFileText("jj", ["bookmark", "set", bookmarkName, "--revision", parentId], cwd);
        return {
          pushable: true,
          revision: parentId,
          adjusted: true,
          originalRevision: checkRev,
        };
      } catch {
        return { pushable: false, reason: "noPushableRevision" };
      }
    }

    // Parent is also empty — continue walking up the chain.
    ancestorRev = parentId;
  }

  return { pushable: false, reason: "noPushableRevision" };
}

async function pushBookmark(bookmarkName, remote, cwd) {
  try {
    await execFileText("jj", ["git", "push", "--bookmark", bookmarkName, "--remote", remote], cwd);
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
        "User-Agent": "pi-materia-blackbelt-pr",
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
        "User-Agent": "pi-materia-blackbelt-pr",
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

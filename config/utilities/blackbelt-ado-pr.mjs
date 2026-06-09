#!/usr/bin/env node
/**
 * Blackbelt-ADO-PR — deterministic jj-only Azure DevOps pull request utility.
 *
 * Pushes a specified or inferred jj bookmark to an Azure DevOps remote and
 * creates a pull request through the Azure DevOps REST API.  Requires jj
 * (no git fallback).  Authentication uses a configurable environment variable
 * name so secrets never appear in plans, logs, or artifacts.
 *
 * Input scope:
 *   - params.bookmark   → explicit bookmark name override
 *   - params.revision   → revision to push (default: the bookmark or @)
 *   - params.base       → PR target branch (default: inferred from remote HEAD)
 *   - params.remote     → git remote name (default: first remote)
 *   - params.repo       → explicit "org/project/repo" override
 *   - params.organization → explicit Azure DevOps organization
 *   - params.project    → explicit Azure DevOps project
 *   - params.repository → explicit Azure DevOps repository name
 *   - params.title      → PR title override
 *   - params.body       → PR body text
 *   - params.draft      → boolean, create as draft PR
 *   - params.authEnv    → env var name for ADO PAT (default: AZURE_DEVOPS_EXT_PAT)
 *   - params.apiBaseUrl → ADO API base URL override (for testing)
 *   - state.blackbeltBootstrap.bookmarkName → fallback bookmark
 *
 * PR title inference (first available):
 *   1. params.title
 *   2. First line of the bookmarked revision's jj description
 *   3. The bookmark name itself
 *
 * Output contract: stdout JSON with top-level `state.blackbeltAdoPr`.
 * Stderr is reserved for diagnostics.
 * All known failure modes (missing jj, missing auth, unresolved bookmark,
 * push failure, API error) return a blackbeltAdoPr failure payload.
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
    throw new UtilityError("Blackbelt-ADO-PR: jj is required but was not found on PATH.", {
      available: { jj: false },
    });
  }

  // Verify we are inside a jj repo.
  const jjRoot = await resolveJjRoot(cwd);
  if (jjRoot === null) {
    throw new UtilityError("Blackbelt-ADO-PR: no jj repository detected. Run Blackbelt-Bootstrap first.", {
      hasJjRepo: false,
    });
  }

  // Resolve bookmark name.
  const bookmarkName = resolveBookmarkName(input) ?? resolveBootstrapBookmark(input);
  if (typeof bookmarkName !== "string" || bookmarkName.trim().length === 0) {
    throw new UtilityError("Blackbelt-ADO-PR: no bookmark resolved. Provide params.bookmark or run Blackbelt-Bootstrap first.", {
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
      throw new UtilityError(`Blackbelt-ADO-PR: revision "${revision}" could not be resolved.`, {
        revision,
        revisionResolved: false,
      });
    }

    // Set (or create) the bookmark to point at the requested revision.
    const setResult = await setBookmarkRevision(bookmarkName, revision, cwd);
    if (!setResult.ok) {
      throw new UtilityError(`Blackbelt-ADO-PR: failed to set bookmark "${bookmarkName}" to revision "${revision}": ${setResult.error}`, {
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
      throw new UtilityError(`Blackbelt-ADO-PR: bookmark "${bookmarkName}" does not exist.`, {
        bookmarkName,
        bookmarkExists: false,
      });
    }
  }

  // Resolve remote.
  const remote = resolveRemote(params);
  const remoteUrl = await resolveRemoteUrl(remote, cwd);
  if (remoteUrl === null) {
    throw new UtilityError(`Blackbelt-ADO-PR: could not resolve URL for remote "${remote}". Check jj git remote list.`, {
      remote,
      remoteResolved: false,
    });
  }

  // Resolve ADO organization, project, and repository.
  const adoConfig = resolveAdoConfig(params, remoteUrl);
  if (adoConfig === null) {
    throw new UtilityError(`Blackbelt-ADO-PR: could not determine Azure DevOps organization/project/repository from remote URL "${remoteUrl}". Provide params.organization, params.project, and params.repository, or params.repo as "org/project/repo".`, {
      remoteUrl,
      repoResolved: false,
    });
  }

  // Resolve auth token.
  const authEnv = typeof params.authEnv === "string" && params.authEnv.trim().length > 0
    ? params.authEnv.trim()
    : "AZURE_DEVOPS_EXT_PAT";
  const token = process.env[authEnv];
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new UtilityError(`Blackbelt-ADO-PR: Azure DevOps token not found in environment variable "${authEnv}". Set ${authEnv} or configure params.authEnv.`, {
      authEnv,
      tokenFound: false,
    });
  }

  // Resolve ADO API base URL (supports ADO Server / testing overrides).
  const apiBaseUrl = typeof params.apiBaseUrl === "string" && params.apiBaseUrl.trim().length > 0
    ? params.apiBaseUrl.trim().replace(/\/$/, "")
    : (process.env.AZURE_DEVOPS_API_URL ?? "https://dev.azure.com").replace(/\/$/, "");

  // Pre-push revision check: detect unpushable revisions before attempting
  // git push.  jj git push rejects both unnamed (non-empty + descriptionless)
  // and purely empty descriptionless commits.  For unnamed revisions, fail
  // early with diagnostics rather than silently renaming or dropping code.
  const preflight = await preflightPushRevision(bookmarkName, revision, cwd);
  if (!preflight.pushable) {
    if (preflight.reason === "unnamedRevision") {
      throw new UtilityError(
        `Blackbelt-ADO-PR: unpushable unnamed revision "${preflight.revision}" for bookmark "${bookmarkName}". ` +
          `The revision has changes but no description — jj git push requires a commit description. ` +
          `Describe the revision before pushing, e.g.: jj describe -r ${preflight.revision} -m "your message"`,
        {
          bookmarkName,
          unnamedRevision: true,
          revision: preflight.revision,
          reason: preflight.reason,
        },
      );
    }
    throw new UtilityError(
      `Blackbelt-ADO-PR: no pushable revision for bookmark "${bookmarkName}". ` +
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

  // Push the bookmark to Azure DevOps.
  const pushResult = await pushBookmark(bookmarkName, remote, cwd);
  if (!pushResult.ok) {
    throw new UtilityError(`Blackbelt-ADO-PR: push failed for bookmark "${bookmarkName}" to remote "${remote}": ${pushResult.error}`, {
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
    : await resolveDefaultBranch(adoConfig.organization, adoConfig.project, adoConfig.repository, token, apiBaseUrl);

  // Create the pull request.
  const draft = typeof params.draft === "boolean" ? params.draft : false;
  const body = typeof params.body === "string" && params.body.trim().length > 0
    ? params.body.trim()
    : undefined;

  const prResult = await createPullRequest(adoConfig, title, bookmarkName, base, token, apiBaseUrl, { body, draft });

  if (!prResult.ok) {
    throw new UtilityError(`Blackbelt-ADO-PR: Azure DevOps API error creating pull request: ${prResult.error}`, {
      org: adoConfig.organization,
      project: adoConfig.project,
      repo: adoConfig.repository,
      prOk: false,
      apiError: prResult.error,
      apiStatus: prResult.status,
    });
  }

  writeStdoutJson({
    state: {
      blackbeltAdoPr: {
        ok: true,
        prUrl: prResult.prUrl,
        prNumber: prResult.prNumber,
        bookmarkName,
        revision: preflight.adjusted ? preflight.revision : (revision ?? bookmarkName),
        remote,
        organization: adoConfig.organization,
        project: adoConfig.project,
        repository: adoConfig.repository,
        base,
        draft,
        title,
        ...(preflight.adjusted ? { revisionAdjusted: true, originalRevision: revision ?? bookmarkName } : {}),
      },
    },
  });
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.startsWith("Blackbelt-ADO-PR:") ? rawMessage : `Blackbelt-ADO-PR: ${rawMessage}`;
  const details = error instanceof UtilityError ? error.details : {};
  console.error(message);
  writeStdoutJson({
    state: {
      blackbeltAdoPr: {
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
 * Parse Azure DevOps org/project/repo from a remote URL.
 * Supports:
 *   https://dev.azure.com/org/project/_git/repo
 *   https://org@dev.azure.com/org/project/_git/repo
 *   git@ssh.dev.azure.com:v3/org/project/repo
 *
 * Returns { organization, project, repository } or null.
 */
function parseAdoFromUrl(url) {
  if (typeof url !== "string") return null;

  // HTTPS: https://dev.azure.com/org/project/_git/repo(.git)?
  let match = url.match(/^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/\s.]+?)(?:\.git)?(?:\/)?$/);
  if (match) return { organization: match[1], project: match[2], repository: match[3] };

  // HTTPS with org prefix: https://org@dev.azure.com/org/project/_git/repo(.git)?
  match = url.match(/^https?:\/\/[^@]+@dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/\s.]+?)(?:\.git)?(?:\/)?$/);
  if (match) return { organization: match[1], project: match[2], repository: match[3] };

  // SSH: git@ssh.dev.azure.com:v3/org/project/repo(.git)?
  match = url.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/\s.]+?)(?:\.git)?$/);
  if (match) return { organization: match[1], project: match[2], repository: match[3] };

  return null;
}

/**
 * Resolve ADO config from params and remote URL.
 * Priority:
 *   1. Explicit params.organization + params.project + params.repository
 *   2. params.repo as "org/project/repo" string
 *   3. Parsed from remote URL
 */
function resolveAdoConfig(params, remoteUrl) {
  // Explicit individual params
  const org = typeof params.organization === "string" && params.organization.trim().length > 0
    ? params.organization.trim()
    : null;
  const proj = typeof params.project === "string" && params.project.trim().length > 0
    ? params.project.trim()
    : null;
  const repo = typeof params.repository === "string" && params.repository.trim().length > 0
    ? params.repository.trim()
    : null;

  if (org && proj && repo) {
    return { organization: org, project: proj, repository: repo };
  }

  // params.repo as "org/project/repo"
  if (typeof params.repo === "string" && params.repo.trim().length > 0) {
    const parts = params.repo.trim().split("/");
    if (parts.length === 3) {
      return { organization: parts[0], project: parts[1], repository: parts[2] };
    }
  }

  // Parse from remote URL
  return parseAdoFromUrl(remoteUrl);
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
      throw new UtilityError(`Blackbelt-ADO-PR: could not read description for revision "${revForDescription}": ${formatExecError(error)}`, {
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
 * Detects two classes of unpushable revision:
 * 1. Unnamed (non-empty diff + blank description): jj git push requires a
 *    description to create the git commit.  Fail early with diagnostics
 *    rather than silently renaming or dropping code.
 * 2. Empty + descriptionless: walk up parent chain to find the nearest
 *    non-empty ancestor.  Move the bookmark to that ancestor only when it
 *    drops no file changes (the tip diff is empty so no diffs are lost).
 *    Return noPushableRevision when there is no non-empty ancestor.
 *
 * Returns { pushable: true, revision, adjusted: false } for normal revisions,
 *         { pushable: true, revision, adjusted: true, originalRevision } for adjusted,
 *         { pushable: false, reason: "unnamedRevision", bookmarkName, revision } for unnamed,
 *         { pushable: false, reason: "noPushableRevision" } for failure.
 */
async function preflightPushRevision(bookmarkName, revision, cwd) {
  const checkRev = revision ?? bookmarkName;

  // 1. Check if the revision has changes.
  let diffSummary;
  try {
    diffSummary = (await execFileText("jj", ["diff", "--summary", "-r", checkRev], cwd)).trim();
  } catch {
    // Can't check diff — assume pushable.
    return { pushable: true, revision: checkRev, adjusted: false };
  }
  const isEmpty = diffSummary.length === 0;

  // 2. Check if the revision has a description.
  let description;
  try {
    description = (await execFileText("jj", ["log", "--no-graph", "-r", checkRev, "-T", "description"], cwd)).trim();
  } catch {
    return { pushable: true, revision: checkRev, adjusted: false };
  }
  const isDescriptionless = description.length === 0;

  // 3. Non-empty but unnamed → jj git push will reject this commit because
  //    it has no description.  Fail early with diagnostics; do not silently
  //    rename or drop code.
  if (!isEmpty && isDescriptionless) {
    return {
      pushable: false,
      reason: "unnamedRevision",
      bookmarkName,
      revision: checkRev,
    };
  }

  // 4. Non-empty with a description — pushable.
  if (!isEmpty) {
    return { pushable: true, revision: checkRev, adjusted: false };
  }

  // 5. Empty with a description — pushable (the description signals intent).
  if (!isDescriptionless) {
    return { pushable: true, revision: checkRev, adjusted: false };
  }

  // 6. Empty AND descriptionless — find nearest non-empty ancestor.
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
      // Found a non-empty ancestor.  Verify it has a description before
      // considering it pushable — a non-empty unnamed ancestor would
      // just reproduce the same jj git push rejection.
      let parentDesc;
      try {
        parentDesc = (await execFileText("jj", [
          "log", "--no-graph", "-r", parentId, "-T", "description",
        ], cwd)).trim();
      } catch {
        // Can't check description — be conservative and report unnamed.
        return {
          pushable: false,
          reason: "unnamedRevision",
          bookmarkName,
          revision: parentId,
        };
      }
      if (parentDesc.length === 0) {
        // Non-empty ancestor with no description — unpushable.
        return {
          pushable: false,
          reason: "unnamedRevision",
          bookmarkName,
          revision: parentId,
        };
      }
      // Non-empty, named ancestor found.  The tip is empty (no diff), so
      // moving the bookmark to this ancestor drops no file changes.
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

async function resolveDefaultBranch(organization, project, repository, token, apiBaseUrl) {
  try {
    const response = await fetch(`${apiBaseUrl}/${organization}/${project}/_apis/git/repositories/${repository}?api-version=7.1`, {
      headers: {
        "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
        "Accept": "application/json",
        "User-Agent": "pi-materia-blackbelt-ado-pr",
      },
    });
    if (!response.ok) return "main";
    const data = await response.json();
    const defaultBranch = typeof data.defaultBranch === "string" ? data.defaultBranch : null;
    // defaultBranch is like "refs/heads/main" — strip the refs/heads/ prefix.
    if (defaultBranch && defaultBranch.startsWith("refs/heads/")) {
      return defaultBranch.slice("refs/heads/".length);
    }
    return defaultBranch ?? "main";
  } catch {
    return "main";
  }
}

async function createPullRequest(adoConfig, title, head, base, token, apiBaseUrl, { body, draft } = {}) {
  const { organization, project, repository } = adoConfig;
  // ADO requires refs/heads/ prefix for source and target refs.
  const sourceRefName = head.startsWith("refs/heads/") ? head : `refs/heads/${head}`;
  const targetRefName = base.startsWith("refs/heads/") ? base : `refs/heads/${base}`;

  const payload = {
    sourceRefName,
    targetRefName,
    title,
    isDraft: draft,
  };
  if (typeof body === "string" && body.length > 0) {
    payload.description = body;
  }

  try {
    const response = await fetch(`${apiBaseUrl}/${organization}/${project}/_apis/git/repositories/${repository}/pullrequests?api-version=7.1`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "pi-materia-blackbelt-ado-pr",
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

    const prUrl = `https://dev.azure.com/${organization}/${project}/_git/${repository}/pullrequest/${data.pullRequestId}`;

    return {
      ok: true,
      prUrl,
      prNumber: data.pullRequestId,
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

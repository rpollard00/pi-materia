#!/usr/bin/env node
/**
 * Mime-ADO-PR — deterministic git-only Azure DevOps pull request utility.
 *
 * Pushes the active git branch to an Azure DevOps remote and creates a pull
 * request through the Azure DevOps REST API.  Uses standard git commands
 * only — no jj dependency.
 *
 * Input scope:
 *   - params.branch     → explicit branch name override
 *   - params.remote     → git remote name (default: origin)
 *   - params.repo       → explicit "org/project/repo" override
 *   - params.organization → explicit Azure DevOps organization
 *   - params.project    → explicit Azure DevOps project
 *   - params.repository → explicit Azure DevOps repository name
 *   - params.title      → PR title override
 *   - params.body       → PR body text
 *   - params.draft      → boolean, create as draft PR
 *   - params.base       → PR target branch (default: inferred from remote HEAD)
 *   - params.pushOnly   → boolean, push branch but skip PR creation (emits result.branch_pushed)
 *   - params.authEnv    → env var name for ADO PAT (default: AZURE_DEVOPS_EXT_PAT)
 *   - params.apiBaseUrl → ADO API base URL override (for testing)
 *   - state.mimeBootstrap.branchName  → fallback branch
 *
 * PR title inference (first available):
 *   1. params.title
 *   2. Latest commit message on the branch (via `git log -1 --format=%s`)
 *   3. The branch name itself
 *
 * Output contract: stdout JSON with top-level `state.mimeAdoPr` and an
 * optional `event` array.  Successful PR creation emits result.pr_created;
 * pushOnly mode emits result.branch_pushed.  Stderr is reserved for
 * diagnostics.  All known failure modes (missing git, missing auth,
 * push failure, API error) return a mimeAdoPr failure payload with no event
 * array.
 */
import { execFile } from "node:child_process";

let activeSecrets = secretValuesForToken(process.env.AZURE_DEVOPS_EXT_PAT);

class UtilityError extends Error {
  constructor(message, details = {}) {
    super(redactSecrets(message, activeSecrets));
    this.details = redactSecretValues(details, activeSecrets);
  }
}

try {
  const input = await readStdinJson();
  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();
  const params = isPlainObject(input.params) ? input.params : {};
  const authEnv = typeof params.authEnv === "string" && params.authEnv.trim().length > 0
    ? params.authEnv.trim()
    : "AZURE_DEVOPS_EXT_PAT";
  const token = process.env[authEnv];
  activeSecrets = secretValuesForToken(token);

  // Require git — no jj fallback.
  if (!(await isCommandAvailable("git"))) {
    throw new UtilityError("Mime-ADO-PR: git is required but was not found on PATH.", {
      available: { git: false },
    });
  }

  // Verify we are inside a git repo.
  const gitRoot = await resolveGitRoot(cwd);
  if (gitRoot === null) {
    throw new UtilityError("Mime-ADO-PR: no git repository detected. Run Mime-Bootstrap first.", {
      hasGitRepo: false,
    });
  }

  // Resolve branch name.
  const branchName = await resolveBranchName(input, cwd);
  if (typeof branchName !== "string" || branchName.trim().length === 0) {
    throw new UtilityError("Mime-ADO-PR: no branch resolved. Provide params.branch, check out a branch, or run Mime-Bootstrap first.", {
      branchResolved: false,
    });
  }

  // Verify the branch exists.
  const branchExists = await checkBranchExists(branchName, cwd);
  if (!branchExists) {
    throw new UtilityError(`Mime-ADO-PR: branch "${branchName}" does not exist.`, {
      branchName,
      branchExists: false,
    });
  }

  // Resolve remote.
  const remote = resolveRemote(params);
  const remoteUrl = await resolveRemoteUrl(remote, cwd);
  if (remoteUrl === null) {
    throw new UtilityError(`Mime-ADO-PR: could not resolve URL for remote "${remote}". Check \`git remote -v\`.`, {
      remote,
      remoteResolved: false,
    });
  }

  // Resolve ADO organization, project, and repository.
  const adoConfig = resolveAdoConfig(params, remoteUrl);
  if (adoConfig === null) {
    throw new UtilityError(`Mime-ADO-PR: could not determine Azure DevOps organization/project/repository from remote URL "${remoteUrl}". Provide params.organization, params.project, and params.repository, or params.repo as "org/project/repo".`, {
      remoteUrl,
      repoResolved: false,
    });
  }

  // Validate the auth token resolved above.
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new UtilityError(`Mime-ADO-PR: Azure DevOps token not found in environment variable "${authEnv}". Set ${authEnv} or configure params.authEnv.`, {
      authEnv,
      tokenFound: false,
    });
  }

  // Resolve ADO API base URL (supports ADO Server / testing overrides).
  const apiBaseUrl = typeof params.apiBaseUrl === "string" && params.apiBaseUrl.trim().length > 0
    ? params.apiBaseUrl.trim().replace(/\/$/, "")
    : (process.env.AZURE_DEVOPS_API_URL ?? "https://dev.azure.com").replace(/\/$/, "");

  // Push the branch to Azure DevOps.
  const pushResult = await pushBranch(branchName, remote, remoteUrl, token, cwd);
  if (!pushResult.ok) {
    const pushError = pushResult.authenticationFailed
      ? `git authentication failed for HTTPS push; verify the PAT in "${authEnv}" is valid and has Code (read & write) scope`
      : pushResult.error;
    const message = pushResult.authenticationFailed
      ? `Mime-ADO-PR: ${pushError}`
      : `Mime-ADO-PR: push failed for branch "${branchName}" to remote "${remote}": ${pushError}`;
    throw new UtilityError(message, {
      branchName,
      remote,
      pushOk: false,
      pushError,
    });
  }

  // Infer PR title.
  const title = await inferPrTitle(branchName, params, cwd);

  // Resolve base branch.
  const base = typeof params.base === "string" && params.base.trim().length > 0
    ? params.base.trim()
    : await resolveDefaultBranch(adoConfig.organization, adoConfig.project, adoConfig.repository, token, apiBaseUrl);

  // Check for pushOnly mode before creating the PR.
  const pushOnly = typeof params.pushOnly === "boolean" ? params.pushOnly : false;

  if (pushOnly) {
    writeStdoutJson({
      state: {
        mimeAdoPr: {
          ok: true,
          branchName,
          remote,
          organization: adoConfig.organization,
          project: adoConfig.project,
          repository: adoConfig.repository,
          pushOnly: true,
        },
      },
      event: [{
        type: "result.branch_pushed",
        message: `Branch ${branchName} pushed to ${remote}`,
        payload: {
          branchName,
          remote,
          organization: adoConfig.organization,
          project: adoConfig.project,
          repository: adoConfig.repository,
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

  const prResult = await createPullRequest(adoConfig, title, branchName, base, token, apiBaseUrl, { body, draft });

  if (!prResult.ok) {
    throw new UtilityError(`Mime-ADO-PR: Azure DevOps API error creating pull request: ${prResult.error}`, {
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
      mimeAdoPr: {
        ok: true,
        prUrl: prResult.prUrl,
        prNumber: prResult.prNumber,
        branchName,
        remote,
        organization: adoConfig.organization,
        project: adoConfig.project,
        repository: adoConfig.repository,
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
        organization: adoConfig.organization,
        project: adoConfig.project,
        repository: adoConfig.repository,
      },
    }],
  });
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const sanitizedMessage = redactSecrets(rawMessage, activeSecrets);
  const message = sanitizedMessage.startsWith("Mime-ADO-PR:") ? sanitizedMessage : `Mime-ADO-PR: ${sanitizedMessage}`;
  const details = error instanceof UtilityError ? redactSecretValues(error.details, activeSecrets) : {};
  console.error(message);
  writeStdoutJson(redactSecretValues({
    state: {
      mimeAdoPr: {
        ok: false,
        error: message,
        ...details,
      },
    },
  }, activeSecrets));
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
  process.stdout.write(`${JSON.stringify(redactSecretValues(value, activeSecrets))}\n`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretValuesForToken(token) {
  if (typeof token !== "string" || token.trim().length === 0) return [];
  const pushEncodedToken = Buffer.from(`x-token-auth:${token}`).toString("base64");
  const apiEncodedToken = Buffer.from(`:${token}`).toString("base64");
  return [
    `Authorization: Basic ${pushEncodedToken}`,
    `Authorization: Basic ${apiEncodedToken}`,
    pushEncodedToken,
    apiEncodedToken,
    token,
  ];
}

function redactSecrets(text, secrets = []) {
  const values = [...new Set(secrets)]
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => right.length - left.length);
  if (values.length === 0) return String(text);
  const secretPattern = values
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return String(text).replace(
    new RegExp(`\\[redacted\\]|${secretPattern}`, "g"),
    "[redacted]",
  );
}

function redactSecretValues(value, secrets = []) {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactSecretValues(item, secrets));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSecretValues(item, secrets)]),
    );
  }
  return value;
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

async function pushBranch(branchName, remote, remoteUrl, token, cwd) {
  const env = { GIT_TERMINAL_PROMPT: "0" };
  if (/^https?:\/\//i.test(remoteUrl)) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-token-auth:${token}`).toString("base64")}`;
  }

  try {
    await execFileText("git", ["push", "-u", remote, branchName], cwd, env);
    return { ok: true };
  } catch (error) {
    const pushError = formatExecError(error, activeSecrets);
    return {
      ok: false,
      error: pushError,
      authenticationFailed: /^https?:\/\//i.test(remoteUrl) && isPushAuthenticationFailure(pushError),
    };
  }
}

function isPushAuthenticationFailure(text) {
  return /authentication failed|could not read username|terminal prompts disabled|invalid credentials|credentials? (?:were )?rejected|http basic: access denied|access denied|permission denied|permission to .* denied|you need the git .* permission|do not have (?:the )?permissions?|requires? authentication|\b(?:401|403)\b|\b(?:unauthorized|forbidden)\b|you are not authorized/i.test(text);
}

async function resolveDefaultBranch(organization, project, repository, token, apiBaseUrl) {
  try {
    const response = await fetch(`${apiBaseUrl}/${organization}/${project}/_apis/git/repositories/${repository}?api-version=7.1`, {
      headers: {
        "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
        "Accept": "application/json",
        "User-Agent": "pi-materia-mime-ado-pr",
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
        "User-Agent": "pi-materia-mime-ado-pr",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        error: redactSecrets(data.message ?? `HTTP ${response.status}`, activeSecrets),
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
    return { ok: false, error: formatExecError(error, activeSecrets) };
  }
}

function execFileText(command, args, cwd, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      env: { ...process.env, ...envOverrides },
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const sanitizedStderr = redactSecrets(stderr ?? "", activeSecrets);
      if (sanitizedStderr.trim().length > 0) {
        console.error(`[${command}] ${sanitizedStderr.trim()}`);
      }
      if (error) {
        error.stderr = sanitizedStderr;
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

function formatExecError(error, secrets = activeSecrets) {
  const message = typeof error === "object" && error !== null ? error.message ?? String(error) : String(error);
  let details = redactSecrets(message, secrets);
  if (typeof error === "object" && error !== null && "stderr" in error && error.stderr) {
    details += ` (stderr: ${redactSecrets(String(error.stderr).trim(), secrets)})`;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    details += ` (exit: ${error.code})`;
  }
  return redactSecrets(details, secrets);
}

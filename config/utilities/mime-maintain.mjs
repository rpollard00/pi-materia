#!/usr/bin/env node
/**
 * Mime-Maintain — deterministic git commit utility.
 *
 * Stages all changes (`git add -A`) and commits them with the current
 * workItem title as the commit message.  Uses standard git commands
 * only — no jj dependency.
 *
 * Input scope (tightly constrained):
 *   - item.title          → git commit message
 *   - cwd                 → working directory for git commands
 *   - state.mimeBootstrap.branchName → branch reference for status output
 *   - params.userName / params.userEmail → fallback commit identity overrides
 *
 * When git has no configured user.name or user.email, commits use the
 * deterministic fallback `pi-materia <pi-materia@localhost>`. The fallback
 * can also be overridden with PI_MATERIA_GIT_USER_NAME and
 * PI_MATERIA_GIT_USER_EMAIL. Existing git config and standard Git author
 * and committer environment variables take precedence.
 *
 * Explicitly NOT coupled to:
 *   - Runtime cast status (phase, active, failedReason, socketState, etc.)
 *   - Artifact scanning or manifest entries
 *   - jj or blackbelt code
 *
 * Output contract: stdout JSON. Successful and clean no-op paths emit the
 * reserved graph-control field `satisfied: true` plus a plain-text `context`
 * message so the output is accepted by sockets using satisfied routing, while
 * deterministic utility details remain under `state.mimeMaintain`.
 * Stderr is reserved for diagnostics.
 * Known/recoverable failure modes (missing git, missing repo, missing title,
 * commit failure) emit `satisfied: false` plus a plain-text `context` with
 * `state.mimeMaintain.ok: false` and exit 0 so satisfied-routing sockets can
 * still consume the structured result. Unexpected parser/runtime crashes
 * that prevent handled output formation are preserved as true process
 * failures (no satisfied/context fields, non-zero exit).
 * A clean working tree produces `ok: true` with a deterministic no-op message
 * rather than failing.
 */
import { execFile } from "node:child_process";

const DEFAULT_GIT_USER_NAME = "pi-materia";
const DEFAULT_GIT_USER_EMAIL = "pi-materia@localhost";

class UtilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

try {
  const input = await readStdinJson();
  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();
  const title = input.item != null && typeof input.item === "object" ? input.item.title : null;

  // Resolve branch name from mime-bootstrap state for status reference.
  const branchName = resolveBranchName(input);

  // Require git.
  if (!(await isCommandAvailable("git"))) {
    throw new UtilityError("Mime-Maintain: git is required but was not found on PATH.", {
      available: { git: false },
      hasGitRepo: false,
    });
  }

  // Check we are inside a git repo.
  const gitRoot = await resolveGitRoot(cwd);
  if (gitRoot === null) {
    throw new UtilityError("Mime-Maintain: no git repository detected. Run Mime-Bootstrap first.", {
      available: { git: true },
      hasGitRepo: false,
    });
  }

  // Fail early if no title available.
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new UtilityError("Mime-Maintain: no item title available for the commit message.", {
      available: { git: true },
      hasGitRepo: true,
    });
  }

  // Detect clean working tree.
  const isClean = await isWorkingTreeClean(cwd);

  if (isClean) {
    const message = "Mime-Maintain: working tree clean — nothing to commit.";
    writeStdoutJson({
      satisfied: true,
      context: message,
      state: {
        mimeMaintain: {
          ok: true,
          committed: false,
          noop: true,
          branchName: branchName ?? null,
          message,
        },
      },
    });
    process.exit(0);
  }

  // Stage and commit. Identity environment variables are supplied only when
  // neither git config nor the corresponding standard git environment
  // variable provides a value, so repository/global identity still wins.
  try {
    await execFileText("git", ["add", "-A"], cwd);
    const identityEnv = await resolveCommitIdentityEnvironment(input, cwd);
    await execFileText("git", ["commit", "-m", title.trim()], cwd, identityEnv);
    const commitMessage = title.trim();
    const context = branchName
      ? `Mime-Maintain: committed "${commitMessage}" to ${branchName}.`
      : `Mime-Maintain: committed "${commitMessage}".`;
    writeStdoutJson({
      satisfied: true,
      context,
      state: {
        mimeMaintain: {
          ok: true,
          committed: true,
          noop: false,
          branchName: branchName ?? null,
          message: commitMessage,
        },
      },
    });
  } catch (error) {
    throw new UtilityError(`Mime-Maintain: git command failed: ${formatExecError(error)}`, {
      available: { git: true },
      hasGitRepo: true,
      gitError: formatExecError(error),
    });
  }
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.startsWith("Mime-Maintain:") ? rawMessage : `Mime-Maintain: ${rawMessage}`;
  console.error(message);

  if (error instanceof UtilityError) {
    // Known/recoverable failures (missing git, missing repo, missing title,
    // commit failure) normalize into routable handoff JSON: top-level
    // satisfied:false plus a plain-text context so satisfied-routing sockets
    // accept the structured result, with deterministic details preserved under
    // state.mimeMaintain.ok:false. Exit 0 so the loop consumes the result.
    writeStdoutJson({
      satisfied: false,
      context: message,
      state: {
        mimeMaintain: {
          ok: false,
          error: message,
          ...error.details,
        },
      },
    });
    process.exitCode = 0;
  } else {
    // Unexpected parser/runtime crashes that prevent handled output formation
    // are preserved as true process failures: emit the structured error state
    // for diagnostics but keep a non-zero exit so the failure is observable.
    writeStdoutJson({
      state: {
        mimeMaintain: {
          ok: false,
          error: message,
        },
      },
    });
    process.exitCode = 1;
  }
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

function resolveBranchName(input) {
  const state = input.state != null && typeof input.state === "object" ? input.state : {};
  const mbState = state.mimeBootstrap != null && typeof state.mimeBootstrap === "object" ? state.mimeBootstrap : {};
  if (typeof mbState.branchName === "string" && mbState.branchName.trim().length > 0) {
    return mbState.branchName.trim();
  }
  return null;
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

async function isWorkingTreeClean(cwd) {
  try {
    const stdout = await execFileText("git", ["status", "--porcelain"], cwd);
    return stdout.trim().length === 0;
  } catch {
    return false;
  }
}

async function resolveCommitIdentityEnvironment(input, cwd) {
  const params = isPlainObject(input.params) ? input.params : {};
  const fallbackName = firstNonEmptyString(
    params.userName,
    process.env.PI_MATERIA_GIT_USER_NAME,
    DEFAULT_GIT_USER_NAME,
  );
  const fallbackEmail = firstNonEmptyString(
    params.userEmail,
    process.env.PI_MATERIA_GIT_USER_EMAIL,
    DEFAULT_GIT_USER_EMAIL,
  );
  const [configuredName, configuredEmail] = await Promise.all([
    readGitConfig(cwd, "user.name"),
    readGitConfig(cwd, "user.email"),
  ]);
  const env = {};

  if (configuredName === null) {
    if (!isNonEmptyString(process.env.GIT_AUTHOR_NAME)) env.GIT_AUTHOR_NAME = fallbackName;
    if (!isNonEmptyString(process.env.GIT_COMMITTER_NAME)) env.GIT_COMMITTER_NAME = fallbackName;
  }
  if (configuredEmail === null) {
    if (!isNonEmptyString(process.env.GIT_AUTHOR_EMAIL)) env.GIT_AUTHOR_EMAIL = fallbackEmail;
    if (!isNonEmptyString(process.env.GIT_COMMITTER_EMAIL)) env.GIT_COMMITTER_EMAIL = fallbackEmail;
  }

  return env;
}

async function readGitConfig(cwd, key) {
  try {
    const stdout = await execFileText("git", ["config", "--get", key], cwd);
    return isNonEmptyString(stdout) ? stdout.trim() : null;
  } catch {
    return null;
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return "";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function execFileText(command, args, cwd, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      env: { ...process.env, ...envOverrides },
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
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

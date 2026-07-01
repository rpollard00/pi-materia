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
 * All known failure modes return `state.mimeMaintain.ok: false` with a
 * descriptive error string.  A clean working tree produces `ok: true`
 * with a deterministic no-op message rather than failing.
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

  // Stage and commit.
  try {
    await execFileText("git", ["add", "-A"], cwd);
    await execFileText("git", ["commit", "-m", title.trim()], cwd);
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
  const details = error instanceof UtilityError ? error.details : {};
  console.error(message);
  writeStdoutJson({
    state: {
      mimeMaintain: {
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

#!/usr/bin/env node
/**
 * Blackbelt-Maintain — deterministic jj checkpoint utility.
 *
 * Input scope (tightly constrained):
 *   - item.title          → jj describe message
 *   - cwd                 → working directory for jj commands
 *   - state.blackbeltBootstrap.bookmarkName → bootstrap-owned bookmark target
 *
 * Explicitly NOT coupled to:
 *   - Runtime cast status (phase, active, failedReason, socketState, etc.)
 *   - Artifact scanning or manifest entries
 *   - Cast lifecycle handoff beyond the bootstrap bookmark
 *
 * Output contract: stdout JSON with ONLY top-level `satisfied` and `context`.
 * Stderr is reserved for diagnostics; no state patches are emitted.
 * All known failure modes (no title, no jj repo, jj command error) return
 * `satisfied: false` with a descriptive context string.
 */
import { execFile } from "node:child_process";

try {
  const input = await readStdinJson();
  const title = input.item != null && typeof input.item === "object" ? input.item.title : null;
  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();

  // Determine bookmark name early so every result context can include it.
  // Bootstrap owns bookmark naming; maintain must not invent replacements.
  const bookmarkName = resolveBookmarkName(input);
  if (bookmarkName === null) {
    writeStdoutJson({
      satisfied: false,
      context: "Blackbelt-Maintain: missing state.blackbeltBootstrap.bookmarkName. Run Blackbelt-Bootstrap first so maintain can advance the bootstrap-owned bookmark.",
    });
    process.exit(0);
  }

  // Fail early if no title available
  if (typeof title !== "string" || title.trim().length === 0) {
    writeStdoutJson({
      satisfied: false,
      context: `Blackbelt-Maintain: no item title available for the VCS message. [bookmark: ${bookmarkName}]`,
    });
    process.exit(0);
  }

  // Require jj; no git fallback — tell the user to run Blackbelt-Bootstrap first
  const jjRoot = await resolveJjRoot(cwd);
  if (jjRoot === null) {
    writeStdoutJson({
      satisfied: false,
      context: `Blackbelt-Maintain: jj is not available or no jj repo is detected. Run Blackbelt-Bootstrap first. [bookmark: ${bookmarkName}]`,
    });
    process.exit(0);
  }

  // Detect clean working commit with empty-diff check
  const diffSummary = await execFileText("jj", ["diff", "--summary"], cwd);
  const isClean = diffSummary.trim().length === 0;

  if (isClean) {
    writeStdoutJson({
      satisfied: true,
      context: `Blackbelt-Maintain: clean jj working commit — no-op, nothing to checkpoint. [bookmark: ${bookmarkName}]`,
    });
    process.exit(0);
  }

  // Dirty: describe the working change, move the bookmark to the described
  // commit, then create a new empty working commit.  Moving the bookmark
  // before `jj new` ensures a post-new failure cannot leave a clean working
  // copy with a stale bookmark.
  try {
    await execFileText("jj", ["describe", "-m", title], cwd);
    await moveBookmark(bookmarkName, cwd);
    await execFileText("jj", ["new"], cwd);
    writeStdoutJson({
      satisfied: true,
      context: `Blackbelt-Maintain: jj checkpoint created and new working commit ready. [bookmark: ${bookmarkName}]`,
    });
  } catch (error) {
    writeStdoutJson({
      satisfied: false,
      context: `Blackbelt-Maintain: jj command failed: ${formatExecError(error)} [bookmark: ${bookmarkName}]`,
    });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeStdoutJson({
    satisfied: false,
    context: `Blackbelt-Maintain: unexpected error: ${message}`,
  });
}

async function resolveJjRoot(cwd) {
  try {
    const stdout = await execFileText("jj", ["root"], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function moveBookmark(bookmarkName, cwd) {
  // Idempotently move/create the bookmark at @.
  // Try jj >= 0.20 bookmark set first, fall back to bookmark create for
  // older jj where the bookmark may not exist yet, then bookmark move.
  try {
    await execFileText("jj", ["bookmark", "set", bookmarkName, "--revision", "@"], cwd);
  } catch (setErr) {
    console.error(`[blackbelt-maintain] bookmark set failed, trying bookmark create: ${formatExecError(setErr)}`);
    try {
      await execFileText("jj", ["bookmark", "create", bookmarkName, "--revision", "@"], cwd);
    } catch (createErr) {
      console.error(`[blackbelt-maintain] bookmark create failed, trying bookmark move: ${formatExecError(createErr)}`);
      await execFileText("jj", ["bookmark", "move", bookmarkName, "--to", "@"], cwd);
    }
  }
}

function resolveBookmarkName(input) {
  const state = input.state != null && typeof input.state === "object" ? input.state : {};
  const bbState = state.blackbeltBootstrap != null && typeof state.blackbeltBootstrap === "object" ? state.blackbeltBootstrap : {};
  if (typeof bbState.bookmarkName === "string" && bbState.bookmarkName.trim().length > 0) {
    return bbState.bookmarkName.trim();
  }
  return null;
}

function execFileText(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      // Log stderr diagnostics to console.error so they are visible but do not
      // pollute stdout JSON output consumed by pi-materia.
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

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function writeStdoutJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

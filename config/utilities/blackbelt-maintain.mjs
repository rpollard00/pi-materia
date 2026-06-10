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
 *
 * Oversized-output / refused-snapshot resilience:
 *   - jj diff --summary may exceed maxBuffer when build artifacts (target/,
 *     node_modules/, etc.) are not gitignored and jj tries to diff thousands
 *     of untracked files.  This is treated as "dirty working copy" so the
 *     checkpoint always advances the bookmark — a satisfied auto-eval result
 *     is never rewritten to a build retry by a jj infrastructure hiccup.
 *   - jj refusing to snapshot oversized files is a non-fatal warning printed
 *     to stderr.  Snapshot refusals do not block describe / bookmark / new.
 *   - All known failure modes (no title, no jj repo, jj checkpoint command
 *     failure) return `satisfied: false` with a descriptive context string.
 */
import { execFile } from "node:child_process";

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB — handles large repos with many tracked files

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

  // Detect clean working commit with empty-diff check.
  // If jj diff --summary output exceeds the buffer (e.g. build artifacts not
  // gitignored), treat it as a dirty working copy and proceed with the
  // checkpoint.  A maxBuffer error is an infrastructure hiccup — it must not
  // mask a satisfied auto-eval result as a build retry.
  const diffResult = await detectWorkingCopyDirty(cwd);
  if (diffResult === "clean") {
    writeStdoutJson({
      satisfied: true,
      context: `Blackbelt-Maintain: clean jj working commit — no-op, nothing to checkpoint. [bookmark: ${bookmarkName}]`,
    });
    process.exit(0);
  }

  // Dirty (or presumed dirty): describe the working change, move the bookmark
  // to the described commit, then create a new empty working commit.  Moving
  // the bookmark before `jj new` ensures a post-new failure cannot leave a
  // clean working copy with a stale bookmark.
  await performCheckpoint(title, bookmarkName, cwd);
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

function execFileText(command, args, cwd, maxBuffer = MAX_BUFFER) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 30000, maxBuffer }, (error, stdout, stderr) => {
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

/**
 * Detect whether the jj working copy is clean using `jj diff --summary`.
 *
 * Returns:
 *   - "clean" when the diff output is empty
 *   - "dirty" when the diff output is non-empty
 *   - "dirty-assume" when the diff command fails (e.g. maxBuffer exceeded
 *     due to build artifacts not being gitignored).  In this case we
 *     optimistically treat the working copy as dirty so the checkpoint
 *     advances the bookmark rather than masking a satisfied auto-eval.
 */
async function detectWorkingCopyDirty(cwd) {
  try {
    const diffSummary = await execFileText("jj", ["diff", "--summary"], cwd);
    if (diffSummary.trim().length === 0) return "clean";
    return "dirty";
  } catch (error) {
    // Log the diff failure as a diagnostic but do not block the checkpoint.
    // jj diff --summary can fail when:
    //   - stdout exceeds maxBuffer (build artifacts not gitignored)
    //   - jj refuses to snapshot oversized files and the output balloons
    // In either case the working copy is almost certainly dirty, and even if
    // it were clean a redundant checkpoint is harmless — far better than
    // masking a satisfied auto-eval result with a build retry.
    console.error(`[blackbelt-maintain] jj diff --summary failed (assuming dirty): ${formatExecError(error)}`);
    return "dirty-assume";
  }
}

/**
 * Execute the jj checkpoint sequence: describe → move bookmark → new.
 *
 * Writes satisfied:true on success or satisfied:false with diagnostics on
 * failure.  This function is the single point that decides whether the
 * checkpoint succeeded — earlier diff failures do not preempt it.
 */
async function performCheckpoint(title, bookmarkName, cwd) {
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

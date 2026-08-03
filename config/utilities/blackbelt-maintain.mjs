#!/usr/bin/env node
/**
 * Blackbelt-Maintain — deterministic jj checkpoint utility.
 *
 * Input scope (tightly constrained):
 *   - item.title          → jj describe message
 *   - executionScope.cwd → working directory for jj commands
 *   - executionScope.state.blackbeltBootstrap.bookmarkName → optional scope-owned bookmark
 *
 * Legacy direct invocations without executionScope continue to use cwd/state.
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
 *     checkpoint always advances the working commit — a satisfied auto-eval
 *     result is never rewritten to a build retry by a jj infrastructure hiccup.
 *   - jj refusing to snapshot oversized files is a non-fatal warning printed
 *     to stderr. Snapshot refusals do not block describe / optional bookmark / new.
 *   - All known failure modes (no title, no jj repo, jj checkpoint command
 *     failure) return `satisfied: false` with a descriptive context string.
 */
import { execFile } from "node:child_process";

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB — handles large repos with many tracked files

try {
  const input = await readStdinJson();
  const title = input.item != null && typeof input.item === "object" ? input.item.title : null;
  const scope = resolveActiveScope(input);
  const cwd = scope?.cwd ?? (typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd());

  // Spawned jj workspaces intentionally checkpoint without bookmarks. Other
  // scopes retain the bootstrap bookmark contract, including sequential base
  // scopes which carry the cast-level bootstrap state as a fallback.
  const spawnedWorkspace = isRecognizedSpawnedWorkspace(scope);
  const bookmarkName = resolveBookmarkName(input, scope, spawnedWorkspace);
  if (bookmarkName === null && !spawnedWorkspace) {
    writeStdoutJson({
      satisfied: false,
      context: scope
        ? "Blackbelt-Maintain: missing executionScope.state.blackbeltBootstrap.bookmarkName. Provision the active scope before maintenance."
        : "Blackbelt-Maintain: missing state.blackbeltBootstrap.bookmarkName. Run Blackbelt-Bootstrap first so maintain can advance the bootstrap-owned bookmark.",
    });
    process.exit(0);
  }

  const unsafeReason = unsafeParallelInvocation(input, scope, bookmarkName);
  if (unsafeReason !== null) {
    writeStdoutJson({
      satisfied: false,
      context: `Blackbelt-Maintain: unsafe parallel invocation: ${unsafeReason} ${bookmarkContext(bookmarkName)}`,
    });
    process.exit(0);
  }

  // Fail early if no title available
  if (typeof title !== "string" || title.trim().length === 0) {
    writeStdoutJson({
      satisfied: false,
      context: `Blackbelt-Maintain: no item title available for the VCS message. ${bookmarkContext(bookmarkName)}`,
    });
    process.exit(0);
  }

  // Require jj; no git fallback — tell the user to run Blackbelt-Bootstrap first
  const jjRoot = await resolveJjRoot(cwd);
  if (jjRoot === null) {
    writeStdoutJson({
      satisfied: false,
      context: `Blackbelt-Maintain: jj is not available or no jj repo is detected. Run Blackbelt-Bootstrap first. ${bookmarkContext(bookmarkName)}`,
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
      context: `Blackbelt-Maintain: clean jj working commit — no-op, nothing to checkpoint. ${bookmarkContext(bookmarkName)}`,
    });
    process.exit(0);
  }

  // Dirty (or presumed dirty): always describe the working change and create
  // a new empty working commit. An authorized bookmark is moved in between
  // only when it is proven to already exist; maintenance never creates one.
  const movableBookmark = await resolveExistingBookmark(bookmarkName, cwd);
  await performCheckpoint(title, movableBookmark, cwd);
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

async function resolveExistingBookmark(bookmarkName, cwd) {
  if (bookmarkName === null) return null;
  try {
    const stdout = await execFileText(
      "jj",
      ["bookmark", "list", bookmarkName, "--template", 'name ++ "\\n"'],
      cwd,
    );
    return stdout.split(/\r?\n/u).some((name) => name.trim() === bookmarkName) ? bookmarkName : null;
  } catch (error) {
    console.error(`[blackbelt-maintain] bookmark existence check failed (checkpointing without moving it): ${formatExecError(error)}`);
    return null;
  }
}

async function moveBookmark(bookmarkName, cwd) {
  // Unlike `bookmark set`, `bookmark move` cannot create a bookmark if the
  // previously verified name disappears between the probe and this command.
  await execFileText("jj", ["bookmark", "move", bookmarkName, "--to", "@"], cwd);
}

function resolveActiveScope(input) {
  const scope = input.executionScope;
  if (scope == null || typeof scope !== "object" || Array.isArray(scope)) return null;
  if (typeof scope.cwd !== "string" || scope.cwd.trim().length === 0) return null;
  return scope;
}

function bookmarkFromState(state) {
  const record = state != null && typeof state === "object" && !Array.isArray(state) ? state : {};
  const bbState = record.blackbeltBootstrap != null && typeof record.blackbeltBootstrap === "object" && !Array.isArray(record.blackbeltBootstrap)
    ? record.blackbeltBootstrap
    : {};
  return typeof bbState.bookmarkName === "string" && bbState.bookmarkName.trim().length > 0
    ? bbState.bookmarkName.trim()
    : null;
}

function resolveBookmarkName(input, scope, spawnedWorkspace) {
  const scopeBookmark = bookmarkFromState(scope?.state);
  if (scopeBookmark !== null) return scopeBookmark;
  if (spawnedWorkspace) return null;
  // Legacy invocations and ordinary base scopes may carry the bootstrap-owned
  // cast bookmark. Replacement/branch scopes must authorize one locally.
  if (scope === null || (typeof scope.id === "string" && scope.id.endsWith(":base"))) return bookmarkFromState(input.state);
  return null;
}

function isRecognizedSpawnedWorkspace(scope) {
  if (scope === null) return false;
  const exportsRecord = scope.exports != null && typeof scope.exports === "object" && !Array.isArray(scope.exports)
    ? scope.exports
    : {};
  const exported = exportsRecord["jj.workspace.integration"];
  if (exported == null || typeof exported !== "object" || Array.isArray(exported)) return false;
  if (exported.producer !== "Spawn-JJ-Workspace") return false;
  const value = exported.value;
  return value != null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.workspacePath === "string"
    && value.workspacePath.trim().length > 0
    && value.workspacePath === scope.cwd;
}

function bookmarkContext(bookmarkName) {
  return `[bookmark: ${bookmarkName ?? "none"}]`;
}

function unsafeParallelInvocation(input, scope, bookmarkName) {
  const state = input.state != null && typeof input.state === "object" && !Array.isArray(input.state) ? input.state : {};
  const parallel = (state.parallelRun != null && typeof state.parallelRun === "object")
    || (state.parallelLane != null && typeof state.parallelLane === "object");
  if (!parallel) return null;
  if (scope === null) return "parallel maintenance requires an explicit active execution scope";

  const inheritedBookmark = bookmarkFromState(state);
  // Production child casts intentionally omit the parent's bootstrap state.
  // In that shape, an explicit active scope with its own bookmark is the only
  // bookmark authority and is safe to maintain. Reject only a bookmark that
  // can actually be identified as the shared cast bookmark.
  if (bookmarkName !== null && inheritedBookmark !== null && inheritedBookmark === bookmarkName) {
    return "the active scope still uses the shared cast bookmark; provision a branch-local scope and bookmark first";
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
 *     advances the working commit rather than masking a satisfied auto-eval.
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
 * Execute the jj checkpoint sequence: describe → optional bookmark move → new.
 *
 * Writes satisfied:true on success or satisfied:false with diagnostics on
 * failure.  This function is the single point that decides whether the
 * checkpoint succeeded — earlier diff failures do not preempt it.
 */
async function performCheckpoint(title, bookmarkName, cwd) {
  try {
    await execFileText("jj", ["describe", "-m", title], cwd);
    if (bookmarkName !== null) await moveBookmark(bookmarkName, cwd);
    await execFileText("jj", ["new"], cwd);
    writeStdoutJson({
      satisfied: true,
      context: `Blackbelt-Maintain: jj checkpoint created and new working commit ready. ${bookmarkContext(bookmarkName)}`,
    });
  } catch (error) {
    writeStdoutJson({
      satisfied: false,
      context: `Blackbelt-Maintain: jj command failed: ${formatExecError(error)} ${bookmarkContext(bookmarkName)}`,
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

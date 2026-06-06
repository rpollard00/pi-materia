#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

try {
  const input = await readStdinJson();
  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();

  const jjAvailable = await isCommandAvailable("jj");
  if (!jjAvailable) {
    throw new UtilityError("Blackbelt-Bootstrap: jj is required but was not found on PATH.", {
      available: { jj: false },
      initialized: false,
      newWorkingCommit: false,
      root: null,
      emptyHead: false,
    });
  }

  let root = await jjRoot(cwd);
  let initialized = false;
  if (root === null) {
    await execFileText("jj", ["git", "init"], cwd);
    initialized = true;
    root = await jjRoot(cwd);
    if (root === null) {
      throw new Error("jj git init completed but jj root could not be resolved.");
    }
  }

  const hadEmptyHead = await isCurrentCommitEmpty(cwd);
  let newWorkingCommit = false;
  if (!hadEmptyHead) {
    await execFileText("jj", ["new"], cwd);
    newWorkingCommit = true;
  }

  const bookmarkName = generateBookmarkName(input, cwd);
  // Idempotently set the bookmark: try bookmark set (jj >= 0.20), fall back to bookmark create
  try {
    await execFileText("jj", ["bookmark", "set", bookmarkName, "--revision", "@"], cwd);
  } catch (setErr) {
    console.error(`[blackbelt-bootstrap] bookmark set failed, trying bookmark create: ${formatError(setErr)}`);
    // Older jj: bookmark create then move if needed
    try {
      await execFileText("jj", ["bookmark", "create", bookmarkName, "--revision", "@"], cwd);
    } catch (createErr) {
      console.error(`[blackbelt-bootstrap] bookmark create failed, trying bookmark move: ${formatError(createErr)}`);
      // Already exists on older jj, try bookmark move
      await execFileText("jj", ["bookmark", "move", bookmarkName, "--to", "@"], cwd);
    }
  }

  writeStdoutJson({
    state: {
      blackbeltBootstrap: {
        ok: true,
        root,
        available: { jj: true },
        initialized,
        newWorkingCommit,
        emptyHead: true,
        bookmarkName,
      },
    },
  });
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.startsWith("Blackbelt-Bootstrap:") ? rawMessage : `Blackbelt-Bootstrap: ${rawMessage}`;
  const details = error instanceof UtilityError ? error.details : {};
  console.error(message);
  writeStdoutJson({
    state: {
      blackbeltBootstrap: {
        ok: false,
        error: message,
        ...details,
      },
    },
  });
  process.exitCode = 1;
}

class UtilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
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

async function isCommandAvailable(command) {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        await access(path.join(dir, `${command}${ext}`), constants.X_OK);
        return true;
      } catch {
        // Try next candidate.
      }
    }
  }
  return false;
}

async function jjRoot(cwd) {
  try {
    const stdout = await execFileText("jj", ["root"], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isCurrentCommitEmpty(cwd) {
  const diffSummary = await execFileText("jj", ["diff", "--summary"], cwd);
  return diffSummary.trim().length === 0;
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

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim().length > 0) {
    return `${message} (stderr: ${error.stderr.trim()})`;
  }
  return message;
}

/**
 * Generate a deterministic, git-ref-safe bookmark name under the blackbelt/ prefix.
 * Priority: params.bookmarkName > castId > basename(runDir) > timestamp + repo basename.
 */
function generateBookmarkName(input, cwd) {
  const params = input.params != null && typeof input.params === "object" ? input.params : {};
  let raw;

  // 1. Explicit params.bookmarkName
  if (typeof params.bookmarkName === "string" && params.bookmarkName.trim().length > 0) {
    raw = params.bookmarkName.trim();
  } else if (typeof input.castId === "string" && input.castId.trim().length > 0) {
    // 2. Prefer castId
    raw = input.castId.trim();
  } else if (typeof input.runDir === "string" && input.runDir.trim().length > 0) {
    // 3. basename(runDir)
    const base = path.basename(input.runDir.trim());
    raw = base.length > 0 ? base : undefined;
  }

  if (!raw) {
    // 4. Fallback: timestamp + sanitized repo basename
    const repoBase = path.basename(cwd);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").toLowerCase();
    raw = `${ts}-${repoBase}`;
  }

  // Always nest under the stable blackbelt/ prefix
  return sanitizeRefName(`blackbelt/${raw}`);
}

/**
 * Sanitize a string for use as a Git/JJ ref (bookmark) name.
 * Rules: lowercase; replace invalid chars with -; collapse repeats;
 * avoid empty segments, .., @{, .lock; no leading/trailing slash or dot.
 * Empty or fully-sanitized segments are replaced with "x" so that the
 * blackbelt/ prefix always produces at least a two-segment ref name.
 */
function sanitizeRefName(raw) {
  let s = raw.toLowerCase();

  // Replace Git-ref-invalid characters with '-'
  // Invalid per git-check-ref-format: control chars, space, ~ ^ : ? * [ \
  s = s.replace(/[\x00-\x20\x7f~^:?*[\\]/g, "-");

  // Break @{ sequence (replace @ with - in that context)
  s = s.replace(/@\{/g, "-{");

  // Break .. (double dot)
  s = s.replace(/\.\./g, ".-");

  // Collapse consecutive hyphens
  s = s.replace(/-{2,}/g, "-");

  // Collapse multiple slashes
  s = s.replace(/\/{2,}/g, "/");

  // Remove leading / and . (before splitting so the first segment is never empty)
  s = s.replace(/^[\/.]+/, "");

  // Replace .lock in any path segment (Git rejects ref components ending in .lock).
  // Run before splitting so it catches .lock at segment boundaries.
  s = s.replace(/\.lock(?=\/|$)/gi, "-lock");

  // Split into segments and clean each one individually.
  // Do NOT strip trailing delimiters before splitting — let the per-segment
  // cleaner replace empty trailing segments with "x" so we always preserve
  // a non-empty suffix (e.g. "blackbelt/" becomes "blackbelt/x").
  const segments = s.split("/").map((seg) => {
    let cleaned = seg.replace(/^[-.]+/, "").replace(/[-.]+$/, "");
    if (cleaned.length === 0) cleaned = "x";
    // Guard against .lock surviving per-segment trimming (e.g. foo.lock. → foo.lock).
    // Git rejects any ref component ending in .lock, so replace the trailing suffix.
    if (cleaned.endsWith(".lock")) {
      cleaned = cleaned.slice(0, -5) + "-x";
    }
    return cleaned;
  });

  s = segments.join("/");

  // A lone '@' is invalid as a ref name; empty string too
  if (s === "@" || s.length === 0) s = "x";

  return s;
}
